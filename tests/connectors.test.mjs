// Phase B: connectors built with the kit, the connector check, and other AI apps acting through the kernel.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KernelClient } from "@uab/kernel/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkTools, checkConnector } from "@uab/connector-kit/check";
import { declaredLabels, fillTemplate } from "../packages/kernel/dist/hub.js";

const home = mkdtempSync(join(tmpdir(), "uab-c-"));
const notesFile = join(home, "notes.json");
const example = resolve("examples/notes-connector/index.mjs");
let kernel;
let approve = true;
const approvals = [];

before(async () => {
  writeFileSync(join(home, "services.json"), JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [example], env: { NOTES_FILE: notesFile } } } }));
  kernel = new KernelClient({ env: { UAB_HOME: home, UAB_VAULT_FILE: "1", UAB_DEMO_SERVICES: "1" } });
  await kernel.start();
  kernel.onEvent("approval.requested", (req) => (approvals.push(req), kernel.call("approvals.resolve", { approvalId: req.approvalId, approve })));
});
after(() => kernel.stop());

test("a connector's own labels decide when the kernel asks, and its template writes the card", async () => {
  const caps = await kernel.call("capabilities.list", {});
  const by = (n) => caps.find((c) => c.id === `mcp.notes.${n}`);
  assert.deepEqual([by("list_notes").effects, by("list_notes").risk], [["read"], "low"]);
  assert.deepEqual([by("add_note").effects, by("add_note").risk], [["write"], "medium"]);
  assert.deepEqual([by("delete_note").effects, by("delete_note").risk], [["delete"], "medium"]);

  const { taskId } = await kernel.call("task.start", { intent: "notes" });
  const add = await kernel.call("propose", { taskId, capability: "mcp.notes.add_note", args: { title: "Shopping", text: "milk, eggs" }, source: "agent" });
  assert.equal(add.status, "executed");
  assert.equal(add.approvedBy, "user");
  assert.equal(approvals.at(-1).summary, 'Notes: Add a note "Shopping": milk, eggs');
  const list = await kernel.call("propose", { taskId, capability: "mcp.notes.list_notes", args: {}, source: "agent" });
  assert.equal(list.approvedBy, "policy"); // reading doesn't ask
  assert.match(list.result.content, /Shopping/);
  assert.equal(JSON.parse(readFileSync(notesFile, "utf8")).length, 1);
});

test("a connector can't label sending or paying as low risk", () => {
  assert.deepEqual(declaredLabels({ "ai.unifiedaibase/effects": ["spend"], "ai.unifiedaibase/risk": "low" }), { effects: ["spend"], risk: "high" });
  assert.deepEqual(declaredLabels({ "ai.unifiedaibase/effects": ["send", "nonsense"], "ai.unifiedaibase/risk": "low" }), { effects: ["send"], risk: "medium" });
  assert.equal(declaredLabels({}), null);
  assert.equal(fillTemplate("Pay {amount} to {to.name}", { amount: "₹500", to: { name: "Asha" } }), "Pay ₹500 to Asha");
  assert.equal(fillTemplate("Order {items}", { items: [{ a: 1 }, { b: 2 }] }), "Order 2 items");
});

test("the connector check passes the example and catches a badly labelled connector", async () => {
  const good = await checkConnector({ command: [process.execPath, example] });
  assert.equal(good.server.name, "notes");
  assert.ok(good.findings.every((f) => f.level === "pass"));

  const bad = checkTools([
    { name: "PayNow", description: "pay", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, _meta: { "ai.unifiedaibase/effects": ["spend"], "ai.unifiedaibase/summary": "Pay {amount}" } },
    { name: "lookup", description: "Look something up in the catalogue.", inputSchema: { type: "object", properties: { q: {} } } },
  ]);
  const fails = bad.filter((f) => f.level === "fail").map((f) => f.message).join(" | ");
  assert.match(fails, /description/);
  assert.match(fails, /readOnlyHint says it only reads/);
  assert.match(fails, /\{amount\}/);
  assert.ok(bad.some((f) => f.tool === "lookup" && f.level === "warn" && /No labels/.test(f.message)));
});

test("another AI app acts through the kernel with a pairing key; approvals name the app", async () => {
  await kernel.call("agents.enable", { on: true });
  const { token } = await kernel.call("agents.token", {});
  const bridge = (key) =>
    new StdioClientTransport({ command: process.execPath, args: [resolve("packages/cli/dist/mcp.js")], env: { ...getDefaultEnvironment(), UAB_HOME: home, NEURAL_PAIRING_KEY: key, NEURAL_CLIENT_NAME: "Test Agent" }, stderr: "ignore" });

  const app = new Client({ name: "test-agent", version: "1" });
  await app.connect(bridge(token));
  const { tools } = await app.listTools();
  assert.ok(tools.some((t) => t.name === "mcp__notes__add_note"));
  assert.ok(tools.find((t) => t.name === "files__search").annotations.readOnlyHint);

  approve = false;
  const declined = await app.callTool({ name: "mcp__notes__add_note", arguments: { title: "From agent", text: "hi" } });
  approve = true;
  assert.equal(declined.isError, true);
  assert.match(declined.content[0].text, /declined this in Neural/);
  assert.equal(approvals.at(-1).model, "Test Agent");
  assert.equal(approvals.at(-1).source, "agent");

  const read = await app.callTool({ name: "mcp__notes__list_notes", arguments: {} });
  assert.match(read.content[0].text, /Shopping/);
  assert.equal(JSON.parse(readFileSync(notesFile, "utf8")).length, 1); // the declined note wasn't added
  assert.deepEqual((await kernel.call("agents.status", {})).connected, ["Test Agent"]);
  await app.close();

  const stranger = new Client({ name: "stranger", version: "1" });
  await stranger.connect(bridge("wrong-key"));
  await assert.rejects(stranger.listTools(), /pairing key/);
  await stranger.close();

  await kernel.call("agents.enable", { on: false });
  const off = new Client({ name: "late", version: "1" });
  await off.connect(bridge(token));
  await assert.rejects(off.listTools(), /isn't reachable/);
  await off.close();
});
