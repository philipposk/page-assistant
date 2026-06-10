import { test } from "node:test";
import assert from "node:assert/strict";
import { Assistant, validateFactualText, InMemoryStore, rememberFactCapability, normalizeTicket } from "../dist/index.js";

function scriptedLLM(steps, captured = {}) {
  let i = 0;
  return {
    name: "scripted",
    async complete(input) {
      captured.lastSystem = input.system;
      return steps[i++] ?? { toolCalls: [], text: "" };
    },
  };
}

test("validator accepts rounded variants of trusted numbers (20.7 → 21)", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "THC ~20.7%, yield 80/100." }];
  const { wasCorrected } = validateFactualText("THC is about 21 percent, yield 80.", inv);
  assert.equal(wasCorrected, false);
});

test("validator accepts comma-formatted trusted numbers (1200 → 1,200)", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "Total 1200 items." }];
  const { wasCorrected } = validateFactualText("That's 1,200 items in total.", inv);
  assert.equal(wasCorrected, false);
});

test("validator still kills genuinely invented numbers", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "Yield 80/100." }];
  const { text, wasCorrected } = validateFactualText("Yield is 9500/100!", inv);
  assert.equal(wasCorrected, true);
  assert.match(text, /80/);
});

test("memory recall is injected into the system prompt", async () => {
  const memory = new InMemoryStore();
  memory.remember({ topic: "grow setup", content: "indoor tent, max 2m height" });
  const captured = {};
  const llm = scriptedLLM([{ toolCalls: [], text: "ok" }], captured);
  const a = new Assistant({ capabilities: [], llm, memory, appName: "T" });
  await a.chat({ message: "what fits my grow setup tent?", page: { url: "x", path: "/" } });
  assert.match(captured.lastSystem, /indoor tent, max 2m height/);
});

test("remember_fact capability writes to the store", async () => {
  const memory = new InMemoryStore();
  const ctx = { page: { url: "x", path: "/" }, memory, caller: "user" };
  const r = await rememberFactCapability.run({ topic: "tent", fact: "2m max" }, ctx);
  assert.equal(r.saved, true);
  const got = memory.recall("tent", 1);
  assert.equal(got[0].content, "2m max");
});

test("hostile ticket context is stripped to known string fields", () => {
  const t = normalizeTicket({
    summary: "x",
    context: { url: "https://a", evil: { nested: true }, path: 42, request: "do thing" },
  });
  assert.deepEqual(t.context, { url: "https://a", request: "do thing" });
});

test("confirm message grammar is sane", async () => {
  const delCap = {
    name: "delete_note",
    description: "Delete a saved note permanently.",
    confirm: true,
    parameters: { type: "object", properties: {} },
    run: () => ({ ok: true }),
  };
  const llm = scriptedLLM([{ toolCalls: [{ name: "delete_note", args: {} }], text: "" }]);
  const a = new Assistant({ capabilities: [delCap], llm, memory: new InMemoryStore() });
  const res = await a.chat({ message: "delete it", page: { url: "x", path: "/" } });
  assert.match(res.message, /^Confirm this action\? Delete a saved note permanently\./);
});
