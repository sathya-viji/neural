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

/** For approval cards: catch the common model mistake of scheduling something in the past. */
function whenChecked(value: unknown): string {
  const text = when(String(value));
  return new Date(String(value)).getTime() < Date.now() ? `${text} ⚠ this time has already passed` : text;
}

/**
 * Accepts ISO dates and the looser forms small models produce, e.g.
 * "Sun Nov 08 2026 16:01 IST" (time-zone abbreviations aren't understood by
 * Date, so they're dropped and the time is read as local).
 */
function date(args: Record<string, unknown>, key: string): string {
  const v = str(args, key);
  const candidates = [v, v.replace(/\s*\(?[A-Z]{2,5}\)?$/, ""), v.replace(/\s*(GMT|UTC)[+-]\d{4}.*$/, "")];
  for (const c of candidates) {
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return c === v ? v : localIso(d);
  }
  throw new Error(`"${key}" must be a date and time like 2026-11-02T15:00`);
}

function localIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
    summarize: (a) => `Add "${a.title}" to your calendar, ${whenChecked(a.start)}${a.calendar ? ` in ${a.calendar}` : ""}`,
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
    summarize: (a) => `Move a calendar event to ${whenChecked(a.start)}`,
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
  {
    id: "calendar.delete",
    service: "calendar",
    title: "Delete calendar events",
    description: "Permanently delete one or more calendar events. Only use when the user clearly asked to delete or cancel. Get ids from calendar.events.",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" }, description: "Event ids from calendar.events" } },
      required: ["ids"],
    },
    effects: ["delete"],
    risk: "high",
    async summarize(a) {
      const events = await Promise.all(strList(a, "ids").map(readEvent));
      const found = events.filter((e): e is CalEvent => !!e);
      if (!found.length) return "Delete calendar events (none of them were found)";
      return `Permanently delete ${found.length} event${found.length === 1 ? "" : "s"}: ${found.map((e) => `"${e.title}" (${when(e.start)})`).join(", ")}`;
    },
    async run(args) {
      const ids = strList(args, "ids");
      if (!ids.length) throw new Error("No events given");
      const deleted: string[] = [];
      for (const id of ids) {
        const ev = await readEvent(id);
        if (!ev) continue;
        await jxa<null>("Calendar", `${FIND_EVENT} if (ev) Cal.delete(ev); return "null";`, { id });
        deleted.push(`"${ev.title}" (${when(ev.start)})`);
      }
      if (!deleted.length) throw new Error("None of those events were found. List events again to get their ids.");
      return { content: `Deleted ${deleted.join(", ")}.`, data: { ids } };
    },
    async verify(args) {
      return (await Promise.all(strList(args, "ids").map(readEvent))).every((e) => e === null);
    },
  },
];

/* ---------------- Reminders ---------------- */

function idsSchema(description: string) {
  return {
    type: "object",
    properties: { ids: { type: "array", items: { type: "string" }, description } },
    required: ["ids"],
  };
}

/** Kernel-side lookup so approval cards name the real reminders, whatever the model says. */
async function reminderTitles(ids: string[]): Promise<string> {
  if (!ids.length) throw new Error("No reminders given");
  const titles = await jxa<(string | null)[]>(
    "Reminders",
    `const R = Application("Reminders");
     return JSON.stringify(a.ids.map(id => { try { return R.reminders.byId(id).name(); } catch (e) { return null; } }));`,
    { ids },
  );
  const found = titles.filter((t): t is string => !!t);
  const missing = titles.length - found.length;
  const shown = found.slice(0, 15).map((t) => `"${t}"`).join(", ") + (found.length > 15 ? ` and ${found.length - 15} more` : "");
  return `${found.length} reminder${found.length === 1 ? "" : "s"}: ${shown}${missing ? ` (${missing} not found)` : ""}`;
}

