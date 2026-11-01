import { test } from "node:test";
import assert from "node:assert/strict";
import { strictTool, pickGeminiModel, rankGeminiModels, createProvider, defaultModelSettings } from "@uab/gateway";

test("Gemini tool schemas: no-input tools send no parameters, unsupported keys are removed", () => {
  const empty = strictTool({ name: "system__now", description: "Time", parameters: { type: "object", properties: {} } });
  assert.deepEqual(empty, { name: "system__now", description: "Time" });

  const mcp = strictTool({
    name: "mcp__x__y",
    description: "d",
    parameters: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: { q: { type: "string", default: "a", description: "query" }, tags: { type: "array", items: { type: "string", pattern: "^a" } } },
      required: ["q"],
    },
  });
  assert.deepEqual(mcp.parameters, {
    type: "object",
    properties: { q: { type: "string", description: "query" }, tags: { type: "array", items: { type: "string" } } },
    required: ["q"],
  });
});

test("picks the newest plain Gemini flash model", () => {
  assert.equal(pickGeminiModel(["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3-pro", "gemini-3-flash", "text-embedding-004"]), "gemini-3-flash");
  assert.equal(pickGeminiModel(["gemini-2.5-pro"]), "gemini-flash-latest");
  assert.deepEqual(rankGeminiModels(["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.8-flash-tts"]), [
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
  ]);
});

test("busy models are skipped and the next one answers", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { model } = JSON.parse(init.body);
    calls.push(model);
    if (model === "busy-1") return new Response("high demand", { status: 503 });
    return Response.json({ choices: [{ message: { content: `hi from ${model}` } }] });
  };
  try {
    const s = defaultModelSettings();
    s.active = "cloud";
    s.cloud = { kind: "gemini", model: "busy-1", fallbacks: ["ok-2", "ok-3"] };
    const p = createProvider(s, "AIza-test");
    const r1 = await p.chat({ system: "", messages: [{ role: "user", content: "x" }], tools: [] });
    assert.equal(r1.text, "hi from ok-2");
    // Second turn goes straight to the model that worked.
    await p.chat({ system: "", messages: [{ role: "user", content: "y" }], tools: [] });
    assert.deepEqual(calls, ["busy-1", "ok-2", "ok-2"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a rejected request is not retried on other models", async () => {
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => (n++, new Response("bad key", { status: 400 }));
  try {
    const s = defaultModelSettings();
    s.active = "cloud";
    s.cloud = { kind: "gemini", model: "m1", fallbacks: ["m2"] };
    await assert.rejects(createProvider(s, "AIza-test").chat({ system: "", messages: [], tools: [] }), /400/);
    assert.equal(n, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Gemini provider is set up from settings", () => {
  const s = defaultModelSettings();
  s.active = "cloud";
  const p = createProvider(s, "AIza-test");
  assert.equal(p.locality, "cloud");
  assert.match(p.label, /^Gemini/);
  assert.throws(() => createProvider(s, null), /API key/);
});
