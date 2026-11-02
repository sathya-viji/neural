// End-to-end: real kernel process, real built-in services, scripted model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { KernelClient } from "@uab/kernel/client";
import { Gateway } from "@uab/gateway";

const home = mkdtempSync(join(tmpdir(), "uab-test-"));
const docs = join(home, "Documents");
const secret = join(home, "Private");
mkdirSync(join(docs, "Finance"), { recursive: true });
mkdirSync(secret);
writeFileSync(join(docs, "Finance", "Q3 Report.md"), "# Q3 Report\nRevenue up 12%.");
writeFileSync(join(secret, "passwords.txt"), "do not share");

let kernel;
let approve = true;
const approvals = [];

/** A model that follows a fixed script, then answers. */
function scripted(steps) {
  let i = 0;
  return {
    id: "test:scripted",
    label: "Scripted test model",
    locality: "local",
    async chat() {
      const step = steps[i++];
      if (!step) return { text: "All done.", toolCalls: [] };
      return { text: "", toolCalls: [{ id: `c${i}`, name: step[0], args: step[1] }] };
    },
  };
}

before(async () => {
  kernel = new KernelClient({ env: { UAB_HOME: home, UAB_VAULT_FILE: "1", UAB_DEMO_SERVICES: "1" } });
  await kernel.start();
  await kernel.call("policy.setFileRoots", { roots: [docs] });
  kernel.onEvent("approval.requested", (req) => {
    approvals.push(req);
    kernel.call("approvals.resolve", { approvalId: req.approvalId, approve });
  });
});

after(() => kernel.stop());

test("find a report, look up a contact and email it, with approval", async () => {
  const report = join(docs, "Finance", "Q3 Report.md");
  const events = [];
  const gw = new Gateway(kernel, scripted([
    ["files__search", { query: "q3 report" }],
    ["contacts__find", { name: "sam" }],
    ["mail__send", { to: ["sam.rivera@example.com"], subject: "Q3 report", body: "Here it is.", attachments: [report] }],
  ]));
  const result = await gw.run("Find the Q3 report and email it to Sam", { onEvent: (e) => events.push(e) });

  const decisions = events.filter((e) => e.type === "decision").map((e) => e.decision);
  assert.deepEqual(decisions.map((d) => d.status), ["executed", "executed", "executed"]);
  assert.match(decisions[0].result.content, /Q3 Report\.md/);
  assert.match(decisions[1].result.content, /sam\.rivera@example\.com/);
  // Reading needed no approval; sending did.
  assert.equal(decisions[0].approvedBy, "policy");
  assert.equal(decisions[2].approvedBy, "user");
  assert.equal(decisions[2].verified, true);
  assert.equal(approvals.length, 1);
  assert.match(approvals[0].summary, /sam\.rivera@example\.com.*Q3 Report\.md/);

  const outbox = readdirSync(join(home, "outbox"));
  assert.equal(outbox.length, 1);
  assert.match(readFileSync(join(home, "outbox", outbox[0]), "utf8"), /filename="Q3 Report\.md"/);
  assert.equal(result.text, "All done.");
});

test("the same send in the same task runs only once", async () => {
  const before = readdirSync(join(home, "outbox")).length;
  const send = ["mail__send", { to: ["sam.rivera@example.com"], subject: "Hi", body: "Once" }];
  const events = [];
  await new Gateway(kernel, scripted([send, send])).run("say hi to sam", { onEvent: (e) => events.push(e) });
  const decisions = events.filter((e) => e.type === "decision").map((e) => e.decision);
  assert.equal(decisions[0].replayed, undefined);
  assert.equal(decisions[1].replayed, true);
  assert.equal(readdirSync(join(home, "outbox")).length, before + 1);
});

test("user declines: nothing is sent", async () => {
  approve = false;
  const before = readdirSync(join(home, "outbox")).length;
  const events = [];
  await new Gateway(kernel, scripted([["mail__send", { to: ["a@example.com"], subject: "x", body: "y" }]])).run("email a", {
    onEvent: (e) => events.push(e),
  });
  approve = true;
  const d = events.find((e) => e.type === "decision").decision;
  assert.equal(d.status, "denied");
  assert.equal(d.by, "user");
  assert.equal(readdirSync(join(home, "outbox")).length, before);
});

