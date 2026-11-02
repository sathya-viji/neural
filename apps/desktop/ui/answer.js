// Turns an AI answer into a readable document: Markdown (headings, lists,
// tables, code) plus visual blocks the AI can add as ```ui JSON```: option
// cards, a weather forecast, a timeline, key facts, a table and follow-up
// buttons. Everything is built from DOM nodes and text, never HTML, so nothing
// a model or a web page writes can run in this window.

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

const str = (v) => (v === null || v === undefined ? "" : String(v));

/**
 * @param {string} text the answer
 * @param {{ openLink(url: string): void, ask(prompt: string): void }} actions
 */
export function renderAnswer(text, actions) {
  const root = el("div", { class: "doc" });
  const lines = normalizeFences(str(text).replace(/\r\n/g, "\n")).split("\n");
  let i = 0;
  const inline = (s) => inlineText(s, actions);

  while (i < lines.length) {
    const line = lines[i];
    // Fenced block: ```ui is a visual block, anything else is code.
    const fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      if (fence[1] === "ui") {
        const block = visualBlock(body.join("\n"), actions);
        if (block) root.append(block);
      } else if (body.join("").trim()) {
        root.append(el("pre", { class: "code" }, el("code", {}, body.join("\n"))));
      }
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      root.append(el(heading[1].length <= 2 ? "h3" : "h4", {}, inline(heading[2])));
      i++;
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      root.append(el("hr"));
      i++;
      continue;
    }
    // Table: a header row, a |---| row, then rows.
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      root.append(table(head, rows, inline));
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      root.append(el("blockquote", {}, inline(quote.join(" "))));
      continue;
    }
    // Lists (one level of nesting by indent).
    const item = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/;
    if (item.test(line)) {
      const ordered = /\d/.test(line.match(item)[2]);
      const list = el(ordered ? "ol" : "ul");
      let last = null;
      while (i < lines.length && (item.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && last))) {
        const m = lines[i].match(item);
        if (m && m[1].length >= 2 && last) {
          let sub = last.querySelector(":scope > ul, :scope > ol");
          if (!sub) last.append((sub = el(/\d/.test(m[2]) ? "ol" : "ul")));
          sub.append(el("li", {}, inline(m[3])));
        } else if (m) {
          last = el("li", {}, inline(m[3]));
          list.append(last);
        } else {
          last.append(" ", inline(lines[i].trim()));
        }
        i++;
      }
      root.append(list);
      continue;
    }
    // Paragraph: consecutive plain lines.
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*```|\s*>|\s*\|)/.test(lines[i]) && !item.test(lines[i])) para.push(lines[i++]);
    const p = el("p");
    para.forEach((l, n) => (n && p.append(el("br")), p.append(inline(l))));
    root.append(p);
  }
  return root;
}

/**
 * Models don't always put ``` on its own line ("…two days.```ui {…}```"), and
 * sometimes leave the last block unclosed. Rewrite every fenced part so each
 * fence sits on its own line. A bare JSON block with a "type" is a visual block.
 */
