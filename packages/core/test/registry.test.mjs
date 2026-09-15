// Capability schemas are checked when they are registered. The whole tool list is sent on
// every chat turn, so a schema a provider rejects would otherwise fail every message.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Assistant,
  InMemoryStore,
  CapabilitySchemaError,
  capabilitySchemaProblems,
  rememberFactCapability,
} from "../dist/index.js";

const llm = { name: "none", async complete() { return { toolCalls: [], text: "ok" }; } };
const make = (capabilities) => new Assistant({ capabilities, llm, memory: new InMemoryStore() });
const cap = (over) => ({
  name: "set_limit",
  description: "Set a spending limit.",
  parameters: { type: "object", properties: { amount: { type: "number" } } },
  run: () => ({}),
  ...over,
});

test("a list-valued type is refused at registration, naming the capability and the field", () => {
  const bad = cap({
    parameters: { type: "object", properties: { amount: { type: ["number", "null"] } } },
  });
  assert.throws(() => make([bad]), (e) => {
    assert.ok(e instanceof CapabilitySchemaError);
    assert.match(e.message, /set_limit\.parameters\.properties\.amount/);
    assert.match(e.message, /"type" is a list/);
    return true;
  });
});

test("a list-valued type nested inside array items is found too", () => {
  const bad = cap({
    parameters: {
      type: "object",
      properties: { rows: { type: "array", items: { type: "object", properties: { v: { type: ["string", "null"] } } } } },
    },
  });
  assert.match(capabilitySchemaProblems([bad]).join("\n"), /rows\.items\.properties\.v/);
});

test("two capabilities with one name are refused instead of one silently replacing the other", () => {
  assert.throws(() => make([cap(), cap({ description: "Another." })]), /registered twice/);
});

test("a required argument missing from properties is refused (it would be stripped before run)", () => {
  const bad = cap({ parameters: { type: "object", properties: {}, required: ["amount"] } });
  assert.throws(() => make([bad]), /"amount" is required but not declared/);
});

test("a name a provider would reject is refused", () => {
  assert.throws(() => make([cap({ name: "set limit" })]), /name must be/);
  assert.throws(() => make([cap({ parameters: { properties: {} } })]), /"type": "object"/);
});

test("the built-in capabilities and ordinary schemas pass", () => {
  assert.deepEqual(capabilitySchemaProblems([rememberFactCapability, cap()]), []);
  // A property literally named "type", and enum values that are arrays, are data — not schemas.
  const tricky = cap({
    parameters: {
      type: "object",
      properties: { type: { type: "string", enum: ["a", "b"] }, pair: { type: "array", enum: [["x", "y"]] } },
      required: ["type"],
    },
  });
  assert.deepEqual(capabilitySchemaProblems([tricky]), []);
  assert.doesNotThrow(() => make([tricky]));
});
