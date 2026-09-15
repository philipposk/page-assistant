// createServer passes the assistant options through to /v1/agent and the discovery files.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/server.js";

let base;
let httpServer;
const seen = [];

before(async () => {
  const app = createServer({
    appName: "Shop",
    assistantName: "Ada",
    vocabulary: { values: { Tags: ["Q3 shortlist"] } },
    capabilities: [
      {
        name: "count_orders",
        description: "Count orders.",
        parameters: { type: "object", properties: {} },
        run: () => ({ n: 7 }),
        render: (r) => `${r.n} orders.`,
      },
      {
        name: "export_report",
        description: "Export the sales report.",
        parameters: { type: "object", properties: {} },
        enabled: false,
        run: () => ({}),
      },
    ],
    llmTxt: {
      appName: "Shop",
      appUrl: "https://shop.example",
      description: "An online shop.",
      agentEndpoint: "https://shop.example/v1/agent",
    },
    llm: {
      name: "test",
      async complete(input) {
        seen.push({ system: input.system, tools: input.tools.map((t) => t.name) });
        return { toolCalls: [], text: "Ask an admin to set OPENAI_API_KEY first." };
      },
    },
  });
  await new Promise((resolve) => {
    httpServer = app.listen(0, () => {
      base = `http://127.0.0.1:${httpServer.address().port}`;
      resolve();
    });
  });
});

after(() => httpServer?.close());

test("/v1/agent gets the name, the vocabulary, the scrub and only enabled capabilities", async () => {
  const r = await fetch(`${base}/v1/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.message, "Ask an admin to set a server setting first.");
  assert.match(seen[0].system, /^You are Ada, the in-app assistant for Shop\./);
  assert.match(seen[0].system, /- Tags: Q3 shortlist/);
  assert.deepEqual(seen[0].tools, ["count_orders"]);
});

test("llm.txt and the actions manifest name the assistant and leave out a disabled capability", async () => {
  const txt = await (await fetch(`${base}/llm.txt`)).text();
  assert.match(txt, /assistant, Ada\./);
  assert.doesNotMatch(txt, /export_report/);
  const manifest = await (await fetch(`${base}/.well-known/llm-actions.json`)).json();
  assert.equal(manifest.app.assistantName, "Ada");
  assert.deepEqual(manifest.capabilities.map((c) => c.name), ["count_orders"]);
});
