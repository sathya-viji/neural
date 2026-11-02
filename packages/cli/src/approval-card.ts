/**
 * Neural's approval card as an MCP App: shown inside the AI app's chat (Claude
 * and other hosts that support io.modelcontextprotocol/ui). It talks to the host
 * with JSON-RPC over postMessage. Allow/Decline call app-only tools the model
 * never sees, with a one-time code only this card gets. Everything shown comes
 * from the kernel and is inserted as text.
 */
export const CARD_URI = "ui://neural/approval";
export const CARD_MIME = "text/html;profile=mcp-app";

export const approvalCardHtml = `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { --panel:#ffffff; --text:#1f1e1b; --muted:#75726b; --line:#e6e3dc; --accent:#3d63dd; --accent-text:#fff; --ok:#1f8a4c; --warn:#b26a00; --bad:#c0392b; --kernel-bg:#eef2fb; --kernel-line:#c9d5f2; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --panel:#242422; --text:#ecebe7; --muted:#a19e96; --line:#34332f; --accent:#7c9cf5; --accent-text:#10131a; --ok:#4cc283; --warn:#e0a447; --bad:#ef6f62; --kernel-bg:#1f2738; --kernel-line:#34446b; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: transparent; color: var(--text); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .card { background: var(--kernel-bg); border: 1.5px solid var(--kernel-line); border-radius: 16px; padding: 14px 16px; display: grid; gap: 10px; }
  .who { font-size: 11.5px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); display: flex; align-items: center; gap: 8px; }
  .mark { width: 16px; height: 16px; border-radius: 5px; background: linear-gradient(135deg,#2f5bd3,#8a5cf6 55%,#31a6a0); }
  .summary { font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px; }
  .badge { font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; color: var(--muted); background: var(--panel); }
  .badge.high { color: var(--bad); } .badge.medium { color: var(--warn); } .badge.low { color: var(--ok); }
  .actions { display: flex; gap: 8px; }
  button { font: inherit; font-weight: 600; border-radius: 10px; padding: 9px 16px; border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; }
  button.allow { background: var(--accent); color: var(--accent-text); border-color: transparent; }
  button:disabled { opacity: .5; cursor: default; }
  .result { font-size: 14px; color: var(--muted); overflow-wrap: anywhere; }
  .result.ok { color: var(--ok); } .result.bad { color: var(--bad); }
  .hint { font-size: 12px; color: var(--muted); }
</style></head>
<body><div class="card" id="card"><div class="who"><span class="mark"></span>Neural · waiting</div><div class="hint">Loading…</div></div>
<script>
  const RISK = { low: "Low risk", medium: "Medium risk", high: "High risk" };
  const EFFECT = { write: "Changes something", send: "Sends something", delete: "Deletes something", device: "Uses the Mac" };
  const card = document.getElementById("card");
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  let nextId = 1;
  const waiting = new Map();
  function request(method, params) {
    const id = nextId++;
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  }
  const notify = (method, params) => window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  const resize = () => notify("ui/notifications/size-changed", { height: Math.ceil(document.documentElement.getBoundingClientRect().height) });

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && waiting.has(m.id)) {
      const w = waiting.get(m.id); waiting.delete(m.id);
      return m.error ? w.reject(new Error(m.error.message || "Error")) : w.resolve(m.result);
    }
    if (m.method === "ui/notifications/tool-result") show(m.params);
    if (m.method === "ui/resource-teardown" && m.id !== undefined) window.parent.postMessage({ jsonrpc: "2.0", id: m.id, result: {} }, "*");
  });

  function show(result) {
    const n = result && result.structuredContent && result.structuredContent.neural;
    if (!n) return;
    if (n.state === "waiting" && n.card) return showCard(n.card, n.requestId);
    showOutcome(n.state, n.text);
  }

  function header(text) { const w = el("div", "who"); w.append(el("span", "mark"), text); return w; }

  function showCard(c, requestId) {
    const facts = el("div", "facts");
    facts.append(el("span", "badge " + c.risk, RISK[c.risk] || c.risk));
    for (const e of c.effects) if (EFFECT[e]) facts.append(el("span", "badge", EFFECT[e]));
    const allow = el("button", "allow", "Allow"), decline = el("button", "", "Decline");
    const actions = el("div", "actions"); actions.append(allow, decline);
    const answer = async (ok) => {
      allow.disabled = decline.disabled = true;
      try {
        const r = await request("tools/call", { name: "neural_answer", arguments: { approval_id: c.approvalId, code: c.code, approve: ok } });
        if (r && r.isError) throw new Error((r.content && r.content[0] && r.content[0].text) || "Couldn't answer");
        actions.replaceWith(el("div", "result", ok ? "Allowed. Working on it…" : "Declined. Nothing was done."));
        resize();
        if (ok) poll(requestId);
      } catch (err) {
        actions.replaceWith(el("div", "result bad", String(err.message || err)));
        resize();
      }
    };
    allow.onclick = () => answer(true);
    decline.onclick = () => answer(false);
    card.replaceChildren(header(c.service + " · needs your OK"), el("div", "summary", c.summary), facts, actions,
      el("div", "hint", "Neural's kernel wrote this card. Only your tap answers it; it's also shown in Neural."));
    resize();
  }

  async function poll(requestId, tries = 0) {
    try {
      const r = await request("tools/call", { name: "neural_request_status", arguments: { request_id: requestId } });
      const n = r && r.structuredContent && r.structuredContent.neural;
      if (n && n.state !== "waiting") return showOutcome(n.state, n.text);
    } catch {}
    if (tries < 40) setTimeout(() => poll(requestId, tries + 1), 1500);
  }

  function showOutcome(state, text) {
    const words = { done: "Done", declined: "Declined", blocked: "Blocked", failed: "Didn't work" }[state] || state;
    card.replaceChildren(header("Neural · " + words), el("div", "result " + (state === "done" ? "ok" : "bad"), String(text || "").slice(0, 400)));
    resize();
  }

  request("ui/initialize", { appInfo: { name: "Neural approval", version: "0.3.1" }, appCapabilities: {}, protocolVersion: "2026-01-26" })
    .then(() => { notify("ui/notifications/initialized", {}); resize(); })
    .catch(() => {});
</script></body></html>`;
