// Renderer. Everything that comes from a model or a service is inserted as
// text, never as HTML.
import { renderAnswer } from "./answer.js";

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

const SERVICE_NAMES = { files: "Files", contacts: "Contacts", mail: "Apple Mail", gmail: "Gmail", calendar: "Calendar", reminders: "Reminders", web: "Web & weather", browser: "Built-in browser", system: "This computer" };
// Titles of connected services (e.g. "Zomato"), kept up to date from the kernel.
const serviceTitles = new Map();
const serviceName = (id) => serviceTitles.get(id) ?? SERVICE_NAMES[id] ?? id.replace(/^mcp\./, "");
function rememberServices(list) {
  for (const s of list) serviceTitles.set(s.id, s.title.replace(/ \(.*\)$/, ""));
}

// What an action does, in plain words.
const EFFECT_WORDS = { read: "Only looks", write: "Changes something", send: "Sends or orders", delete: "Deletes something", spend: "Spends money", device: "Uses this Mac" };
const RISK_WORDS = { low: "Low risk", medium: "Medium risk", high: "High risk" };
function effectBadges(cap) {
  const effects = cap.effects.includes("read") && cap.effects.length > 1 ? cap.effects.filter((x) => x !== "read") : cap.effects;
  return [el("span", { class: `badge ${cap.risk}` }, RISK_WORDS[cap.risk] ?? cap.risk), ...effects.map((x) => el("span", { class: "badge" }, EFFECT_WORDS[x] ?? x))];
}

/* ---------------- navigation ---------------- */

const loaders = { you: loadYou, activity: loadActivity, permissions: loadPermissions, services: loadServices, settings: loadSettings };
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

const scroller = $("#scroller");
function scrollDown() {
  scroller.scrollTop = scroller.scrollHeight;
}

/** An answer as a document: Markdown plus the visual blocks the AI adds. */
const answer = (text) =>
  el("div", { class: "answer" }, renderAnswer(text, { openLink: (url) => uab.call("browser.open", url), ask: (prompt) => !current && submit(prompt) }));

