// Replies must not show the user credentials, connection strings, environment variable
// names or host-declared internal terms — whether they came from model prose, a render(),
// or the raw error text of a failed run().
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Assistant,
  InMemoryStore,
  DEFAULT_SCRUB_RULES,
  PLAIN_TEXT_SCRUB_RULES,
  scrubText,
} from "../dist/index.js";

const page = { url: "x", path: "/" };
const LEAK = "connect failed: postgres://app:hunter2@10.0.0.5/shop (check DATABASE_URL)";

const failing = (over = {}) => ({
  name: "sync_inventory",
  description: "Sync inventory from the warehouse.",
  parameters: { type: "object", properties: {} },
  run: () => {
    throw new Error(LEAK);
  },
  ...over,
});

function scripted(steps, seen = []) {
  let i = 0;
  return {
    name: "scripted",
    async complete(input) {
      seen.push(input);
      return steps[i++] ?? { toolCalls: [], text: "" };
    },
  };
}

const idle = scripted([]);

test("a failed action does not show the user a connection string or an env var name", async () => {
  const a = new Assistant({ capabilities: [failing({ confirm: true })], llm: idle, memory: new InMemoryStore() });
  const res = await a.confirmAndRun("sync_inventory", {}, page);
  assert.doesNotMatch(res.message, /hunter2|postgres:|DATABASE_URL/);
  assert.match(res.message, /\[redacted\].*a server setting/);
});

test("model prose is scrubbed, and so is the error text sent back to the model", async () => {
  const seen = [];
  const llm = scripted(
    [
      { toolCalls: [{ id: "t1", name: "sync_inventory", args: {} }], text: "" },
      { toolCalls: [], text: "Key sk-abcdefghijklmnop1234 was refused; ask an admin to set OPENAI_API_KEY." },
    ],
    seen
  );
  const a = new Assistant({ capabilities: [failing()], llm, memory: new InMemoryStore() });
  const res = await a.chat({ message: "sync the inventory", page });
  assert.doesNotMatch(res.message, /sk-abc|OPENAI_API_KEY/);
  assert.equal(res.message, "Key [redacted] was refused; ask an admin to set a server setting.");
  const toolTurn = seen[1].messages.find((m) => m.role === "tool");
  assert.doesNotMatch(toolTurn.content, /hunter2/);
});

test("a host extends the defaults with its own internal terms", async () => {
  const llm = scripted([{ toolCalls: [], text: "Legacy Suite is slow; LEGACY SUITE's warehouse-db timed out." }]);
  const a = new Assistant({
    capabilities: [failing()],
    llm,
    memory: new InMemoryStore(),
    scrub: [...DEFAULT_SCRUB_RULES, ["Legacy Suite", "the product"], [/\bwarehouse-db\b/, "our records"]],
  });
  const res = await a.chat({ message: "status?", page });
  assert.equal(res.message, "the product is slow; the product's our records timed out.");
});

test("scrub: false leaves replies exactly as written", async () => {
  const text = "Set OPENAI_API_KEY first.";
  const a = new Assistant({
    capabilities: [failing()],
    llm: scripted([{ toolCalls: [], text }]),
    memory: new InMemoryStore(),
    scrub: false,
  });
  assert.equal((await a.chat({ message: "hi", page })).message, text);
});

test("ordinary text passes through the defaults untouched", () => {
  const text = "Status: IN_PROGRESS. Order 42 costs $5 — see https://shop.example/help or the API_REFERENCE page.";
  assert.equal(scrubText(text, DEFAULT_SCRUB_RULES), text);
});

test("plain-text rules drop markdown markers; the defaults keep them", () => {
  const text = "**Done**: ran `export` for __all__ rows.";
  assert.equal(scrubText(text, DEFAULT_SCRUB_RULES), text);
  assert.equal(scrubText(text, PLAIN_TEXT_SCRUB_RULES), "Done: ran export for all rows.");
});

test("the system prompt tells the model to keep internals out of replies", async () => {
  const seen = [];
  const a = new Assistant({ capabilities: [failing()], llm: scripted([], seen), memory: new InMemoryStore() });
  await a.chat({ message: "hi", page });
  assert.match(seen[0].system, /Never mention environment variables, API routes, internal system names or capability names/);
});
