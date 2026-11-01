import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai.js";
import type { ModelProvider } from "./providers/types.js";

/** Which model the user picked. Models are replaceable; this is the only place that knows them. */
export interface ModelSettings {
  active: "local" | "cloud";
  local: { baseUrl: string; model: string };
  cloud: { kind: "anthropic" | "openai-compatible"; model: string; baseUrl?: string };
}

export function defaultModelSettings(): ModelSettings {
  return {
    active: "local",
    local: { baseUrl: "http://localhost:11434/v1", model: "qwen3:8b" },
    cloud: { kind: "anthropic", model: "claude-sonnet-5-5" },
  };
}

export function describeModelSettings(s: ModelSettings): string {
  return s.active === "local" ? `Local · ${s.local.model}` : `Cloud · ${s.cloud.model}`;
}

/** The cloud API key is fetched from the kernel's vault by the caller. */
export function createProvider(s: ModelSettings, cloudKey: string | null): ModelProvider {
  if (s.active === "local") {
    return new OpenAICompatibleProvider({ baseUrl: s.local.baseUrl, model: s.local.model, label: `${s.local.model} (local)`, locality: "local" });
  }
  if (!cloudKey) throw new Error("Add your cloud model API key in Settings first.");
  if (s.cloud.kind === "anthropic") return new AnthropicProvider({ apiKey: cloudKey, model: s.cloud.model, baseUrl: s.cloud.baseUrl });
  return new OpenAICompatibleProvider({
    baseUrl: s.cloud.baseUrl || "https://api.openai.com/v1",
    model: s.cloud.model,
    apiKey: cloudKey,
    label: s.cloud.model,
    locality: "cloud",
  });
}
