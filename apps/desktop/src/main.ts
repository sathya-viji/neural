/**
 * Desktop host. Three separate pieces meet here:
 *   - the kernel, started as its own process (it decides what is allowed)
 *   - the gateway, which talks to the chosen model and sends proposals to the kernel
 *   - the window, which shows results and the kernel's approval requests
 */
import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { KernelClient } from "@uab/kernel/client";
import {
  Gateway,
  cloudModelsUrl,
  createProvider,
  defaultModelSettings,
  describeModelSettings,
  pickGeminiModel,
  type Message,
  type ModelSettings,
} from "@uab/gateway";
import type { KernelEvent, Permission } from "@uab/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");

let win: BrowserWindow | null = null;
let kernel: KernelClient;
let kernelHome = "";
let history: Message[] = [];
let running: AbortController | null = null;

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
  const key = settings.active === "cloud" ? (await kernel.call("vault.getModelKey", { name: "model.cloud" })).value : null;
  let gateway: Gateway;
  try {
    gateway = new Gateway(kernel, createProvider(settings, key));
  } catch (err) {
    send("gateway", { type: "error", message: (err as Error).message });
    send("gateway", { type: "done", text: (err as Error).message, taskId: "" });
    return;
  }
  running = new AbortController();
  try {
    const result = await gateway.run(text, {
      history,
      signal: running.signal,
      onEvent: (e) => send("gateway", e),
    });
    // Keep the conversation for follow-ups, but only the readable parts.
    history = result.messages.slice(-30);
  } finally {
    running = null;
  }
}

/** Ask the cloud provider which models the saved key can use. Also confirms the key works. */
async function listCloudModels(cloud: ModelSettings["cloud"]): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const url = cloudModelsUrl(cloud);
  if (!url) return { ok: true, models: [] };
  const key = (await kernel.call("vault.getModelKey", { name: "model.cloud" })).value;
  if (!key) return { ok: false, models: [], error: "No API key saved yet." };
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
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
  handle("conversation.new", () => ((history = []), {}));

  handle("approvals.pending", () => kernel.call("approvals.pending", {}));
  handle("approvals.resolve", (approvalId: string, approve: boolean) => kernel.call("approvals.resolve", { approvalId, approve: !!approve }));

  handle("capabilities", () => kernel.call("capabilities.list", {}));
  handle("policy.get", () => kernel.call("policy.get", {}));
  handle("policy.set", (target: string, permission: Permission) => kernel.call("policy.set", { target, permission }));
  handle("roots.add", async () => {
    const pick = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "multiSelections"], title: "Share folders with Unified AI Base" });
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
  handle("services.edit", () => shell.openPath(join(kernelHome, "services.json")));

  handle("settings.get", () => loadSettings());
  handle("settings.set", async (s: ModelSettings) => {
    // No model chosen for Gemini: pick the best free-tier one this key can use.
    if (s.active === "cloud" && s.cloud.kind === "gemini" && !s.cloud.model) {
      const listed = await listCloudModels(s.cloud);
      if (listed.ok) s.cloud.model = pickGeminiModel(listed.models);
    }
    saveSettings(s);
    return { model: describeModelSettings(s), settings: s };
  });
  handle("cloud.models", (cloud: ModelSettings["cloud"]) => listCloudModels(cloud));
  handle("key.set", (value: string) => kernel.call("vault.set", { name: "model.cloud", value: String(value) }));
  handle("key.has", () => kernel.call("vault.has", { name: "model.cloud" }));
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
    env: { ELECTRON_RUN_AS_NODE: "1" },
    onLog: (line) => console.log(line),
  });
  const events: KernelEvent[] = ["approval.requested", "approval.resolved", "audit.appended", "services.changed"];
  for (const e of events) kernel.on(e, (payload) => send(e, payload));
  kernel.on("exit", (code) => {
    if (!app.isReady() || quitting) return;
    dialog.showErrorBox("Kernel stopped", `The trusted kernel stopped unexpectedly (code ${code}). Nothing can run until the app restarts.`);
    app.quit();
  });
  await kernel.start();
  kernelHome = (await kernel.call("kernel.hello", {})).home;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    title: "Unified AI Base",
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
});
