#!/usr/bin/env node
/**
 * Kernel process entry point. Runs as its own process, separate from the
 * app and the models, and speaks newline-delimited JSON-RPC over stdio.
 * stdout carries protocol messages only; logs go to stderr.
 */
import { createInterface } from "node:readline";
import type { KernelEvent, KernelMethods, RpcRequest } from "@uab/protocol";
import { Kernel, KERNEL_VERSION } from "./kernel.js";

type Handlers = { [M in keyof KernelMethods]: (params: KernelMethods[M]["params"]) => Promise<KernelMethods[M]["result"]> | KernelMethods[M]["result"] };

const kernel = new Kernel();

function send(message: object): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const events: KernelEvent[] = ["approval.requested", "approval.resolved", "audit.appended", "services.changed"];
for (const event of events) kernel.on(event, (params) => send({ jsonrpc: "2.0", method: event, params }));

const handlers: Handlers = {
  "kernel.hello": () => ({ version: KERNEL_VERSION, identity: kernel.identity, home: kernel.home }),
  "capabilities.list": () => kernel.hub.capabilities(),
  "services.list": () => kernel.hub.services(),
  "services.reload": async () => {
    await kernel.hub.connect();
    const services = kernel.hub.services();
    kernel.emit("services.changed", services);
    return services;
  },
  "task.start": ({ intent }) => ({ taskId: kernel.startTask(intent) }),
  "task.end": ({ taskId, summary }) => (kernel.endTask(taskId, summary), {}),
  "tasks.list": ({ limit }) => kernel.listTasks(limit),
  propose: (p) => kernel.propose(p),
  "approvals.pending": () => kernel.pendingApprovals(),
  "approvals.resolve": ({ approvalId, approve }) => (kernel.resolveApproval(approvalId, approve), {}),
  "policy.get": () => ({ ...kernel.policy.get(), effective: kernel.effectivePermissions() }),
  "policy.set": (rule) => {
    if (!["allow", "ask", "deny"].includes(rule.permission)) throw new Error("permission must be allow, ask or deny");
    kernel.policy.setRule(rule);
    return {};
  },
  "policy.setFileRoots": ({ roots }) => (kernel.policy.setFileRoots(roots), {}),
  "audit.list": ({ limit }) => kernel.audit.list(limit),
  "audit.verify": () => kernel.audit.verify(),
  "vault.set": async ({ name, value }) => (await kernel.vault.set(name, value), {}),
  "vault.has": async ({ name }) => ({ present: await kernel.vault.has(name) }),
  // The host needs model API keys to reach cloud models. Other secrets
  // (service tokens) never leave the kernel.
  "vault.getModelKey": async ({ name }) => {
    if (!name.startsWith("model.")) throw new Error("Only model keys can be read from outside the kernel");
    return { value: await kernel.vault.get(name) };
  },
};

async function handle(req: RpcRequest): Promise<void> {
  const handler = handlers[req.method as keyof Handlers] as ((p: unknown) => unknown) | undefined;
  if (!handler) {
    send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Unknown method ${req.method}` } });
    return;
  }
  try {
    const result = await handler(req.params ?? {});
    send({ jsonrpc: "2.0", id: req.id, result });
  } catch (err) {
    send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: (err as Error).message } });
  }
}

await kernel.start();
process.stderr.write(`[kernel] ready (home ${kernel.home})\n`);
send({ jsonrpc: "2.0", method: "kernel.ready", params: {} });

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req: RpcRequest;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  void handle(req);
});
rl.on("close", async () => {
  await kernel.stop();
  process.exit(0);
});
