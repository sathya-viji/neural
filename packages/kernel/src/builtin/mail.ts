import { mkdir, writeFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { BuiltinCapability } from "./types.js";
import { str, strList } from "./types.js";
import { insideRoots } from "./files.js";
import { buildMime, checkRecipients } from "./mime.js";

/**
 * A local outbox: messages are written as standard .eml files that any mail
 * app can open. Nothing leaves the machine. Used for tests and on systems
 * without a real mail service connected.
 */
export const mailCapabilities: BuiltinCapability[] = [
  {
    id: "mail.send",
    service: "mail",
    title: "Save an email to the outbox (demo, not delivered)",
    description:
      "Send an email, optionally with file attachments from the shared folders. This built-in service saves the message to the local outbox as an .eml file; it is not delivered over the internet.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text message" },
        attachments: { type: "array", items: { type: "string" }, description: "Full file paths to attach" },
      },
      required: ["to", "subject", "body"],
    },
    effects: ["send"],
    risk: "high",
    summarize(a) {
      const to = strList(a, "to").join(", ");
      const files = strList(a, "attachments").map((p) => basename(p));
      return `Save an email to ${to} in the outbox — "${a.subject}"${files.length ? ` with ${files.join(", ")}` : ""} (not delivered)`;
    },
    async run(args, ctx) {
      const to = strList(args, "to");
      checkRecipients(to);
      const attachments = await Promise.all(strList(args, "attachments").map((p) => insideRoots(p, ctx)));
      const raw = await buildMime({
        from: "me@localhost",
        to,
        subject: str(args, "subject"),
        body: str(args, "body"),
        attachments,
        extraHeaders: { "X-Unsent": "1" },
      });

      const dir = join(ctx.home, "outbox");
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.eml`);
      await writeFile(file, raw, { mode: 0o600 });
      return {
        content: `NOT delivered: this demo mail service only saves messages on this computer. The message for ${to.join(", ")}${attachments.length ? ` with ${attachments.length} attachment(s)` : ""} was saved to the local outbox at ${file}. Tell the user it was saved to the outbox, not sent.`,
        data: { file, to, attachments },
      };
    },
    async verify(_args, result) {
      const file = (result.data as { file?: string } | undefined)?.file;
      if (!file) return false;
      const s = await stat(file).catch(() => null);
      return !!s && s.size > 0;
    },
  },
];
