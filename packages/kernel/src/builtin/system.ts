import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BuiltinCapability } from "./types.js";
import { str } from "./types.js";
import { insideRoots } from "./files.js";

const run = promisify(execFile);

function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export const systemCapabilities: BuiltinCapability[] = [
  {
    id: "system.now",
    service: "system",
    title: "Current date and time",
    description: "Get the current local date, time and time zone.",
    inputSchema: { type: "object", properties: {} },
    effects: ["read"],
    risk: "low",
    summarize: () => "Check the date and time",
    async run() {
      const now = new Date();
      return {
        content: `${now.toString()} (ISO ${now.toISOString()}, zone ${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
      };
    },
  },
  {
    id: "system.notify",
    service: "system",
    title: "Show a notification",
    description: "Show a desktop notification to the user.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, message: { type: "string" } },
      required: ["title", "message"],
    },
    effects: ["device"],
    risk: "low",
    summarize: (a) => `Show a notification: "${a.title}"`,
    async run(args) {
      const title = str(args, "title");
      const message = str(args, "message");
      if (process.platform !== "darwin") return { content: `Notification: ${title} — ${message}` };
      await run("osascript", ["-e", `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`]);
      return { content: "Notification shown." };
    },
  },
  {
    id: "system.open",
    service: "system",
    title: "Open a file or web page",
    description: "Open a file from the shared folders in its default app, or open an https:// link in the browser.",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string", description: "Full file path or https:// URL" } },
      required: ["target"],
    },
    effects: ["device"],
    risk: "medium",
    summarize: (a) => `Open ${a.target}`,
    async run(args, ctx) {
      const target = str(args, "target");
      let resolved: string;
      if (/^https:\/\//i.test(target)) resolved = target;
      else if (/^[a-z]+:/i.test(target)) throw new Error("Only https:// links and local files can be opened");
      else resolved = await insideRoots(target, ctx);
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      await run(opener, [resolved]);
      return { content: `Opened ${resolved}` };
    },
  },
];
