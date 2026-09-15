// A capability that is registered but switched off (feature flag, plan tier, missing
// backend) must not be offered, advertised or run. Both states are covered.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Assistant,
  InMemoryStore,
  generateLlmTxt,
  generateActionsJson,
  isCapabilityEnabled,
} from "../dist/index.js";

const meta = {
  appName: "Shop",
  appUrl: "https://shop.example",
  description: "An online shop.",
  agentEndpoint: "https://shop.example/v1/agent",
};

function flagged() {
  const state = { on: false, runs: 0 };
  const cap = {
    name: "export_report",
    description: "Export the sales report as a spreadsheet.",
    parameters: { type: "object", properties: {} },
    enabled: () => state.on,
    run: () => {
      state.runs++;
      return { rows: 12 };
    },
    render: (r) => `Exported ${r.rows} rows.`,
  };
  return { state, cap };
}

const count = {
  name: "count_orders",
  description: "Count orders matching a status.",
  parameters: { type: "object", properties: {} },
  run: () => ({ n: 7 }),
  render: (r) => `${r.n} orders.`,
};

function recordingLLM(script = []) {
  const seen = [];
  let i = 0;
  return {
    seen,
    llm: {
      name: "rec",
      async complete(input) {
        seen.push({ tools: input.tools.map((t) => t.name), forceTool: input.forceTool });
        return script[i++] ?? { toolCalls: [], text: "ok" };
      },
    },
  };
}

const page = { url: "x", path: "/" };

test("off: not in the tool list; on: offered — re-read every turn", async () => {
  const { state, cap } = flagged();
  const { seen, llm } = recordingLLM();
  const a = new Assistant({ capabilities: [count, cap], llm, memory: new InMemoryStore() });
  await a.chat({ message: "hello", page });
  state.on = true;
  await a.chat({ message: "hello", page });
  assert.deepEqual(seen[0].tools, ["count_orders"]);
  assert.deepEqual(seen[1].tools, ["count_orders", "export_report"]);
});

test("off: forced routing does not force it (the provider was never given that tool)", async () => {
  const { state, cap } = flagged();
  const { seen, llm } = recordingLLM();
  const a = new Assistant({ capabilities: [count, cap], llm, memory: new InMemoryStore() });
  const message = "show me the sales report spreadsheet export";
  await a.chat({ message, page });
  state.on = true;
  await a.chat({ message, page });
  assert.equal(seen[0].forceTool, undefined);
  assert.equal(seen[1].forceTool, "export_report");
});

test("off: a stale call to it is refused and run() never happens", async () => {
  const { state, cap } = flagged();
  const { llm } = recordingLLM([
    { toolCalls: [{ id: "t1", name: "export_report", args: {} }], text: "" },
    { toolCalls: [], text: "Sorry, that is not available." },
  ]);
  const a = new Assistant({ capabilities: [count, cap], llm, memory: new InMemoryStore() });
  const res = await a.chat({ message: "export the report", page });
  assert.equal(state.runs, 0);
  assert.equal(res.invocations[0].ok, false);
  assert.match(res.invocations[0].error, /not available/);

  const confirmed = await a.confirmAndRun("export_report", {}, page);
  assert.equal(state.runs, 0);
  assert.match(confirmed.message, /no longer available/);

  state.on = true;
  const ran = await a.confirmAndRun("export_report", {}, page);
  assert.equal(state.runs, 1);
  assert.equal(ran.message, "Exported 12 rows.");
});

test("off: not in llm.txt or the actions manifest; on: listed in both", () => {
  const { state, cap } = flagged();
  assert.doesNotMatch(generateLlmTxt(meta, [count, cap]), /export_report/);
  assert.deepEqual(generateActionsJson(meta, [count, cap]).capabilities.map((c) => c.name), ["count_orders"]);
  state.on = true;
  assert.match(generateLlmTxt(meta, [count, cap]), /### export_report/);
  assert.deepEqual(generateActionsJson(meta, [count, cap]).capabilities.map((c) => c.name), ["count_orders", "export_report"]);
});

test("static false and a flag that throws both count as off; unset counts as on", () => {
  assert.equal(isCapabilityEnabled({ ...count, enabled: false }), false);
  assert.equal(isCapabilityEnabled({ ...count, enabled: () => { throw new Error("flag service down"); } }), false);
  assert.equal(isCapabilityEnabled(count), true);
  assert.equal(isCapabilityEnabled({ ...count, enabled: true }), true);
});
