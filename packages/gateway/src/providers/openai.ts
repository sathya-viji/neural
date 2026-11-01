import type { ChatRequest, ChatResponse, Message, ModelProvider, ToolSpec } from "./types.js";
import { ProviderError } from "./types.js";

export interface OpenAICompatibleOptions {
  /** e.g. http://localhost:11434/v1 for Ollama, https://api.openai.com/v1 for OpenAI */
  baseUrl: string;
  model: string;
  apiKey?: string;
  label?: string;
  locality?: "local" | "cloud";
  /** Some servers (Gemini) accept only a subset of JSON Schema in tool definitions. */
  strictSchemas?: boolean;
}

/**
 * Any server that speaks the OpenAI chat-completions format with tools:
 * Ollama, LM Studio, llama.cpp server, vLLM, OpenAI, OpenRouter and others.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;
  readonly locality: "local" | "cloud";

  constructor(private options: OpenAICompatibleOptions) {
    const isLocal = /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(options.baseUrl);
    this.locality = options.locality ?? (isLocal ? "local" : "cloud");
    this.id = `openai-compatible:${options.model}`;
    this.label = options.label ?? options.model;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: req.signal,
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [{ role: "system", content: req.system }, ...toOpenAI(req.messages)],
        tools: req.tools.map((t) => ({
          type: "function",
          function: this.options.strictSchemas ? strictTool(t) : t,
        })),
      }),
    }).catch((err: Error) => {
      throw new ProviderError(`Can't reach ${this.options.baseUrl} (${err.message}). Is the model server running?`);
    });
    if (!res.ok) throw new ProviderError(`${this.label} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as {
      choices: {
        message: {
          content?: string | null;
          tool_calls?: { id: string; function: { name: string; arguments: string | object }; extra_content?: unknown }[];
        };
      }[];
    };
    const msg = body.choices[0]?.message ?? {};
    return {
      text: msg.content ?? "",
      toolCalls: (msg.tool_calls ?? []).map((c, i) => ({
        id: c.id || `call_${i}`,
        name: c.function.name,
        args: parseArgs(c.function.arguments),
        extra: c.extra_content,
      })),
    };
  }
}

const UNSUPPORTED_SCHEMA_KEYS = new Set(["$schema", "$id", "$ref", "$defs", "definitions", "additionalProperties", "examples", "default", "const", "pattern", "patternProperties", "oneOf", "allOf", "not"]);

function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([p, s]) => [p, strictSchema(s)])) : strictSchema(v);
  }
  return out;
}

/** Gemini rejects object schemas with no properties, so tools without inputs send no parameters. */
export function strictTool(t: ToolSpec): Partial<ToolSpec> {
  const hasProps = t.parameters.properties && Object.keys(t.parameters.properties).length > 0;
  if (!hasProps) return { name: t.name, description: t.description };
  return { name: t.name, description: t.description, parameters: strictSchema(t.parameters) as ToolSpec["parameters"] };
}

function parseArgs(raw: string | object): Record<string, unknown> {
  if (typeof raw === "object") return raw as Record<string, unknown>;
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function toOpenAI(messages: Message[]): object[] {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user", content: m.content };
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.text || null,
        ...(m.toolCalls.length
          ? { tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args) },
              ...(c.extra !== undefined ? { extra_content: c.extra } : {}),
            })) }
          : {}),
      };
    }
    return { role: "tool", tool_call_id: m.callId, content: m.content };
  });
}
