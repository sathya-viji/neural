import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ChatRequest, ChatResponse, Message, ModelProvider, ToolCall, ToolSpec } from "./types.js";
import { ProviderError } from "./types.js";

const run = promisify(execFile);

export const APPLE_HELPER = fileURLToPath(new URL("../../native/bin/uab-apple-model", import.meta.url));
/** Where the helper is: next to the code in development, or wherever the packaged app put it (UAB_APPLE_HELPER). */
export const appleHelperPath = () => process.env.UAB_APPLE_HELPER || APPLE_HELPER;

/** Is Apple's on-device model usable on this machine right now? */
export async function appleModelAvailability(helper = appleHelperPath()): Promise<{ available: boolean; reason?: string }> {
  if (process.platform !== "darwin") return { available: false, reason: "The built-in model needs a Mac with Apple Intelligence." };
  if (!existsSync(helper)) return { available: false, reason: "The built-in model helper isn't built. Run npm run build." };
  try {
    const { stdout } = await run(helper, ["--check"], { timeout: 10_000 });
    return JSON.parse(stdout.trim());
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}

/**
 * The on-device model has a small context window, so it only sees the tools
 * that matter for this request. Groups are matched by words in the request.
 */
const TOOL_GROUPS: Record<string, RegExp> = {
  files: /\b(files?|documents?|docs?|folders?|downloads?|desktop|reports?|pdfs?|images?|photos?|pictures?|open|read|latest|newest|recent|saved|attach\w*)\b/i,
  contacts: /\b(contacts?|phone|number|address|who is|email of|e-?mail address)\b/i,
  mail: /\b(e-?mails?|mails?|send|draft|inbox|reply|message|write to|invite)\b/i,
  gmail: /\b(e-?mails?|mails?|gmail|send|draft|inbox|reply|unread|message|invite)\b/i,
  calendar: /\b(calendar|meetings?|events?|schedule\w*|appointments?|busy|free|cancel|reschedule|move)\b/i,
  reminders: /\b(remind\w*|todos?|to-dos?|tasks?)\b/i,
  system: /\b(time|date|day|notify|notification|open|link|website)\b/i,
  web: /\b(search|look up|lookup|google|news|latest|headlines?|internet|online|web|website|https?:\/\/\S+|price|cost|who is|who was|what is|when is|where is|how (much|many|to)|score|results?|stock|movie|restaurant|near me|open now)\b/i,
  weather: /\b(weather|rain\w*|temperature|forecast|hot|cold|humid\w*|umbrella|sunny|storm\w*)\b/i,
  browser: /\b(show me|open|google|browser|page|link|site|website|article)\b/i,
  memory: /\b(remember|forget|memory|memories|last time|again|earlier|yesterday|what did i|did i|history|i am|i'm|i prefer|my name)\b/i,
};
const ALWAYS = new Set(["system__now"]);
const MAX_TOOLS = 10;
const MAX_RESULT_CHARS = 2000;

/** Day words suggest the calendar only when nothing more specific (like "remind") was asked for. */
const DAY_WORDS = /\b(tomorrow|today|tonight|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

export function pickTools(tools: ToolSpec[], request: string): ToolSpec[] {
  const wanted = new Set(Object.entries(TOOL_GROUPS).filter(([, re]) => re.test(request)).map(([g]) => g));
  const specific = [...wanted].some((g) => g !== "system");
  if (DAY_WORDS.test(request) && !specific) wanted.add("calendar");
  // Nothing recognised: offer the everyday basics.
  if (!wanted.size) ["files", "calendar", "reminders", "mail", "gmail"].forEach((g) => wanted.add(g));
  const picked = tools.filter((t) => {
    if (ALWAYS.has(t.name)) return true;
    const group = t.name.split("__")[0];
    if (group === "mcp") return request.toLowerCase().includes(t.name.split("__")[1]?.toLowerCase() ?? "\0");
    return wanted.has(group);
  });
  return picked.slice(0, MAX_TOOLS).map((t) => ({
    name: t.name,
    // First sentence is enough for a small model, and saves context.
    description: (t.description.match(/^.*?[.!?](\s|$)/)?.[0] ?? t.description).trim().slice(0, 200),
    parameters: t.parameters,
  }));
}

/** The conversation so far, as plain text for a fresh on-device session. */
function promptFrom(messages: Message[]): string {
  const turns = messages.filter((m): m is Extract<Message, { role: "user" }> | Extract<Message, { role: "assistant" }> => m.role !== "tool");
  const last = turns.at(-1);
  if (!last || last.role !== "user") return "";
  const earlier = turns
    .slice(0, -1)
    .filter((m) => (m.role === "user" ? m.content : m.text))
    .slice(-6)
    .map((m) => (m.role === "user" ? `User: ${m.content}` : `Assistant: ${m.text}`));
  return earlier.length ? `Earlier in this conversation:\n${earlier.join("\n")}\n\nThe user now says: ${last.content}` : last.content;
}

type HelperEvent =
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "final"; text: string }
  | { type: "error"; code: string; message: string };

/**
 * Apple's on-device model (Apple Intelligence) via a small Swift helper.
 * Free, private and needs no setup. The helper hands every tool call back,
 * so actions still go through the kernel like any other model.
 */
export class AppleOnDeviceProvider implements ModelProvider {
  readonly id = "apple:on-device";
  readonly label = "Built-in (Apple, on this Mac)";
  readonly locality = "local" as const;
  readonly compact = true;

  private child?: ChildProcess;
  private events: HelperEvent[] = [];
  private waiter?: (e: HelperEvent) => void;
  private answered = new Set<string>();

  constructor(private helper = appleHelperPath()) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.child) this.start(req);
    else this.sendResults(req.messages);

    // Collect everything the helper has said; tool calls may arrive together.
    const first = await this.next(req.signal);
    const batch = [first];
    while (first.type === "tool_call" && this.events[0]?.type === "tool_call") batch.push(this.events.shift()!);

    if (first.type === "error") {
      this.dispose();
      throw new ProviderError(friendly(first));
    }
    if (first.type === "final") {
      this.dispose();
      return { text: first.text, toolCalls: [] };
    }
    const toolCalls: ToolCall[] = batch.filter((e): e is Extract<HelperEvent, { type: "tool_call" }> => e.type === "tool_call").map((e) => ({ id: e.id, name: e.name, args: e.arguments ?? {} }));
    return { text: "", toolCalls };
  }

  dispose(): void {
    this.child?.stdin?.end();
    this.child?.kill();
    this.child = undefined;
  }

  private start(req: ChatRequest): void {
    if (!existsSync(this.helper)) throw new ProviderError("The built-in model helper isn't built. Run npm run build.");
    const prompt = promptFrom(req.messages);
    const child = spawn(this.helper, [], { stdio: ["pipe", "pipe", "ignore"] });
    this.child = child;
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let e: HelperEvent;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = undefined;
        w(e);
      } else this.events.push(e);
    });
    // "close" fires after all output is read, so a final answer is never mistaken for a crash.
    child.on("close", () => {
      const e: HelperEvent = { type: "error", code: "exit", message: "The built-in model stopped unexpectedly." };
      if (this.waiter) this.waiter(e);
      else if (this.child === child) this.events.push(e);
    });
    child.stdin!.write(JSON.stringify({ type: "start", instructions: req.system, prompt, tools: pickTools(req.tools, prompt) }) + "\n");
  }

  private sendResults(messages: Message[]): void {
    for (const m of messages) {
      if (m.role !== "tool" || this.answered.has(m.callId)) continue;
      this.answered.add(m.callId);
      const content = m.content.length > MAX_RESULT_CHARS ? `${m.content.slice(0, MAX_RESULT_CHARS)}\n… [shortened]` : m.content;
      this.child?.stdin?.write(JSON.stringify({ type: "tool_result", id: m.callId, content }) + "\n");
    }
  }

  private next(signal?: AbortSignal): Promise<HelperEvent> {
    const queued = this.events.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        this.dispose();
        reject(new ProviderError("The built-in model took too long to answer."));
      }, 120_000);
      const onAbort = () => {
        clearTimeout(timer);
        this.dispose();
        reject(Object.assign(new Error("Stopped."), { name: "AbortError" }));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = (e) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(e);
      };
    });
  }
}

function friendly(e: { code: string; message: string }): string {
  switch (e.code) {
    case "context":
      return "That was too much for the built-in model to keep in mind. Try a shorter request, or switch to a cloud model in Settings for bigger tasks.";
    case "guardrail":
      return "Apple's built-in model declined this request. Try rephrasing, or use a cloud model in Settings.";
    case "unavailable":
      return e.message;
    case "busy":
      return "The built-in model is busy. Try again in a moment.";
    default:
      return `Built-in model: ${e.message}`;
  }
}