function setBusy(busy) {
  $("#send").disabled = busy;
  $("#send").classList.toggle("hidden", busy);
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
  transcript.append(container);
  current = { container, actions: new Map(), files: [], question: text };
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
/** Things to try, based on what's connected right now. */
function loadSuggestions(services) {
  const on = new Set(services.filter((s) => s.status === "connected").map((s) => s.id));
  const ideas = [
    on.has("mcp.zomato") && "Find good biryani places near me on Zomato",
    on.has("calendar") && "What's on my calendar tomorrow?",
    on.has("gmail") && "Any important emails today?",
    on.has("reminders") && "Remind me to call the bank tomorrow at 10am",
    on.has("web") && "What's the weather this weekend?",
    on.has("files") && "What did I save in Downloads this week?",
    ...services.filter((s) => s.kind === "mcp" && s.status === "connected" && s.id !== "mcp.zomato").map((s) => `What can you do with ${s.title}?`),
  ].filter(Boolean);
  $("#suggestions")?.replaceChildren(...ideas.slice(0, 4).map((text) => el("button", { class: "suggestion", onclick: () => submit(text) }, el("span", { class: "suggestion-icon" }, iconFor(text)), el("span", {}, text))));
  lastServices = services;
}
let lastServices = [];
const iconFor = (text) =>
  /zomato|biryani|food|restaurant/i.test(text) ? "🍽️" : /calendar/i.test(text) ? "📅" : /email/i.test(text) ? "✉️" : /remind/i.test(text) ? "⏰" : /weather/i.test(text) ? "🌦️" : /download|file/i.test(text) ? "📁" : "✨";

/** The start screen: a greeting by name (from You) and things to try. */
async function emptyState() {
  const node = el(
    "div",
    { class: "empty", id: "ask-empty" },
    el("div", { class: "greeting", id: "greeting" }, "Hello"),
    el("p", { class: "greeting-sub" }, "Say what you'd like done, in your own words. Everyday things happen straight away; anything that sends, changes, orders or deletes asks you first."),
    el("div", { class: "suggestions", id: "suggestions" }),
  );
  transcript.replaceChildren(node);
  loadSuggestions(lastServices);
  await setGreeting();
}
async function setGreeting() {
  const h = new Date().getHours();
  const part = h < 5 ? "Hello" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const name = (await uab.call("context.get").catch(() => null))?.profile?.name;
  const g = $("#greeting");
  if (g) g.textContent = name ? `${part}, ${name.split(" ")[0]}` : part;
}
$("#stop").addEventListener("click", () => uab.call("stop"));
$("#new-conversation").addEventListener("click", async () => {
  if (current) return;
  await uab.call("conversation.new");
  currentConversation = null;
  emptyState();
  loadConversations();
  showView("ask");
  input.focus();
});

/* ---------------- Past conversations ---------------- */

let currentConversation = null;

async function loadConversations() {
  const list = await uab.call("conversation.list");
  $("#conv-list").replaceChildren(
    ...list.map((c) =>
      el(
        "div",
        { class: `conv ${c.id === currentConversation ? "active" : ""}`, title: `${c.title}\n${timeAgo(c.updatedAt)} · ${c.turnCount} ${c.turnCount === 1 ? "question" : "questions"}` },
        el("button", { class: "conv-open", onclick: () => openConversation(c.id) }, c.title),
        el(
          "button",
          {
            class: "conv-delete",
            title: "Delete this conversation",
            onclick: async () => {
              if (!confirm(`Delete "${c.title}"? This removes it from this Mac. The Activity history keeps its record of the actions.`)) return;
              const { currentId } = await uab.call("conversation.delete", c.id);
              if (!currentId && currentConversation === c.id) {
                currentConversation = null;
                emptyState();
              }
              loadConversations();
            },
          },
          "×",
        ),
      ),
    ),
  );
}

async function openConversation(id) {
  if (current) return alert("Wait for the current request to finish, or stop it.");
  try {
    showConversation(await uab.call("conversation.open", id));
    showView("ask");
  } catch (err) {
    alert(cleanError(err));
    loadConversations();
  }
}

/** Draw a saved conversation the way it looked: questions, steps and answers. */
function showConversation(c) {
  currentConversation = c.id;
  transcript.replaceChildren(
    el("div", { class: "conv-intro" }, `${c.title} · started ${timeAgo(c.createdAt)}`),
    ...c.turns.flatMap((t) => [
      el("div", { class: "turn-user" }, t.question),
      el(
        "div",
        { class: "turn-ai" },
        t.error ? el("div", { class: "error" }, t.error) : null,
        t.answer && !t.error ? answer(t.answer) : null,
        summaryLine(
          { model: t.model, locality: t.locality, taskId: t.taskId },
          t.steps.map((s) => ({
            service: s.service,
            status: s.status,
            approvedBy: s.meta === "You approved" ? "user" : undefined,
            // Older saves called kernel rejections "Blocked" too; those say what was invalid.
            by: s.meta === "You declined" ? "user" : s.meta === "Blocked" && !/^(Invalid|Unknown)/.test(s.detail) ? "policy" : s.status === "denied" ? "kernel" : undefined,
          })),
        ),
      ),
    ]),
  );
  loadConversations();
  scrollDown();
}

function showView(name) {
  document.querySelectorAll(".nav").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
}

function onGateway(e) {
  if (!current) return;
  if (e.type === "task") {
    current.meta = { model: e.model, locality: e.locality, taskId: e.taskId };
    current.working = el("div", { class: "working" }, el("span", { class: "spinner" }), el("span", { class: "working-text" }, "Working on it…"));
    current.container.append(current.working);
  } else if (e.type === "thinking") {
    setWorking("Thinking…");
  } else if (e.type === "proposal") {
    current.actions.set(e.callId, { service: e.capability.service, status: "pending" });
    setWorking(`${e.capability.title} (${serviceName(e.capability.service)})…`);
  } else if (e.type === "decision") {
    const a = current.actions.get(e.callId);
    if (a) (a.status = e.decision.status), (a.approvedBy = e.decision.approvedBy), (a.by = e.decision.by);
    // "Show in Finder" is still useful in the chat when a step made a file.
    const file = e.decision.status === "executed" && e.decision.result.data?.file;
    if (file) current.files.push(file);
  } else if (e.type === "error") {
    current.error = e.message;
  } else if (e.type === "done") {
    current.working?.remove();
    const { container, meta, actions, files, error } = current;
    if (error) container.append(el("div", { class: "error" }, error));
    else container.append(answer(e.text));
    for (const file of files) container.append(el("button", { class: "link", onclick: () => uab.call("reveal", file) }, "Show the file in Finder"));
    container.append(summaryLine(meta, [...actions.values()]));
    current = null;
    setBusy(false);
  }
  scrollDown();
}

function setWorking(text) {
  const node = current?.working?.querySelector(".working-text");
  if (node) node.textContent = text;
}

/**
 * One quiet line under an answer: which model, which services it used, and how
 * many actions. The step-by-step record lives in Activity.
 */
function summaryLine(meta, all) {
  // The kernel turning down a malformed proposal is the AI's own mistake, which it corrects; not worth showing.
  const actions = all.filter((a) => !(a.status === "denied" && a.by === "kernel"));
  const services = [...new Set(actions.map((a) => serviceName(a.service)))];
  const declined = actions.filter((a) => a.status === "denied" && a.by === "user").length;
  const blocked = actions.filter((a) => a.status === "denied" && a.by === "policy").length;
  const failed = actions.filter((a) => a.status === "failed").length;
  const approved = actions.filter((a) => a.approvedBy === "user").length;
  const parts = [
    meta?.model ? `${meta.locality === "cloud" ? "☁ " : ""}${meta.model}` : null,
    services.length ? `Used ${services.slice(0, 3).join(", ")}${services.length > 3 ? ` +${services.length - 3}` : ""}` : null,
    actions.length ? `${actions.length} ${actions.length === 1 ? "action" : "actions"}` : null,
    approved ? `${approved} approved by you` : null,
    declined ? `${declined} declined by you` : null,
    blocked ? `${blocked} blocked by your permissions` : null,
    failed ? `${failed} didn't work` : null,
  ].filter(Boolean);
  return el(
    "div",
    { class: "summary-line" },
    parts.join(" · "),
    actions.length && meta?.taskId ? el("button", { class: "link", onclick: () => openActivity(meta.taskId) }, "Details") : null,
  );
}

/**
 * Plain text with the bits of Markdown models use: **bold**, [label](link) and
 * bare links. Built from DOM nodes, never HTML, so nothing in a model's or a
 * web page's text can run in this window. Links open in the built-in browser.
 */
function richText(text) {
  const frag = document.createDocumentFragment();
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?])|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const m of String(text ?? "").matchAll(pattern)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[4]) frag.append(el("b", {}, m[4]));
    else {
      const url = (m[2] ?? m[3]).replace(/[?&]utm_source=openai$/, "");
      const label = m[1] ?? new URL(url).hostname.replace(/^www\./, "");
      frag.append(el("a", { href: "#", title: url, onclick: (ev) => (ev.preventDefault(), uab.call("browser.open", url)) }, label));
    }
    last = m.index + m[0].length;
  }
  if (last < String(text ?? "").length) frag.append(String(text).slice(last));
  return frag;
}