async function reminderStates(ids: string[]): Promise<("open" | "done" | "missing")[]> {
  return jxa(
    "Reminders",
    `const R = Application("Reminders");
     return JSON.stringify(a.ids.map(id => { try { return R.reminders.byId(id).completed() ? "done" : "open"; } catch (e) { return "missing"; } }));`,
    { ids },
  );
}

async function changeReminders(action: "complete" | "delete", ids: string[]): Promise<ActionResult> {
  if (!ids.length) throw new Error("No reminders given");
  const results = await jxa<{ id: string; title?: string; ok: boolean; error?: string }[]>(
    "Reminders",
    `const R = Application("Reminders");
     return JSON.stringify(a.ids.map(id => {
       try {
         const r = R.reminders.byId(id); const title = r.name();
         if (a.action === "complete") r.completed = true; else R.delete(r);
         return { id, title, ok: true };
       } catch (e) { return { id, ok: false, error: String(e) }; }
     }));`,
    { ids, action },
    60_000,
  );
  const done = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  if (!done.length) throw new Error(`None of the reminders could be changed (${failed[0]?.error ?? "not found"}).`);
  const verb = action === "complete" ? "Marked as done" : "Deleted";
  return {
    content: `${verb}: ${done.map((r) => `"${r.title}"`).join(", ")}.${failed.length ? ` ${failed.length} couldn't be changed.` : ""}`,
    data: results,
  };
}

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
      const items = await jxa<{ id: string; title: string; list: string; due?: string }[]>(
        "Reminders",
        `const R = Application("Reminders"); const out = [];
         const lists = a.list ? [R.lists.byName(a.list)] : R.lists();
         for (const l of lists) for (const r of l.reminders.whose({ completed: false })()) {
           const due = r.dueDate(); out.push({ id: r.id(), title: r.name(), list: l.name(), due: due ? due.toISOString() : undefined });
           if (out.length >= 100) break;
         }
         return JSON.stringify(out);`,
        { list: args.list },
        60_000,
      );
      if (!items.length) return { content: "No unfinished reminders.", data: [] };
      return { content: items.map((r) => `${r.title} [${r.list}]${r.due ? ` — due ${when(r.due)}` : ""} (id ${r.id})`).join("\n"), data: items };
    },
  },
  {
    id: "reminders.complete",
    service: "reminders",
    title: "Mark reminders as done",
    description: "Mark one or more reminders as completed. They stay in the Reminders app and can be un-ticked. Prefer this over deleting unless the user asked to delete. Get ids from reminders.list.",
    inputSchema: idsSchema("Reminder ids from reminders.list"),
    effects: ["write"],
    risk: "medium",
    summarize: async (a) => `Mark as done: ${await reminderTitles(strList(a, "ids"))}`,
    run: (args) => changeReminders("complete", strList(args, "ids")),
    verify: async (args) => (await reminderStates(strList(args, "ids"))).every((s) => s === "done"),
  },
  {
    id: "reminders.delete",
    service: "reminders",
    title: "Delete reminders",
    description: "Permanently delete one or more reminders. Only use when the user clearly asked to delete. Get ids from reminders.list.",
    inputSchema: idsSchema("Reminder ids from reminders.list"),
    effects: ["delete"],
    risk: "high",
    summarize: async (a) => `Permanently delete: ${await reminderTitles(strList(a, "ids"))}`,
    run: (args) => changeReminders("delete", strList(args, "ids")),
    verify: async (args) => (await reminderStates(strList(args, "ids"))).every((s) => s === "missing"),
  },
  {
    id: "reminders.create",
    service: "reminders",
    title: "Add a reminder",
    description: "Add a reminder to the user's Reminders app. Set due whenever the user says when.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What to be reminded about, without the time" },
        due: { type: "string", description: `When to remind. ${DATE_HINT}. Required if the user gave a time or day.` },
        notes: { type: "string" },
        list: { type: "string", description: "List name; leave out for the default list" },
      },
      required: ["title"],
    },
    effects: ["write"],
    risk: "medium",
    summarize: (a) => `Add a reminder "${a.title}"${a.due ? ` for ${whenChecked(a.due)}` : ""}`,
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
