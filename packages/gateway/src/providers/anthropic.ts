import type { ChatRequest, ChatResponse, Message, ModelProvider } from "./types.js";
import { ProviderError } from "./types.js";
import type { ModelFetch } from "./kernel-fetch.js";

export interface AnthropicOptions {
  /** Requests go through the kernel, which adds the API key. */
  fetch: ModelFetch;
  model?: string;
  baseUrl?: string;
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

/** Claude via the Messages API. */
export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;
  readonly locality = "cloud" as const;
  private model: string;

  constructor(private options: AnthropicOptions) {
    this.model = options.model || "claude-sonnet-5-5";
    this.id = `anthropic:${this.model}`;
    this.label = `Claude (${this.model})`;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await this.options.fetch(`${this.options.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      signal: req.signal,
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: req.system,
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        messages: toAnthropic(req.messages),
      }),
    });
    if (!res.ok) throw new ProviderError(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { content: Block[] };
    return {
      text: body.content.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n"),
      toolCalls: body.content
        .filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
    };
  }
}

function toAnthropic(messages: Message[]): { role: "user" | "assistant"; content: Block[] | string }[] {
  const out: { role: "user" | "assistant"; content: Block[] | string }[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const content: Block[] = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      out.push({ role: "assistant", content });
    } else {
      // Consecutive tool results share one user turn.
      const block: Block = { type: "tool_result", tool_use_id: m.callId, content: m.content };
      const last = out.at(-1);
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
        last.content.push(block);
      } else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}