function firstLines(text, n) {
  const lines = String(text ?? "").split("\n");
  return lines.slice(0, n).join("\n") + (lines.length > n ? `\n… ${lines.length - n} more lines` : "");
}

/* ---------------- Kernel approvals ---------------- */

const approvalNodes = new Map();

function showApproval(req) {
  if (approvalNodes.has(req.approvalId)) return;
  // Requests from other AI apps can come at any time: bring the Ask screen forward.
  if (req.source === "agent") showView("ask");
  const cap = req.capability;
  const node = el(
    "div",
    { class: "approval" },
    el("div", { class: "who" }, `${serviceName(cap.service)} · needs your OK`),
    el("div", { class: "summary" }, req.summary),
    el("div", { class: "facts" }, ...effectBadges(cap), el("span", { class: "badge" }, `Suggested by ${req.model ?? req.source}`)),
    req.reason ? el("div", { class: "reason" }, "The AI's reason (not verified): ", req.reason) : null,
    el("details", {}, el("summary", {}, "Exact details"), el("pre", {}, JSON.stringify(req.args, null, 2))),
    el(
      "div",
      { class: "actions" },
      el("button", { class: "primary", onclick: () => resolveApproval(req.approvalId, true) }, "Allow"),
      el("button", { class: "ghost", onclick: () => resolveApproval(req.approvalId, false) }, "Decline"),
      // Never offered for high-risk actions (sending, paying, deleting): those always ask.
      cap.risk !== "high"
        ? el("button", { class: "link always", title: `Change ${cap.title} to Allow in Permissions`, onclick: async () => (await uab.call("policy.set", cap.id, "allow"), resolveApproval(req.approvalId, true)) }, `Always allow "${cap.title}"`)
        : null,
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
  // Answered: the card goes away; the summary under the answer and Activity keep the record.
  approvalNodes.delete(approvalId);
  node.remove();
}

/* ---------------- You ---------------- */

const PROFILE_FIELDS = ["name", "city", "address", "language", "about"];
let previewCloud = true;

async function loadYou() {
  const { profile, memories } = await uab.call("context.get");
  for (const f of PROFILE_FIELDS) $(`#p-${f}`).value = profile[f] ?? "";
  $("#memories").replaceChildren(
    ...(memories.length
      ? memories
          .slice()
          .reverse()
          .map((m) =>
            el(
              "div",
              { class: "service" },
              el("div", {}, el("div", { class: "name" }, m.text), el("div", { class: "sub" }, `${m.source === "ai" ? "Suggested by the AI, approved by you" : "Added by you"} · ${timeAgo(m.createdAt)}`)),
              el("div", { class: "service-actions" }, el("button", { class: "ghost small", onclick: async () => (await uab.call("context.removeMemory", m.id), loadYou()) }, "Forget")),
            ),
          )
      : [el("p", { class: "hint" }, "Nothing yet.")]),
  );
  const { text } = await uab.call("context.preview", previewCloud);
  $("#context-preview").textContent = text || "Nothing yet. Fill in About you or add something to remember.";
}
$("#p-save").addEventListener("click", async () => {
  const profile = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, $(`#p-${f}`).value]));
  try {
    await uab.call("context.setProfile", profile);
    $("#p-status").className = "hint ok";
    $("#p-status").textContent = "Saved.";
    setTimeout(() => ($("#p-status").textContent = ""), 1500);
    loadYou();
  } catch (err) {
    $("#p-status").className = "hint bad";
    $("#p-status").textContent = cleanError(err);
  }
});
$("#memory-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#memory-text").value.trim();
  if (!text) return;
  await uab.call("context.addMemory", text);
  $("#memory-text").value = "";
  loadYou();
});
document.querySelectorAll("#preview-mode button").forEach((b) =>
  b.addEventListener("click", () => {
    previewCloud = b.dataset.cloud === "1";
    document.querySelectorAll("#preview-mode button").forEach((x) => x.classList.toggle("on", x === b));
    loadYou();
  }),
);

