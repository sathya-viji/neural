/**
 * Desktop host. Three separate pieces meet here:
 *   - the kernel, started as its own process (it decides what is allowed)
 *   - the gateway, which talks to the chosen model and sends proposals to the kernel
 *   - the window, which shows results and the kernel's approval requests
 */
import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu, MenuItem, Notification, clipboard } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { KernelClient } from "@uab/kernel/client";
import {
  Gateway,
  conversationOnly,
  appleModelAvailability,
  cloudModelsUrl,
  createProvider,
  kernelFetch,
  defaultModelSettings,
  describeModelSettings,
  pickGeminiModel,
  probeModels,
  rankGeminiModels,
  GEMINI_BASE_URL,
  type GatewayEvent,
  type Message,
  type ModelSettings,
} from "@uab/gateway";
import type { ConversationTurn, KernelEvent, Permission } from "@uab/protocol";
import { MiniBrowser, refersToPage } from "./browser.js";
import QRCode from "qrcode";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
// In the packaged app the on-device model helper sits in the app folder.
if (app.isPackaged) process.env.UAB_APPLE_HELPER = join(appRoot, "bin", "uab-apple-model");

let win: BrowserWindow | null = null;
let kernel: KernelClient;
let kernelHome = "";
let history: Message[] = [];
/** The conversation on screen; saved by the kernel after each turn. Undefined until the first question. */
let conversationId: string | undefined;
let running: AbortController | null = null;
let browser: MiniBrowser | null = null;

/* ---------------- settings (which model to use) ---------------- */

function settingsPath(): string {
  return join(kernelHome, "settings.json");
}

function loadSettings(): ModelSettings {
  const defaults = defaultModelSettings();
  if (!existsSync(settingsPath())) return defaults;
  try {
    const saved = JSON.parse(readFileSync(settingsPath(), "utf8")).models ?? {};
    return { ...defaults, ...saved, local: { ...defaults.local, ...saved.local }, cloud: { ...defaults.cloud, ...saved.cloud } };
  } catch {
    return defaults;
  }
}

function saveSettings(models: ModelSettings): void {
  writeFileSync(settingsPath(), JSON.stringify({ models }, null, 2), { mode: 0o600 });
}

function send(channel: string, payload: unknown): void {
  win?.webContents.send("uab:event", { channel, payload });
}

/* ---------------- running a request ---------------- */

async function ask(text: string): Promise<void> {
  if (running) throw new Error("Already working on something. Stop it or wait.");
  const settings = loadSettings();
  let gateway: Gateway;
  try {
    gateway = new Gateway(kernel, createProvider(settings, kernel));
  } catch (err) {
    send("gateway", { type: "error", message: (err as Error).message });
    send("gateway", { type: "done", text: (err as Error).message, taskId: "" });
    return;
  }
  running = new AbortController();
  stepIds.clear();
  const turn: ConversationTurn = { question: text, at: new Date().toISOString(), steps: [] };
  try {
    // Who the user is and what they asked to be remembered. The kernel decides how much of it
    // this model gets (less for cloud models).
    const parts: string[] = [];
    const known = await kernel.call("context.build", { intent: text, cloud: gateway.locality === "cloud" }).catch(() => ({ text: "" }));
    if (known.text) parts.push(known.text);
    // If the request is about the page open in the browser panel, the AI gets that page's text.
    if (browser?.state().open && refersToPage(text)) {
      const page = await browser.pageText().catch(() => null);
      if (page) parts.push(`The user is looking at this page in the app's browser.\nTitle: ${page.title}\nAddress: ${page.url}\n\n${page.text}`);
    }
    const context = parts.join("\n\n") || undefined;
    const result = await gateway.run(text, {
      history,
      context,
      signal: running.signal,
      onEvent: (e) => {
        record(turn, e);
        // "Show a web page" results open in the browser panel.
        if (e.type === "decision" && e.decision.status === "executed") {
          const target = (e.decision.result.data as { openInBrowser?: string } | undefined)?.openInBrowser;
          if (target) browser?.open(target);
        }
        send("gateway", e);
      },
    });
    // Keep the conversation for follow-ups: what was asked and answered, not each
    // turn's tool steps. Old tool results without their calls break providers.
    history = conversationOnly(result.messages, result.text).slice(-20);
  } catch (err) {
    turn.error = (err as Error).message;
    throw err;
  } finally {
    running = null;
    if (turn.answer === undefined && !turn.error) turn.error = "Stopped before finishing.";
    await saveTurn(turn);
  }
}

