import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import type { ActionResult } from "@uab/protocol";
import type { BuiltinCapability } from "./types.js";
import { str, strList } from "./types.js";
import { insideRoots } from "./files.js";

const run = promisify(execFile);
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * The Mac's own apps (Mail, Contacts, Calendar, Reminders), driven through
 * macOS scripting. No accounts or keys: the apps already have the user's data.
 * macOS asks the user once per app before allowing access.
 */
async function osa(app: string, lang: "JavaScript" | "AppleScript", script: string, args: string[], timeoutMs = 30_000): Promise<string> {
  try {
    const { stdout } = await run("osascript", ["-l", lang, "-e", script, ...args], { timeout: timeoutMs, maxBuffer: 10_000_000 });
    return stdout.trim();
  } catch (err) {
    const e = err as Error & { stderr?: string; killed?: boolean };
    const msg = e.stderr || e.message;
    if (/-1743|Not authorized|not allowed/i.test(msg)) {
      throw new Error(`macOS hasn't allowed access to ${app}. Open System Settings → Privacy & Security → Automation and turn on ${app} for this app, then try again.`);
    }
    if (e.killed) throw new Error(`${app} took too long to answer.`);
    throw new Error(`${app}: ${msg.replace(/^.*execution error: /s, "").trim().slice(0, 300)}`);
  }
}

/** Run a JXA function body with one JSON argument and parse its JSON result. */
async function jxa<T>(app: string, body: string, input: unknown, timeoutMs?: number): Promise<T> {
  const script = `function run(argv) { const a = JSON.parse(argv[0]); ${body} }`;
  const out = await osa(app, "JavaScript", script, [JSON.stringify(input)], timeoutMs);
  return JSON.parse(out || "null") as T;
}

function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function date(args: Record<string, unknown>, key: string): string {
  const v = str(args, key);
  if (Number.isNaN(new Date(v).getTime())) throw new Error(`"${key}" must be a date and time like 2026-11-02T15:00`);
  return v;
}

const DATE_HINT = "Local date and time, e.g. 2026-11-02T15:00";

/* ---------------- Contacts ---------------- */

interface Person {
  name: string;
  emails: string[];
  phones: string[];
  organization?: string;
}

const contacts: BuiltinCapability[] = [
  {
    id: "contacts.find",
    service: "contacts",
    title: "Find a contact",
    description: "Look up people in the user's Contacts app by name. Returns email addresses and phone numbers.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Full or partial name" } }, required: ["name"] },
    effects: ["read"],
    risk: "low",
    summarize: (a) => `Look up "${a.name}" in your contacts`,
    async run(args) {
      const people = await jxa<Person[]>(
        "Contacts",
        `const C = Application("Contacts");
         const found = C.people.whose({ name: { _contains: a.name } })();
         return JSON.stringify(found.slice(0, 10).map(p => ({
           name: p.name(),
           emails: p.emails().map(e => e.value()),
           phones: p.phones().map(x => x.value()),
           organization: p.organization() || undefined,
         })));`,
        { name: str(args, "name") },
      );
      if (!people.length) return { content: `No one called "${args.name}" in Contacts.`, data: [] };
      return {
        content: people.map((p) => [p.name, p.organization, ...p.emails, ...p.phones].filter(Boolean).join(" · ")).join("\n"),
        data: people,
      };
    },
  },
];

/* ---------------- Mail ---------------- */