/* ---------------- Activity ---------------- */

/** An answer as one plain line: no visual blocks, code or Markdown marks. */
const plainSummary = (text) =>
  String(text)
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Show one request's step-by-step record in Activity. */
async function openActivity(taskId) {
  showView("activity");
  await loadActivity();
  const node = document.getElementById(`task-${taskId}`);
  if (!node) return;
  node.scrollIntoView({ block: "start", behavior: "smooth" });
  node.classList.add("highlight");
  setTimeout(() => node.classList.remove("highlight"), 2500);
}

async function loadActivity() {
  const [tasks, entries, verify, caps] = await Promise.all([uab.call("tasks"), uab.call("audit"), uab.call("audit.verify"), uab.call("capabilities")]);
  const titles = new Map(caps.map((c) => [c.id, `${serviceName(c.service)}: ${c.title}`]));
  const OUTCOME_WORDS = { executed: "done", denied: "declined", failed: "failed" };
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
        { class: "task", id: `task-${t.taskId}` },
        el("div", { class: "task-head" }, el("div", { class: "task-intent" }, t.intent), el("div", { class: "task-time" }, timeAgo(t.startedAt))),
        t.summary ? el("div", { class: "task-summary" }, plainSummary(t.summary)) : null,
        ...rows.map((e) =>
          el(
            "div",
            { class: "entry" },
            el("div", { class: `outcome ${e.outcome}` }, OUTCOME_WORDS[e.outcome] ?? e.outcome),
            el("div", {}, el("b", {}, titles.get(e.capability) ?? e.capability), " — ", firstLines(e.detail, 1)),
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
    const asking = list.filter((c) => policy.effective[c.id] === "ask").length;
    const group = el(
      "details",
      { class: "service-group", open: openGroups.has(service) ? true : undefined, ontoggle: (e) => (e.target.open ? openGroups.add(service) : openGroups.delete(service)) },
      el(
        "summary",
        {},
        el("span", { class: "group-name" }, serviceName(service)),
        el("span", { class: "hint" }, `${list.length} ${list.length === 1 ? "action" : "actions"}${asking ? ` · ${asking} ask first` : ""}`),
      ),
    );
    box.append(group);
    for (const c of list) {
      const current = policy.effective[c.id];
      const seg = el(
        "div",
        { class: "segmented" },
        ...[["allow", "Allow"], ["ask", "Ask"], ["deny", "Block"]].map(([p, label]) =>
          el("button", { "data-p": p, class: current === p ? "on" : "", onclick: async () => (await uab.call("policy.set", c.id, p), loadPermissions()) }, label),
        ),
      );
      group.append(
        el(
          "div",
          { class: "cap" },
          el(
            "div",
            {},
            el("div", { class: "name" }, c.title),
            el("div", { class: "desc" }, c.description.length > 180 ? c.description.slice(0, 180) + "…" : c.description),
            el("div", { class: "facts" }, ...effectBadges(c)),
          ),
          seg,
        ),
      );
    }
  }
}
// Which service groups are expanded; remembered while the app is open.
const openGroups = new Set(["files"]);
$("#add-root").addEventListener("click", async () => (await uab.call("roots.add"), loadPermissions()));

/* ---------------- Services ---------------- */

async function loadServices(list) {
  loadGmail();
  const services = list ?? (await uab.call("services"));
  rememberServices(services);
  $("#services-list").replaceChildren(
    ...services.map((s) =>
      el(
        "div",
        { class: "service" },
        el("div", {}, el("div", { class: "name" }, s.title), el("div", { class: "sub" }, `${s.kind === "builtin" ? "Built-in" : s.online ? "Online service" : "Program on this Mac"} · ${s.capabilityCount} ${s.capabilityCount === 1 ? "action" : "actions"}`, s.error ? ` · ${s.error}` : "")),
        el(
          "div",
          { class: "service-actions" },
          el("span", { class: `dot ${s.status === "connected" ? "ok" : s.status === "error" ? "bad" : ""}` }),
          s.status === "signin" ? (s.signingIn ? "waiting for sign-in…" : "not signed in") : s.status,
          s.online && (s.status === "signin" || s.status === "error") ? signInButton(s) : null,
          s.online && s.signedIn ? el("button", { class: "ghost small", onclick: () => uab.call("services.signOut", s.id).then(loadServices) }, "Sign out") : null,
          s.kind === "mcp"
            ? el("button", { class: "ghost small", onclick: async () => confirm(`Remove ${s.title}? The AI won't be able to use it, and its sign-in is forgotten.`) && loadServices(await uab.call("services.remove", s.id)) }, "Remove")
            : null,
        ),
      ),
    ),
  );
}
function signInButton(s) {
  const b = el("button", { class: "primary small" }, s.signingIn ? "Start sign-in again" : "Sign in");
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await uab.call("services.signIn", s.id);
    } catch (err) {
      alert(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      b.disabled = false;
    }
  });
  return b;
}
async function loadGmail() {
  const s = await uab.call("gmail.status");
  const state = $("#gmail-state");
  $("#gmail-setup").classList.toggle("hidden", s.configured && !showGmailSetup);
  $("#gmail-connect").classList.toggle("hidden", !s.configured || s.connected);
  $("#gmail-disconnect").classList.toggle("hidden", !s.connected);
  // Never a dead end: if Google shows an error page it never comes back, so let the user start over.
  $("#gmail-connect").textContent = s.connecting ? "Start sign-in again" : "Connect Gmail";
  state.className = `hint ${s.connected ? "ok" : ""}`;
  state.textContent = s.connected
    ? `Connected as ${s.email}. The AI can search, read, draft and send (sending always asks first).`
    : s.connecting
      ? "Finish signing in in your browser, then come back here. If Google showed an error, fix it and click \"Start sign-in again\"."
      : s.configured
        ? "Ready to connect. You'll sign in on Google's own page."
        : "Not set up yet.";
}
let showGmailSetup = false;

