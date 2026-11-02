// Approving from a phone: the kernel's page on the local network, behind a pairing key.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelClient } from "@uab/kernel/client";

const home = mkdtempSync(join(tmpdir(), "uab-p-"));
let kernel, base;

before(async () => {
  writeFileSync(join(home, "phone.json"), JSON.stringify({ port: 0 })); // any free port
  kernel = new KernelClient({ env: { UAB_HOME: home, UAB_VAULT_FILE: "1", UAB_DEMO_SERVICES: "1" } });
  await kernel.start();
});
after(() => kernel.stop());

test("off until turned on; then a page behind the pairing key", async () => {
  assert.equal((await kernel.call("phone.status", {})).listening, false);
  const s = await kernel.call("phone.enable", { on: true });
  assert.equal(s.listening, true);
  const { port } = JSON.parse(readFileSync(join(home, "phone.json"), "utf8"));
  const token = JSON.parse(readFileSync(join(home, "vault.json"), "utf8"))["phone.token"];
  base = `http://127.0.0.1:${port}/a/${token}`;
  if (s.url) assert.ok(s.url.endsWith(`:${port}/a/${token}`));
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Approvals/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/a/${"x".repeat(32)}`)).status, 404);
});

test("a waiting approval shows on the phone and is answered there", async () => {
  const { taskId } = await kernel.call("task.start", { intent: "email from phone test" });
  const pending = kernel.call("propose", { taskId, capability: "mail.send", args: { to: ["sam.rivera@example.com"], subject: "Hi", body: "From the phone" }, source: "agent", model: "Claude Desktop" });
  let items = [];
  for (let i = 0; i < 50 && !items.length; i++) {
    await new Promise((r) => setTimeout(r, 50));
    items = await (await fetch(`${base}/api/pending`)).json();
  }
  assert.equal(items.length, 1);
  assert.match(items[0].summary, /sam\.rivera@example\.com/);
  assert.equal(items[0].from, "Claude Desktop");
  const ok = await fetch(`${base}/api/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalId: items[0].approvalId, approve: true }) });
  assert.equal(ok.status, 200);
  const d = await pending;
  assert.equal(d.status, "executed");
  assert.equal(d.approvedBy, "user");
  const again = await fetch(`${base}/api/resolve`, { method: "POST", body: JSON.stringify({ approvalId: items[0].approvalId, approve: false }) });
  assert.equal(again.status, 409); // already answered
});

test("repeated wrong keys lock that address out; turning it off closes the page", async () => {
  const { port } = JSON.parse(readFileSync(join(home, "phone.json"), "utf8"));
  for (let i = 0; i < 10; i++) await fetch(`http://127.0.0.1:${port}/a/${"y".repeat(32)}`);
  assert.equal((await fetch(base)).status, 429);
  await kernel.call("phone.enable", { on: false });
  await assert.rejects(fetch(base));
});