function normalizeFences(text) {
  const parts = text.split("```");
  if (parts.length < 2) return text;
  let out = "";
  parts.forEach((part, n) => {
    if (n % 2 === 0) return void (out += part);
    let [, lang, body] = part.match(/^([\w-]*)([\s\S]*)$/);
    if ((!lang || lang === "json") && /^\s*\{[\s\S]*"type"\s*:/.test(body)) lang = "ui";
    out += `\n\`\`\`${lang}\n${body.trim()}\n\`\`\`\n`;
  });
  return out;
}

/** **bold**, *italic*, `code`, [label](link) and bare links. Links open in the app's browser. */
export function inlineText(text, actions) {
  const frag = document.createDocumentFragment();
  const s = str(text);
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?])|\*\*([^*]+)\*\*|`([^`]+)`|(?<![\w*])\*([^*\s][^*]*?)\*(?!\w)|(?<!\w)_([^_\s][^_]*?)_(?!\w)/g;
  let last = 0;
  for (const m of s.matchAll(pattern)) {
    if (m.index > last) frag.append(s.slice(last, m.index));
    if (m[4]) frag.append(el("strong", {}, m[4]));
    else if (m[5]) frag.append(el("code", {}, m[5]));
    else if (m[6] || m[7]) frag.append(el("em", {}, m[6] ?? m[7]));
    else frag.append(link((m[2] ?? m[3]).replace(/[?&]utm_source=openai$/, ""), m[1], actions));
    last = m.index + m[0].length;
  }
  if (last < s.length) frag.append(s.slice(last));
  return frag;
}

function link(url, label, actions) {
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {}
  return el("a", { href: "#", title: url, onclick: (e) => (e.preventDefault(), actions.openLink(url)) }, label ?? host);
}

function table(head, rows, inline) {
  return el(
    "div",
    { class: "table-wrap" },
    el("table", {}, el("thead", {}, el("tr", {}, ...head.map((h) => el("th", {}, inline(h))))), el("tbody", {}, ...rows.map((r) => el("tr", {}, ...head.map((_, c) => el("td", {}, inline(r[c] ?? ""))))))),
  );
}

/* ---------------- visual blocks ---------------- */

const WEATHER = { thunder: "⛈️", storm: "⛈️", showers: "🌦️", drizzle: "🌦️", rain: "🌧️", snow: "❄️", fog: "🌫️", mist: "🌫️", wind: "💨", partly: "⛅", overcast: "☁️", cloud: "☁️", clear: "☀️", sun: "☀️" };
function weatherIcon(day) {
  const key = str(day.icon || day.summary).toLowerCase();
  for (const [word, icon] of Object.entries(WEATHER)) if (key.includes(word)) return icon;
  return "🌤️";
}

function visualBlock(json, actions) {
  let b;
  try {
    // Tolerate text around the JSON: take the outermost { … }.
    b = JSON.parse(json.slice(json.indexOf("{"), json.lastIndexOf("}") + 1));
  } catch {
    return null; // A broken block is skipped; the text around it still reads fine.
  }
  if (!b || typeof b !== "object") return null;
  const list = (v) => (Array.isArray(v) ? v.slice(0, 24) : []);
  const title = b.title ? el("div", { class: "block-title" }, str(b.title)) : null;
  const inline = (s) => inlineText(s, actions);

  switch (b.type) {
    case "cards":
      return el(
        "div",
        { class: "block" },
        title,
        el(
          "div",
          { class: "cards" },
          ...list(b.items).map((c) =>
            el(
              "div",
              { class: "card-item" },
              el("div", { class: "card-top" }, el("div", { class: "card-title" }, str(c.title)), c.badge ? el("span", { class: "card-badge" }, str(c.badge)) : null),
              c.subtitle ? el("div", { class: "card-sub" }, inline(c.subtitle)) : null,
              list(c.details).length ? el("ul", { class: "card-details" }, ...list(c.details).map((d) => el("li", {}, inline(d)))) : null,
              c.note ? el("div", { class: "card-note" }, inline(c.note)) : null,
              c.action?.prompt || c.url
                ? el(
                    "div",
                    { class: "card-actions" },
                    c.action?.prompt ? el("button", { class: "card-btn", onclick: () => actions.ask(str(c.action.prompt)) }, str(c.action.label || "Choose")) : null,
                    c.url && /^https:\/\//.test(c.url) ? el("button", { class: "card-btn ghost", onclick: () => actions.openLink(c.url) }, "Open") : null,
                  )
                : null,
            ),
          ),
        ),
      );
    case "forecast":
      return el(
        "div",
        { class: "block forecast" },
        el("div", { class: "block-title" }, str(b.place || b.title || "Forecast")),
        el(
          "div",
          { class: "days" },
          ...list(b.days).map((d) =>
            el(
              "div",
              { class: "day" },
              el("div", { class: "day-name" }, str(d.day)),
              el("div", { class: "day-icon" }, weatherIcon(d)),
              el("div", { class: "day-temp" }, el("strong", {}, str(d.high)), d.low !== undefined ? el("span", {}, ` / ${str(d.low)}`) : null),
              d.rain !== undefined ? el("div", { class: "day-rain" }, `💧 ${str(d.rain)}`) : null,
              d.summary ? el("div", { class: "day-sum" }, str(d.summary)) : null,
            ),
          ),
        ),
      );
    case "events":
      return el(
        "div",
        { class: "block" },
        title,
        el(
          "div",
          { class: "timeline" },
          ...list(b.items).map((e) =>
            el("div", { class: "event" }, el("div", { class: "event-time" }, str(e.time)), el("div", { class: "event-body" }, el("div", { class: "event-title" }, inline(e.title)), e.detail ? el("div", { class: "event-detail" }, inline(e.detail)) : null)),
          ),
        ),
      );
    case "facts":
      return el("div", { class: "block" }, title, el("div", { class: "facts-grid" }, ...list(b.items).map((f) => el("div", { class: "fact" }, el("div", { class: "fact-label" }, str(f.label)), el("div", { class: "fact-value" }, inline(f.value))))));
    case "table":
      return el("div", { class: "block" }, title, table(list(b.columns).map(str), list(b.rows).map((r) => list(r).map(str)), inline));
    case "choices":
      return el("div", { class: "choices" }, ...list(b.items).slice(0, 4).map((c) => el("button", { class: "choice", onclick: () => actions.ask(str(c.prompt || c.label)) }, str(c.label))));
    default:
      return null;
  }
}
