import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgent, MemoryPendingActionStore, defineTool } from "../dist/agent/index.js";
import { anthropicProvider } from "../dist/llm/anthropic.js";
import { routerFromEnv } from "../dist/llm/router.js";
import { HttpProviderError } from "../dist/llm/errors.js";
import { acceptsSampling, acceptsForcedTool, acceptsEffort, claudeIdFromOpenRouter } from "../dist/llm/modelRules.js";
import { MODEL_DEFAULTS } from "@page-assistant/core";

// --- helpers -------------------------------------------------------------------------------

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const messagesReply = (content, extra = {}) =>
  json({ model: "anthropic/claude-haiku-5.5", stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", content, usage: { input_tokens: 5, output_tokens: 2 }, ...extra });

const chatReply = (text) => json({ model: "openai/gpt-4o-mini", choices: [{ message: { content: text }, finish_reason: "stop" }] });

/** Replaces fetch for the test: records each request and answers from `respond(url, body)`. */
async function withFetch(respond, fn) {
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), headers: init.headers, body });
    return respond(String(url), body, requests.length);
  };
  try {
    await fn(requests);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const TOOL = { name: "t", description: "d", parameters: { type: "object", properties: {} } };

// --- model rules -----------------------------------------------------------------------------

test("OpenRouter's Claude ids read as Anthropic's own, so the same rules apply", () => {
  const rules = (m) => {
    const c = claudeIdFromOpenRouter(m);
    return { sampling: acceptsSampling(c), forced: acceptsForcedTool(c), effort: acceptsEffort(c) };
  };
  assert.equal(claudeIdFromOpenRouter("anthropic/claude-haiku-5.5"), "claude-haiku-5-5");
  assert.deepEqual(rules("anthropic/claude-haiku-5.5"), { sampling: false, forced: true, effort: true });
  assert.equal(rules("anthropic/claude-sonnet-5.5").forced, false);
  assert.equal(rules("anthropic/claude-opus-5.5:thinking").forced, false);
  assert.equal(rules("Anthropic/Claude-Fable-5.1").sampling, false);
  // Older OpenRouter ids put the version first.
  assert.equal(claudeIdFromOpenRouter("anthropic/claude-3.5-haiku"), "claude-haiku-3-5");
  assert.equal(rules("anthropic/claude-3.5-haiku").sampling, true);
  assert.equal(rules("anthropic/claude-4.7-opus").sampling, false);
  assert.equal(rules("anthropic/claude-4.6-sonnet").effort, true);
  assert.equal(rules("anthropic/claude-4.5-sonnet-20250929").effort, false);
  // An alias that moves to new models gets neither temperature nor a forced tool.
  assert.equal(claudeIdFromOpenRouter("~anthropic/claude-opus-latest"), "claude-opus-latest");
  assert.deepEqual(rules("~anthropic/claude-opus-latest"), { sampling: false, forced: false, effort: false });
  assert.equal(claudeIdFromOpenRouter("openai/gpt-4o-mini"), null);
  assert.equal(claudeIdFromOpenRouter("claude-haiku-5-5"), null);
});

// --- provider --------------------------------------------------------------------------------

test("anthropic provider on OpenRouter: /messages, bearer key, id as given, thinking replayed", async () => {
  const raw = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "t1", name: "t", input: {} }];
  await withFetch(
    () => messagesReply([{ type: "thinking", thinking: "", signature: "s2" }, { type: "text", text: "hi" }]),
    async (requests) => {
      const p = anthropicProvider({ apiKey: "or-key", baseUrl: "https://openrouter.ai/api/v1/", model: "anthropic/claude-haiku-5.5" });
      assert.equal(p.name, "openrouter");
      const out = await p.complete({
        system: "s",
        tools: [TOOL],
        forceTool: "t",
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "t", args: {} }], providerContent: { provider: "openrouter", content: raw } },
          { role: "tool", toolName: "t", toolCallId: "t1", content: "{}" },
        ],
      });
      const [r] = requests;
      assert.equal(r.url, "https://openrouter.ai/api/v1/messages");
      assert.equal(r.headers.authorization, "Bearer or-key");
      assert.equal(r.headers["x-api-key"], undefined, "the OpenRouter key is not sent as an Anthropic key");
      assert.equal(r.headers["anthropic-version"], "2023-06-01");
      assert.equal(r.body.model, "anthropic/claude-haiku-5.5");
      assert.equal(r.body.temperature, undefined, "Haiku 5.5 rejects temperature, through OpenRouter too");
      assert.deepEqual(r.body.tool_choice, { type: "tool", name: "t" }, "Haiku 5.5 takes a forced tool");
      assert.deepEqual(r.body.messages[1].content, raw, "the model's own thinking blocks go back unchanged");
      assert.deepEqual(r.body.messages[2].content, [{ type: "tool_result", content: "{}", tool_use_id: "t1" }]);
      assert.equal(out.provider, "openrouter");
      assert.equal(out.text, "hi");
      assert.equal(out.assistantContent[0].signature, "s2");
    }
  );
});

