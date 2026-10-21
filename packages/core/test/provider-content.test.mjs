import { test } from "node:test";
import assert from "node:assert/strict";
import { Assistant, InMemoryStore } from "../dist/index.js";

// Lite's loop on a model that thinks: the thinking blocks must go back verbatim with the
// tool_use they belong to, or the provider rejects the next round.

test("grounding replays the provider's own assistant content on the next round", async () => {
  const blocks = [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "tool_use", id: "tu_1", name: "ping", input: {} },
  ];
  const seen = [];
  const llm = {
    name: "scripted",
    async complete(input) {
      seen.push(structuredClone(input.messages));
      if (seen.length === 1) return { toolCalls: [{ id: "tu_1", name: "ping", args: {} }], text: "", provider: "anthropic", assistantContent: blocks };
      return { toolCalls: [], text: "done", provider: "anthropic" };
    },
  };
  const ping = { name: "ping", description: "Ping.", parameters: { type: "object", properties: {} }, run: () => ({ ok: true }), render: () => "pong" };
  const a = new Assistant({ capabilities: [ping], llm, memory: new InMemoryStore() });
  await a.chat({ message: "hello there", page: { url: "x", path: "/" } });

  assert.equal(seen.length, 2);
  const assistantTurn = seen[1].find((m) => m.role === "assistant");
  assert.deepEqual(assistantTurn.providerContent, { provider: "anthropic", content: blocks });
  assert.equal(assistantTurn.toolCalls[0].id, "tu_1", "the rebuilt tool call still carries the provider's id");
  const result = seen[1].find((m) => m.role === "tool");
  assert.equal(result.toolCallId, "tu_1");
});

test("grounding adds no providerContent when the provider returned none", async () => {
  const seen = [];
  const llm = {
    name: "scripted",
    async complete(input) {
      seen.push(structuredClone(input.messages));
      return seen.length === 1
        ? { toolCalls: [{ id: "a", name: "ping", args: {} }], text: "", provider: "openai" }
        : { toolCalls: [], text: "done" };
    },
  };
  const ping = { name: "ping", description: "Ping.", parameters: { type: "object", properties: {} }, run: () => ({ ok: true }), render: () => "pong" };
  const a = new Assistant({ capabilities: [ping], llm, memory: new InMemoryStore() });
  await a.chat({ message: "hello there", page: { url: "x", path: "/" } });
  const assistantTurn = seen[1].find((m) => m.role === "assistant");
  assert.equal("providerContent" in assistantTurn, false);
});

test("a long history is cut once per turn, so the conversation's start never changes between rounds", async () => {
  const { Assistant, InMemoryStore } = await import("../dist/index.js");
  const seen = [];
  const outs = [
    { toolCalls: [{ id: "t1", name: "look", args: {} }], text: "", provider: "anthropic", assistantContent: [{ type: "thinking", thinking: "", signature: "s" }, { type: "tool_use", id: "t1", name: "look", input: {} }] },
    { toolCalls: [{ id: "t2", name: "look", args: {} }], text: "", provider: "anthropic" },
    { toolCalls: [], text: "done" },
  ];
  const llm = { name: "stub", async complete(input) { seen.push(input.messages.map((m) => m.content)); return outs.shift(); } };
  const a = new Assistant({
    llm,
    memory: new InMemoryStore(),
    capabilities: [{ name: "look", description: "Look.", parameters: { type: "object", properties: {} }, run: () => ({ ok: true }) }],
  });
  const history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
  await a.chat({ message: "go", page: { url: "/", path: "/" }, history });
  // Every round starts with the same message: nothing before the replayed thinking changed.
  assert.ok(seen.length === 3);
  assert.ok(seen.every((round) => round[0] === seen[0][0]));
  assert.ok(seen[0].length <= 20);
});
