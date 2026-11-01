import type { ChatRequest, ChatResponse, Message, ModelProvider } from "./types.js";
import { ProviderError } from "./types.js";

export interface OpenAICompatibleOptions {
  /** e.g. http://localhost:11434/v1 for Ollama, https://api.openai.com/v1 for OpenAI */
  baseUrl: string;
  model: string;
  apiKey?: string;
  label?: string;
  locality?: "local" | "cloud";
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
        tools: req.tools.map((t) => ({ type: "function", function: t })),
      }),
    }).catch((err: Error) => {
      throw new ProviderError(`Can't reach ${this.options.baseUrl} (${err.message}). Is the model server running?`);
    });
    if (!res.ok) throw new ProviderError(`${this.label} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as {
      choices: { message: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string | object } }[] } }[];
    };
    const msg = body.choices[0]?.message ?? {};
    return {
      text: msg.content ?? "",
      toolCalls: (msg.tool_calls ?? []).map((c, i) => ({
        id: c.id || `call_${i}`,
        name: c.function.name,
        args: parseArgs(c.function.arguments),
      })),
    };
  }
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
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {}),
      };
    }
    return { role: "tool", tool_call_id: m.callId, content: m.content };
  });
}
