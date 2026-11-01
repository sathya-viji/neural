import type { JsonSchema } from "@uab/protocol";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Provider data that must be sent back unchanged (e.g. Gemini thought signatures). */
  extra?: unknown;
}

/** Provider-neutral conversation history. */
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string };

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
}

export interface ModelProvider {
  /** e.g. "ollama:qwen3:8b" */
  id: string;
  label: string;
  /** Local models run on this machine; cloud models send data off it. */
  locality: "local" | "cloud";
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Release anything held for a request (e.g. a helper process). */
  dispose?(): void;
}

export class ProviderError extends Error {}
