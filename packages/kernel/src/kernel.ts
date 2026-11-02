import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type {
  ActionProposal,
  ApprovalRequest,
  Capability,
  Decision,
  Identity,
  JsonSchema,
  KernelEvents,
  Permission,
  TaskRecord,
} from "@uab/protocol";
import { PolicyStore } from "./policy.js";
import { AuditLog } from "./audit.js";
import { Vault } from "./vault.js";
import { ContextStore } from "./context.js";
import { ServiceHub } from "./hub.js";
import { readJson, resolveHome, writeJson } from "./store.js";

export const KERNEL_VERSION = "0.1.0";
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

interface Pending {
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
}

/**
 * The trusted kernel. Every action from every model goes through propose():
 *
 *   validate → check policy → ask the user if needed → execute → verify → record
 *
 * It contains no model and makes no decision a model can talk it out of.
 */
export class Kernel extends EventEmitter {
  readonly home: string;
  readonly identity: Identity;
  readonly policy: PolicyStore;
  readonly audit: AuditLog;
  readonly vault: Vault;
  readonly hub: ServiceHub;
  readonly context: ContextStore;

  private pending = new Map<string, Pending>();
  /** Actions already done in a task, so a repeated proposal never runs twice. */
  private completed = new Map<string, Decision>();
  private tasks = new Map<string, TaskRecord>();
  private tasksPath: string;

  constructor(home = resolveHome()) {
    super();
    this.home = home;
    this.identity = this.loadIdentity();
    this.policy = new PolicyStore(home);
    this.audit = new AuditLog(home);
    this.vault = new Vault(home);
    this.context = new ContextStore(home);
    this.hub = new ServiceHub({ home, policy: () => this.policy.get(), context: this.context, recentTasks: (n) => this.listTasks(n) }, this.vault);
    this.tasksPath = join(home, "tasks.jsonl");
    this.loadTasks();
  }

  async start(): Promise<void> {
    await this.hub.connect();
  }

  async stop(): Promise<void> {
    for (const p of this.pending.values()) p.resolve(false);
    await this.hub.disconnect();
  }

  override emit<E extends keyof KernelEvents>(event: E, payload: KernelEvents[E]): boolean {
    return super.emit(event, payload);
  }

  /* ---------------- tasks ---------------- */

  startTask(intent: string): string {
    const record: TaskRecord = { taskId: randomUUID(), intent, startedAt: new Date().toISOString() };
    this.tasks.set(record.taskId, record);
    appendFileSync(this.tasksPath, JSON.stringify(record) + "\n", { mode: 0o600 });
    return record.taskId;
  }

  endTask(taskId: string, summary: string): void {
    const record = this.tasks.get(taskId);
    if (!record) return;
    record.endedAt = new Date().toISOString();
    record.summary = summary;
    appendFileSync(this.tasksPath, JSON.stringify(record) + "\n", { mode: 0o600 });
    for (const key of [...this.completed.keys()]) if (key.startsWith(`${taskId}:`)) this.completed.delete(key);
  }

  listTasks(limit = 100): TaskRecord[] {
    return [...this.tasks.values()].slice(-limit).reverse();
  }

  /* ---------------- the lifecycle ---------------- */

  async propose(p: ActionProposal): Promise<Decision> {
    const proposalId = randomUUID();
    const deny = (reason: string, by: "policy" | "user" | "kernel"): Decision => {
      this.record(p, proposalId, { outcome: "denied", detail: reason });
      return { status: "denied", proposalId, reason, by };
    };

    // 1. Validate: the task, the capability and the arguments must all be real.
    if (!this.tasks.has(p.taskId)) return deny("Unknown task. Start a task first.", "kernel");
    const cap = this.hub.get(p.capability);
    if (!cap) return deny(`No capability called "${p.capability}" is available.`, "kernel");
    const args = p.args ?? {};
    const invalid = validateArgs(cap.inputSchema, args);
    if (invalid) return deny(`Invalid arguments: ${invalid}`, "kernel");

    // 2. Idempotency: the same action in the same task runs once.
    const key = `${p.taskId}:${cap.id}:${digest(args)}`;
    const changesThings = cap.effects.some((e) => e !== "read");
    const previous = changesThings ? this.completed.get(key) : undefined;
    if (previous?.status === "executed") {
      return { ...previous, proposalId, replayed: true };
    }

    // 3. Policy.
    const permission = this.policy.evaluate(cap);
    if (permission === "deny") return deny(`You have blocked "${cap.title}".`, "policy");

    // 4. Confirmation from the user, when the policy says so.
    let approvedBy: "policy" | "user" = "policy";
    if (permission === "ask") {
      const approved = await this.requestApproval(proposalId, p, cap, args);
      if (!approved) return deny("You declined this action.", "user");
      approvedBy = "user";
    }

    // 5. Execute, then 6. verify.
    let decision: Decision;
    try {
      const { result, verified } = await this.hub.execute(cap.id, args);
      decision = { status: "executed", proposalId, result, verified, approvedBy };
      this.record(p, proposalId, {
        outcome: "executed",
        approvedBy,
        verified,
        detail: result.content.length > 500 ? result.content.slice(0, 500) + "…" : result.content,
      });
    } catch (err) {
      const error = (err as Error).message;
      decision = { status: "failed", proposalId, error };
      this.record(p, proposalId, { outcome: "failed", approvedBy, detail: error });
    }
    if (decision.status === "executed" && changesThings) this.completed.set(key, decision);
    return decision;
  }

