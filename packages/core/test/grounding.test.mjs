import { test } from "node:test";
import assert from "node:assert/strict";
import { Assistant, validateFactualText, forcedFactualTool, InMemoryStore } from "../dist/index.js";

// A fake LLM we script per-test so we can prove the grounding behavior deterministically.
function scriptedLLM(steps) {
  let i = 0;
  return { name: "scripted", async complete() { return steps[i++] ?? { toolCalls: [], text: "" }; } };
}

const yieldCap = {
  name: "simulate_cross",
  description: "Simulate a breeding cross between two strains and predict yield.",
  parameters: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] },
  run: () => ({ yieldScore: 72, heightCm: { low: 95, high: 140 } }),
  render: (r) => `Predicted yield ${r.yieldScore}/100. Expected height ${r.heightCm.low}-${r.heightCm.high} cm.`,
};

test("validator replaces invented numbers with trusted tool render", () => {
  const invocations = [{ name: "simulate_cross", args: {}, ok: true, rendered: "Predicted yield 72/100." }];
  const { text, wasCorrected } = validateFactualText("The yield will be 95/100, amazing!", invocations);
  assert.equal(wasCorrected, true);
  assert.match(text, /72/);
  assert.doesNotMatch(text, /95/);
});

test("validator leaves honest text alone", () => {
  const invocations = [{ name: "simulate_cross", args: {}, ok: true, rendered: "Predicted yield 72/100." }];
  const { text, wasCorrected } = validateFactualText("Your predicted yield is 72 out of 100.", invocations);
  assert.equal(wasCorrected, false);
  assert.match(text, /72/);
});

test("assistant runs the real capability and reports its render verbatim", async () => {
  const llm = scriptedLLM([
    { toolCalls: [{ name: "simulate_cross", args: { a: "Northern Lights", b: "Sour Diesel" } }], text: "" },
    { toolCalls: [], text: "I ran a simulation and yield is around 9000/100." }, // model lies
  ]);
  const a = new Assistant({ capabilities: [yieldCap], llm, memory: new InMemoryStore(), appName: "Test" });
  const res = await a.chat({ message: "simulate cross of Northern Lights and Sour Diesel", page: { url: "x", path: "/" } });
  assert.equal(res.invocations[0].ok, true);
  assert.equal(res.invocations[0].result.yieldScore, 72);
  assert.equal(res.corrected, true); // lie was caught
  assert.match(res.message, /72/);
  assert.doesNotMatch(res.message, /9000/);
});

test("unknown capability is never silently faked", async () => {
  const llm = scriptedLLM([{ toolCalls: [{ name: "delete_universe", args: {} }], text: "" }, { toolCalls: [], text: "ok" }]);
  const a = new Assistant({ capabilities: [yieldCap], llm, memory: new InMemoryStore() });
  const res = await a.chat({ message: "do something", page: { url: "x", path: "/" } });
  assert.equal(res.invocations[0].ok, false);
});

test("forced-factual selection picks the obvious capability", () => {
  const forced = forcedFactualTool("simulate a cross for high yield", [yieldCap]);
  assert.equal(forced, "simulate_cross");
});

test("confirm-required capability stages instead of running", async () => {
  let ran = false;
  const delCap = { name: "delete_note", description: "Delete a saved note.", confirm: true,
    parameters: { type: "object", properties: {} }, run: () => { ran = true; return { ok: true }; } };
  const llm = scriptedLLM([{ toolCalls: [{ name: "delete_note", args: {} }], text: "" }]);
  const a = new Assistant({ capabilities: [delCap], llm, memory: new InMemoryStore() });
  const res = await a.chat({ message: "delete my note", page: { url: "x", path: "/" } });
  assert.equal(ran, false);
  assert.ok(res.pendingConfirmation);
});

test("verbatim capability is not paraphrased, so a label cannot be swapped", () => {
  /* The regression this exists for: asked for withdrawals per partner, the
     model reproduced both real amounts and attached each to the wrong name.
     Every number was present in the trusted output, so the number check
     passed it. Where a figure only means something next to its label, the
     rendering has to be shown as written. */
  const rendered = "Withdrawals in Aug: 1665.75 across 2. Anna 691.89 · Boris 973.86.";
  const paraphrasedWrong = "Anna took 973.86 and Boris took 691.89.";

  const out = validateFactualText(paraphrasedWrong, [
    { name: "withdrawals_in_month", args: {}, ok: true, rendered, verbatim: true },
  ]);

  assert.equal(out.text, rendered);
  assert.equal(out.wasCorrected, true);
});

test("without verbatim, honest prose is still left alone", () => {
  const rendered = "Takings today: 450.50.";
  const prose = "You took 450.50 today.";
  const out = validateFactualText(prose, [
    { name: "todays_takings", args: {}, ok: true, rendered },
  ]);
  assert.equal(out.text, prose);
  assert.equal(out.wasCorrected, false);
});