/** Keep what the user saw of this turn, so the conversation can be reopened after a restart. */
function record(turn: ConversationTurn, e: GatewayEvent): void {
  if (e.type === "task") (turn.model = e.model), (turn.locality = e.locality), (turn.taskId = e.taskId);
  else if (e.type === "proposal") {
    const detail = Object.entries(e.args ?? {})
      .filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" · ")
      .slice(0, 160);
    stepIds.set(e.callId, turn.steps.push({ title: e.capability.title, service: e.capability.service, status: "pending", detail, meta: "" }) - 1);
  } else if (e.type === "decision") {
    const step = turn.steps[stepIds.get(e.callId) ?? -1];
    if (!step) return;
    const d = e.decision;
    step.status = d.status;
    if (d.status === "executed") {
      step.detail = d.replayed ? "Already done earlier — not repeated." : d.result.content.split("\n").slice(0, 3).join("\n").slice(0, 600);
      step.meta = d.approvedBy === "user" ? "You approved" : d.verified ? "Allowed" : "Not verified";
    } else if (d.status === "denied") {
      step.detail = d.reason;
      step.meta = d.by === "user" ? "You declined" : d.by === "policy" ? "Blocked" : "Rejected by the kernel";
    } else {
      step.detail = d.error;
      step.meta = "Failed";
    }
  } else if (e.type === "done") turn.answer = e.text;
  else if (e.type === "error") turn.error = e.message;
}
const stepIds = new Map<string, number>();

async function saveTurn(turn: ConversationTurn): Promise<void> {
  try {
    const { id } = await kernel.call("conversations.appendTurn", { id: conversationId, turn, history });
    conversationId = id;
    send("conversations.changed", { currentId: id });
  } catch (err) {
    process.stderr.write(`[app] couldn't save the conversation: ${(err as Error).message}\n`);
  }
}

