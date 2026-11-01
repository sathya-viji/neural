import { test } from "node:test";
import assert from "node:assert/strict";
import { strictTool, pickGeminiModel, createProvider, defaultModelSettings } from "@uab/gateway";

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
  assert.equal(pickGeminiModel(["gemini-2.5-pro"]), "gemini-2.5-flash");
});

test("Gemini provider is set up from settings", () => {
  const s = defaultModelSettings();
  s.active = "cloud";
  const p = createProvider(s, "AIza-test");
  assert.equal(p.locality, "cloud");
  assert.match(p.label, /^Gemini/);
  assert.throws(() => createProvider(s, null), /API key/);
});
