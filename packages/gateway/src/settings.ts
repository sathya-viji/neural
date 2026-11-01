import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai.js";
import type { ModelProvider } from "./providers/types.js";

export type CloudKind = "gemini" | "anthropic" | "openai-compatible";

/** Which model the user picked. Models are replaceable; this is the only place that knows them. */
export interface ModelSettings {
  active: "local" | "cloud";
  local: { baseUrl: string; model: string };
  cloud: { kind: CloudKind; model: string; baseUrl?: string };
}

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const GEMINI_FALLBACK_MODEL = "gemini-2.5-flash";

export function defaultModelSettings(): ModelSettings {
  return {
    active: "local",
    local: { baseUrl: "http://localhost:11434/v1", model: "qwen3:8b" },
    cloud: { kind: "gemini", model: "" },
  };
}

export function describeModelSettings(s: ModelSettings): string {
  return s.active === "local" ? `Local · ${s.local.model}` : `Cloud · ${s.cloud.model || cloudDefaultModel(s.cloud.kind)}`;
}

export function cloudDefaultModel(kind: CloudKind): string {
  return kind === "gemini" ? GEMINI_FALLBACK_MODEL : kind === "anthropic" ? "claude-sonnet-5-5" : "";
}

/** Where a cloud provider lists its models (OpenAI-style GET /models). */
export function cloudModelsUrl(s: ModelSettings["cloud"]): string | null {
  if (s.kind === "gemini") return `${GEMINI_BASE_URL}/models`;
  if (s.kind === "openai-compatible") return `${(s.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "")}/models`;
  return null;
}

/** From a Gemini model list, pick the newest plain "flash" model: fast, capable and on the free tier. */
export function pickGeminiModel(ids: string[]): string {
  const version = (id: string) => parseFloat(id.match(/^gemini-(\d+(?:\.\d+)?)-flash$/)?.[1] ?? "0");
  const flash = ids.filter((id) => version(id) > 0).sort((a, b) => version(b) - version(a));
  return flash[0] ?? GEMINI_FALLBACK_MODEL;
}

/** The cloud API key is fetched from the kernel's vault by the caller. */
export function createProvider(s: ModelSettings, cloudKey: string | null): ModelProvider {
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
