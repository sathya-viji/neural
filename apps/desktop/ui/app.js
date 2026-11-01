// Renderer. Everything that comes from a model or a service is inserted as
// text, never as HTML.
const uab = window.uab;
const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const SERVICE_NAMES = { files: "Files", contacts: "Contacts", mail: "Mail", calendar: "Calendar", reminders: "Reminders", system: "This computer" };
const serviceName = (id) => SERVICE_NAMES[id] ?? id.replace(/^mcp\./, "");

/* ---------------- navigation ---------------- */

const loaders = { activity: loadActivity, permissions: loadPermissions, services: loadServices, settings: loadSettings };
document.querySelectorAll(".nav").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${btn.dataset.view}`));
    loaders[btn.dataset.view]?.();
  }),
);

/* ---------------- Ask ---------------- */

const transcript = $("#transcript");
const input = $("#input");
let current = null; // { container, steps: Map<callId, node> }

function scrollDown() {
  transcript.scrollTop = transcript.scrollHeight;
}

function setBusy(busy) {
  $("#send").disabled = busy;
  $("#stop").classList.toggle("hidden", !busy);
  input.disabled = busy;
  if (!busy) input.focus();
}

function submit(text) {
  text = text.trim();
  if (!text) return;
  $("#ask-empty")?.remove();
  transcript.append(el("div", { class: "turn-user" }, text));
  const container = el("div", { class: "turn-ai" });
  const steps = el("div", { class: "steps" });
  container.append(steps);
  transcript.append(container);
  current = { container, stepsNode: steps, steps: new Map() };
  input.value = "";
  autosize();
  setBusy(true);
  scrollDown();
  uab.call("ask", text);
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  submit(input.value);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit(input.value);
  }
});
function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}
input.addEventListener("input", autosize);
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => submit(c.textContent)));
$("#stop").addEventListener("click", () => uab.call("stop"));
$("#new-conversation").addEventListener("click", async () => {
  await uab.call("conversation.new");
  transcript.replaceChildren(el("div", { class: "empty" }, el("p", {}, "New conversation. What would you like done?")));
});

function onGateway(e) {
  if (!current) return;
  if (e.type === "task") {
    current.container.prepend(
      el("div", { class: "model-tag" }, e.locality === "cloud" ? el("span", { class: "cloud" }, "☁ ") : "⌂ ", `${e.model}${e.locality === "cloud" ? " · cloud" : " · on this computer"}`),
    );
  } else if (e.type === "thinking") {
    current.stepsNode.append(el("div", { class: "thinking" }, e.text));
  } else if (e.type === "proposal") {
    const node = el(
      "div",
      { class: "step pending" },
      el("div", { class: "icon" }, "○"),
      el("div", {}, el("div", { class: "title" }, e.capability.title), el("div", { class: "detail" }, briefArgs(e.args))),
      el("div", { class: "meta" }, serviceName(e.capability.service)),
    );
    current.steps.set(e.callId, node);
    current.stepsNode.append(node);
  } else if (e.type === "decision") {
    const node = current.steps.get(e.callId);
    if (!node) return;
    const d = e.decision;
    node.className = `step ${d.status}`;
    node.querySelector(".icon").textContent = d.status === "executed" ? "✓" : "✕";
    const detail = node.querySelector(".detail");
    if (d.status === "executed") {
      detail.textContent = d.replayed ? "Already done earlier — not repeated." : firstLines(d.result.content, 3);
      const file = d.result.data?.file;
      if (file) detail.after(el("button", { class: "link", onclick: () => uab.call("reveal", file) }, "Show in Finder"));
      node.querySelector(".meta").textContent = d.approvedBy === "user" ? "You approved" : d.verified ? "Allowed" : "Not verified";
    } else if (d.status === "denied") {
      detail.textContent = d.reason;
      node.querySelector(".meta").textContent = d.by === "user" ? "You declined" : "Blocked";
    } else {
      detail.textContent = d.error;
      node.querySelector(".meta").textContent = "Failed";
    }
  } else if (e.type === "error") {
    current.container.append(el("div", { class: "error" }, e.message));
  } else if (e.type === "done") {
    if (!current.container.querySelector(".error")) current.container.append(el("div", { class: "answer" }, e.text));
    current = null;
    setBusy(false);
  }
  scrollDown();
}

function briefArgs(args) {
  const s = Object.entries(args ?? {})
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" · ");
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
}

function firstLines(text, n) {
  const lines = String(text ?? "").split("\n");
  return lines.slice(0, n).join("\n") + (lines.length > n ? `\n… ${lines.length - n} more lines` : "");
}

/* ---------------- Kernel approvals ---------------- */

const approvalNodes = new Map();

function showApproval(req) {
  if (approvalNodes.has(req.approvalId)) return;
  const cap = req.capability;
  const node = el(
    "div",
    { class: "approval" },
    el("div", { class: "who" }, "Kernel · your approval needed"),
    el("div", { class: "summary" }, req.summary),
    el(
      "div",
      { class: "facts" },
      el("span", { class: `badge ${cap.risk}` }, `${cap.risk} risk`),
      ...cap.effects.map((x) => el("span", { class: "badge" }, x)),
      el("span", { class: "badge" }, serviceName(cap.service)),
      el("span", { class: "badge" }, `asked by ${req.model ?? req.source}`),
    ),
    req.reason ? el("div", { class: "reason" }, "The AI's reason (not verified): ", req.reason) : null,
    el("details", {}, el("summary", {}, "Exact details"), el("pre", {}, JSON.stringify(req.args, null, 2))),
    el(
      "div",
      { class: "actions" },
      el("button", { class: "primary", onclick: () => resolveApproval(req.approvalId, true) }, "Allow once"),
      el("button", { class: "ghost", onclick: () => resolveApproval(req.approvalId, false) }, "Decline"),
    ),
  );
  approvalNodes.set(req.approvalId, node);
  (current?.container ?? transcript).append(node);
  scrollDown();
}

async function resolveApproval(id, approve) {
  await uab.call("approvals.resolve", id, approve).catch(() => {});
}

function onApprovalResolved({ approvalId, approved }) {
  const node = approvalNodes.get(approvalId);
  if (!node) return;
  node.classList.add("resolved");
  node.querySelector(".who").textContent = approved ? "Kernel · you allowed this" : "Kernel · you declined this";
}

/* ---------------- Activity ---------------- */

async function loadActivity() {
  const [tasks, entries, verify] = await Promise.all([uab.call("tasks"), uab.call("audit"), uab.call("audit.verify")]);
  const integrity = $("#integrity");
  integrity.className = `integrity ${verify.ok ? "ok" : "bad"}`;
  integrity.textContent = verify.ok ? `✓ History intact · ${verify.entries} records` : `✕ History was changed at record ${verify.brokenAt}`;

  const byTask = new Map();
  for (const e of entries) {
    if (!byTask.has(e.taskId)) byTask.set(e.taskId, []);
    byTask.get(e.taskId).push(e);
  }
  const list = $("#activity-list");
  list.replaceChildren();
  const shown = tasks.filter((t) => byTask.has(t.taskId) || t.summary);
  if (!shown.length) list.append(el("p", { class: "lede" }, "Nothing yet. Ask for something and it will show up here."));
  for (const t of shown) {
    const rows = (byTask.get(t.taskId) ?? []).slice().reverse();
    list.append(
      el(
        "div",
        { class: "task" },
        el("div", { class: "task-head" }, el("div", { class: "task-intent" }, t.intent), el("div", { class: "task-time" }, timeAgo(t.startedAt))),
        t.summary ? el("div", { class: "task-summary" }, t.summary) : null,
        ...rows.map((e) =>
          el(
            "div",
            { class: "entry" },
            el("div", { class: `outcome ${e.outcome}` }, e.outcome),
            el("div", {}, el("b", {}, e.capability), " — ", firstLines(e.detail, 1)),
            el("div", { class: "who" }, e.approvedBy === "user" ? "approved by you" : e.approvedBy === "policy" ? "allowed by policy" : ""),
          ),
        ),
      ),
    );
  }
}

/* ---------------- Permissions ---------------- */

async function loadPermissions() {
  const [policy, caps] = await Promise.all([uab.call("policy.get"), uab.call("capabilities")]);

  const roots = $("#roots");
  roots.replaceChildren(
    ...(policy.fileRoots.length
      ? policy.fileRoots.map((r) =>
          el("div", { class: "root" }, el("code", {}, r), el("button", { class: "ghost", onclick: async () => (await uab.call("roots.remove", r), loadPermissions()) }, "Remove")),
        )
      : [el("p", { class: "lede" }, "No folders shared. The AI can't see any of your files.")]),
  );

  const groups = new Map();
  for (const c of caps) {
    if (!groups.has(c.service)) groups.set(c.service, []);
    groups.get(c.service).push(c);
  }
  const box = $("#caps");
  box.replaceChildren();
  for (const [service, list] of groups) {
    box.append(el("div", { class: "service-group" }, serviceName(service)));
    for (const c of list) {
      const current = policy.effective[c.id];
      const seg = el(
        "div",
        { class: "segmented" },
        ...[["allow", "Allow"], ["ask", "Ask"], ["deny", "Block"]].map(([p, label]) =>
          el("button", { "data-p": p, class: current === p ? "on" : "", onclick: async () => (await uab.call("policy.set", c.id, p), loadPermissions()) }, label),
        ),
      );
      box.append(
        el(
          "div",
          { class: "cap" },
          el(
            "div",
            {},
            el("div", { class: "name" }, c.title),
            el("div", { class: "desc" }, c.description.length > 180 ? c.description.slice(0, 180) + "…" : c.description),
            el("div", { class: "facts" }, el("span", { class: `badge ${c.risk}` }, `${c.risk} risk`), ...c.effects.map((x) => el("span", { class: "badge" }, x))),
          ),
          seg,
        ),
      );
    }
  }
}
$("#add-root").addEventListener("click", async () => (await uab.call("roots.add"), loadPermissions()));

/* ---------------- Services ---------------- */

async function loadServices(list) {
  const services = list ?? (await uab.call("services"));
  $("#services-list").replaceChildren(
    ...services.map((s) =>
      el(
        "div",
        { class: "service" },
        el("div", {}, el("div", { class: "name" }, s.title), el("div", { class: "sub" }, `${s.kind === "builtin" ? "Built-in" : "MCP server"} · ${s.capabilityCount} capabilities`, s.error ? ` · ${s.error}` : "")),
        el("div", {}, el("span", { class: `dot ${s.status === "connected" ? "ok" : s.status === "error" ? "bad" : ""}` }), s.status),
      ),
    ),
  );
}
$("#edit-services").addEventListener("click", () => uab.call("services.edit"));
$("#reload-services").addEventListener("click", async (e) => {
  e.target.disabled = true;
  e.target.textContent = "Connecting…";
  try {
    await loadServices(await uab.call("services.reload"));
  } finally {
    e.target.disabled = false;
    e.target.textContent = "Reconnect";
  }
});

/* ---------------- Settings ---------------- */

let settings = null;

async function loadSettings() {
  settings = await uab.call("settings.get");
  setMode(settings.active);
  $("#local-url").value = settings.local.baseUrl;
  $("#local-model").value = settings.local.model;
  $("#cloud-kind").value = settings.cloud.kind;
  $("#cloud-model").value = settings.cloud.model;
  $("#cloud-url").value = settings.cloud.baseUrl ?? "";
  showKind(settings.cloud.kind);
  const has = await uab.call("key.has");
  $("#cloud-key").value = "";
  $("#cloud-key").placeholder = has.present ? "•••••••• saved in Keychain (type to replace)" : "Paste your API key";
  checkLocal();
  if (has.present) checkCloud();
  else setCloudStatus("", "No API key yet.");
}

function showKind(kind) {
  $("#cloud-url-row").classList.toggle("hidden", kind !== "openai-compatible");
  $("#gemini-help").classList.toggle("hidden", kind !== "gemini");
  $("#cloud-model").placeholder = kind === "gemini" ? "Picked automatically" : kind === "anthropic" ? "claude-sonnet-5-5" : "Model name";
}

function setCloudStatus(cls, text) {
  const status = $("#cloud-status");
  status.className = `hint ${cls}`;
  status.textContent = text;
}

/** Confirms the saved key works and fills the model suggestions. */
async function checkCloud() {
  if (settings.cloud.kind === "anthropic") return setCloudStatus("ok", "API key saved.");
  setCloudStatus("", "Checking your key…");
  const r = await uab.call("cloud.models", settings.cloud);
  if (!r.ok) return setCloudStatus("bad", r.error || "Couldn't reach the provider.");
  const shown = r.models.filter((m) => settings.cloud.kind !== "gemini" || /^gemini-/.test(m));
  $("#cloud-models").replaceChildren(...shown.map((m) => el("option", { value: m })));
  setCloudStatus("ok", `Key works. Using ${settings.cloud.model || "the default model"}${shown.length ? ` · ${shown.length} models available` : ""}.`);
}

/** Catch keys that are obviously incomplete or for a different provider before saving them. */
function keyProblem(kind, key) {
  if (kind === "gemini" && !/^AIza[\w-]{30,}$/.test(key)) return "That doesn't look like a Gemini key. They start with \"AIza\" and are 39 characters long. Copy it again from AI Studio.";
  if (kind === "anthropic" && (key.includes("…") || key.includes("...") || key.length < 60))
    return "That looks like the shortened key shown in the Console's key list, not the full key. Create a new key and copy it with the copy button (it's about 100 characters).";
  return null;
}

function setMode(mode) {
  document.querySelectorAll("#model-mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("#local-settings").classList.toggle("hidden", mode !== "local");
  $("#cloud-settings").classList.toggle("hidden", mode !== "cloud");
  if (settings) settings.active = mode;
}

async function checkLocal() {
  const status = $("#local-status");
  status.className = "hint";
  status.textContent = "Checking for a local model server…";
  const r = await uab.call("local.models", $("#local-url").value);
  $("#local-models").replaceChildren(...r.models.map((m) => el("option", { value: m })));
  if (!r.ok) {
    status.className = "hint bad";
    status.textContent = "No local model server found at this address. Install Ollama (ollama.com), then run: ollama pull qwen3:8b";
  } else if (!r.models.length) {
    status.className = "hint bad";
    status.textContent = "The server is running but has no models. Run: ollama pull qwen3:8b";
  } else {
    status.className = "hint ok";
    status.textContent = `Connected. Available: ${r.models.join(", ")}`;
  }
}

document.querySelectorAll("#model-mode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$("#local-url").addEventListener("change", checkLocal);
$("#cloud-kind").addEventListener("change", () => {
  showKind($("#cloud-kind").value);
  $("#cloud-model").value = "";
  $("#cloud-models").replaceChildren();
});
$("#save-settings").addEventListener("click", async (e) => {
  settings.local = { baseUrl: $("#local-url").value.trim() || "http://localhost:11434/v1", model: $("#local-model").value.trim() || "qwen3:8b" };
  settings.cloud = { kind: $("#cloud-kind").value, model: $("#cloud-model").value.trim(), baseUrl: $("#cloud-url").value.trim() || undefined };
  const key = $("#cloud-key").value.trim();
  const problem = key ? keyProblem(settings.cloud.kind, key) : null;
  if (problem) return setCloudStatus("bad", problem);
  if (key) await uab.call("key.set", key);
  e.target.disabled = true;
  try {
    const { model } = await uab.call("settings.set", settings);
    $("#model-label").textContent = model;
    e.target.textContent = "Saved";
    setTimeout(() => (e.target.textContent = "Save"), 1200);
    await loadSettings();
  } finally {
    e.target.disabled = false;
  }
});
$("#open-home").addEventListener("click", () => uab.call("openHome"));

/* ---------------- events from the host ---------------- */

uab.on((channel, payload) => {
  if (channel === "gateway") onGateway(payload);
  else if (channel === "approval.requested") showApproval(payload);
  else if (channel === "approval.resolved") onApprovalResolved(payload);
  else if (channel === "audit.appended" && $("#view-activity").classList.contains("active")) loadActivity();
  else if (channel === "services.changed") loadServices(payload);
});

/* ---------------- start ---------------- */

(async () => {
  const hello = await uab.call("hello");
  $("#identity").textContent = `${hello.identity.displayName} · kernel ${hello.version}`;
  $("#model-label").textContent = hello.model;
  $("#home-path").textContent = hello.home;
  for (const req of await uab.call("approvals.pending")) showApproval(req);
  input.focus();
})();