// Paths and addresses are turned into plain values before talking to Mail:
// inside a "tell Mail" block, loop items are references Mail can't convert.
const MAIL_SCRIPT = `on run argv
  set {mode, recipientText, theSubject, theBody, attachmentText} to argv
  set recipientList to {}
  repeat with addr in paragraphs of recipientText
    set addrText to contents of addr
    if length of addrText > 0 then set end of recipientList to addrText
  end repeat
  set fileList to {}
  repeat with p in paragraphs of attachmentText
    set pathText to contents of p
    if length of pathText > 0 then set end of fileList to (POSIX file pathText) as alias
  end repeat
  tell application "Mail"
    set m to make new outgoing message with properties {subject:theSubject, content:theBody & return & return, visible:(mode is "draft")}
    tell m
      repeat with addrText in recipientList
        make new to recipient at end of to recipients with properties {address:(contents of addrText)}
      end repeat
      repeat with f in fileList
        tell content to make new attachment with properties {file name:(contents of f)} at after last paragraph
      end repeat
    end tell
    if mode is "send" then
      delay 1
      send m
      return "sent"
    else
      activate
      return "draft"
    end if
  end tell
end run`;

const mailSchema = {
  type: "object",
  properties: {
    to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
    subject: { type: "string" },
    body: { type: "string", description: "Plain-text message" },
    attachments: { type: "array", items: { type: "string" }, description: "Full file paths to attach" },
  },
  required: ["to", "subject", "body"],
};

async function mail(mode: "send" | "draft", args: Record<string, unknown>, ctx: Parameters<BuiltinCapability["run"]>[1]): Promise<ActionResult> {
  const to = strList(args, "to");
  if (!to.length) throw new Error("At least one recipient is required");
  for (const addr of to) if (!EMAIL.test(addr)) throw new Error(`"${addr}" is not an email address`);
  const attachments = await Promise.all(strList(args, "attachments").map((p) => insideRoots(p, ctx)));
  const outcome = await osa("Mail", "AppleScript", MAIL_SCRIPT, [mode, to.join("\n"), str(args, "subject"), str(args, "body"), attachments.join("\n")], 60_000);
  const files = attachments.length ? ` with ${attachments.map((p) => basename(p)).join(", ")}` : "";
  return {
    content:
      outcome === "sent"
        ? `Sent from Apple Mail to ${to.join(", ")}${files}.`
        : `Draft to ${to.join(", ")}${files} is open in Apple Mail for the user to review and send. It has NOT been sent.`,
    data: { to, attachments, outcome },
  };
}

function mailSummary(verb: string) {
  return (a: Record<string, unknown>) => {
    const files = strList(a, "attachments").map((p) => basename(p));
    return `${verb} ${strList(a, "to").join(", ")} — "${a.subject}"${files.length ? ` with ${files.join(", ")}` : ""}`;
  };
}

const mailCaps: BuiltinCapability[] = [
  {
    id: "mail.draft",
    service: "mail",
    title: "Write an email draft",
    description: "Open a new email in Apple Mail, filled in and ready for the user to review and send themselves. Prefer this unless the user clearly asked for the email to be sent.",
    inputSchema: mailSchema,
    effects: ["write"],
    risk: "medium",
    summarize: mailSummary("Open a draft to"),
    run: (args, ctx) => mail("draft", args, ctx),
  },
  {
    id: "mail.send",
    service: "mail",
    title: "Send an email",
    description: "Send an email right away from the user's Apple Mail account, optionally with attachments from the shared folders.",
    inputSchema: mailSchema,
    effects: ["send"],
    risk: "high",
    summarize: mailSummary("Send an email to"),
    run: (args, ctx) => mail("send", args, ctx),
    async verify(_args, result) {
      return (result.data as { outcome?: string } | undefined)?.outcome === "sent";
    },
  },
];

/* ---------------- Calendar ---------------- */

interface CalEvent {
  id: string;
  calendar: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  allDay?: boolean;
}

const FIND_EVENT = `const Cal = Application("Calendar");
  let ev = null, cal = null;
  for (const c of Cal.calendars()) { const m = c.events.whose({ uid: a.id })(); if (m.length) { ev = m[0]; cal = c; break; } }`;

const EVENT_JSON = `({ id: ev.uid(), calendar: cal.name(), title: ev.summary(), start: ev.startDate().toISOString(), end: ev.endDate().toISOString(), location: ev.location() || undefined, allDay: ev.alldayEvent() })`;

