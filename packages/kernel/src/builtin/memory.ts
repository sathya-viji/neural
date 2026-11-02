import type { BuiltinCapability } from "./types.js";
import { str } from "./types.js";

/** Memory and history. Saving or forgetting anything asks the user first (it changes what the AI knows). */
export const memoryCapabilities: BuiltinCapability[] = [
  {
    id: "memory.remember",
    service: "memory",
    title: "Remember something",
    description:
      "Save a lasting fact or preference the user told you about themselves (e.g. 'Vegetarian', 'Prefers cash on delivery'), so it's known in future conversations. Only when the user says it or clearly wants it kept. Write it as a short note, without 'the user', e.g. 'Vegetarian' or 'Works from home on Fridays'.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "The fact or preference, in one short sentence" } }, required: ["text"] },
    effects: ["write"],
    risk: "medium",
    summarize: (a) => `Remember: "${str(a, "text")}"`,
    async run(args, ctx) {
      const m = ctx.context!.addMemory(str(args, "text"), "ai");
      return { content: `Remembered: ${m.text}`, data: { id: m.id } };
    },
    async verify(args, _result, ctx) {
      return ctx.context!.get().memories.some((m) => m.text.toLowerCase() === str(args, "text").trim().replace(/\s+/g, " ").toLowerCase());
    },
  },
  {
    id: "memory.forget",
    service: "memory",
    title: "Forget something",
    description: "Delete something the user asked you to remember, when they ask you to forget it. Describe it in a few words.",
    inputSchema: { type: "object", properties: { what: { type: "string", description: "What to forget, in a few words" } }, required: ["what"] },
    effects: ["delete"],
    risk: "medium",
    // The card shows the exact memory that would be deleted, found by the kernel.
    summarize: (a, ctx) => {
      const m = ctx.context!.findMemory(str(a, "what"));
      return m ? `Forget: "${m.text}"` : `Forget "${str(a, "what")}" (nothing saved matches, so nothing will change)`;
    },
    async run(args, ctx) {
      const m = ctx.context!.findMemory(str(args, "what"));
      if (!m) throw new Error("Nothing saved matches that.");
      ctx.context!.removeMemory(m.id);
      return { content: `Forgot: ${m.text}` };
    },
  },
  {
    id: "memory.recent",
    service: "memory",
    title: "Recent activity",
    description: "What the user asked for recently and how it went, newest first. Use for 'what did I do…', 'last time', 'again'.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional words to look for" },
        limit: { type: "number", description: "How many (default 10)" },
      },
    },
    effects: ["read"],
    risk: "low",
    summarize: () => "Look at recent activity",
    async run(args, ctx) {
      const search = typeof args.search === "string" ? args.search.toLowerCase() : "";
      const limit = Math.min(Number(args.limit) || 10, 50);
      const tasks = (ctx.recentTasks?.(300) ?? []).filter((t) => t.summary && (!search || `${t.intent} ${t.summary}`.toLowerCase().includes(search))).slice(0, limit);
      if (!tasks.length) return { content: search ? `Nothing recent matches "${search}".` : "Nothing yet." };
      return { content: tasks.map((t) => `${new Date(t.startedAt).toLocaleString()}: "${t.intent}" → ${t.summary!.replace(/\s+/g, " ").slice(0, 300)}`).join("\n") };
    },
  },
];