$("#gmail-save").addEventListener("click", async () => {
  const status = $("#gmail-setup-status");
  try {
    await uab.call("gmail.configure", $("#gmail-client-id").value, $("#gmail-client-secret").value);
    $("#gmail-client-secret").value = "";
    status.className = "hint ok";
    status.textContent = "Saved.";
    showGmailSetup = false;
    loadGmail();
  } catch (err) {
    status.className = "hint bad";
    status.textContent = String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  }
});
$("#gmail-connect").addEventListener("click", async () => {
  await uab.call("gmail.connect").catch((err) => alert(err.message));
  loadGmail();
});
$("#gmail-disconnect").addEventListener("click", async () => {
  await uab.call("gmail.disconnect");
  loadGmail();
});
$("#gmail-guide").addEventListener("click", () => uab.call("gmail.guide"));

$("#edit-services").addEventListener("click", () => uab.call("services.edit"));
$("#reload-services").addEventListener("click", async (e) => {
  e.target.disabled = true;
  e.target.textContent = "Connecting…";
  try {
    await loadServices(await uab.call("services.reload"));
  } finally {
    e.target.disabled = false;
    e.target.textContent = "Reconnect all";
  }
});
$("#svc-add").addEventListener("click", async () => {
  const status = $("#svc-status");
  try {
    await uab.call("services.add", { name: $("#svc-name").value, url: $("#svc-url").value, command: $("#svc-command").value });
    for (const id of ["#svc-name", "#svc-url", "#svc-command"]) $(id).value = "";
    status.className = "hint ok";
    status.textContent = "Added. It appears in the list above in a moment; if it needs a sign-in, click Sign in there.";
  } catch (err) {
    status.className = "hint bad";
    status.textContent = cleanError(err);
  }
});
const cleanError = (err) => String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

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
  loadVault();
  loadAgents();
  loadPhone();
  $("#update-toggle").checked = updatesOn();
  if (updatesOn()) checkUpdates(true);
  if (settings.cloud.kind === "chatgpt") loadChatGPT();
  else if (has.present) checkCloud();
  else setCloudStatus("", "No API key yet.");
}

