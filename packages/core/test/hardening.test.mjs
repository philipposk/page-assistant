import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Assistant,
  validateFactualText,
  validateArgs,
  coerceArgTypes,
  InMemoryStore,
  makeTicketFloodGuard,
  MemoryTicketStore,
} from "../dist/index.js";

function scriptedLLM(steps, captured = {}) {
  let i = 0;
  return {
    name: "scripted",
    async complete(input) {
      captured.calls ??= [];
      captured.calls.push(input);
      return steps[i++] ?? { toolCalls: [], text: "" };
    },
  };
}

// ---- Validator whitelist (fix #9): years / ordinals / versions must NOT be flagged. ----

test("validator does not flag a 4-digit year", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "Yield 80/100." }];
  const { wasCorrected } = validateFactualText("This strain was stabilized in 2026 and scored 80.", inv);
  assert.equal(wasCorrected, false);
});

test("validator does not flag ordinals like 'top 10'", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "Score 80/100." }];
  const { wasCorrected } = validateFactualText("It's in the top 10 and ranked 5th, scoring 80.", inv);
  assert.equal(wasCorrected, false);
});

test("validator does not flag version-like tokens", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "Score 80/100." }];
  const { wasCorrected } = validateFactualText("Running v2.11 of the model, yield 80.", inv);
  assert.equal(wasCorrected, false);
});

test("validator does not flag numbers inside model ids / URLs", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "Score 80/100." }];
  const { wasCorrected } = validateFactualText("Used gpt-4o via https://api.example.com/v1/run, yield 80.", inv);
  assert.equal(wasCorrected, false);
});

test("validator STILL kills a genuine invented ratio (9000/100)", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "Yield 72/100." }];
  const { text, wasCorrected } = validateFactualText("The yield is 9000/100, incredible!", inv);
  assert.equal(wasCorrected, true);
  assert.match(text, /72/);
  assert.doesNotMatch(text, /9000/);
});

// ---- Validator regression: unit-fused quantities & bare "year-looking" quantities
//      must STAY validated (BLOCKER 1). The old whitelist auto-trusted them. ----

test("validator CATCHES a unit-fused quantity no tool emitted (500g)", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "Yield 72/100." }];
  const { text, wasCorrected } = validateFactualText("You'll get 500g of flower.", inv);
  assert.equal(wasCorrected, true);
  assert.doesNotMatch(text, /500/);
  assert.match(text, /72/);
});

test("validator CATCHES 1200mg when no tool emitted 1200", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "Dose 50mg." }];
  const { wasCorrected } = validateFactualText("Take 1200mg daily.", inv);
  assert.equal(wasCorrected, true);
});

test("validator CATCHES '2000 units' (not treated as a bare year)", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "Score 80/100." }];
  const { wasCorrected } = validateFactualText("It produces 2000 units, scoring 80.", inv);
  assert.equal(wasCorrected, true);
});

test("validator CATCHES '1950 grams' when no tool emitted 1950", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "Score 80/100." }];
  const { wasCorrected } = validateFactualText("The batch weighs 1950 grams, scoring 80.", inv);
  assert.equal(wasCorrected, true);
});

test("validator PASSES a tool-rendered 500g (it's honest)", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "Predicted 500g yield. Score 72/100." }];
  const { wasCorrected } = validateFactualText("You'll get about 500g, score 72.", inv);
  assert.equal(wasCorrected, false);
});

test("validator PASSES a real date 'in 2024' (date context whitelist)", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "Score 80/100." }];
  const { wasCorrected } = validateFactualText("Stabilized in 2024, scoring 80.", inv);
  assert.equal(wasCorrected, false);
});

test("validator PASSES a month-name date 'January 2024'", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "Score 80/100." }];
  const { wasCorrected } = validateFactualText("Launched January 2024, scoring 80.", inv);
  assert.equal(wasCorrected, false);
});

test("validator still whitelists ordinals and semantic versions", () => {
  const inv = [{ name: "x", args: {}, ok: true, rendered: "Score 72/100." }];
  assert.equal(validateFactualText("Ranked 5th using v2.11, score 72.", inv).wasCorrected, false);
  assert.equal(validateFactualText("Built on 2.11.0, score 72.", inv).wasCorrected, false);
});

// ---- Numeric-string coercion for number/integer params (minor). ----

test("coerceArgTypes converts a numeric string to a number for number params", () => {
  const schema = { type: "object", properties: { n: { type: "number" }, s: { type: "string" } } };
  const out = coerceArgTypes({ n: "5", s: "5" }, schema);
  assert.strictEqual(out.n, 5); // number-typed → coerced
  assert.strictEqual(out.s, "5"); // string-typed → untouched
});

test("coerceArgTypes truncates for integer params and leaves junk alone", () => {
  const schema = { type: "object", properties: { i: { type: "integer" }, n: { type: "number" } } };
  const out = coerceArgTypes({ i: "7.9", n: "abc" }, schema);
  assert.strictEqual(out.i, 7);
  assert.strictEqual(out.n, "abc"); // non-numeric string stays as-is
});

