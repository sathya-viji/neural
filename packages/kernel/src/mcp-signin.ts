import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Vault } from "./vault.js";
import { page } from "./builtin/gmail.js";

interface Saved {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

/**
 * Sign-in for an online MCP service (the MCP standard's OAuth with PKCE).
 * The user signs in on the service's own page in their browser; the kernel
 * keeps the tokens in the vault. Models and the app window never see them.
 */
export class McpSignIn implements OAuthClientProvider {
  private saved: Saved = {};
  private verifier = "";
  private stateValue = "";
  private redirect?: string;
  private onAuthUrl?: (url: URL) => void;

  constructor(private id: string, private vault: Vault) {}

  private get key(): string {
    return `service.${this.id}.signin`;
  }

  async load(): Promise<this> {
    this.saved = JSON.parse((await this.vault.get(this.key)) ?? "{}") ?? {};
    return this;
  }

  get signedIn(): boolean {
    return !!this.saved.tokens;
  }

  private async save(): Promise<void> {
    await this.vault.set(this.key, JSON.stringify(this.saved));
  }

  async signOut(): Promise<void> {
    this.saved = {};
    await this.save();
  }

  // --- OAuthClientProvider ---

  get redirectUrl(): string | undefined {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Unified AI Base",
      redirect_uris: this.redirect ? [this.redirect] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const c = this.saved.client;
    // A client registered for a different sign-in address can't be reused for a new sign-in.
    if (c && this.redirect && "redirect_uris" in c && !(c.redirect_uris as string[]).includes(this.redirect)) return undefined;
    return c;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.saved.client = info;
    await this.save();
  }

  tokens(): OAuthTokens | undefined {
    return this.saved.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.saved.tokens = tokens;
    await this.save();
  }

  redirectToAuthorization(url: URL): void {
    // In the background there's no one to sign in; the service shows "Sign in" instead.
    this.onAuthUrl?.(url);
  }

  saveCodeVerifier(v: string): void {
    this.verifier = v;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "client") delete this.saved.client;
    if (scope === "all" || scope === "tokens") delete this.saved.tokens;
    await this.save();
  }

  // --- Interactive sign-in ---

  /**
   * Start sign-in. Returns the service's page to open; when the browser comes
   * back, the tokens are saved and `onDone` runs.
   */
  async start(serverUrl: string, onDone: (error?: string) => void): Promise<{ url: string; cancel: () => void }> {
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    this.redirect = `http://127.0.0.1:${port}/callback`;
    this.stateValue = randomBytes(16).toString("base64url");
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: this });

    let finished = false;
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      server.close();
      transport.close().catch(() => {});
      this.onAuthUrl = undefined;
      onDone(error);
    };
    const timer = setTimeout(() => finish("Sign-in timed out. Start again from Services."), 5 * 60 * 1000);

    server.on("request", async (req, res) => {
      const url = new URL(req.url ?? "/", this.redirect);
      if (url.pathname !== "/callback") return void res.writeHead(404).end();
      const reply = (ok: boolean, message: string) => {
        res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
        res.end(page(ok, message));
      };
      if (url.searchParams.get("state") !== this.stateValue) return reply(false, "This sign-in link doesn't match. Start again from the app.");
      const code = url.searchParams.get("code");
      if (!code) {
        const error = url.searchParams.get("error_description") || url.searchParams.get("error") || "The service didn't return a sign-in code.";
        reply(false, error);
        return finish(error);
      }
      try {
        await transport.finishAuth(code);
        reply(true, `${this.id} is connected. You can close this tab and go back to the app.`);
        finish();
      } catch (err) {
        reply(false, (err as Error).message);
        finish((err as Error).message);
      }
    });

    // Asking for the service's tools without a valid token makes the SDK find
    // the service's sign-in server, register this app and build the sign-in link.
    let url: URL | undefined;
    this.onAuthUrl = (u) => (url = u);
    let failure: string | undefined;
    try {
      await transport.start();
      await withTimeout(
        transport.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "unified-ai-base-kernel", version: "0.1.0" } } }),
        20_000,
        "The service didn't respond.",
      );
      failure = "Already signed in.";
    } catch (err) {
      if (!url) failure = (err as Error).message;
    }
    if (!failure && url!.protocol !== "https:" && !isLoopback(url!)) failure = "The service's sign-in page isn't secure (https).";
    if (failure) {
      finish(failure);
      throw new Error(failure);
    }
    return { url: url!.toString(), cancel: () => finish("Sign-in cancelled.") };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

/** Plain http is only for services running on this computer (for example while developing one). */
export function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}
