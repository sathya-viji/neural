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
export type Effect =
  | "read" // looks at data, changes nothing
  | "write" // creates or changes the user's own data
  | "send" // communicates with someone else
  | "spend" // costs money
  | "delete" // removes data
  | "device"; // acts on a physical device or the local system

export type Risk = "low" | "medium" | "high";

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
  "vault.getModelKey": { params: { name: string }; result: { value: string | null } };
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