test("assistant coerces a numeric-string arg to a number before run()", async () => {
  let received;
  const cap = {
    name: "add_one",
    description: "Add one.",
    parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    run: (args) => {
      received = args.n;
      return { result: args.n + 1 };
    },
    render: (r) => `Result ${r.result}.`,
  };
  const llm = scriptedLLM([
    { toolCalls: [{ id: "c1", name: "add_one", args: { n: "5" } }], text: "" },
    { toolCalls: [], text: "Result 6." },
  ]);
  const a = new Assistant({ capabilities: [cap], llm, memory: new InMemoryStore() });
  const res = await a.chat({ message: "add one to 5", page: { url: "x", path: "/" } });
  assert.strictEqual(received, 5); // a number, not "5"
  assert.equal(res.invocations[0].ok, true);
  assert.strictEqual(res.invocations[0].result.result, 6); // 5 + 1, not "5" + 1 = "51"
});

// ---- Required-arg validation (fix #12). ----

test("validateArgs rejects a missing required argument", () => {
  const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] };
  const problem = validateArgs({ a: "x" }, schema);
  assert.ok(problem);
  assert.match(problem, /missing required argument/);
  assert.match(problem, /b/);
});

test("validateArgs accepts a complete arg set", () => {
  const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  assert.equal(validateArgs({ a: "x" }, schema), null);
});

test("validateArgs flags a wrong type but allows numeric strings for number fields", () => {
  const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
  assert.equal(validateArgs({ n: "42" }, schema), null); // coercible
  assert.match(validateArgs({ n: "abc" }, schema), /must be a number/);
});

test("assistant feeds a required-arg error back to the model instead of throwing", async () => {
  const cap = {
    name: "sim",
    description: "Simulate.",
    parameters: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] },
    run: () => ({ ok: true }),
    render: () => "done 72",
  };
  // Round 1: model calls with a missing required arg. Round 2: model gives up with text.
  const llm = scriptedLLM([
    { toolCalls: [{ id: "c1", name: "sim", args: { a: "x" } }], text: "" },
    { toolCalls: [], text: "I need more info." },
  ]);
  const a = new Assistant({ capabilities: [cap], llm, memory: new InMemoryStore() });
  const res = await a.chat({ message: "simulate", page: { url: "x", path: "/" } });
  assert.equal(res.invocations[0].ok, false);
  assert.match(res.invocations[0].error, /missing required argument/);
});

// ---- Tool_use threading round-trip (fix #7). ----

test("assistant threads the model's tool-call turn and result back into messages", async () => {
  const captured = {};
  const cap = {
    name: "count",
    description: "Count things.",
    parameters: { type: "object", properties: {} },
    run: () => ({ n: 7 }),
    render: () => "There are 7 things.",
  };
  const llm = scriptedLLM(
    [
      { toolCalls: [{ id: "call_abc", name: "count", args: {} }], text: "let me check" },
      { toolCalls: [], text: "There are 7 things." },
    ],
    captured
  );
  const a = new Assistant({ capabilities: [cap], llm, memory: new InMemoryStore() });
  const res = await a.chat({ message: "count them", page: { url: "x", path: "/" } });
  assert.match(res.message, /7/);
  // The SECOND llm call must have received the assistant tool-call turn + a tool result
  // keyed by the same id — proving native threading (not plain "[result of ...]" text).
  const secondCallMessages = captured.calls[1].messages;
  const asstTurn = secondCallMessages.find((m) => m.role === "assistant" && m.toolCalls?.length);
  assert.ok(asstTurn, "assistant tool-call turn was appended");
  assert.equal(asstTurn.toolCalls[0].id, "call_abc");
  const toolResult = secondCallMessages.find((m) => m.role === "tool" && m.toolCallId === "call_abc");
  assert.ok(toolResult, "tool result threaded with matching toolCallId");
  assert.match(toolResult.content, /7 things/);
});

test("usage is aggregated across rounds into the response", async () => {
  const cap = { name: "c", description: "x", parameters: { type: "object", properties: {} }, run: () => ({}), render: () => "ok" };
  const llm = scriptedLLM([
    { toolCalls: [{ id: "c1", name: "c", args: {} }], text: "", usage: { promptTokens: 10, completionTokens: 5 }, provider: "anthropic" },
    { toolCalls: [], text: "ok", usage: { promptTokens: 8, completionTokens: 3 }, provider: "anthropic" },
  ]);
  const a = new Assistant({ capabilities: [cap], llm, memory: new InMemoryStore() });
  const res = await a.chat({ message: "go", page: { url: "x", path: "/" } });
  assert.equal(res.usage.promptTokens, 18);
  assert.equal(res.usage.completionTokens, 8);
  assert.equal(res.usage.provider, "anthropic");
});

// ---- Memory cap (fix #8). ----

test("InMemoryStore evicts oldest facts past the cap", () => {
  const s = new InMemoryStore(3);
  for (let i = 0; i < 10; i++) s.remember({ topic: "t", content: `fact ${i}` });
  const all = s.recall("fact", 100);
  assert.equal(all.length, 3);
  assert.ok(all.every((f) => Number(f.content.split(" ")[1]) >= 7));
});

// ---- Ticket flood guard (minor). ----

test("ticket flood guard collapses identical derived tickets", () => {
  const allow = makeTicketFloodGuard({ windowMs: 60_000 });
  const t = { app: "a", source: "s", kind: "missing_capability", summary: "No capability matched.", context: { request: "do x" } };
  assert.equal(allow(t), true);
  assert.equal(allow({ ...t }), false); // duplicate within window dropped
  assert.equal(allow({ ...t, context: { request: "do y" } }), true); // different request allowed
});

test("MemoryTicketStore caps stored tickets", () => {
  const s = new MemoryTicketStore(3);
  for (let i = 0; i < 10; i++) s.save({ app: "a", source: "s", kind: "other", summary: `t${i}` });
  assert.equal(s.list(100).length, 3);
});
