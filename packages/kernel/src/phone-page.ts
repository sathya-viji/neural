/**
 * The phone approvals page. Self-contained (no outside requests). Everything it
 * shows comes from the kernel and is inserted as text, never HTML.
 */
export const phonePage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="Neural" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<title>Neural approvals</title>
<style>
  :root { --bg:#f8f7f4; --panel:#fff; --text:#1f1e1b; --muted:#75726b; --line:#e6e3dc; --accent:#3d63dd; --accent-text:#fff; --ok:#1f8a4c; --warn:#b26a00; --bad:#c0392b; --kernel-bg:#eef2fb; --kernel-line:#c9d5f2; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg:#1a1a19; --panel:#242422; --text:#ecebe7; --muted:#a19e96; --line:#34332f; --accent:#7c9cf5; --accent-text:#10131a; --ok:#4cc283; --warn:#e0a447; --bad:#ef6f62; --kernel-bg:#1f2738; --kernel-line:#34446b; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; padding: env(safe-area-inset-top) 16px calc(24px + env(safe-area-inset-bottom)); }
  header { display: flex; align-items: center; gap: 10px; padding: 18px 2px 10px; }
  .mark { width: 30px; height: 30px; border-radius: 8px; background: linear-gradient(135deg,#2f5bd3,#8a5cf6 55%,#31a6a0); }
  h1 { font-size: 20px; margin: 0; flex: 1; }
  .conn { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .conn i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; }
  .conn.live i { background: var(--ok); }
  .empty { text-align: center; color: var(--muted); padding: 18vh 10px 0; }
  .empty b { display: block; color: var(--text); font-size: 18px; margin-bottom: 6px; }
  .card { background: var(--kernel-bg); border: 1.5px solid var(--kernel-line); border-radius: 18px; padding: 16px; margin: 12px 0; display: grid; gap: 10px; }
  .who { font-size: 12px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
  .summary { font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px; }
  .badge { font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; color: var(--muted); background: var(--panel); }
  .badge.high { color: var(--bad); } .badge.medium { color: var(--warn); } .badge.low { color: var(--ok); }
  details summary { color: var(--muted); font-size: 14px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px; margin: 8px 0 0; }
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 4px; }
  button { font: inherit; font-weight: 600; border-radius: 14px; padding: 14px; border: 1px solid var(--line); background: var(--panel); color: var(--text); }
  button.allow { background: var(--accent); color: var(--accent-text); border-color: transparent; }
  button:disabled { opacity: .5; }
  .done { text-align: center; color: var(--muted); font-size: 14px; }
  .tip { color: var(--muted); font-size: 13px; text-align: center; margin-top: 28px; }
</style>
</head>
<body>
<header><div class="mark"></div><h1>Approvals</h1><div class="conn" id="conn"><i></i><span>Connecting…</span></div></header>
<main id="list"></main>
<p class="tip">Neural asks here when something needs your OK: sending, changing, ordering or deleting. Tip: Share → <b>Add to Home Screen</b> to keep this one tap away.</p>
<script>
  const base = location.pathname.replace(/\\/$/, "");
  const list = document.getElementById("list");
  const conn = document.getElementById("conn");
  const RISK = { low: "Low risk", medium: "Medium risk", high: "High risk" };
  const EFFECT = { read: "Only looks", write: "Changes something", send: "Sends or orders", delete: "Deletes something", spend: "Spends money", device: "Uses the Mac" };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  let known = new Set();

  async function load() {
    const res = await fetch(base + "/api/pending", { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const items = await res.json();
    document.title = items.length ? "(" + items.length + ") Neural approvals" : "Neural approvals";
    const fresh = items.some((i) => !known.has(i.approvalId));
    known = new Set(items.map((i) => i.approvalId));
    if (fresh && navigator.vibrate) navigator.vibrate(200);
    list.replaceChildren(...(items.length ? items.map(card) : [empty()]));
  }
  function empty() {
    const n = el("div", "empty");
    n.append(el("b", "", "Nothing waiting"), "Requests that need your OK will appear here.");
    return n;
  }
  function card(a) {
    const n = el("div", "card");
    n.append(el("div", "who", a.service + " · needs your OK"), el("div", "summary", a.summary));
    const facts = el("div", "facts");
    facts.append(el("span", "badge " + a.risk, RISK[a.risk] || a.risk));
    for (const e of a.effects) if (e !== "read" || a.effects.length === 1) facts.append(el("span", "badge", EFFECT[e] || e));
    facts.append(el("span", "badge", "Asked by " + a.from));
    const d = el("details"); d.append(el("summary", "", "Exact details"), el("pre", "", JSON.stringify(a.args, null, 2)));
    const actions = el("div", "actions");
    const allow = el("button", "allow", "Allow"), decline = el("button", "", "Decline");
    const answer = async (ok) => {
      allow.disabled = decline.disabled = true;
      const r = await fetch(base + "/api/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalId: a.approvalId, approve: ok }) });
      n.replaceChildren(el("div", "done", r.ok ? (ok ? "✓ Allowed" : "✕ Declined") : "This was already answered."));
      setTimeout(load, 900);
    };
    allow.onclick = () => answer(true);
    decline.onclick = () => answer(false);
    actions.append(decline, allow);
    n.append(facts, d, actions);
    return n;
  }
  function live(on) {
    conn.className = "conn" + (on ? " live" : "");
    conn.lastChild.textContent = on ? "Connected to your Mac" : "Can't reach your Mac";
  }
  function connect() {
    const es = new EventSource(base + "/api/events");
    es.addEventListener("changed", () => load().then(() => live(true)).catch(() => live(false)));
    es.onerror = () => { live(false); es.close(); setTimeout(connect, 4000); };
  }
  load().then(() => live(true)).catch(() => live(false));
  connect();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load().then(() => live(true)).catch(() => live(false)); });
</script>
</body>
</html>`;
