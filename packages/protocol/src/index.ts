/**
 * Unified AI Base protocol.
 *
 * The contract between the intelligence layer (which proposes) and the
 * kernel (which authorises). Nothing in here depends on a particular model,
 * provider or device.
 */

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema & { description?: string }>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  enum?: unknown[];
  [key: string]: unknown;
};

/** What a capability does to the world. Drives default policy. */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

/**
 * Where other AI apps reach the kernel (see uab-mcp). In the data folder, unless
 * that path is too long for a socket (macOS allows about 104 bytes); then a short
 * path in this user's private temp folder, derived from the data folder.
 */
export function agentSocketPath(home: string): string {
  const inHome = join(home, "agent.sock");
  if (Buffer.byteLength(inHome) < 100) return inHome;
  return join(tmpdir(), `uab-agent-${createHash("sha256").update(home).digest("hex").slice(0, 12)}.sock`);
}

export type Effect =
  | "read" // looks at data, changes nothing
  | "write" // creates or changes the user's own data
  | "send" // communicates with someone else
  | "spend" // costs money
  | "delete" // removes data
  | "device"; // acts on a physical device or the local system

export type Risk = "low" | "medium" | "high";

export const EFFECTS: readonly Effect[] = ["read", "write", "send", "spend", "delete", "device"];

/**
 * Labels a connector (MCP server) can put in a tool's _meta so the kernel knows
 * exactly what the tool does, instead of guessing from MCP's hints:
 *   "ai.unifiedaibase/effects": ["send", "spend"]
 *   "ai.unifiedaibase/risk": "high"
 *   "ai.unifiedaibase/summary": "Order {quantity} × {item} from {restaurant}"
 * The summary is a template for the approval card; the kernel fills it from the real arguments.
 */
export const CONNECTOR_META = {
  effects: "ai.unifiedaibase/effects",
  risk: "ai.unifiedaibase/risk",
  summary: "ai.unifiedaibase/summary",
} as const;

/** The least risk an effect can carry, whatever a connector declares. */
export const MIN_RISK: Record<Effect, Risk> = { read: "low", device: "low", write: "medium", delete: "medium", send: "medium", spend: "high" };

/** A single thing the system can do, offered by a service or device. */
export interface Capability {
  /** Stable id, e.g. "files.search" or "mcp.github.create_issue". */
  id: string;
  /** Which service or device provides it. */
  service: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  effects: Effect[];
  risk: Risk;
}

export interface ServiceInfo {
  id: string;
  title: string;
  kind: "builtin" | "mcp";
  /** "signin": an online service that's waiting for the user to sign in. */
  status: "connected" | "error" | "disabled" | "signin";
  error?: string;
  capabilityCount: number;
  /** An online MCP service (reached over the internet, not a program on this computer). */
  online?: boolean;
  signedIn?: boolean;
  signingIn?: boolean;
}

/** Who produced a proposal. The kernel treats all of them the same way. */
export type ProposalSource = "local-model" | "cloud-model" | "agent" | "user";

/** A structured request to do something, produced by the intelligence layer. */
export interface ActionProposal {
  taskId: string;
  capability: string;
  args: Record<string, unknown>;
  /** The model's explanation, shown to the user next to the approval. */
  reason?: string;
  source: ProposalSource;
  /** Which model produced it, for the activity history. */
  model?: string;
}

export type Decision =
  | { status: "executed"; proposalId: string; result: ActionResult; verified: boolean; approvedBy: "policy" | "user"; replayed?: boolean }
  | { status: "denied"; proposalId: string; reason: string; by: "policy" | "user" | "kernel" }
  | { status: "failed"; proposalId: string; error: string };

export interface ActionResult {
  /** Text the intelligence layer can read. Always treated as untrusted data. */
  content: string;
  /** Optional structured data. */
  data?: unknown;
}

export type Permission = "allow" | "ask" | "deny";

export interface PolicyRule {
  /** Capability id, or "service:<id>" for a whole service. */
  target: string;
  permission: Permission;
}

export interface Policy {
  rules: PolicyRule[];
  /** Folders the built-in file capabilities may look inside. */
  fileRoots: string[];
}

/** Shown to the user by the host, built only from kernel data. */
export interface ApprovalRequest {
  approvalId: string;
  proposalId: string;
  taskId: string;
  capability: Capability;
  args: Record<string, unknown>;
  reason?: string;
  source: ProposalSource;
  model?: string;
  /** Plain-language summary written by the kernel, not by the model. */
  summary: string;
  createdAt: string;
}

export interface AuditEntry {
  seq: number;
  time: string;
  taskId: string;
  proposalId: string;
  capability: string;
  args: Record<string, unknown>;
  source: ProposalSource;
  model?: string;
  outcome: "executed" | "denied" | "failed";
  approvedBy?: "policy" | "user";
  detail: string;
  verified?: boolean;
  prevHash: string;
  hash: string;
}

export interface TaskRecord {
  taskId: string;
  intent: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
}

/** What the user tells the app about themselves. Every field is optional. */
export interface Profile {
  name?: string;
  city?: string;
  address?: string;
  language?: string;
  about?: string;
}

export interface Memory {
  id: string;
  text: string;
  createdAt: string;
  /** "user": typed in the app. "ai": suggested by the AI and approved by the user. */
  source: "user" | "ai";
}