/** Approving from a phone on the same Wi-Fi. */
async function loadPhone(s) {
  s ??= await uab.call("phone.status");
  $("#phone-toggle").checked = s.enabled;
  $("#phone-box").classList.toggle("hidden", !s.enabled);
  if (!s.enabled) return;
  if (s.qr) $("#phone-qr").src = s.qr;
  $("#phone-qr").classList.toggle("hidden", !s.qr);
  $("#phone-status").textContent = !s.listening
    ? "Couldn't start. Try turning it off and on."
    : !s.url
      ? "This Mac isn't on a network right now."
      : s.lastSeen
        ? `Your phone last checked in ${timeAgo(s.lastSeen)}.`
        : "Waiting for your phone to open it.";
}
$("#phone-toggle").addEventListener("change", async (e) => {
  try {
    loadPhone(await uab.call("phone.enable", e.target.checked));
  } catch (err) {
    e.target.checked = false;
    alert(cleanError(err));
  }
});
$("#phone-rotate").addEventListener("click", async () => {
  if (!confirm("Make a new pairing key? Your phone will need to scan the new QR code.")) return;
  loadPhone(await uab.call("phone.rotate"));
});

/** Other AI apps acting through Neural. */
async function loadAgents() {
  const s = await uab.call("agents.status");
  $("#agents-toggle").checked = s.enabled;
  $("#agents-box").classList.toggle("hidden", !s.enabled);
  if (!s.enabled) return;
  $("#agents-confirm").checked = s.confirmInApp;
  $("#agents-status").textContent = !s.listening ? "Couldn't open the connection. Try turning it off and on." : s.connected.length ? `Connected now: ${s.connected.join(", ")}` : "Ready. No app connected right now.";
  // The key is shown masked; Copy setup puts the full config on the clipboard.
  const { config } = await uab.call("agents.setup");
  $("#agents-config").textContent = config.replace(/("NEURAL_PAIRING_KEY": ")([^"]{4})[^"]*/, "$1$2••••••••");
}
$("#agents-toggle").addEventListener("change", async (e) => {
  try {
    await uab.call("agents.enable", e.target.checked);
  } catch (err) {
    e.target.checked = false;
    $("#agents-box").classList.remove("hidden");
    $("#agents-status").textContent = `Couldn't turn it on: ${cleanError(err)}`;
    return;
  }
  loadAgents();
});
$("#agents-confirm").addEventListener("change", async (e) => {
  await uab.call("agents.confirmInApp", e.target.checked);
});
$("#agents-copy").addEventListener("click", async () => {
  await uab.call("agents.copy");
  $("#agents-note").textContent = "Copied. Paste it into the other app's MCP config.";
});
$("#agents-rotate").addEventListener("click", async () => {
  if (!confirm("Make a new pairing key? Apps set up with the old one will stop connecting until you paste the new setup.")) return;
  await uab.call("agents.setup", true);
  $("#agents-note").textContent = "New key made. Copy the setup again.";
  loadAgents();
});

async function loadVault() {
  const items = await uab.call("vault.list");
  $("#vault-list").replaceChildren(
    ...(items.length
      ? items.map((item) =>
          el(
            "div",
            { class: "service" },
            el("div", {}, el("div", { class: "name" }, item.label), el("div", { class: "sub" }, "Saved in Keychain")),
            el(
              "div",
              { class: "service-actions" },
              el("button", { class: "ghost small", onclick: async () => confirm(`Remove "${item.label}"? You'll need to sign in or paste it again to use it.`) && (await uab.call("vault.remove", item.name), loadVault()) }, "Remove"),
            ),
          ),
        )
      : [el("p", { class: "hint" }, "Nothing saved yet.")]),
  );
}

function showKind(kind) {
  $("#cloud-url-row").classList.toggle("hidden", kind !== "openai-compatible");
  $("#gemini-help").classList.toggle("hidden", kind !== "gemini");
  $("#chatgpt-box").classList.toggle("hidden", kind !== "chatgpt");
  // ChatGPT signs in instead of using a key.
  $("#cloud-key").closest("label").classList.toggle("hidden", kind === "chatgpt");
  $("#cloud-model").placeholder = kind === "gemini" || kind === "chatgpt" ? "Picked automatically" : kind === "anthropic" ? "claude-sonnet-5-5" : "Model name";
  if (kind === "chatgpt") loadChatGPT();
}

/** Sign-in state and, once signed in, the models this ChatGPT account may use. */
async function loadChatGPT() {
  const s = await uab.call("chatgpt.status");
  const state = $("#chatgpt-state");
  $("#chatgpt-connect").classList.toggle("hidden", s.connected);
  $("#chatgpt-disconnect").classList.toggle("hidden", !s.connected);
  $("#chatgpt-connect").textContent = s.connecting ? "Start sign-in again" : "Sign in with ChatGPT";
  state.className = `hint ${s.connected ? "ok" : s.error ? "bad" : ""}`;
  state.textContent = s.connected
    ? `Signed in${s.email ? ` as ${s.email}` : ""}.`
    : s.connecting
      ? "Finish signing in in your browser, then come back here."
      : (s.error ?? "Not signed in.");
  setCloudStatus("", "");
  if (!s.connected) return;
  try {
    const models = await uab.call("chatgpt.models");
    $("#cloud-models").replaceChildren(...models.map((m) => el("option", { value: m.slug, label: m.name })));
    setCloudStatus("ok", `${models.length} models available: ${models.map((m) => m.name).join(", ")}. Leave Model empty to use ${models[0]?.name ?? "the default"}.`);
  } catch (err) {
    setCloudStatus("bad", String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
  }
}

$("#chatgpt-connect").addEventListener("click", async () => {
  await uab.call("chatgpt.connect").catch((err) => alert(err.message));
  loadChatGPT();
});
$("#chatgpt-disconnect").addEventListener("click", async () => {
  await uab.call("chatgpt.disconnect");
  loadChatGPT();
});

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
  $("#builtin-settings").classList.toggle("hidden", mode !== "builtin");
  $("#local-settings").classList.toggle("hidden", mode !== "local");
  $("#cloud-settings").classList.toggle("hidden", mode !== "cloud");
  if (settings) settings.active = mode;
  if (mode === "builtin") checkBuiltin();
}

async function checkBuiltin() {
  const status = $("#builtin-status");
  const r = await uab.call("builtin.status");
  status.className = `hint ${r.available ? "ok" : "bad"}`;
  status.textContent = r.available ? "Ready." : r.reason || "Not available on this computer.";
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
  if (settings) settings.cloud.kind = $("#cloud-kind").value;
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
  if (key) await uab.call("key.set", key, settings.cloud);
  e.target.disabled = true;
  if (settings.active === "cloud" && settings.cloud.kind === "gemini") {
    e.target.textContent = "Testing models…";
    setCloudStatus("", "Testing which Gemini models are answering right now…");
  }
  try {
    const { model, working } = await uab.call("settings.set", settings);
    $("#model-label").textContent = model;
    $("#model-hint").textContent = model;
    e.target.textContent = "Saved";
    setTimeout(() => (e.target.textContent = "Save"), 1200);
    await loadSettings();
    if (working) {
      if (working.length) setCloudStatus("ok", `Working now: ${working.join(", ")}. Using ${settings.cloud.model}; the others are backups.`);
      else setCloudStatus("bad", "No Gemini model answered. Your free quota may be used up for today, or Google is busy. Try again later.");
    }
  } finally {
    e.target.disabled = false;
  }
});
$("#open-home").addEventListener("click", () => uab.call("openHome"));

