import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

export const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".rtf": "application/rtf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

function wrap64(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n");
}

/** Header values with non-ASCII text (names, emoji) must be encoded. */
function header(value: string): string {
  const clean = value.replace(/[\r\n]/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

export interface MimeMessage {
  from?: string;
  to: string[];
  subject: string;
  body: string;
  /** Absolute paths, already checked against the user's shared folders. */
  attachments?: string[];
  extraHeaders?: Record<string, string>;
}

/** A standard multipart email that any mail system accepts. */
export async function buildMime(m: MimeMessage): Promise<string> {
  const boundary = `uab-${randomUUID()}`;
  const lines = [
    ...(m.from ? [`From: ${m.from}`] : []),
    `To: ${m.to.join(", ")}`,
    `Subject: ${header(m.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@unified-ai-base.local>`,
    ...Object.entries(m.extraHeaders ?? {}).map(([k, v]) => `${k}: ${header(v)}`),
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    wrap64(Buffer.from(m.body, "utf8").toString("base64")),
  ];
  for (const path of m.attachments ?? []) {
    const name = basename(path).replace(/"/g, "");
    const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    lines.push(
      `--${boundary}`,
      `Content-Type: ${type}; name="${header(name)}"`,
      `Content-Disposition: attachment; filename="${header(name)}"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      wrap64((await readFile(path)).toString("base64")),
    );
  }
  lines.push(`--${boundary}--`, ``);
  return lines.join("\r\n");
}

export function checkRecipients(to: string[]): void {
  if (!to.length) throw new Error("At least one recipient is required");
  for (const addr of to) if (!EMAIL.test(addr)) throw new Error(`"${addr}" is not an email address`);
}