/** One question and what happened, as shown in the app. */
export interface ConversationTurn {
  question: string;
  answer?: string;
  error?: string;
  at: string;
  model?: string;
  locality?: "local" | "cloud";
  /** The task in Activity that holds this turn's step-by-step record. */
  taskId?: string;
  steps: { title: string; service: string; status: "executed" | "denied" | "failed" | "pending"; detail: string; meta: string }[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
  /** What the AI is given to continue the conversation (questions and final answers). */
  history: unknown[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}

export interface AgentStatus {
  enabled: boolean;
  listening: boolean;
  socket: string;
  connected: string[];
  /** Apps may show approval cards in their own chat (except payments). */
  confirmInApp: boolean;
}

export interface Identity {
  userId: string;
  displayName: string;
  createdAt: string;
}

/* ---------- Kernel RPC (newline-delimited JSON-RPC 2.0 over stdio) ---------- */

export interface KernelMethods {
  "kernel.hello": { params: {}; result: { version: string; identity: Identity; home: string } };
  "capabilities.list": { params: {}; result: Capability[] };
  "services.list": { params: {}; result: ServiceInfo[] };
  "services.reload": { params: {}; result: ServiceInfo[] };
  "services.signIn": { params: { id: string }; result: { url: string } };
  "services.signOut": { params: { id: string }; result: ServiceInfo[] };
  "context.get": { params: {}; result: { profile: Profile; memories: Memory[]; identity: Identity } };
  "context.setProfile": { params: { profile: Profile }; result: Profile };
  "context.addMemory": { params: { text: string }; result: Memory };
  "context.removeMemory": { params: { id: string }; result: {} };
  "context.build": { params: { intent: string; cloud: boolean }; result: { text: string } };
  "conversations.list": { params: { limit?: number }; result: ConversationSummary[] };
  "conversations.get": { params: { id: string }; result: Conversation };
  "conversations.appendTurn": { params: { id?: string; turn: ConversationTurn; history: unknown[] }; result: { id: string } };
  "conversations.delete": { params: { id: string }; result: {} };
  "phone.status": { params: {}; result: { enabled: boolean; listening: boolean; url: string | null; lastSeen: string | null } };
  "phone.enable": { params: { on: boolean }; result: { enabled: boolean; listening: boolean; url: string | null; lastSeen: string | null } };
  "phone.rotate": { params: {}; result: { enabled: boolean; listening: boolean; url: string | null; lastSeen: string | null } };
  "agents.status": { params: {}; result: AgentStatus };
  "agents.enable": { params: { on: boolean }; result: AgentStatus };
  "agents.confirmInApp": { params: { on: boolean }; result: AgentStatus };
  "agents.token": { params: { rotate?: boolean }; result: { token: string } };
  "vault.list": { params: {}; result: { name: string; label: string }[] };
  "vault.remove": { params: { name: string }; result: {} };
  "services.add": { params: { name: string; url?: string; command?: string }; result: { id: string } };
  "services.remove": { params: { id: string }; result: ServiceInfo[] };
  "task.start": { params: { intent: string }; result: { taskId: string } };
  "task.end": { params: { taskId: string; summary: string }; result: {} };
  "tasks.list": { params: { limit?: number }; result: TaskRecord[] };
  propose: { params: ActionProposal; result: Decision };
  "approvals.pending": { params: {}; result: ApprovalRequest[] };
  "approvals.resolve": { params: { approvalId: string; approve: boolean }; result: {} };
  "policy.get": { params: {}; result: Policy & { effective: Record<string, Permission> } };
  "policy.set": { params: PolicyRule; result: {} };
  "policy.setFileRoots": { params: { roots: string[] }; result: {} };
  "audit.list": { params: { limit?: number }; result: AuditEntry[] };
  "audit.verify": { params: {}; result: { ok: boolean; entries: number; brokenAt?: number } };
  "vault.set": { params: { name: string; value: string }; result: {} };
  "vault.has": { params: { name: string }; result: { present: boolean } };
  "model.saveKey": { params: { value: string; endpoint?: string }; result: {} };
  "model.hasKey": { params: {}; result: { present: boolean } };
  "model.fetch": {
    params: { url: string; method?: string; body?: string; auth: "bearer" | "x-api-key"; headers?: Record<string, string>; timeoutMs?: number };
    result: { status: number; text: string };
  };
  "gmail.status": { params: {}; result: GmailStatus };
  "gmail.configure": { params: { clientId: string; clientSecret: string }; result: GmailStatus };
  /** Returns Google's sign-in page for the host to open; sign-in completes in the background. */
  "gmail.connect": { params: {}; result: { url: string } };
  "gmail.disconnect": { params: {}; result: GmailStatus };
  "chatgpt.status": { params: {}; result: ChatGPTStatus };
  "chatgpt.connect": { params: {}; result: { url: string } };
  "chatgpt.disconnect": { params: {}; result: ChatGPTStatus };
  "chatgpt.models": { params: {}; result: { slug: string; name: string }[] };
  /** A Responses API request on the user's ChatGPT plan. The kernel adds the credentials. */
  "chatgpt.respond": { params: { body: Record<string, unknown> }; result: { output: unknown[] } };
}

export interface ChatGPTStatus {
  connected: boolean;
  email?: string;
  connecting: boolean;
  error?: string;
}

export interface GmailStatus {
  configured: boolean;
  connected: boolean;
  email?: string;
  connecting: boolean;
}

export type KernelMethod = keyof KernelMethods;

export interface KernelEvents {
  "approval.requested": ApprovalRequest;
  "approval.resolved": { approvalId: string; approved: boolean };
  "audit.appended": AuditEntry;
  "services.changed": ServiceInfo[];
  "chatgpt.changed": ChatGPTStatus;
}

export type KernelEvent = keyof KernelEvents;

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** Tool names models accept are restricted; map capability ids both ways. */
export function capabilityToToolName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "__");
}

export function toolNameToCapability(name: string, capabilities: Capability[]): Capability | undefined {
  return capabilities.find((c) => capabilityToToolName(c.id) === name);
}
