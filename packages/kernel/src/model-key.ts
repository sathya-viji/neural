import type { Vault } from "./vault.js";

const KEY = "model.cloud";
const ENDPOINT = "model.cloud.endpoint";
/** Cloud model providers the key may always be sent to. */
const KNOWN = ["https://generativelanguage.googleapis.com", "https://api.anthropic.com", "https://api.openai.com"];

/**
 * The cloud model API key (Gemini, Claude, OpenAI-compatible). The app asks the
 * kernel to make the request; the kernel adds the key and sends it only to the
 * provider's own address. The key itself never leaves the kernel.
 */
export class ModelKey {
  constructor(private vault: Vault) {}

  /** Save a key. `endpoint` is the provider address it's for (needed for providers that aren't built in). */
  async save(value: string, endpoint?: string): Promise<void> {
    await this.vault.set(KEY, value.trim());
    if (endpoint) await this.vault.set(ENDPOINT, new URL(endpoint).origin);
  }

  async has(): Promise<boolean> {
    return this.vault.has(KEY);
  }

  async fetch(req: { url: string; method?: string; body?: string; auth: "bearer" | "x-api-key"; headers?: Record<string, string>; timeoutMs?: number }): Promise<{ status: number; text: string }> {
    const key = await this.vault.get(KEY);
    if (!key) throw new Error("Add your cloud model API key in Settings first.");
    const origin = new URL(req.url).origin;
    const saved = await this.vault.get(ENDPOINT);
    if (!KNOWN.includes(origin) && origin !== saved) {
      throw new Error(`Your API key was saved for a different address. Paste the key again in Settings to use it with ${origin}.`);
    }
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    for (const h of Object.keys(headers)) if (/^(authorization|x-api-key)$/i.test(h)) delete headers[h];
    if (req.auth === "x-api-key") headers["x-api-key"] = key;
    else headers.authorization = `Bearer ${key}`;
    const res = await fetch(req.url, { method: req.method ?? "GET", headers, body: req.body, signal: AbortSignal.timeout(req.timeoutMs ?? 60_000) });
    return { status: res.status, text: await res.text() };
  }
}