/* ---------------- Built-in browser ---------------- */

const browserHost = $("#browser-host");

function sendBrowserBounds() {
  const r = browserHost.getBoundingClientRect();
  uab.call("browser.bounds", { x: r.left, y: r.top, width: r.width, height: r.height });
}
new ResizeObserver(sendBrowserBounds).observe(browserHost);
window.addEventListener("resize", sendBrowserBounds);

function onBrowserState(s) {
  $(".app").classList.toggle("with-browser", s.open);
  $("#browser-panel").classList.toggle("hidden", !s.open);
  if (!s.open) return;
  const urlBox = $("#browser-url");
  if (document.activeElement !== urlBox) urlBox.value = s.url;
  urlBox.classList.toggle("loading", s.loading);
  $("#browser-back").disabled = !s.canGoBack;
  $("#browser-forward").disabled = !s.canGoForward;
  requestAnimationFrame(sendBrowserBounds);
}

// Clicking anywhere in the app (not the page panel) gives the keyboard back to the app.
document.addEventListener("mousedown", () => uab.call("app.focus"), true);

$("#browser-form").addEventListener("submit", (e) => {
  e.preventDefault();
  uab.call("browser.go", $("#browser-url").value);
  $("#browser-url").blur();
});
$("#browser-back").addEventListener("click", () => uab.call("browser.back"));
$("#browser-forward").addEventListener("click", () => uab.call("browser.forward"));
$("#browser-reload").addEventListener("click", () => uab.call("browser.reload"));
$("#browser-external").addEventListener("click", () => uab.call("browser.external"));
$("#browser-close").addEventListener("click", () => uab.call("browser.close"));
$("#open-browser").addEventListener("click", () => uab.call("browser.go", "https://www.google.com"));

/* ---------------- events from the host ---------------- */

uab.on((channel, payload) => {
  if (channel === "gateway") onGateway(payload);
  else if (channel === "approval.requested") showApproval(payload);
  else if (channel === "approval.resolved") onApprovalResolved(payload);
  else if (channel === "audit.appended" && $("#view-activity").classList.contains("active")) loadActivity();
  else if (channel === "audit.appended" && $("#view-you").classList.contains("active")) loadYou();
  else if (channel === "services.changed") (rememberServices(payload), loadServices(payload), loadSuggestions(payload));
  else if (channel === "chatgpt.changed" && settings?.cloud.kind === "chatgpt") loadChatGPT();
  else if (channel === "browser.state") onBrowserState(payload);
  else if (channel === "conversations.changed") (currentConversation = payload.currentId), loadConversations();
});