test("thinking blocks are replayed only to the endpoint that wrote them", async () => {
  const raw = [{ type: "thinking", thinking: "", signature: "from-anthropic" }, { type: "tool_use", id: "t1", name: "t", input: {} }];
  const history = [
    { role: "user", content: "q" },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "t", args: {} }], providerContent: { provider: "anthropic", content: raw } },
    { role: "tool", toolName: "t", toolCallId: "t1", content: "{}" },
  ];
  await withFetch(
    () => messagesReply([{ type: "text", text: "ok" }]),
    async (requests) => {
      await anthropicProvider({ apiKey: "k", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-haiku-5.5" }).complete({ system: "s", tools: [TOOL], messages: history });
      assert.deepEqual(requests[0].body.messages[1].content, [{ type: "tool_use", id: "t1", name: "t", input: {} }], "rebuilt from toolCalls, no foreign signature");
      await anthropicProvider({ apiKey: "k", model: "claude-haiku-5-5" }).complete({ system: "s", tools: [TOOL], messages: history });
      assert.equal(requests[1].url, "https://api.anthropic.com/v1/messages");
      assert.equal(requests[1].headers["x-api-key"], "k");
      assert.equal(requests[1].headers.authorization, undefined);
      assert.deepEqual(requests[1].body.messages[1].content, raw);
    }
  );
});

test("an OpenRouter error is typed with OpenRouter's name", async () => {
  await withFetch(
    () => json({ error: { message: "bad" } }, 400),
    async () => {
      const p = anthropicProvider({ apiKey: "k", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-haiku-5.5" });
      await assert.rejects(p.complete({ system: "s", tools: [], messages: [{ role: "user", content: "q" }] }), (e) => e instanceof HttpProviderError && e.provider === "openrouter" && e.status === 400);
    }
  );
});

// --- router ----------------------------------------------------------------------------------

test("router: OpenRouter's Claude models take the Anthropic format, the rest chat completions", async () => {
  await withFetch(
    (url) => (url.endsWith("/messages") ? messagesReply([{ type: "text", text: "claude" }]) : chatReply("other")),
    async (requests) => {
      const router = routerFromEnv({ OPENROUTER_API_KEY: "or-key" });
      const ask = (model, more = {}) => router.complete({ system: "s", tools: [TOOL], messages: [{ role: "user", content: "q" }], model, ...more });

      assert.equal((await ask("anthropic/claude-sonnet-5.5", { forceTool: "t" })).provider, "openrouter");
      let r = requests.at(-1);
      assert.equal(r.url, "https://openrouter.ai/api/v1/messages");
      assert.equal(r.headers.authorization, "Bearer or-key");
      assert.equal(r.body.model, "anthropic/claude-sonnet-5.5");
      assert.equal(r.body.system, "s");
      assert.equal(r.body.tool_choice, undefined, "Sonnet 5.5 rejects a forced tool_choice");
      assert.equal(r.body.temperature, undefined);

      await ask("~anthropic/claude-opus-latest");
      assert.ok(requests.at(-1).url.endsWith("/messages"));

      assert.equal((await ask("openai/gpt-4o-mini", { forceTool: "t" })).text, "other");
      r = requests.at(-1);
      assert.equal(r.url, "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(r.headers.authorization, "Bearer or-key");
      assert.equal(r.body.model, "openai/gpt-4o-mini");
      assert.deepEqual(r.body.tool_choice, { type: "function", function: { name: "t" } });
    }
  );
});

test("router: the default OpenRouter model goes through /messages with its own rules", async () => {
  await withFetch(
    () => messagesReply([{ type: "text", text: "ok" }]),
    async (requests) => {
      await routerFromEnv({ OPENROUTER_API_KEY: "k" }).complete({ system: "s", tools: [], messages: [{ role: "user", content: "q" }] });
      assert.equal(requests[0].url, "https://openrouter.ai/api/v1/messages");
      assert.equal(requests[0].body.model, MODEL_DEFAULTS.openrouter);
      assert.equal(requests[0].body.temperature, 0.3, "Haiku 4.5 still takes a temperature");

      await routerFromEnv({ OPENROUTER_API_KEY: "k", PA_OPENROUTER_MODEL: "anthropic/claude-opus-5.5" }).complete({ system: "s", tools: [TOOL], forceTool: "t", messages: [{ role: "user", content: "q" }] });
      assert.equal(requests[1].body.model, "anthropic/claude-opus-5.5");
      assert.equal(requests[1].body.temperature, undefined);
      assert.equal(requests[1].body.tool_choice, undefined);
    }
  );
});

// --- agent loop ------------------------------------------------------------------------------

test("agent mode through OpenRouter: thinking blocks come back on the next tool round", async () => {
  const thought = [
    { type: "thinking", thinking: "Count first.", signature: "or-sig" },
    { type: "tool_use", id: "tu_1", name: "count_items", input: {} },
  ];
  await withFetch(
    (_url, _body, n) => (n === 1 ? messagesReply(thought) : messagesReply([{ type: "text", text: "You have 2 items." }])),
    async (requests) => {
      const agent = createAgent({
        llm: routerFromEnv({ OPENROUTER_API_KEY: "or-key" }),
        model: "anthropic/claude-haiku-5.5",
        pendingActions: new MemoryPendingActionStore(),
        tools: [
          defineTool({
            name: "count_items",
            description: "Count the user's items.",
            parameters: { type: "object", properties: {} },
            run: () => ({ count: 2 }),
          }),
        ],
      });
      const r = await agent.turn({ message: "how many items?", clientCapabilities: ["result_cards"] }, { id: "u1" }, undefined);
      assert.equal(r.errorCode, null);
      assert.equal(requests.length, 2);
      for (const req of requests) {
        assert.equal(req.url, "https://openrouter.ai/api/v1/messages");
        assert.equal(req.headers.authorization, "Bearer or-key");
        assert.equal(req.body.model, "anthropic/claude-haiku-5.5");
      }
      const second = requests[1].body.messages;
      const assistant = second.find((m) => m.role === "assistant");
      assert.deepEqual(assistant.content, thought, "round 2 carries round 1's thinking block, signature intact");
      const results = second.at(-1).content;
      assert.equal(results[0].type, "tool_result");
      assert.equal(results[0].tool_use_id, "tu_1");
    }
  );
});