  pendingApprovals(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  resolveApproval(approvalId: string, approve: boolean): void {
    const p = this.pending.get(approvalId);
    if (!p) throw new Error("That approval is no longer waiting");
    p.resolve(approve);
  }

  effectivePermissions(): Record<string, Permission> {
    return Object.fromEntries(this.hub.capabilities().map((c) => [c.id, this.policy.evaluate(c)]));
  }

  /* ---------------- internals ---------------- */

  private async requestApproval(proposalId: string, p: ActionProposal, cap: Capability, args: Record<string, unknown>): Promise<boolean> {
    const approvalId = randomUUID();
    const summary = await this.hub.summarize(cap.id, args);
    const request: ApprovalRequest = {
      approvalId,
      proposalId,
      taskId: p.taskId,
      capability: cap,
      args,
      reason: p.reason,
      source: p.source,
      model: p.model,
      summary,
      createdAt: new Date().toISOString(),
    };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
      const finish = (approved: boolean) => {
        if (!this.pending.has(approvalId)) return;
        clearTimeout(timer);
        this.pending.delete(approvalId);
        this.emit("approval.resolved", { approvalId, approved });
        resolve(approved);
      };
      this.pending.set(approvalId, { request, resolve: finish });
      this.emit("approval.requested", request);
    });
  }

  private record(
    p: ActionProposal,
    proposalId: string,
    fields: { outcome: "executed" | "denied" | "failed"; detail: string; approvedBy?: "policy" | "user"; verified?: boolean },
  ): void {
    const entry = this.audit.append({
      taskId: p.taskId,
      proposalId,
      capability: p.capability,
      args: p.args ?? {},
      source: p.source,
      model: p.model,
      ...fields,
    });
    this.emit("audit.appended", entry);
  }

  private loadIdentity(): Identity {
    const path = join(this.home, "identity.json");
    const existing = readJson<Identity | null>(path, null);
    if (existing) return existing;
    const identity: Identity = { userId: randomUUID(), displayName: userInfo().username, createdAt: new Date().toISOString() };
    writeJson(path, identity);
    return identity;
  }

  private loadTasks(): void {
    if (!existsSync(this.tasksPath)) return;
    for (const line of readFileSync(this.tasksPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as TaskRecord;
      this.tasks.set(r.taskId, { ...this.tasks.get(r.taskId), ...r });
    }
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 32);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Small structural check: required fields present, top-level types right. */
export function validateArgs(schema: JsonSchema, args: Record<string, unknown>): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "arguments must be an object";
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === "") return `"${key}" is required`;
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties?.[key];
    if (!prop?.type || value === undefined || value === null) continue;
    const t = prop.type;
    const ok =
      (t === "string" && typeof value === "string") ||
      ((t === "number" || t === "integer") && typeof value === "number") ||
      (t === "boolean" && typeof value === "boolean") ||
      (t === "array" && (Array.isArray(value) || typeof value === "string")) ||
      (t === "object" && typeof value === "object") ||
      Array.isArray(t);
    if (!ok) return `"${key}" should be ${t}`;
    if (prop.enum && !prop.enum.includes(value)) return `"${key}" must be one of ${prop.enum.join(", ")}`;
  }
  return null;
}
