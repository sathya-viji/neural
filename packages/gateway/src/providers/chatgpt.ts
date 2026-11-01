import type { KernelMethods } from "@uab/protocol";
import type { ChatRequest, ChatResponse, Message, ModelProvider, ToolCall } from "./types.js";
import { ProviderError } from "./types.js";

interface KernelCaller {
  call<M extends keyof KernelMethods>(method: M, params: KernelMethods[M]["params"]): Promise<KernelMethods[M]["result"]>;
}

type Item = Record<string, unknown> & { type?: string };

const NAMESPACE = "uab";

/**
 * The user's ChatGPT Plus/Pro plan via "Sign in with ChatGPT".
 * This provider builds Responses API requests; the kernel sends them with the
 * user's credentials, which this side never sees.
 *
 * The plan route keeps no server-side state (store: false), so the provider
 * keeps the turn's items itself and resends them each step.
 */
export class ChatGPTPlanProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;
  readonly locality = "cloud" as const;

  private items: Item[] = [];
  private sentResults = new Set<string>();

  constructor(private kernel: KernelCaller, private model: string) {
    this.id = `chatgpt:${model || "default"}`;
    this.label = `ChatGPT${model ? ` (${model})` : ""}`;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.items.length) {
      this.items = toItems(req.messages);
      // Tool results already in the history belong to earlier turns; only new ones are sent.
      for (const m of req.messages) if (m.role === "tool") this.sentResults.add(m.callId);
    }
    for (const m of req.messages) {
      if (m.role !== "tool" || this.sentResults.has(m.callId)) continue;
      this.sentResults.add(m.callId);
      this.items.push({ type: "function_call_output", call_id: m.callId, output: m.content });
    }
    if (!this.model) this.model = (await this.kernel.call("chatgpt.models", {}))[0]?.slug ?? "";
    if (!this.model) throw new ProviderError("Your ChatGPT account didn't list any models this app can use.");

    const body = {
      model: this.model,
      instructions: req.system,
      input: this.items,
      tools: req.tools.length
        ? [
            {
              type: "namespace",
              name: NAMESPACE,
              description: "Actions on the user's computer and accounts. Every call is checked by the user's trusted kernel before it runs.",
              tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })),
            },
          ]
        : [],
      include: ["reasoning.encrypted_content"],
    };

    let output: unknown[];
    try {
      ({ output } = await this.kernel.call("chatgpt.respond", { body }));
    } catch (err) {
      throw new ProviderError((err as Error).message);
    }

    const text: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const raw of output as Item[]) {
      // Nothing is stored server-side, so ids must not be referenced later.
      const { id: _id, status: _status, ...item } = raw;
      if (item.type === "reasoning") {
        if (item.encrypted_content) this.items.push(item);
      } else if (item.type === "message") {
        this.items.push(item);
        for (const part of (item.content as { type?: string; text?: string }[]) ?? []) {
          if (part.type === "output_text" && part.text) text.push(part.text);
        }
      } else if (item.type === "function_call") {
        this.items.push(item);
        toolCalls.push({ id: String(item.call_id), name: stripNamespace(String(item.name)), args: parseArgs(item.arguments) });
      }
    }
    return { text: text.join("\n"), toolCalls };
  }

  dispose(): void {
    this.items = [];
    this.sentResults.clear();
  }
}

function stripNamespace(name: string): string {
  return name.startsWith(`${NAMESPACE}.`) ? name.slice(NAMESPACE.length + 1) : name;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  try {
    const v = JSON.parse(String(raw || "{}"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Earlier conversation as plain messages (system guidance goes in `instructions`, never as a message). */
function toItems(messages: Message[]): Item[] {
  const items: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") items.push({ role: "user", content: m.content });
    else if (m.role === "assistant" && m.text) items.push({ role: "assistant", content: m.text });
  }
  return items;
}
