// Phase B: connectors built with the kit, the connector check, and other AI apps acting through the kernel.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KernelClient } from "@uab/kernel/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { checkTools, checkConnector } from "@uab/connector-kit/check";
import { declaredLabels, fillTemplate } from "../packages/kernel/dist/hub.js";

const home = mkdtempSync(join(tmpdir(), "uab-c-"));
const notesFile = join(home, "notes.json");
const example = resolve("examples/notes-connector/index.mjs");
let kernel;
let approve = true;
const readNotes = () => (existsSync(notesFile) ? JSON.parse(readFileSync(notesFile, "utf8")) : []);
let hold = false; // leave approvals waiting, like a user who hasn't looked yet
const approvals = [];

before(async () => {
  writeFileSync(join(home, "services.json"), JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [example], env: { NOTES_FILE: notesFile } } } }));
  kernel = new KernelClient({ env: { UAB_HOME: home, UAB_VAULT_FILE: "1", UAB_DEMO_SERVICES: "1" } });
  await kernel.start();
  kernel.onEvent("approval.requested", (req) => (approvals.push(req), hold || kernel.call("approvals.resolve", { approvalId: req.approvalId, approve })));
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
  assert.equal(readNotes().length, 1);
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
  assert.equal(readNotes().length, 1); // the declined note wasn't added
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

const bridgeFor = (token, name, extra = {}) =>
  new StdioClientTransport({ command: process.execPath, args: [resolve("packages/cli/dist/mcp.js")], env: { ...getDefaultEnvironment(), UAB_HOME: home, NEURAL_PAIRING_KEY: token, NEURAL_CLIENT_NAME: name, ...extra }, stderr: "ignore" });

test("an approval the user hasn't answered yet: the app gets a request id, then checks the outcome", async () => {
  await kernel.call("agents.enable", { on: true });
  const { token } = await kernel.call("agents.token", {});
  const app = new Client({ name: "slow-user", version: "1" });
  await app.connect(bridgeFor(token, "Phone Claude", { NEURAL_WAIT_MS: "1000" }));
  assert.ok((await app.listTools()).tools.some((t) => t.name === "neural_check_request"));

  hold = true;
  const first = await app.callTool({ name: "mcp__notes__add_note", arguments: { title: "Later", text: "approved after a while" } });
  hold = false;
  assert.ok(!first.isError);
  assert.match(first.content[0].text, /Nothing has happened yet/);
  const id = first.content[0].text.match(/request ([\w-]+)\)/)[1];
  assert.equal(readNotes().some((n) => n.title === "Later"), false);
  assert.match((await app.callTool({ name: "neural_check_request", arguments: { request_id: id } })).content[0].text, /Waiting for the user's OK/);

  await kernel.call("approvals.resolve", { approvalId: approvals.at(-1).approvalId, approve: true });
  await new Promise((r) => setTimeout(r, 200));
  assert.match((await app.callTool({ name: "neural_check_request", arguments: { request_id: id } })).content[0].text, /Saved "Later"/);
  assert.equal(readNotes().filter((n) => n.title === "Later").length, 1);
  assert.equal((await app.callTool({ name: "neural_check_request", arguments: { request_id: "nope" } })).isError, true);
  await app.close();
});

test("approving in the app's own chat: the kernel's card is shown there, and only when the user allows it", async () => {
  const { token } = await kernel.call("agents.token", {});
  const shown = [];
  const chat = (answer) => {
    const c = new Client({ name: "chat-app", version: "1" }, { capabilities: { elicitation: {} } });
    c.setRequestHandler(ElicitRequestSchema, async (req) => (shown.push(req.params.message), { action: answer }));
    return c;
  };

  // Off by default: the card isn't sent to the app, so it waits in Neural.
  hold = true;
  const off = chat("accept");
  await off.connect(bridgeFor(token, "Chat App", { NEURAL_WAIT_MS: "800" }));
  const waited = await off.callTool({ name: "mcp__notes__add_note", arguments: { title: "Off", text: "x" } });
  assert.match(waited.content[0].text, /Waiting for the user's OK/);
  assert.equal(shown.length, 0);
  await kernel.call("approvals.resolve", { approvalId: approvals.at(-1).approvalId, approve: false });
  await off.close();

  await kernel.call("agents.confirmInApp", { on: true });
  const yes = chat("accept");
  await yes.connect(bridgeFor(token, "Chat App"));
  const done = await yes.callTool({ name: "mcp__notes__add_note", arguments: { title: "In chat", text: "allowed in the conversation" } });
  assert.match(done.content[0].text, /Saved "In chat"/);
  assert.match(shown.at(-1), /Notes: Add a note "In chat": allowed in the conversation/);
  await yes.close();

  const no = chat("decline");
  await no.connect(bridgeFor(token, "Chat App"));
  const declined = await no.callTool({ name: "mcp__notes__add_note", arguments: { title: "Nope", text: "declined" } });
  assert.match(declined.content[0].text, /declined this in Neural/);
  assert.equal(readNotes().some((n) => n.title === "Nope"), false);
  await no.close();
  hold = false;
  await kernel.call("agents.confirmInApp", { on: false });
  await kernel.call("agents.enable", { on: false });
});