/** Ask the cloud provider which models the saved key can use. Also confirms the key works. */
async function listCloudModels(cloud: ModelSettings["cloud"]): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const url = cloudModelsUrl(cloud);
  if (!url) return { ok: true, models: [] };
  if (!(await kernel.call("model.hasKey", {})).present) return { ok: false, models: [], error: "No API key saved yet." };
  try {
    // The kernel adds the key; it never comes to this process.
    const res = await kernelFetch(kernel, "bearer", 8000)(url, {});
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, models: [], error: res.status === 400 || res.status === 401 || res.status === 403 ? "The provider rejected this API key." : `${res.status}: ${text.slice(0, 160)}` };
    }
    const body = (await res.json()) as { data?: { id: string }[] };
    return { ok: true, models: (body.data ?? []).map((m) => m.id.replace(/^models\//, "")) };
  } catch (err) {
    return { ok: false, models: [], error: (err as Error).message };
  }
}

/* ---------------- New versions ---------------- */

const RELEASES = "https://api.github.com/repos/sathya-viji/neural/releases?per_page=10";
const versionParts = (v: string) => v.replace(/^v/, "").split("-")[0].split(".").map((n) => Number(n) || 0);
const isNewer = (a: string, b: string) => {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/**
 * Is there a newer release on GitHub? This alpha isn't signed, so macOS won't
 * let it replace itself: the app shows a notice and the user downloads it.
 * Only GitHub's public release list is fetched; nothing about the user is sent.
 */
async function checkForUpdate(): Promise<{ current: string; latest?: string; url?: string }> {
  const current = app.getVersion();
  const res = await fetch(RELEASES, { headers: { accept: "application/vnd.github+json", "user-agent": `Neural/${current}` }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return { current };
  const releases = (await res.json()) as { tag_name: string; html_url: string; draft: boolean }[];
  const latest = releases.filter((r) => !r.draft).sort((a, b) => (isNewer(a.tag_name, b.tag_name) ? -1 : 1))[0];
  if (!latest || !isNewer(latest.tag_name, current)) return { current };
  if (!latest.html_url.startsWith("https://github.com/sathya-viji/neural/")) return { current };
  return { current, latest: latest.tag_name.replace(/^v/, ""), url: latest.html_url };
}

/* ---------------- IPC: the only things the window can ask for ---------------- */

function insideHome(path: string): string {
  const p = resolve(path);
  if (p !== kernelHome && !p.startsWith(kernelHome + sep)) throw new Error("Can only reveal files in the app's data folder");
  return p;
}

function registerIpc(): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown) => ipcMain.handle(channel, (_e, ...args) => fn(...args));

  handle("hello", async () => {
    const hello = await kernel.call("kernel.hello", {});
    const settings = loadSettings();
    return { ...hello, model: describeModelSettings(settings), settings };
  });
  handle("ask", (text: string) => {
    ask(String(text)).catch((err) => send("gateway", { type: "error", message: (err as Error).message }));
    return {};
  });
  handle("stop", () => (running?.abort(), {}));
  handle("conversation.new", () => ((history = []), (conversationId = undefined), {}));
  handle("conversation.current", async () => (conversationId ? kernel.call("conversations.get", { id: conversationId }).catch(() => null) : null));
  handle("conversation.list", () => kernel.call("conversations.list", { limit: 50 }));
  handle("conversation.open", async (id: string) => {
    if (running) throw new Error("Wait for the current request to finish, or stop it.");
    const c = await kernel.call("conversations.get", { id: String(id) });
    conversationId = c.id;
    history = c.history as Message[];
    return c;
  });
  handle("conversation.delete", async (id: string) => {
    await kernel.call("conversations.delete", { id: String(id) });
    if (id === conversationId) (conversationId = undefined), (history = []);
    return { currentId: conversationId ?? null };
  });

  handle("approvals.pending", () => kernel.call("approvals.pending", {}));
  handle("approvals.resolve", (approvalId: string, approve: boolean) => kernel.call("approvals.resolve", { approvalId, approve: !!approve }));

  handle("capabilities", () => kernel.call("capabilities.list", {}));
  handle("policy.get", () => kernel.call("policy.get", {}));
  handle("policy.set", (target: string, permission: Permission) => kernel.call("policy.set", { target, permission }));
  handle("roots.add", async () => {
    const pick = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "multiSelections"], title: "Share folders with Neural" });
    if (pick.canceled) return {};
    const policy = await kernel.call("policy.get", {});
    return kernel.call("policy.setFileRoots", { roots: [...new Set([...policy.fileRoots, ...pick.filePaths])] });
  });
  handle("roots.remove", async (root: string) => {
    const policy = await kernel.call("policy.get", {});
    return kernel.call("policy.setFileRoots", { roots: policy.fileRoots.filter((r) => r !== root) });
  });

  handle("audit", () => kernel.call("audit.list", { limit: 300 }));
  handle("audit.verify", () => kernel.call("audit.verify", {}));
  handle("tasks", () => kernel.call("tasks.list", { limit: 100 }));

  handle("services", () => kernel.call("services.list", {}));
  handle("services.reload", () => kernel.call("services.reload", {}));
  handle("services.signIn", async (id: string) => {
    const { url } = await kernel.call("services.signIn", { id: String(id) });
    // The service's own sign-in page, in the user's normal browser.
    if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(url)) throw new Error("Unexpected sign-in address");
    await shell.openExternal(url);
    return {};
  });
  handle("services.signOut", (id: string) => kernel.call("services.signOut", { id: String(id) }));
  handle("services.add", (input: { name?: string; url?: string; command?: string }) =>
    kernel.call("services.add", { name: String(input?.name ?? ""), url: input?.url ? String(input.url) : undefined, command: input?.command ? String(input.command) : undefined }),
  );
  handle("services.remove", (id: string) => kernel.call("services.remove", { id: String(id) }));
  handle("vault.list", () => kernel.call("vault.list", {}));
  // Approve from your phone: the kernel serves the page; the app shows its address as a QR code.
  const withQr = async (s: { url: string | null }) => ({ ...s, qr: s.url ? await QRCode.toDataURL(s.url, { margin: 1, width: 360 }) : null });
  handle("phone.status", async () => withQr(await kernel.call("phone.status", {})));
  handle("phone.enable", async (on: boolean) => withQr(await kernel.call("phone.enable", { on: !!on })));
  handle("phone.rotate", async () => withQr(await kernel.call("phone.rotate", {})));
  handle("agents.status", () => kernel.call("agents.status", {}));
  handle("agents.enable", (on: boolean) => kernel.call("agents.enable", { on: !!on }));
  handle("agents.confirmInApp", (on: boolean) => kernel.call("agents.confirmInApp", { on: !!on }));
  // The setup another app needs: run the bridge with Neural's own runtime, plus the pairing key.
  handle("agents.setup", async (rotate?: boolean) => {
    const { token } = await kernel.call("agents.token", { rotate: !!rotate });
    const bridge = app.isPackaged ? join(here, "uab-mcp.js") : join(appRoot, "..", "..", "packages", "cli", "dist", "mcp.js");
    const config = { mcpServers: { neural: { command: process.execPath, args: [bridge], env: { ELECTRON_RUN_AS_NODE: "1", NEURAL_PAIRING_KEY: token, UAB_HOME: kernelHome } } } };
    return { config: JSON.stringify(config, null, 2) };
  });
  handle("agents.copy", async () => {
    const { token } = await kernel.call("agents.token", {});
    const bridge = app.isPackaged ? join(here, "uab-mcp.js") : join(appRoot, "..", "..", "packages", "cli", "dist", "mcp.js");
    clipboard.writeText(JSON.stringify({ mcpServers: { neural: { command: process.execPath, args: [bridge], env: { ELECTRON_RUN_AS_NODE: "1", NEURAL_PAIRING_KEY: token, UAB_HOME: kernelHome } } } }, null, 2));
    return {};
  });
  handle("context.get", () => kernel.call("context.get", {}));
  handle("context.setProfile", (profile: Record<string, unknown>) =>
    kernel.call("context.setProfile", { profile: Object.fromEntries(Object.entries(profile ?? {}).map(([k, v]) => [k, String(v ?? "")])) }),
  );
  handle("context.addMemory", (text: string) => kernel.call("context.addMemory", { text: String(text) }));
  handle("context.removeMemory", (id: string) => kernel.call("context.removeMemory", { id: String(id) }));
  handle("context.preview", (cloud: boolean) => kernel.call("context.build", { intent: "", cloud: !!cloud }));
  handle("vault.remove", (name: string) => kernel.call("vault.remove", { name: String(name) }));
  handle("update.check", () => checkForUpdate().catch(() => ({ current: app.getVersion() })));
  handle("update.open", async () => {
    const { url } = await checkForUpdate();
    if (url) await shell.openExternal(url);
    return {};
  });
  handle("services.edit", () => shell.openPath(join(kernelHome, "services.json")));

  handle("gmail.status", () => kernel.call("gmail.status", {}));
  handle("gmail.configure", (clientId: string, clientSecret: string) => kernel.call("gmail.configure", { clientId: String(clientId), clientSecret: String(clientSecret) }));
  handle("gmail.connect", async () => {
    const { url } = await kernel.call("gmail.connect", {});
    // Only Google's sign-in page, in the user's normal browser.
    if (!url.startsWith("https://accounts.google.com/")) throw new Error("Unexpected sign-in address");
    await shell.openExternal(url);
    return {};
  });
  handle("gmail.disconnect", () => kernel.call("gmail.disconnect", {}));
  handle("browser.open", (url: string) => (browser?.open(String(url)), {}));
  handle("browser.go", (input: string) => (browser?.go(String(input)), {}));
  handle("browser.back", () => (browser?.back(), {}));
  handle("browser.forward", () => (browser?.forward(), {}));
  handle("browser.reload", () => (browser?.reload(), {}));
  handle("browser.external", () => (browser?.openExternal(), {}));
  handle("browser.close", () => (browser?.close(), {}));
  handle("browser.bounds", (b: { x: number; y: number; width: number; height: number }) => (browser?.setBounds(b), {}));
  handle("browser.state", () => browser?.state());
  // The page panel keeps keyboard focus once clicked; the chat takes it back when it's clicked.
  handle("app.focus", () => (win?.webContents.focus(), {}));
  handle("chatgpt.status", () => kernel.call("chatgpt.status", {}));
  handle("chatgpt.connect", async () => {
    const { url } = await kernel.call("chatgpt.connect", {});
    // Only OpenAI's own sign-in page, in the user's normal browser.
    if (!url.startsWith("https://auth.openai.com/")) throw new Error("Unexpected sign-in address");
    await shell.openExternal(url);
    return {};
  });
  handle("chatgpt.disconnect", () => kernel.call("chatgpt.disconnect", {}));
  handle("chatgpt.models", () => kernel.call("chatgpt.models", {}));
  handle("gmail.guide", () => shell.openPath(app.isPackaged ? join(appRoot, "docs", "gmail-setup.md") : join(appRoot, "..", "..", "docs", "gmail-setup.md")));

  handle("settings.get", () => loadSettings());
  handle("settings.set", async (s: ModelSettings) => {
    // Gemini: pick the best free-tier model this key can use (unless the user chose one)
    // and keep a few others to fall back on when it's overloaded.
    let working: string[] | undefined;
    if (s.cloud.kind === "gemini" && s.active === "cloud") {
      const listed = await listCloudModels(s.cloud);
      if (listed.ok) {
        const ranked = rankGeminiModels(listed.models).slice(0, 10);
        const candidates = s.cloud.model && !ranked.includes(s.cloud.model) ? [s.cloud.model, ...ranked] : ranked;
        working = await probeModels(GEMINI_BASE_URL, kernelFetch(kernel, "bearer", 15_000), candidates);
        if (working.length) {
          // Keep the user's choice if it works; otherwise the best one that answered.
          if (!s.cloud.model || !working.includes(s.cloud.model)) s.cloud.model = working[0];
          s.cloud.fallbacks = working.filter((m) => m !== s.cloud.model).slice(0, 4);
        } else if (!s.cloud.model) {
          s.cloud.model = pickGeminiModel(listed.models);
        }
      }
    } else if (s.cloud.kind !== "gemini") {
      delete s.cloud.fallbacks;
    }
    saveSettings(s);
    return { model: describeModelSettings(s), settings: s, working };
  });
  handle("cloud.models", (cloud: ModelSettings["cloud"]) => listCloudModels(cloud));
  // The key goes straight to the kernel, with the address it's for, and never comes back out.
  handle("key.set", (value: string, cloud?: ModelSettings["cloud"]) => {
    const endpoint = cloud?.kind === "openai-compatible" ? cloud.baseUrl || "https://api.openai.com/v1" : cloud?.kind === "anthropic" ? cloud.baseUrl : undefined;
    return kernel.call("model.saveKey", { value: String(value), endpoint: endpoint ? String(endpoint) : undefined });
  });
  handle("key.has", () => kernel.call("model.hasKey", {}));
  handle("builtin.status", () => appleModelAvailability());
  handle("local.models", async (baseUrl: string) => {
    try {
      const res = await fetch(`${String(baseUrl).replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(2500) });
      const body = (await res.json()) as { data?: { id: string }[] };
      return { ok: true, models: (body.data ?? []).map((m) => m.id) };
    } catch {
      return { ok: false, models: [] };
    }
  });
  handle("reveal", (path: string) => (shell.showItemInFolder(insideHome(path)), {}));
  handle("openHome", () => shell.openPath(kernelHome));
}

/* ---------------- start up ---------------- */

async function startKernel(): Promise<void> {
  kernel = new KernelClient({
    execPath: process.execPath,
    // Packaged: the kernel is bundled next to this file, with its model and runtime in the app folder.
    entry: app.isPackaged ? join(here, "kernel.js") : undefined,
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ...(app.isPackaged ? { UAB_EMBED_MODEL: join(appRoot, "models", "all-MiniLM-L6-v2"), UAB_ORT_WASM: join(appRoot, "ort") + "/" } : {}),
    },
    onLog: (line) => console.log(line),
  });
  const events: KernelEvent[] = ["approval.requested", "approval.resolved", "audit.appended", "services.changed", "chatgpt.changed"];
  for (const e of events) kernel.on(e, (payload) => send(e, payload));
  // Another AI app is asking for something that needs your OK: say so, even if Neural is in the background.
  kernel.on("approval.requested", (req) => {
    if (req.source !== "agent" || win?.isFocused()) return;
    const note = new Notification({ title: `${req.model ?? "Another AI app"} needs your OK`, body: req.summary });
    note.on("click", () => (win?.show(), win?.focus()));
    note.show();
  });
  kernel.on("exit", (code) => {
    if (!app.isReady() || quitting) return;
    dialog.showErrorBox("Kernel stopped", `The trusted kernel stopped unexpectedly (code ${code}). Nothing can run until the app restarts.`);
    app.quit();
  });
  await kernel.start();
  kernelHome = (await kernel.call("kernel.hello", {})).home;
  // Pick up where the user left off, if that was in the last 12 hours.
  const [last] = await kernel.call("conversations.list", { limit: 1 }).catch(() => []);
  if (last && Date.now() - new Date(last.updatedAt).getTime() < 12 * 3600 * 1000) {
    const c = await kernel.call("conversations.get", { id: last.id }).catch(() => null);
    if (c) (conversationId = c.id), (history = c.history as Message[]);
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    title: "Neural",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#14161a" : "#f6f6f3",
    webPreferences: {
      preload: join(appRoot, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(join(appRoot, "ui", "index.html"));
  // Links never open inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  browser = new MiniBrowser(win, (state) => send("browser.state", state));
}

let quitting = false;
app.on("before-quit", () => {
  quitting = true;
  kernel?.stop();
});
app.on("window-all-closed", () => app.quit());

app.whenReady().then(async () => {
  try {
    await startKernel();
  } catch (err) {
    dialog.showErrorBox("Couldn't start the kernel", (err as Error).message);
    app.quit();
    return;
  }
  registerIpc();
  createWindow();
  addCaptureMenu();
});

/**
 * For README screenshots: with UAB_CAPTURE_DIR set (development only), a Capture
 * menu saves the window as a PNG there. Absent from normal runs and the packaged app.
 */
function addCaptureMenu(): void {
  const dir = process.env.UAB_CAPTURE_DIR;
  const menu = Menu.getApplicationMenu();
  if (!dir || app.isPackaged || !menu) return;
  let n = 0;
  const capture = async () => {
    const image = await win?.webContents.capturePage();
    if (image) writeFileSync(join(dir, `shot-${String(++n).padStart(2, "0")}.png`), image.toPNG());
  };
  menu.append(new MenuItem({ label: "Capture", submenu: [{ label: "Save window as PNG", accelerator: "CmdOrCtrl+Shift+9", click: () => void capture() }] }));
  Menu.setApplicationMenu(menu);
}
