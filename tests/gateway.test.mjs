import { test } from "node:test";
import assert from "node:assert/strict";
import { strictTool, pickGeminiModel, rankGeminiModels, createProvider, defaultModelSettings, pickTools, dateContext } from "@uab/gateway";

test("models get today's and tomorrow's dates ready-made", () => {
  const text = dateContext(new Date(2026, 10, 1, 16, 5)); // Sun 1 Nov 2026, 16:05
  assert.match(text, /today: Sunday 2026-11-01/);
  assert.match(text, /tomorrow: Monday 2026-11-02/);
  assert.match(text, /tomorrow at 10am is 2026-11-02T10:00/);
  assert.match(text, /in 7 days: Sunday 2026-11-08/);
});

test("built-in model sees only the tools a request needs, with short descriptions", () => {
  const t = (name) => ({ name, description: `Does ${name}. More detail that a small model doesn't need.`, parameters: { type: "object", properties: {} } });
  const all = ["files__search", "files__recent", "calendar__events", "reminders__list", "gmail__search", "mail__send", "system__now", "mcp__github__create_issue"].map(t);
  const names = (q) => pickTools(all, q).map((x) => x.name);
  assert.deepEqual(names("what's on my calendar tomorrow?"), ["calendar__events", "system__now"]);
  assert.deepEqual(names("remind me to call mum tomorrow at 10am"), ["reminders__list", "system__now"]);
  assert.deepEqual(names("what am I doing tomorrow?"), ["calendar__events", "system__now"]);
  assert.deepEqual(names("latest files in downloads"), ["files__search", "files__recent", "system__now"]);
  assert.ok(names("open an issue on github").includes("mcp__github__create_issue"));
  assert.equal(pickTools(all, "remind me")[0].description, "Does reminders__list.");
  assert.equal(defaultModelSettings().active, "builtin");
  const web = ["web__search", "web__read", "weather__forecast", "system__now"].map(t);
  assert.deepEqual(pickTools(web, "will it rain in Chennai tomorrow?").map((x) => x.name), ["weather__forecast", "system__now"]);
  assert.deepEqual(pickTools(web, "latest news about ISRO").map((x) => x.name), ["web__search", "web__read", "system__now"]);
});

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