test("files outside shared folders can't be read or attached", async () => {
  const events = [];
  await new Gateway(kernel, scripted([
    ["files__read", { path: join(secret, "passwords.txt") }],
    ["mail__send", { to: ["a@example.com"], subject: "x", body: "y", attachments: [join(secret, "passwords.txt")] }],
  ])).run("leak", { onEvent: (e) => events.push(e) });
  const [read, send] = events.filter((e) => e.type === "decision").map((e) => e.decision);
  assert.equal(read.status, "failed");
  assert.match(read.error, /outside the folders you have shared/);
  assert.equal(send.status, "failed");
});

test("blocked capabilities are refused by policy", async () => {
  await kernel.call("policy.set", { target: "service:mail", permission: "deny" });
  const events = [];
  await new Gateway(kernel, scripted([["mail__send", { to: ["a@example.com"], subject: "x", body: "y" }]])).run("email", {
    onEvent: (e) => events.push(e),
  });
  await kernel.call("policy.set", { target: "service:mail", permission: "ask" });
  const d = events.find((e) => e.type === "decision").decision;
  assert.equal(d.status, "denied");
  assert.equal(d.by, "policy");
});

test("invalid proposals are rejected before anything runs", async () => {
  const { taskId } = await kernel.call("task.start", { intent: "bad" });
  const missing = await kernel.call("propose", { taskId, capability: "mail.send", args: { to: ["a@example.com"] }, source: "agent" });
  assert.equal(missing.status, "denied");
  assert.match(missing.reason, /subject/);
  const unknown = await kernel.call("propose", { taskId, capability: "bank.transfer", args: {}, source: "agent" });
  assert.equal(unknown.status, "denied");
  const noTask = await kernel.call("propose", { taskId: "nope", capability: "system.now", args: {}, source: "agent" });
  assert.equal(noTask.status, "denied");
});

test("activity history is complete and tamper-evident", async () => {
  const v = await kernel.call("audit.verify", {});
  assert.equal(v.ok, true);
  assert.ok(v.entries >= 10);
  const entries = await kernel.call("audit.list", { limit: 100 });
  assert.ok(entries.some((e) => e.outcome === "denied" && e.capability === "mail.send"));

  // Edit one line on disk: a fresh kernel must notice.
  const path = join(home, "audit.jsonl");
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const first = JSON.parse(lines[0]);
  first.detail = "something else";
  lines[0] = JSON.stringify(first);
  writeFileSync(path, lines.join("\n") + "\n");
  const fresh = new KernelClient({ env: { UAB_HOME: home, UAB_VAULT_FILE: "1", UAB_DEMO_SERVICES: "1" } });
  await fresh.start();
  const broken = await fresh.call("audit.verify", {});
  fresh.stop();
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenAt, 1);
});

test("recent files: by folder name, newest first; unknown folders are refused", async () => {
  const { taskId } = await kernel.call("task.start", { intent: "recent" });
  writeFileSync(join(docs, "newest.txt"), "new");
  const d = await kernel.call("propose", { taskId, capability: "files.recent", args: { folder: "Documents", limit: 2 }, source: "agent" });
  assert.equal(d.status, "executed");
  assert.match(d.result.content.split("\n")[0], /newest\.txt/);
  const outside = await kernel.call("propose", { taskId, capability: "files.recent", args: { folder: "Private" }, source: "agent" });
  assert.equal(outside.status, "failed");
  assert.match(outside.error, /No shared folder/);
});

test("Gmail isn't offered to the AI until it's connected", async () => {
  const caps = await kernel.call("capabilities.list", {});
  assert.ok(!caps.some((c) => c.service === "gmail"));
  const status = await kernel.call("gmail.status", {});
  assert.deepEqual({ configured: status.configured, connected: status.connected }, { configured: false, connected: false });
  await assert.rejects(kernel.call("gmail.configure", { clientId: "nope", clientSecret: "x" }), /Client ID/);
});

test("show a web page: Google searches and public links open in the app's browser; local addresses don't", async () => {
  const { taskId } = await kernel.call("task.start", { intent: "browser" });
  const g = await kernel.call("propose", { taskId, capability: "browser.show", args: { query: "ISRO news" }, source: "agent" });
  assert.equal(g.status, "executed");
  assert.equal(g.result.data.openInBrowser, "https://www.google.com/search?q=ISRO%20news");
  const local = await kernel.call("propose", { taskId, capability: "browser.show", args: { url: "http://127.0.0.1:8080/admin" }, source: "agent" });
  assert.equal(local.status, "failed");
  assert.match(local.error, /local network/);
});

