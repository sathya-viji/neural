// Online MCP services: sign in through the service's own page, then use its tools.
// A fake service plays both the sign-in server and the MCP server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelClient } from "@uab/kernel/client";

const home = mkdtempSync(join(tmpdir(), "uab-online-"));
let base;
let kernel;
const issued = { code: "code-1", token: "token-1" };
let challenge;

const service = createServer(async (req, res) => {
  const url = new URL(req.url, base);
  const body = await new Promise((r) => {
    let s = "";
    req.on("data", (c) => (s += c)).on("end", () => r(s));
  });
  const json = (status, data, headers = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(data));

  if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json(200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  }
  if (url.pathname === "/register") {
    return json(201, { ...JSON.parse(body), client_id: "client-1" });
  }
  if (url.pathname === "/authorize") {
    // The user "signs in" and the service sends the browser back to the app.
    challenge = url.searchParams.get("code_challenge");
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", issued.code);
    back.searchParams.set("state", url.searchParams.get("state"));
    return res.writeHead(302, { location: back.toString() }).end();
  }
  if (url.pathname === "/token") {
    const p = new URLSearchParams(body);
    const ok = p.get("code") === issued.code && createHash("sha256").update(p.get("code_verifier")).digest("base64url") === challenge;
    return ok ? json(200, { access_token: issued.token, token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1" }) : json(400, { error: "invalid_grant" });
  }
  if (url.pathname === "/mcp") {
    if (req.headers.authorization !== `Bearer ${issued.token}`) {
      return json(401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
    }
    if (req.method !== "POST") return res.writeHead(405).end();
    const msg = JSON.parse(body);
    if (msg.id === undefined) return res.writeHead(202).end();
    const reply = (result) => json(200, { jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize") return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-food", version: "1" } });
    if (msg.method === "tools/list") {
      return reply({
        tools: [
          { name: "find_restaurants", description: "Find restaurants", inputSchema: { type: "object", properties: { dish: { type: "string" } } }, annotations: { readOnlyHint: true } },
          { name: "place_order", description: "Place an order", inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] } },
        ],
      });
    }
    if (msg.method === "tools/call") return reply({ content: [{ type: "text", text: `${msg.params.name}: ${JSON.stringify(msg.params.arguments)}` }] });
    return json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
  }
  res.writeHead(404).end();
});

before(async () => {
  await new Promise((r) => service.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${service.address().port}`;
  writeFileSync(join(home, "services.json"), JSON.stringify({ mcpServers: { food: { url: `${base}/mcp` } } }));
  kernel = new KernelClient({ env: { UAB_HOME: home, UAB_VAULT_FILE: "1", UAB_DEMO_SERVICES: "1" } });
  await kernel.start();
  kernel.onEvent("approval.requested", (req) => kernel.call("approvals.resolve", { approvalId: req.approvalId, approve: true }));
});

after(() => {
  kernel.stop();
  service.close();
});

const food = async () => (await kernel.call("services.list", {})).find((s) => s.id === "mcp.food");

test("an online service waits for sign-in and offers nothing until then", async () => {
  const s = await food();
  assert.equal(s.status, "signin");
  assert.equal(s.online, true);
  const caps = await kernel.call("capabilities.list", {});
  assert.ok(!caps.some((c) => c.service === "mcp.food"));
});

test("sign in on the service's page, then use its tools through the kernel", async () => {
  const connected = new Promise((resolve) =>
    kernel.onEvent("services.changed", (list) => list.find((s) => s.id === "mcp.food")?.status === "connected" && resolve()),
  );
  const { url } = await kernel.call("services.signIn", { id: "mcp.food" });
  assert.ok(url.startsWith(`${base}/authorize`));
  // What the browser does: open the page, follow it back to the app.
  const page = await fetch(url);
  assert.match(await page.text(), /is connected/);
  await connected;

  const s = await food();
  assert.equal(s.capabilityCount, 2);
  assert.equal(s.signedIn, true);

  const { taskId } = await kernel.call("task.start", { intent: "order food" });
  const find = await kernel.call("propose", { taskId, capability: "mcp.food.find_restaurants", args: { dish: "biryani" }, source: "agent" });
  assert.equal(find.status, "executed");
  assert.equal(find.approvedBy, "policy");
  // Ordering isn't marked read-only, so the user is asked first.
  const order = await kernel.call("propose", { taskId, capability: "mcp.food.place_order", args: { item: "biryani" }, source: "agent" });
  assert.equal(order.status, "executed");
  assert.equal(order.approvedBy, "user");
  assert.match(order.result.content, /place_order/);
});

test("signing in survives a kernel restart; signing out removes the service's tools", async () => {
  await kernel.call("services.reload", {});
  assert.equal((await food()).status, "connected");
  const list = await kernel.call("services.signOut", { id: "mcp.food" });
  assert.equal(list.find((s) => s.id === "mcp.food").status, "signin");
  const caps = await kernel.call("capabilities.list", {});
  assert.ok(!caps.some((c) => c.service === "mcp.food"));
});
