#!/usr/bin/env node
/**
 * Kernel process entry point. Runs as its own process, separate from the
 * app and the models, and speaks newline-delimited JSON-RPC over stdio.
 * stdout carries protocol messages only; logs go to stderr.
 */
import { createInterface } from "node:readline";
import { watch } from "node:fs";
import type { KernelEvent, KernelMethods, RpcRequest } from "@uab/protocol";
import { Kernel, KERNEL_VERSION } from "./kernel.js";
import { gmail } from "./builtin/gmail.js";
import { chatgpt } from "./chatgpt.js";
import { ModelKey } from "./model-key.js";

type Handlers = { [M in keyof KernelMethods]: (params: KernelMethods[M]["params"]) => Promise<KernelMethods[M]["result"]> | KernelMethods[M]["result"] };

const kernel = new Kernel();

function send(message: object): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const events: KernelEvent[] = ["approval.requested", "approval.resolved", "audit.appended", "services.changed"];
for (const event of events) kernel.on(event, (params) => send({ jsonrpc: "2.0", method: event, params }));

const modelKey = new ModelKey(kernel.vault);

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
  "services.signIn": ({ id }) => kernel.hub.signIn(id),
  "services.signOut": async ({ id }) => (await kernel.hub.signOut(id), kernel.hub.services()),
  "services.add": (input) => kernel.hub.addService(input),
  "services.remove": async ({ id }) => (await kernel.hub.removeService(id), kernel.hub.services()),
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
  // Cloud model requests: the kernel adds the API key, which never leaves it.
  "model.saveKey": async ({ value, endpoint }) => (await modelKey.save(value, endpoint), {}),
  "model.hasKey": async () => ({ present: await modelKey.has() }),
  "model.fetch": (req) => modelKey.fetch(req),
  "vault.list": async () => {
    const entries = [
      { name: "model.cloud", label: "Cloud model API key (Gemini, Claude or other)" },
      { name: "chatgpt.account", label: "ChatGPT sign-in" },
      { name: "gmail.token", label: "Gmail sign-in" },
      { name: "gmail.client", label: "Gmail app registration (OAuth client)" },
      ...kernel.hub.vaultEntries(),
    ];
    const present = new Set(await kernel.vault.present(entries.map((e) => e.name)));
    return entries.filter((e) => present.has(e.name)).map(({ name, label }) => ({ name, label }));
  },
  // Removing a sign-in signs out properly, so nothing keeps using a token in memory.
  "vault.remove": async ({ name }) => {
    if (name === "chatgpt.account") await chatgpt.disconnect();
    else if (name === "gmail.token") await gmail.disconnect();
    else if (name.startsWith("service.") && name.endsWith(".signin")) await kernel.hub.signOut(`mcp.${name.slice(8, -7)}`).catch(() => {});
    await kernel.vault.remove(name);
    if (name === "model.cloud") await kernel.vault.remove("model.cloud.endpoint");
    if (name === "gmail.client") await gmail.init(kernel.vault), gmail.onChange();
    return {};
  },
  "gmail.status": () => gmail.status(),
  "gmail.configure": async ({ clientId, clientSecret }) => (await gmail.configure(clientId, clientSecret), gmail.status()),
  "gmail.connect": () => gmail.connect(),
  "gmail.disconnect": async () => (await gmail.disconnect(), gmail.status()),
  "chatgpt.status": () => chatgpt.status(),
  "chatgpt.connect": () => chatgpt.connect(),
  "chatgpt.disconnect": async () => (await chatgpt.disconnect(), chatgpt.status()),
  "chatgpt.models": () => chatgpt.models(),
  // The app sends the request; the kernel adds the user's ChatGPT credentials, which never leave it.
  "chatgpt.respond": ({ body }) => chatgpt.respond(body),
};

// Gmail connects and disconnects in the background (browser sign-in).
gmail.onChange = () => kernel.emit("services.changed", kernel.hub.services());
kernel.hub.onChange = () => kernel.emit("services.changed", kernel.hub.services());
chatgpt.onChange = () => send({ jsonrpc: "2.0", method: "chatgpt.changed", params: chatgpt.status() });

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
await chatgpt.init(kernel.vault);
process.stderr.write(`[kernel] ready (home ${kernel.home})\n`);

// Edits to services.json take effect without pressing Reconnect.
let reloadTimer: NodeJS.Timeout | undefined;
watch(kernel.home, (_event, file) => {
  if (file !== "services.json") return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void Promise.resolve(handlers["services.reload"]({})).catch(() => {}), 500);
});
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
