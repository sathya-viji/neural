import { createServer, type Server } from "node:http";
import { createHash, createPublicKey, createVerify, randomBytes, randomUUID, type JsonWebKey } from "node:crypto";
import type { ChatGPTStatus } from "@uab/protocol";
import type { Vault } from "./vault.js";

/**
 * "Sign in with ChatGPT": use the user's ChatGPT Plus/Pro plan for model
 * requests, with no API key. Follows OpenAI's flow for open-source, locally
 * hosted apps (developers.openai.com/siwc/token-sharing-open-source).
 *
 * The kernel keeps the tokens and makes the model calls itself, so the
 * tokens never leave the kernel: the app sends a request body, the kernel
 * returns the model's output.
 */

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const APP_NAME = "Unified AI Base";
const V_ACCOUNT = "chatgpt.account";
const V_HOST = "chatgpt.host";

interface Account {
  clientId: string;
  subject: string;
  email?: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  savedAt: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export class ChatGPTError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

export class ChatGPTAccount {
  private vault?: Vault;
  private account: Account | null = null;
  private hostId = "";
  private pending?: { server: Server; timer: NodeJS.Timeout };
  private lastError?: string;
  onChange: () => void = () => {};

  async init(vault: Vault): Promise<void> {
    this.vault = vault;
    this.account = parse<Account>(await vault.get(V_ACCOUNT));
    // One opaque, persistent id per installation ("host"), as the docs require.
    this.hostId = (await vault.get(V_HOST)) ?? "";
    if (!this.hostId.startsWith("urn:uuid:")) {
      this.hostId = `urn:uuid:${randomUUID()}`;
      await vault.set(V_HOST, this.hostId);
    }
  }

  status(): ChatGPTStatus {
    return {
      connected: !!this.account,
      email: this.account?.email,
      connecting: !!this.pending,
      error: this.lastError,
    };
  }

  /** Start sign-in. Returns OpenAI's page to open; finishes in the background. */
  async connect(): Promise<{ url: string }> {
    this.cancelPending();
    this.lastError = undefined;
    const previous = this.account;
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(16));
    const nonce = base64url(randomBytes(16));

    // Loopback on 127.0.0.1 (not "localhost"); only the port may vary between sign-ins.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const redirectUri = `http://127.0.0.1:${port}/auth/callback`;

