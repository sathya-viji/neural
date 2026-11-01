import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { GmailStatus } from "@uab/protocol";
import type { BuiltinCapability } from "./types.js";
import { str, strList } from "./types.js";
import { insideRoots } from "./files.js";
import { buildMime, checkRecipients } from "./mime.js";
import type { Vault } from "../vault.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
// Read mail, and create drafts / send. Nothing that deletes or changes settings.
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"];

const V_CLIENT = "gmail.client";
const V_TOKEN = "gmail.token";

interface ClientConfig {
  clientId: string;
  clientSecret: string;
}

interface Token {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  email: string;
}

/**
 * The user's Gmail account. The kernel signs in through Google's own page in
 * the browser (OAuth with PKCE) and keeps the tokens in the vault. Models and
 * the app window never see them.
 */
export class GmailAccount {
  private vault?: Vault;
  private token: Token | null = null;
  private client: ClientConfig | null = null;
  private pending?: { server: Server; timer: NodeJS.Timeout };
  onChange: () => void = () => {};

  async init(vault: Vault): Promise<void> {
    this.vault = vault;
    this.client = parse<ClientConfig>(await vault.get(V_CLIENT));
    this.token = parse<Token>(await vault.get(V_TOKEN));
  }

  get connected(): boolean {
    return !!this.token;
  }

  status(): GmailStatus {
    return { configured: !!this.client, connected: !!this.token, email: this.token?.email, connecting: !!this.pending };
  }

  async configure(clientId: string, clientSecret: string): Promise<void> {
    clientId = clientId.trim();
    clientSecret = clientSecret.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error("That doesn't look like a Google OAuth Client ID (it ends in .apps.googleusercontent.com).");
    if (clientSecret.length < 10) throw new Error("The client secret looks incomplete.");
    this.client = { clientId, clientSecret };
    await this.vault!.set(V_CLIENT, JSON.stringify(this.client));
    this.onChange();
  }

  /** Start sign-in. Returns the Google page to open; finishes in the background. */
  async connect(): Promise<{ url: string }> {
    if (!this.client) throw new Error("Add your Google OAuth Client ID first.");
    this.cancelPending();
    const client = this.client;
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(16));

    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const redirectUri = `http://127.0.0.1:${port}`;

    server.on("request", async (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/") return void res.writeHead(404).end();
      const done = (ok: boolean, message: string) => {
        res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
        res.end(page(ok, message));
        this.cancelPending();
        this.onChange();
      };
      if (url.searchParams.get("state") !== state) return done(false, "This sign-in link doesn't match. Start again from the app.");
      const code = url.searchParams.get("code");
      if (!code) return done(false, url.searchParams.get("error") === "access_denied" ? "You didn't allow access. Nothing was connected." : "Google didn't return a sign-in code.");
      try {
        const t = await tokenRequest({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          client_id: client.clientId,
          client_secret: client.clientSecret,
        });
        if (!t.refresh_token) throw new Error("Google didn't grant offline access. Remove the app at myaccount.google.com/permissions and connect again.");
        const profile = await fetch(`${API}/profile`, { headers: { authorization: `Bearer ${t.access_token}` } }).then((r) => r.json() as Promise<{ emailAddress?: string }>);
        this.token = { refreshToken: t.refresh_token, accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000, email: profile.emailAddress ?? "unknown" };
        await this.vault!.set(V_TOKEN, JSON.stringify(this.token));
        done(true, `Gmail (${this.token.email}) is connected. You can close this tab and go back to the app.`);
      } catch (err) {
        done(false, (err as Error).message);
      }
    });
    this.pending = { server, timer: setTimeout(() => (this.cancelPending(), this.onChange()), 5 * 60 * 1000) };
    this.onChange();

    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent",
    });
    return { url: `${AUTH_URL}?${params}` };
  }

  async disconnect(): Promise<void> {
    if (this.token) {
      await fetch(`${REVOKE_URL}?token=${encodeURIComponent(this.token.refreshToken)}`, { method: "POST" }).catch(() => {});
    }
    this.token = null;
    await this.vault!.set(V_TOKEN, "null");
    this.onChange();
  }

  /** Authorised call to the Gmail API, refreshing the access token when needed. */
  async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.token || !this.client) throw new Error("Gmail isn't connected. Connect it under Services.");
    if (!this.token.accessToken || (this.token.expiresAt ?? 0) < Date.now()) {
      const t = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: this.token.refreshToken,
        client_id: this.client.clientId,
        client_secret: this.client.clientSecret,
      }).catch((err: Error) => {
        throw new Error(`Gmail sign-in has expired or was removed (${err.message}). Connect it again under Services.`);
      });
      this.token = { ...this.token, accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
      await this.vault!.set(V_TOKEN, JSON.stringify(this.token));
    }
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token.accessToken}`, "content-type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Gmail ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  private cancelPending(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.server.close();
    this.pending = undefined;
  }
}

export const gmail = new GmailAccount();

/* ---------------- helpers ---------------- */

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T | null;
  } catch {
    return null;
  }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

async function tokenRequest(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await fetch(TOKEN_URL, { method: "POST", body: new URLSearchParams(form), signal: AbortSignal.timeout(20_000) });
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(body.error_description || body.error || `token request failed (${res.status})`);
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in ?? 3600 };
}

export function page(ok: boolean, message: string): string {
  const safe = message.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
  return `<!doctype html><meta charset="utf-8"><title>Unified AI Base</title>