/* ---------------- New versions ---------------- */

const updatesOn = () => {
  try {
    return localStorage.getItem("neural.updates") !== "off";
  } catch {
    return true;
  }
};
async function checkUpdates(manual = false) {
  if (!manual && !updatesOn()) return;
  const r = await uab.call("update.check").catch(() => null);
  const notice = $("#update-notice");
  notice.classList.toggle("hidden", !r?.latest);
  if (r?.latest) notice.replaceChildren(el("strong", {}, `Neural ${r.latest} is available`), el("span", {}, "Download the new version"));
  $("#update-status").textContent = r ? (r.latest ? `Version ${r.latest} is available (you have ${r.current}).` : `You have the latest version (${r.current}).`) : "Couldn't check right now.";
}
$("#update-notice").addEventListener("click", () => uab.call("update.open"));
$("#update-toggle").addEventListener("change", (e) => {
  try {
    localStorage.setItem("neural.updates", e.target.checked ? "on" : "off");
  } catch {}
  if (e.target.checked) checkUpdates(true);
  else $("#update-notice").classList.add("hidden");
});
setInterval(checkUpdates, 12 * 3600 * 1000);

/* ---------------- First-launch welcome ---------------- */

const welcome = $("#welcome");
function welcomeStep(n) {
  welcome.querySelectorAll(".welcome-step").forEach((s) => s.classList.toggle("hidden", Number(s.dataset.step) !== n));
  welcome.querySelectorAll(".welcome-dots span").forEach((d, i) => d.classList.toggle("on", i === n));
  welcome.dataset.step = String(n);
}
function finishWelcome() {
  try {
    localStorage.setItem("neural.welcomed", "1");
  } catch {}
  welcome.classList.add("hidden");
  setGreeting();
  input.focus();
}
async function maybeWelcome() {
  let seen = false;
  try {
    seen = localStorage.getItem("neural.welcomed") === "1";
  } catch {}
  if (seen) return;
  welcomeStep(0);
  welcome.classList.remove("hidden");
  const r = await uab.call("builtin.status").catch(() => ({ available: false }));
  $("#welcome-builtin").textContent = r.available ? "Ready on this Mac." : r.reason || "Not available on this Mac.";
  welcome.querySelector('[data-model="builtin"]').disabled = !r.available;
}
welcome.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.hasAttribute("data-next")) welcomeStep(Number(welcome.dataset.step) + 1);
  else if (t.hasAttribute("data-skip") || t.hasAttribute("data-done")) finishWelcome();
});
welcome.querySelectorAll("[data-model]").forEach((b) =>
  b.addEventListener("click", async () => {
    const choice = b.dataset.model;
    if (choice !== "later") {
      const s = await uab.call("settings.get");
      s.active = choice === "builtin" ? "builtin" : "cloud";
      if (choice === "chatgpt") s.cloud = { ...s.cloud, kind: "chatgpt", model: "" };
      const { model } = await uab.call("settings.set", s);
      $("#model-label").textContent = model;
      $("#model-hint").textContent = model;
      // ChatGPT: sign in on OpenAI's page in the browser; the kernel keeps the sign-in.
      if (choice === "chatgpt") uab.call("chatgpt.connect").catch(() => {});
    }
    welcomeStep(2);
  }),
);
$("#w-save").addEventListener("click", async () => {
  const name = $("#w-name").value.trim();
  const city = $("#w-city").value.trim();
  if (name || city) {
    const { profile } = await uab.call("context.get");
    await uab.call("context.setProfile", { ...profile, ...(name && { name }), ...(city && { city }) });
  }
  welcomeStep(3);
});
$("#w-folders").addEventListener("click", async () => {
  await uab.call("roots.add").catch(() => {});
  welcomeStep(4);
});

/* ---------------- start ---------------- */

(async () => {
  const hello = await uab.call("hello");
  $("#identity").textContent = `${hello.identity.displayName} · kernel ${hello.version}`;
  $("#model-label").textContent = hello.model;
  $("#model-hint").textContent = hello.model;
  setGreeting();
  $("#home-path").textContent = hello.home;
  const services = await uab.call("services");
  rememberServices(services);
  loadSuggestions(services);
  const last = await uab.call("conversation.current");
  if (last) showConversation(last);
  else loadConversations();
  for (const req of await uab.call("approvals.pending")) showApproval(req);
  input.focus();
  maybeWelcome();
  checkUpdates();
})();
