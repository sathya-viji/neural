// "Sign in with ChatGPT" against a fake OpenAI (no network, no real account).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { get } from "node:http";
import { chatgpt } from "../packages/kernel/dist/chatgpt.js";
import { ChatGPTPlanProvider } from "@uab/gateway";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

function idToken(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
  const body = enc(claims);
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

const store = {};
const vault = { get: async (k) => store[k] ?? null, set: async (k, v) => void (store[k] = v) };
const calls = [];
let nonce = "";
let respondMode = "tool";
const realFetch = globalThis.fetch;

const sse = (events) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

before(async () => {
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, body: init.body });
    if (url === "https://auth.openai.com/.well-known/jwks.json") return Response.json({ keys: [jwk] });
    if (url === "https://auth.openai.com/api/accounts/oauth/token") {
      const form = new URLSearchParams(String(init.body));
      return Response.json({
        access_token: "at-1",
        refresh_token: "rt-1",
        id_token: idToken({ iss: "https://auth.openai.com", aud: form.get("client_id"), sub: "user-1", email: "me@example.com", nonce, exp: Math.floor(Date.now() / 1000) + 3600 }),
        expires_in: 3600,
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      });
    }
    if (url === "https://api.openai.com/v1/models") return Response.json({ models: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list" }, { slug: "hidden", visibility: "hide" }] });
    if (url === "https://api.openai.com/v1/responses") {
      const body = JSON.parse(init.body);
      if (respondMode === "limit") return sse([{ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }]);
      const hasResult = body.input.some((i) => i.type === "function_call_output");
      if (respondMode === "tool" && !hasResult) {
        // As the real service does with store: false: items arrive one by one, the completed event is empty.
        return sse([
          { type: "response.created" },
          { type: "response.output_item.done", output_index: 0, item: { id: "rs_1", type: "reasoning", encrypted_content: "enc" } },
          { type: "response.output_item.done", output_index: 1, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "uab.system__now", arguments: "{}" } },
          { type: "response.completed", response: { output: [] } },
        ]);
      }
      return sse([
        { type: "response.output_text.delta", delta: "It is " },
        { type: "response.completed", response: { output: [{ id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "It is 4pm." }] }] } },
      ]);
    }
    return new Response("not found", { status: 404 });
  };
  await chatgpt.init(vault);
});

after(() => {
  globalThis.fetch = realFetch;
});

test("sign-in: OpenAI's page with the documented parameters, then a verified, connected account", async () => {
  const { url } = await chatgpt.connect();
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://auth.openai.com/api/accounts/authorize");
  assert.equal(u.searchParams.get("client_id"), "dynamic_agent_client");
  assert.match(u.searchParams.get("ext_agent_host_id"), /^urn:uuid:/);
  assert.equal(u.searchParams.get("scope"), "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
  assert.equal(u.searchParams.get("resource"), "https://api.openai.com/v1");
  assert.match(u.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  nonce = u.searchParams.get("nonce");

  const cb = `${u.searchParams.get("redirect_uri")}?code=c1&state=${u.searchParams.get("state")}&client_id=oaiapp_test`;
  const status = await new Promise((resolve) => get(cb, (res) => (res.resume(), resolve(res.statusCode))));
  assert.equal(status, 200);
  assert.deepEqual({ connected: chatgpt.status().connected, email: chatgpt.status().email }, { connected: true, email: "me@example.com" });
  const exchange = new URLSearchParams(calls.find((c) => c.url.endsWith("/oauth/token")).body);
  assert.equal(exchange.get("client_id"), "oaiapp_test");
  assert.ok(exchange.get("code_verifier"));
  assert.ok(!exchange.has("client_secret"));
  assert.match(store["chatgpt.account"], /oaiapp_test/);
});

test("models: only the ones listed for this account", async () => {
  assert.deepEqual(await chatgpt.models(), [{ slug: "gpt-test", name: "GPT Test" }]);
});

test("provider: tools sent in a namespace, tool call returned, result sent back without stored ids", async () => {
  respondMode = "tool";
  const kernel = { call: async (method, params) => (method === "chatgpt.respond" ? chatgpt.respond(params.body) : chatgpt.models()) };
  const p = new ChatGPTPlanProvider(kernel, "");
  const tools = [{ name: "system__now", description: "Time", parameters: { type: "object", properties: {} } }];
  const r1 = await p.chat({ system: "Be brief.", messages: [{ role: "user", content: "What time is it?" }], tools });
  assert.deepEqual(r1.toolCalls, [{ id: "call_1", name: "system__now", args: {} }]);

  const first = JSON.parse(calls.filter((c) => c.url.endsWith("/responses"))[0].body);
  assert.equal(first.model, "gpt-test");
  assert.equal(first.store, false);
  assert.equal(first.stream, true);
  assert.equal(first.instructions, "Be brief.");
  assert.equal(first.tools[0].type, "namespace");
  assert.equal(first.tools[0].tools[0].name, "system__now");

  const r2 = await p.chat({
    system: "Be brief.",
    messages: [{ role: "user", content: "What time is it?" }, { role: "assistant", text: "", toolCalls: r1.toolCalls }, { role: "tool", callId: "call_1", name: "system__now", content: "16:00" }],
    tools,
  });
  assert.equal(r2.text, "It is 4pm.");
  const second = JSON.parse(calls.filter((c) => c.url.endsWith("/responses"))[1].body);
  const types = second.input.map((i) => i.type ?? i.role);
  assert.deepEqual(types, ["user", "reasoning", "function_call", "function_call_output"]);
  assert.ok(second.input.every((i) => !("id" in i)), "no server-side ids are referenced");
});

test("usage limit: a plain explanation, not a raw error", async () => {
  respondMode = "limit";
  await assert.rejects(chatgpt.respond({ model: "gpt-test", input: [] }), /usage limit/);
});

test("a forged sign-in reply is rejected", async () => {
  const { url } = await chatgpt.connect();
  const redirect = new URL(url).searchParams.get("redirect_uri");
  const status = await new Promise((resolve) => get(`${redirect}?code=x&state=forged`, (res) => (res.resume(), resolve(res.statusCode))));
  assert.equal(status, 400);
  assert.equal(chatgpt.status().connected, true);
});
