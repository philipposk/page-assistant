// Forced routing picks a capability before the model gets a say. It exists for factual
// questions, so it must not pick a write, must not match a word hidden inside another
// word, and a host must be able to turn it off or replace it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Assistant, InMemoryStore, forcedFactualTool } from "../dist/index.js";

const read = (name, description) => ({
  name,
  description,
  parameters: { type: "object", properties: {} },
  run: () => ({ n: 1 }),
  render: () => "one",
});

const countOrders = read("count_orders", "Count orders matching a status.");
const archiveOrders = {
  ...read("archive_old_orders", "Archive all orders older than a given number of days."),
  confirm: true,
};

test("a question is never routed to a confirm-gated capability", () => {
  // Overlap favours the archive action (orders, older, than, days); forcing it would answer
  // a "how many" question with a confirmation card for a bulk write.
  const message = "how many orders older than 90 days would archiving touch?";
  assert.equal(forcedFactualTool(message, [countOrders, archiveOrders]), undefined);
});

test("a word found only inside another word does not count toward routing", () => {
  // "late" sits inside "template" and "rate" inside "generate"; neither is a match.
  const template = read("generate_template", "Generate a document from a template.");
  const fees = read("get_fees", "Get the fees charged on an account.");
  assert.equal(forcedFactualTool("show me the late fees rate", [template, fees]), undefined);
});

test("whole words and their plural forms still route", () => {
  const cross = read("simulate_cross", "Simulate a breeding cross between two strains and predict yield.");
  assert.equal(forcedFactualTool("simulate a cross of two strains", [cross, countOrders]), "simulate_cross");
  assert.equal(forcedFactualTool("how many orders match this status", [countOrders]), "count_orders");
});

function recordingLLM() {
  const seen = [];
  return {
    seen,
    llm: {
      name: "rec",
      async complete(input) {
        seen.push(input.forceTool);
        return { toolCalls: [], text: "ok" };
      },
    },
  };
}

const chat = (opts, message) => {
  const { seen, llm } = recordingLLM();
  const a = new Assistant({ llm, memory: new InMemoryStore(), ...opts });
  return a.chat({ message, page: { url: "x", path: "/" } }).then(() => seen[0]);
};

test("forcedRouting: false turns the heuristic off", async () => {
  const cross = read("simulate_cross", "Simulate a breeding cross between two strains and predict yield.");
  const msg = "simulate a cross of two strains";
  assert.equal(await chat({ capabilities: [cross] }, msg), "simulate_cross");
  assert.equal(await chat({ capabilities: [cross], forcedRouting: false }, msg), undefined);
});

test("a host router replaces the heuristic, and a name it invents is ignored", async () => {
  const caps = [countOrders];
  assert.equal(await chat({ capabilities: caps, forcedRouting: () => "count_orders" }, "anything"), "count_orders");
  // Forcing a tool the provider was never given fails the whole turn, so it is dropped.
  assert.equal(await chat({ capabilities: caps, forcedRouting: () => "no_such_tool" }, "anything"), undefined);
});