    server.on("request", async (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/auth/callback") return void res.writeHead(404).end();
      const finish = (ok: boolean, message: string) => {
        res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
        res.end(page(ok, message));
        if (!ok) this.lastError = message;
        this.cancelPending();
        this.onChange();
      };
      if (url.searchParams.get("state") !== state) return finish(false, "This sign-in link doesn't match. Start again from the app.");
      if (url.searchParams.get("error")) {
        return finish(false, url.searchParams.get("error") === "access_denied" ? "You didn't allow access. Nothing was connected." : `OpenAI said: ${url.searchParams.get("error_description") ?? url.searchParams.get("error")}`);
      }
      const code = url.searchParams.get("code");
      const returnedClient = url.searchParams.get("client_id");
      // New registrations return the issued client id; re-authorisations may omit it but must not change it.
      const clientId = previous?.clientId ?? returnedClient;
      if (!code || !clientId) return finish(false, "OpenAI didn't finish registering this app. Please try again.");
      if (previous && returnedClient && returnedClient !== previous.clientId) return finish(false, "OpenAI returned a different app registration. Please try again.");
      try {
        const t = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE });
        if (!t.id_token || !t.refresh_token) throw new ChatGPTError("OpenAI didn't return a complete sign-in.");
        const claims = await verifyIdToken(t.id_token, clientId, nonce);
        const scopes = (t.scope ?? "").split(/\s+/).filter(Boolean);
        if (!scopes.includes(PLAN_SCOPE)) {
          throw new ChatGPTError("You signed in, but didn't allow the app to use your ChatGPT plan. Try again and allow \"Use your ChatGPT plan\".");
        }
        if (previous && previous.subject !== claims.sub) throw new ChatGPTError("That's a different ChatGPT account. Sign out first to switch accounts.");
        this.account = {
          clientId,
          subject: String(claims.sub),
          email: typeof claims.email === "string" ? claims.email : undefined,
          idToken: t.id_token,
          accessToken: t.access_token,
          refreshToken: t.refresh_token,
          expiresAt: Date.now() + ((t.expires_in ?? 3600) - 60) * 1000,
          scopes,
          savedAt: new Date().toISOString(),
        };
        await this.save();
        finish(true, `ChatGPT${this.account.email ? ` (${this.account.email})` : ""} is connected. You can close this tab and go back to the app.`);
      } catch (err) {
        finish(false, (err as Error).message);
      }
    });
    this.pending = { server, timer: setTimeout(() => (this.cancelPending(), this.onChange()), 5 * 60 * 1000) };
    this.onChange();

    const params = new URLSearchParams({
      client_id: previous?.clientId ?? "dynamic_agent_client",
      ext_agent_host_id: this.hostId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    if (previous) {
      params.set("id_token_hint", previous.idToken);
      if (previous.email) params.set("login_hint", previous.email);
    } else {
      params.set("agent_name_hint", APP_NAME);
    }
    return { url: `${AUTHORIZE_URL}?${params}` };
  }

  async disconnect(): Promise<void> {
    this.account = null;
    this.lastError = undefined;
    await this.vault!.set(V_ACCOUNT, "null");
    this.onChange();
  }

  /** Models this account may use, as { slug, name }. */
  async models(): Promise<{ slug: string; name: string }[]> {
    const res = await fetch(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw await apiError(res);
    const body = (await res.json()) as { models?: { slug: string; display_name?: string; visibility?: string }[]; data?: { id: string }[] };
    if (body.models) return body.models.filter((m) => m.visibility === "list").map((m) => ({ slug: m.slug, name: m.display_name ?? m.slug }));
    return (body.data ?? []).map((m) => ({ slug: m.id, name: m.id }));
  }

  /**
   * One Responses API request on the user's plan. The caller supplies the body;
   * the kernel adds the credentials and the plan's required settings.
   */
  async respond(body: Record<string, unknown>, timeoutMs = 120_000): Promise<{ output: unknown[] }> {
    // Settings the plan route requires or rejects (see the preview limitations page).
    const request: Record<string, unknown> = { ...body, store: false, stream: true };
    for (const k of ["previous_response_id", "temperature", "top_p", "max_output_tokens", "metadata", "user", "truncation", "background"]) delete request[k];

    const send = async () =>
      fetch(`${RESOURCE}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    let res = await send();
    if (res.status === 401 && this.account) {
      // The access token may have been revoked early; one refresh, then give up.
      this.account.expiresAt = 0;
      res = await send();
    }
    if (!res.ok || !res.body) throw await apiError(res);

    // Server-sent events; success only once response.completed arrives.
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (!data || data === "[DONE]") continue;
        let event: { type?: string; response?: { output?: unknown[]; error?: { code?: string; message?: string }; incomplete_details?: { reason?: string } }; error?: { code?: string; message?: string } };
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.type === "response.completed") return { output: event.response?.output ?? [] };
        if (event.type === "response.failed" || event.type === "error") {
          const e = event.response?.error ?? event.error ?? {};
          throw new ChatGPTError(friendly(e.code, e.message), e.code);
        }
        if (event.type === "response.incomplete") {
          throw new ChatGPTError(`ChatGPT stopped early (${event.response?.incomplete_details?.reason ?? "incomplete"}).`, "incomplete");
        }
      }
    }
    throw new ChatGPTError("The connection to ChatGPT ended before the answer finished. Try again.", "interrupted");
  }

  private async accessToken(): Promise<string> {
    const a = this.account;
    if (!a) throw new ChatGPTError("ChatGPT isn't connected. Sign in under Settings.", "not_connected");
    if (a.expiresAt > Date.now()) return a.accessToken;
    let t: TokenResponse;
    try {
      t = await tokenRequest({ grant_type: "refresh_token", client_id: a.clientId, refresh_token: a.refreshToken, resource: RESOURCE });
    } catch (err) {
      const code = (err as ChatGPTError).code ?? "";
      if (/invalid_grant|invalid_refresh_token|token_expired|refresh_token_/.test(code)) {
        this.account = null;
        await this.vault!.set(V_ACCOUNT, "null");
        this.onChange();
        throw new ChatGPTError("Your ChatGPT sign-in has expired. Sign in again under Settings.", "signed_out");
      }
      throw err;
    }
    // Access token, expiry, scopes and the rotated refresh token are replaced together.
    this.account = {
      ...a,
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? a.refreshToken,
      expiresAt: Date.now() + ((t.expires_in ?? 3600) - 60) * 1000,
      scopes: t.scope ? t.scope.split(/\s+/).filter(Boolean) : a.scopes,
      savedAt: new Date().toISOString(),
    };
    await this.save();
    return this.account.accessToken;
  }

  private async save(): Promise<void> {
    await this.vault!.set(V_ACCOUNT, JSON.stringify(this.account));
  }

  private cancelPending(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.server.close();
    this.pending = undefined;
  }
}

export const chatgpt = new ChatGPTAccount();

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

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, { method: "POST", body: new URLSearchParams(form), signal: AbortSignal.timeout(20_000) });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) throw new ChatGPTError(body.error_description || body.error || `sign-in failed (${res.status})`, body.error);
  return body;
}

/** Validate the ID token: OpenAI's signature (from its published keys), issuer, audience, expiry and our nonce. */
export async function verifyIdToken(token: string, audience: string, nonce: string, jwksUrl = JWKS_URL): Promise<Record<string, unknown>> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new ChatGPTError("OpenAI returned a malformed sign-in token.");
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string; kid?: string };
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
  if (header.alg !== "RS256") throw new ChatGPTError(`Unexpected sign-in token type (${header.alg}).`);
  const jwks = (await (await fetch(jwksUrl, { signal: AbortSignal.timeout(15_000) })).json()) as { keys: (JsonWebKey & { kid?: string })[] };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new ChatGPTError("Couldn't find OpenAI's signing key for this sign-in.");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  if (!verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"))) {
    throw new ChatGPTError("The sign-in token's signature isn't valid.");
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER) throw new ChatGPTError("The sign-in token wasn't issued by OpenAI.");
  if (!aud.includes(audience)) throw new ChatGPTError("The sign-in token is for a different app.");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 60_000) throw new ChatGPTError("The sign-in token has expired. Try again.");
  if (claims.nonce !== nonce) throw new ChatGPTError("The sign-in token doesn't match this attempt. Try again.");
  return claims;
}

async function apiError(res: Response): Promise<ChatGPTError> {
  const text = await res.text().catch(() => "");
  let code: string | undefined;
  let message = text.slice(0, 300);
  try {
    const body = JSON.parse(text) as { error?: { code?: string; message?: string }; detail?: string };
    code = body.error?.code;
    message = body.error?.message ?? body.detail ?? message;
  } catch {
    /* not JSON */
  }
  if (!code && res.status === 401) code = "unauthorized";
  if (!code && res.status === 403) code = "forbidden";
  if (!code && res.status === 503) code = "unavailable";
  return new ChatGPTError(friendly(code, message), code);
}

/** OpenAI's documented plan-usage errors, in plain language. */
function friendly(code?: string, message?: string): string {
  switch (code) {
    case "subscription_sharing_user_not_eligible":
      return "Your ChatGPT plan can't be used in other apps. This needs ChatGPT Plus or Pro.";
    case "subscription_sharing_usage_limit_exceeded":
      return "You've reached your ChatGPT plan's usage limit for apps. Check ChatGPT → Settings → Usage, or switch to the built-in model.";
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
    case "unavailable":
      return "ChatGPT isn't available right now. Try again in a minute.";
    case "subscription_sharing_invalid_user":
    case "unauthorized":
      return "ChatGPT didn't accept the sign-in. Sign in again under Settings.";
    case "forbidden":
      return `ChatGPT blocked this request${message ? `: ${message}` : "."}`;
    case "subscription_sharing_unsupported_capability":
      return `ChatGPT plan usage doesn't support part of this request${message ? `: ${message}` : "."}`;
    default:
      return `ChatGPT: ${message || code || "request failed"}`;
  }
}

function page(ok: boolean, message: string): string {
  const safe = message.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
  return `<!doctype html><meta charset="utf-8"><title>Unified AI Base</title>
<body style="font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;background:#14161a;color:#e8e9ec">
<div style="max-width:440px;text-align:center"><div style="font-size:40px">${ok ? "✓" : "✕"}</div><p>${safe}</p></div></body>`;
}
