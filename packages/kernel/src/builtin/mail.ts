import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { BuiltinCapability } from "./types.js";
import { str, strList } from "./types.js";
import { insideRoots } from "./files.js";

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function wrap64(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n");
}

/**
 * A local outbox: messages are written as standard .eml files that any mail
 * app can open. Nothing leaves the machine. Connect a real mail service
 * through MCP (Services tab) to deliver mail for real.
 */
export const mailCapabilities: BuiltinCapability[] = [
  {
    id: "mail.send",
    service: "mail",
    title: "Send an email (local outbox)",
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
      return `Email ${to} — "${a.subject}"${files.length ? ` with ${files.join(", ")}` : ""}`;
    },
    async run(args, ctx) {
      const to = strList(args, "to");
      if (!to.length) throw new Error("At least one recipient is required");
      for (const addr of to) if (!EMAIL.test(addr)) throw new Error(`"${addr}" is not an email address`);
      const subject = str(args, "subject");
      const body = str(args, "body");
      const attachments = await Promise.all(strList(args, "attachments").map((p) => insideRoots(p, ctx)));

      const boundary = `uab-${randomUUID()}`;
      const id = randomUUID();
      const parts = [
        `From: me@localhost`,
        `To: ${to.join(", ")}`,
        `Subject: ${subject.replace(/[\r\n]/g, " ")}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${id}@unified-ai-base.local>`,
        `X-Unsent: 1`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset=utf-8`,
        `Content-Transfer-Encoding: base64`,
        ``,
        wrap64(Buffer.from(body, "utf8").toString("base64")),
      ];
      for (const path of attachments) {
        const name = basename(path).replace(/"/g, "");
        parts.push(
          `--${boundary}`,
          `Content-Type: application/octet-stream; name="${name}"`,
          `Content-Disposition: attachment; filename="${name}"`,
          `Content-Transfer-Encoding: base64`,
          ``,
          wrap64((await readFile(path)).toString("base64")),
        );
      }
      parts.push(`--${boundary}--`, ``);

      const dir = join(ctx.home, "outbox");
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${id.slice(0, 8)}.eml`);
      await writeFile(file, parts.join("\r\n"), { mode: 0o600 });
      return {
        content: `Saved to the local outbox for ${to.join(", ")}${attachments.length ? ` with ${attachments.length} attachment(s)` : ""}. File: ${file}`,
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