<body style="font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;background:#14161a;color:#e8e9ec">
<div style="max-width:440px;text-align:center"><div style="font-size:40px">${ok ? "✓" : "✕"}</div><p>${safe}</p></div></body>`;
}

interface Part {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  payload?: Part;
}

function headerOf(m: GmailMessage, name: string): string {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function findText(part: Part | undefined, type: string): string | null {
  if (!part) return null;
  if (part.mimeType === type && part.body?.data) return fromBase64url(part.body.data);
  for (const p of part.parts ?? []) {
    const t = findText(p, type);
    if (t) return t;
  }
  return null;
}

function attachmentNames(part: Part | undefined, out: string[] = []): string[] {
  if (!part) return out;
  if (part.filename) out.push(part.filename);
  for (const p of part.parts ?? []) attachmentNames(p, out);
  return out;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ---------------- capabilities ---------------- */

const composeSchema = {
  type: "object",
  properties: {
    to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
    subject: { type: "string" },
    body: { type: "string", description: "Plain-text message" },
    attachments: { type: "array", items: { type: "string" }, description: "Full file paths to attach" },
    replyTo: { type: "string", description: "Message id from gmail.search to reply to (keeps the conversation together)" },
  },
  required: ["to", "subject", "body"],
};

async function compose(args: Record<string, unknown>, ctx: Parameters<BuiltinCapability["run"]>[1]) {
  const to = strList(args, "to");
  checkRecipients(to);
  const attachments = await Promise.all(strList(args, "attachments").map((p) => insideRoots(p, ctx)));
  const extraHeaders: Record<string, string> = {};
  let threadId: string | undefined;
  const replyTo = str(args, "replyTo", false);
  if (replyTo) {
    const original = await gmail.api<GmailMessage>(`/messages/${encodeURIComponent(replyTo)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`);
    const msgId = headerOf(original, "Message-ID");
    if (msgId) {
      extraHeaders["In-Reply-To"] = msgId;
      extraHeaders["References"] = `${headerOf(original, "References")} ${msgId}`.trim();
    }
    threadId = original.threadId;
  }
  const raw = await buildMime({ to, subject: str(args, "subject"), body: str(args, "body"), attachments, extraHeaders });
  return { raw: base64url(Buffer.from(raw, "utf8")), threadId, to, attachments };
}

function composeSummary(verb: string) {
  return (a: Record<string, unknown>) => {
    const files = strList(a, "attachments").map((p) => basename(p));
    return `${verb} ${strList(a, "to").join(", ")} from ${gmail.status().email ?? "your Gmail"} — "${a.subject}"${files.length ? ` with ${files.join(", ")}` : ""}`;
  };
}

const onlyWhenConnected = () => gmail.connected;

export const gmailCapabilities: BuiltinCapability[] = [
  {
    id: "gmail.search",
    service: "gmail",
    title: "Search Gmail",
    // Examples avoid real-looking names: small models tend to copy them literally.
    description:
      "Find emails in the user's Gmail, newest first. Leave query empty for the latest emails in the inbox. Otherwise use Gmail search words such as is:unread, newer_than:7d, has:attachment, subject:WORD or from:NAME.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional Gmail search. Empty means the latest inbox emails." },
        limit: { type: "number", description: "Maximum results (default 10)" },
      },
    },
    effects: ["read"],
    risk: "low",
    available: onlyWhenConnected,
    summarize: (a) => (a.query ? `Search your Gmail for "${a.query}"` : "Look at your latest Gmail emails"),
    async run(args) {
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(args.limit, 25)) : 10;
      const query = str(args, "query", false) || "in:inbox";
      const list = await gmail.api<{ messages?: { id: string }[] }>(`/messages?q=${encodeURIComponent(query)}&maxResults=${limit}`);
      const ids = (list.messages ?? []).map((m) => m.id);
      if (!ids.length) return { content: `No emails match "${query}".`, data: [] };
      const messages = await Promise.all(
        ids.map((id) => gmail.api<GmailMessage>(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)),
      );
      const rows = messages.map((m) => ({
        id: m.id,
        from: headerOf(m, "From"),
        subject: headerOf(m, "Subject"),
        date: headerOf(m, "Date"),
        // Gmail returns snippets HTML-escaped (&gt;, &#39;).
        snippet: htmlToText(m.snippet ?? ""),
        unread: m.labelIds?.includes("UNREAD") ?? false,
      }));
      return {
        content: rows.map((r) => `${r.unread ? "[unread] " : ""}${r.date} — ${r.from} — "${r.subject}"\n  ${r.snippet} (id ${r.id})`).join("\n"),
        data: rows,
      };
    },
  },
  {
    id: "gmail.read",
    service: "gmail",
    title: "Read an email",
    description: "Read the full text of one Gmail message. Get the id from gmail.search.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Message id from gmail.search" } }, required: ["id"] },
    effects: ["read"],
    risk: "low",
    available: onlyWhenConnected,
    summarize: () => "Read an email",
    async run(args) {
      const m = await gmail.api<GmailMessage>(`/messages/${encodeURIComponent(str(args, "id"))}?format=full`);
      const text = findText(m.payload, "text/plain") ?? htmlToText(findText(m.payload, "text/html") ?? m.snippet ?? "");
      const files = attachmentNames(m.payload);
      const max = 20_000;
      return {
        content: [
          `From: ${headerOf(m, "From")}`,
          `To: ${headerOf(m, "To")}`,
          `Date: ${headerOf(m, "Date")}`,
          `Subject: ${headerOf(m, "Subject")}`,
          files.length ? `Attachments: ${files.join(", ")}` : "",
          "",
          text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text,
        ]
          .filter((l, i) => l !== "" || i === 5)
          .join("\n"),
        data: { id: m.id, threadId: m.threadId },
      };
    },
  },
  {
    id: "gmail.draft",
    service: "gmail",
    title: "Create a Gmail draft",
    description:
      "Create a draft in the user's Gmail, ready for them to review and send from Gmail on any device. Prefer this unless the user clearly asked for the email to be sent. Use replyTo to answer an existing email.",
    inputSchema: composeSchema,
    effects: ["write"],
    risk: "medium",
    available: onlyWhenConnected,
    summarize: composeSummary("Create a Gmail draft to"),
    async run(args, ctx) {
      const c = await compose(args, ctx);
      const draft = await gmail.api<{ id: string; message: { id: string } }>("/drafts", {
        method: "POST",
        body: JSON.stringify({ message: { raw: c.raw, ...(c.threadId ? { threadId: c.threadId } : {}) } }),
      });
      return {
        content: `Draft to ${c.to.join(", ")} saved in Gmail (Drafts folder). It has NOT been sent.`,
        data: { draftId: draft.id, messageId: draft.message.id },
      };
    },
    async verify(_args, result) {
      const id = (result.data as { draftId?: string } | undefined)?.draftId;
      if (!id) return false;
      return gmail.api(`/drafts/${id}?format=minimal`).then(() => true, () => false);
    },
  },
  {
    id: "gmail.send",
    service: "gmail",
    title: "Send with Gmail",
    description: "Send an email right away from the user's Gmail, optionally with attachments from the shared folders. Use replyTo to answer an existing email.",
    inputSchema: composeSchema,
    effects: ["send"],
    risk: "high",
    available: onlyWhenConnected,
    summarize: composeSummary("Send an email to"),
    async run(args, ctx) {
      const c = await compose(args, ctx);
      const sent = await gmail.api<{ id: string }>("/messages/send", {
        method: "POST",
        body: JSON.stringify({ raw: c.raw, ...(c.threadId ? { threadId: c.threadId } : {}) }),
      });
      const files = c.attachments.length ? ` with ${c.attachments.map((p) => basename(p)).join(", ")}` : "";
      return { content: `Sent from Gmail (${gmail.status().email}) to ${c.to.join(", ")}${files}.`, data: { messageId: sent.id } };
    },
    async verify(_args, result) {
      const id = (result.data as { messageId?: string } | undefined)?.messageId;
      if (!id) return false;
      const m = await gmail.api<GmailMessage>(`/messages/${id}?format=minimal`).catch(() => null);
      return !!m?.labelIds?.includes("SENT");
    },
  },
];
