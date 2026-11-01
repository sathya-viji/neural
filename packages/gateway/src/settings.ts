import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai.js";
import { AppleOnDeviceProvider } from "./providers/apple.js";
import { ChatGPTPlanProvider } from "./providers/chatgpt.js";
import type { ModelProvider } from "./providers/types.js";
import type { KernelCaller } from "./gateway.js";

/** chatgpt: the user's ChatGPT plan via sign-in (no key). The others use an API key. */
export type CloudKind = "chatgpt" | "gemini" | "anthropic" | "openai-compatible";

/** Which model the user picked. Models are replaceable; this is the only place that knows them. */
export interface ModelSettings {
  /** builtin: the model that comes with the device (Apple Intelligence). local: a model server like Ollama. */
  active: "builtin" | "local" | "cloud";
  local: { baseUrl: string; model: string };
  cloud: { kind: CloudKind; model: string; baseUrl?: string; fallbacks?: string[] };
}

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const GEMINI_FALLBACK_MODEL = "gemini-flash-latest";

export function defaultModelSettings(): ModelSettings {
  return {
    // Works with no setup on Macs with Apple Intelligence; the host falls back when it isn't available.
    active: "builtin",
    local: { baseUrl: "http://localhost:11434/v1", model: "qwen3:8b" },
    cloud: { kind: "gemini", model: "" },
  };
}

export function describeModelSettings(s: ModelSettings): string {
  if (s.active === "builtin") return "Built-in · on this Mac";
  return s.active === "local" ? `Local · ${s.local.model}` : `Cloud · ${s.cloud.model || cloudDefaultModel(s.cloud.kind)}`;
}

export function cloudDefaultModel(kind: CloudKind): string {
  return kind === "gemini" ? GEMINI_FALLBACK_MODEL : kind === "anthropic" ? "claude-sonnet-5-5" : kind === "chatgpt" ? "ChatGPT" : "";
}

/** Where a cloud provider lists its models (OpenAI-style GET /models). */
export function cloudModelsUrl(s: ModelSettings["cloud"]): string | null {
  if (s.kind === "gemini") return `${GEMINI_BASE_URL}/models`;
  if (s.kind === "openai-compatible") return `${(s.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "")}/models`;
  return null;
}

/**
 * From a Gemini model list, rank the plain "flash" models (fast, capable, on the free tier),
 * newest first, then the "flash-lite" ones as a last resort.
 */
export function rankGeminiModels(ids: string[]): string[] {
  const version = (id: string, suffix: string) => parseFloat(id.match(new RegExp(`^gemini-(\\d+(?:\\.\\d+)?)-${suffix}$`))?.[1] ?? "0");
  const byVersion = (suffix: string) => ids.filter((id) => version(id, suffix) > 0).sort((a, b) => version(b, suffix) - version(a, suffix));
  return [...byVersion("flash"), ...byVersion("flash-lite")];
}

/**
 * Catalogues list models that are retired, out of free quota or overloaded.
 * Send each a tiny request in parallel and return the ones that answered, in the order given.
 */
export async function probeModels(baseUrl: string, apiKey: string, models: string[], timeoutMs = 12_000): Promise<string[]> {
  const results = await Promise.all(
    models.map(async (model) => {
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 5 }),
        });
        return res.ok;
      } catch {
        return false;
      }
    }),
  );
  return models.filter((_, i) => results[i]);
}

export function pickGeminiModel(ids: string[]): string {
  return rankGeminiModels(ids)[0] ?? GEMINI_FALLBACK_MODEL;
}

/**
 * The cloud API key is fetched from the kernel's vault by the caller. ChatGPT
 * needs no key here: requests go through the kernel, which holds the sign-in.
 */
export function createProvider(s: ModelSettings, cloudKey: string | null, kernel?: KernelCaller): ModelProvider {
  if (s.active === "builtin") return new AppleOnDeviceProvider();
  if (s.active === "cloud" && s.cloud.kind === "chatgpt") {
    if (!kernel) throw new Error("ChatGPT needs the kernel connection.");
    return new ChatGPTPlanProvider(kernel, s.cloud.model);
  }
  if (s.active === "local") {
    return new OpenAICompatibleProvider({ baseUrl: s.local.baseUrl, model: s.local.model, label: `${s.local.model} (local)`, locality: "local" });
  }
  if (!cloudKey) throw new Error("Add your cloud model API key in Settings first.");
  const model = s.cloud.model || cloudDefaultModel(s.cloud.kind);
  if (s.cloud.kind === "gemini") {
    return new OpenAICompatibleProvider({
      baseUrl: GEMINI_BASE_URL,
      model,
      apiKey: cloudKey,
      label: `Gemini (${model})`,
      locality: "cloud",
      strictSchemas: true,
      fallbackModels: (s.cloud.fallbacks ?? []).filter((m) => m !== model),
    });
  }
  if (s.cloud.kind === "anthropic") return new AnthropicProvider({ apiKey: cloudKey, model, baseUrl: s.cloud.baseUrl });
  return new OpenAICompatibleProvider({
    baseUrl: s.cloud.baseUrl || "https://api.openai.com/v1",
    model,
    apiKey: cloudKey,
    label: model,
    locality: "cloud",
  });
}