async function readEvent(id: string): Promise<CalEvent | null> {
  return jxa<CalEvent | null>("Calendar", `${FIND_EVENT} return JSON.stringify(ev ? ${EVENT_JSON} : null);`, { id });
}

function describeEvent(e: CalEvent): string {
  return `${e.title} — ${e.allDay ? new Date(e.start).toDateString() + " (all day)" : `${when(e.start)} to ${new Date(e.end).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}${e.location ? ` @ ${e.location}` : ""} [${e.calendar}] (id ${e.id})`;
}

const calendar: BuiltinCapability[] = [
  {
    id: "calendar.events",
    service: "calendar",
    title: "List calendar events",
    description: "List events in the user's Calendar app between two times. Repeating events may only show their first occurrence.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string", description: DATE_HINT }, to: { type: "string", description: DATE_HINT } },
      required: ["from", "to"],
    },
    effects: ["read"],
    risk: "low",
    summarize: (a) => `Look at your calendar from ${a.from} to ${a.to}`,
    async run(args) {
      const events = await jxa<CalEvent[]>(
        "Calendar",
        `const Cal = Application("Calendar"); const s = new Date(a.from), e = new Date(a.to); const out = [];
         for (const c of Cal.calendars()) {
           const evs = c.events.whose({ _and: [{ startDate: { _lessThan: e } }, { endDate: { _greaterThan: s } }] })();
           for (const ev of evs) { const cal = c; out.push(${EVENT_JSON}); }
         }
         out.sort((x, y) => x.start.localeCompare(y.start));
         return JSON.stringify(out.slice(0, 100));`,
        { from: date(args, "from"), to: date(args, "to") },
        60_000,
      );
      if (!events.length) return { content: `No events between ${when(String(args.from))} and ${when(String(args.to))}.`, data: [] };
      return { content: events.map(describeEvent).join("\n"), data: events };
    },
  },
  {
    id: "calendar.create",
    service: "calendar",
    title: "Add a calendar event",
    description: "Create an event in the user's Calendar app.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: DATE_HINT },
        end: { type: "string", description: DATE_HINT },
        location: { type: "string" },
        notes: { type: "string" },
        calendar: { type: "string", description: "Calendar name; leave out for the default" },
      },
      required: ["title", "start", "end"],
    },
    effects: ["write"],
    risk: "medium",
    summarize: (a) => `Add "${a.title}" to your calendar, ${when(String(a.start))}${a.calendar ? ` in ${a.calendar}` : ""}`,
    async run(args) {
      const created = await jxa<{ id: string }>(
        "Calendar",
        `const Cal = Application("Calendar");
         const cal = a.calendar ? Cal.calendars.byName(a.calendar) : Cal.calendars().find(c => c.writable());
         if (!cal) throw new Error("No calendar you can add events to");
         const ev = Cal.Event({ summary: a.title, startDate: new Date(a.start), endDate: new Date(a.end), location: a.location || "", description: a.notes || "" });
         cal.events.push(ev);
         return JSON.stringify({ id: ev.uid() });`,
        { title: str(args, "title"), start: date(args, "start"), end: date(args, "end"), location: args.location, notes: args.notes, calendar: args.calendar },
      );
      const ev = await readEvent(created.id);
      return { content: ev ? `Added: ${describeEvent(ev)}` : `Added (id ${created.id})`, data: ev ?? created };
    },
    async verify(_args, result) {
      const id = (result.data as { id?: string } | undefined)?.id;
      return !!id && (await readEvent(id)) !== null;
    },
  },
  {
    id: "calendar.reschedule",
    service: "calendar",
    title: "Move a calendar event",
    description: "Change the start and end time of an existing event. Get the event id from calendar.events first.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Event id from calendar.events" },
        start: { type: "string", description: DATE_HINT },
        end: { type: "string", description: DATE_HINT },
      },
      required: ["id", "start", "end"],
    },
    effects: ["write"],
    risk: "medium",
    summarize: (a) => `Move a calendar event to ${when(String(a.start))}`,
    async run(args) {
      const before = await readEvent(str(args, "id"));
      if (!before) throw new Error("That event wasn't found. List events again to get its id.");
      await jxa<null>(
        "Calendar",
        `${FIND_EVENT} if (!ev) throw new Error("Event not found");
         ev.startDate = new Date(a.start); ev.endDate = new Date(a.end); return "null";`,
        { id: before.id, start: date(args, "start"), end: date(args, "end") },
      );
      const after = await readEvent(before.id);
      return { content: `Moved "${before.title}" from ${when(before.start)} to ${after ? when(after.start) : args.start}.`, data: { before, after, wanted: args.start } };
    },
    async verify(_args, result) {
      const d = result.data as { after?: CalEvent; wanted?: string } | undefined;
      return !!d?.after && !!d.wanted && Math.abs(new Date(d.after.start).getTime() - new Date(d.wanted).getTime()) < 60_000;
    },
  },
];

/* ---------------- Reminders ---------------- */

const reminders: BuiltinCapability[] = [
  {
    id: "reminders.list",
    service: "reminders",
    title: "List reminders",
    description: "List the user's unfinished reminders from the Reminders app.",
    inputSchema: { type: "object", properties: { list: { type: "string", description: "List name; leave out for all lists" } } },
    effects: ["read"],
    risk: "low",
    summarize: (a) => `Look at your reminders${a.list ? ` in ${a.list}` : ""}`,
    async run(args) {
      const items = await jxa<{ title: string; list: string; due?: string }[]>(
        "Reminders",
        `const R = Application("Reminders"); const out = [];
         const lists = a.list ? [R.lists.byName(a.list)] : R.lists();
         for (const l of lists) for (const r of l.reminders.whose({ completed: false })()) {
           const due = r.dueDate(); out.push({ title: r.name(), list: l.name(), due: due ? due.toISOString() : undefined });
           if (out.length >= 100) break;
         }
         return JSON.stringify(out);`,
        { list: args.list },
        60_000,
      );
      if (!items.length) return { content: "No unfinished reminders.", data: [] };
      return { content: items.map((r) => `${r.title} [${r.list}]${r.due ? ` — due ${when(r.due)}` : ""}`).join("\n"), data: items };
    },
  },
  {
    id: "reminders.create",
    service: "reminders",
    title: "Add a reminder",
    description: "Add a reminder to the user's Reminders app, optionally with a due time.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        due: { type: "string", description: DATE_HINT },
        notes: { type: "string" },
        list: { type: "string", description: "List name; leave out for the default list" },
      },
      required: ["title"],
    },
    effects: ["write"],
    risk: "medium",
    summarize: (a) => `Add a reminder "${a.title}"${a.due ? ` for ${when(String(a.due))}` : ""}`,
    async run(args) {
      if (args.due !== undefined) date(args, "due");
      const r = await jxa<{ id: string; list: string }>(
        "Reminders",
        `const R = Application("Reminders");
         const list = a.list ? R.lists.byName(a.list) : R.defaultList();
         const props = { name: a.title };
         if (a.notes) props.body = a.notes;
         if (a.due) props.dueDate = new Date(a.due);
         const r = R.Reminder(props); list.reminders.push(r);
         return JSON.stringify({ id: r.id(), list: list.name() });`,
        { title: str(args, "title"), due: args.due, notes: args.notes, list: args.list },
      );
      return { content: `Added reminder "${args.title}" to ${r.list}${args.due ? `, due ${when(String(args.due))}` : ""}.`, data: r };
    },
  },
];

export const appleCapabilities: BuiltinCapability[] = [...contacts, ...mailCaps, ...calendar, ...reminders];