test("cloud model keys never leave the kernel: it adds them, and only for the provider's own address", async () => {
  let seen;
  const provider = createServer((req, res) => ((seen = req.headers.authorization), res.end('{"data":[]}')));
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${provider.address().port}/v1`;
  try {
    await kernel.call("model.saveKey", { value: "sk-test", endpoint: base });
    assert.equal((await kernel.call("model.hasKey", {})).present, true);
    const r = await kernel.call("model.fetch", { url: `${base}/models`, auth: "bearer" });
    assert.equal(r.status, 200);
    assert.equal(seen, "Bearer sk-test");
    await assert.rejects(kernel.call("model.fetch", { url: "https://example.com/steal", auth: "bearer" }), /different address/);
    await assert.rejects(kernel.call("vault.getModelKey", { name: "model.cloud" }));
  } finally {
    provider.close();
  }
});

test("saved sign-ins and keys are listed by name only, and can be removed", async () => {
  await kernel.call("vault.set", { name: "gmail.client", value: JSON.stringify({ clientId: "x", clientSecret: "y" }) });
  const list = await kernel.call("vault.list", {});
  assert.ok(list.some((e) => e.name === "model.cloud" && /API key/.test(e.label)));
  assert.ok(list.some((e) => e.name === "gmail.client"));
  assert.ok(!JSON.stringify(list).includes("sk-test"));
  await kernel.call("vault.remove", { name: "model.cloud" });
  assert.equal((await kernel.call("model.hasKey", {})).present, false);
  assert.ok(!(await kernel.call("vault.list", {})).some((e) => e.name === "model.cloud"));
});

test("context: who you are and what to remember, with less sent to cloud models", async () => {
  await kernel.call("context.setProfile", { profile: { name: "Asha", city: "Bengaluru", address: "12 MG Road", about: "Keep answers short." } });
  const { taskId } = await kernel.call("task.start", { intent: "I'm vegetarian" });
  const saved = await kernel.call("propose", { taskId, capability: "memory.remember", args: { text: "Vegetarian" }, source: "agent" });
  assert.equal(saved.status, "executed");
  assert.equal(saved.approvedBy, "user"); // saving a memory asks first
  assert.match(approvals.at(-1).summary, /Remember: "Vegetarian"/);
  await kernel.call("task.end", { taskId, summary: "Saved that you're vegetarian." });

  const local = (await kernel.call("context.build", { intent: "what's on today", cloud: false })).text;
  assert.match(local, /Name: Asha/);
  assert.match(local, /12 MG Road/);
  assert.match(local, /- Vegetarian/);
  assert.match(local, /Recently done/);
  // A cloud model gets the address only when the request needs it.
  assert.doesNotMatch((await kernel.call("context.build", { intent: "what's on today", cloud: true })).text, /MG Road/);
  assert.match((await kernel.call("context.build", { intent: "order dinner", cloud: true })).text, /MG Road/);

  const recent = await kernel.call("propose", { taskId, capability: "memory.recent", args: { search: "vegetarian" }, source: "agent" });
  assert.match(recent.result.content, /Saved that you're vegetarian/);

  const forget = await kernel.call("propose", { taskId, capability: "memory.forget", args: { what: "that I'm vegetarian" }, source: "agent" });
  assert.equal(forget.status, "executed");
  assert.match(approvals.at(-1).summary, /Forget: "Vegetarian"/);
  assert.equal((await kernel.call("context.get", {})).memories.length, 0);
});

test("with many memories, a cloud model gets the ones that relate to the request, picked by meaning on this computer", async () => {
  const notes = ["Vegetarian", "Prefers cash on delivery", "Works from home on Fridays", "Allergic to peanuts", "Daughter's school is DPS", "Supports Chennai Super Kings", "Keep emails short and formal", "Has diabetes", "Wife's name is Priya", "Office is in Whitefield", "Doesn't like spicy food", "Learning Spanish", "Gym on weekday mornings"];
  for (const text of notes) await kernel.call("context.addMemory", { text });
  const cloud = (await kernel.call("context.build", { intent: "book me a table for dinner tonight", cloud: true })).text;
  // Shares no words with the request, but matters for dinner.
  for (const m of ["Allergic to peanuts", "Vegetarian", "Prefers cash on delivery"]) assert.ok(cloud.includes(m), `${m} should be sent`);
  for (const m of ["Daughter's school is DPS", "Learning Spanish", "Supports Chennai Super Kings"]) assert.ok(!cloud.includes(m), `${m} shouldn't be sent`);
  // A model on this Mac gets everything.
  const local = (await kernel.call("context.build", { intent: "book me a table for dinner tonight", cloud: false })).text;
  for (const m of notes) assert.ok(local.includes(m));
  for (const m of (await kernel.call("context.get", {})).memories) await kernel.call("context.removeMemory", { id: m.id });
});
