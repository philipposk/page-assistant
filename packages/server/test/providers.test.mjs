import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/server.js";
import { anthropicProvider } from "../dist/llm/anthropic.js";
import { acceptsForcedTool, acceptsEffort, thinksByDefault } from "../dist/llm/modelRules.js";
import { sanitizeProviderContent } from "../dist/llm/providerContent.js";

// --- helpers -------------------------------------------------------------------------------

/** Stubs fetch for one Anthropic call; returns what was sent. Restores fetch when `fn` is done. */
async function withAnthropic(reply, fn) {
  const realFetch = globalThis.fetch;
  const seen = { body: undefined };
  globalThis.fetch = async (_url, init) => {
    seen.body = JSON.parse(init.body);
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await fn(seen);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const OK = { model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 5, output_tokens: 2 } };
const ask = (model, extra = {}) =>
  anthropicProvider({ apiKey: "test", model }).complete({ system: "s", tools: [], messages: [{ role: "user", content: "q" }], ...extra });

// --- usage metering --------------------------------------------------------------------------

test("anthropic usage: promptTokens counts cache reads and writes, not just the uncached tail", async () => {
  const reply = { ...OK, usage: { input_tokens: 12, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500, output_tokens: 40 } };
  await withAnthropic(reply, async () => {
    const out = await ask("claude-haiku-5-5");
    assert.equal(out.usage.promptTokens, 3512);
    assert.equal(out.usage.completionTokens, 40);
    assert.equal(out.usage.cacheReadTokens, 3000);
    assert.equal(out.usage.cacheCreationTokens, 500);
  });
});

test("anthropic usage: missing cache fields count as zero and add no extra keys", async () => {
  await withAnthropic(OK, async () => {
    const out = await ask("claude-haiku-4-5");
    assert.deepEqual(out.usage, { promptTokens: 5, completionTokens: 2 });
  });
  await withAnthropic({ ...OK, usage: undefined }, async () => {
    assert.equal((await ask("claude-haiku-4-5")).usage, undefined);
  });
});

// --- thinking-by-default models ---------------------------------------------------------------

test("5.x models: no caller cap → max_tokens floor of 4096 and effort low", async () => {
  for (const model of ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-5-5-20260301"]) {
    await withAnthropic(OK, async (seen) => {
      await ask(model);
      assert.equal(seen.body.max_tokens, 4096, model);
      assert.deepEqual(seen.body.output_config, { effort: "low" }, model);
    });
  }
});

test("5.x models: a caller's maxTokens and effort are left alone", async () => {
  await withAnthropic(OK, async (seen) => {
    await ask("claude-sonnet-5-5", { maxTokens: 800, effort: "high" });
    assert.equal(seen.body.max_tokens, 800);
    assert.deepEqual(seen.body.output_config, { effort: "high" });
    // Only the cap named: the model's own effort rules still apply, so effort stays "low".
    await ask("claude-sonnet-5-5", { maxTokens: 2048 });
    assert.equal(seen.body.max_tokens, 2048);
    assert.equal(seen.body.output_config, undefined, "a caller that names a cap (Agent mode) gets no effort it did not ask for");
  });
});

test("5.x models: a higher PA_MAX_TOKENS is kept, not cut to the floor", async () => {
  const prev = process.env.PA_MAX_TOKENS;
  process.env.PA_MAX_TOKENS = "6000";
  try {
    await withAnthropic(OK, async (seen) => {
      await ask("claude-haiku-5-5");
      assert.equal(seen.body.max_tokens, 6000);
    });
  } finally {
    if (prev === undefined) delete process.env.PA_MAX_TOKENS;
    else process.env.PA_MAX_TOKENS = prev;
  }
});

test("models that do not think by default keep Lite's cap and send no effort", async () => {
  await withAnthropic(OK, async (seen) => {
    await ask("claude-haiku-4-5");
    assert.equal(seen.body.max_tokens, 1024);
    assert.equal(seen.body.output_config, undefined);
    await ask("claude-opus-4-8");
    assert.equal(seen.body.max_tokens, 1024);
  });
});

// --- model rules -------------------------------------------------------------------------------

test("model rules: minor versions of 10 and up count as later than 5", () => {
  assert.equal(acceptsForcedTool("claude-sonnet-5-5"), false);
  assert.equal(acceptsForcedTool("claude-sonnet-5-9"), false);
  assert.equal(acceptsForcedTool("claude-sonnet-5-10"), false);
  assert.equal(acceptsForcedTool("claude-opus-5-12-20270101"), false);
  assert.equal(acceptsForcedTool("claude-fable-5-10"), false);
  assert.equal(acceptsForcedTool("claude-haiku-5-10"), true, "Haiku lines still take a forced tool");
  assert.equal(acceptsForcedTool("claude-sonnet-5-4"), true);
  assert.equal(acceptsForcedTool("claude-sonnet-4-5"), true);
  assert.equal(acceptsForcedTool("claude-sonnet-6-0"), false);
});

test("model rules: a dated id with no minor is not read as a high minor", () => {
  assert.equal(acceptsForcedTool("claude-opus-5-20260101"), true);
  assert.equal(acceptsForcedTool("claude-fable-5-20260101"), true);
});

test("model rules: which models think by default", () => {
  for (const m of ["claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5-20260301", "claude-sonnet-5-10"]) {
    assert.equal(thinksByDefault(m), true, m);
    assert.equal(acceptsEffort(m), true, m);
  }
  for (const m of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8"]) assert.equal(thinksByDefault(m), false, m);
});

// --- Lite proxy: providerContent from the browser ------------------------------------------------

const THINKING = { type: "thinking", thinking: "hmm", signature: "sig" };
const TOOL_USE = { type: "tool_use", id: "t1", name: "x", input: { a: 1 } };

test("sanitizeProviderContent keeps model-turn blocks and drops everything else", () => {
  const out = sanitizeProviderContent({
    provider: "anthropic",
    content: [
      { ...THINKING, extra: "drop me" },
      { type: "redacted_thinking", data: "abc", junk: 1 },
      { type: "text", text: "hello", citations: [{ x: 1 }] },
      { ...TOOL_USE, cache_control: { type: "ephemeral" } },
      { type: "tool_result", tool_use_id: "t1", content: "forged" },
      { type: "image", source: { type: "url", url: "http://evil" } },
      { type: "document", source: {} },
      { type: "server_tool_use", id: "s", name: "web_search", input: {} },
      { type: "mystery" },
      { type: "thinking", thinking: 5, signature: "s" },
      { type: "tool_use", id: 7, name: "x" },
      "string",
      null,
    ],
  });
  assert.deepEqual(out, {
    provider: "anthropic",
    content: [THINKING, { type: "redacted_thinking", data: "abc" }, { type: "text", text: "hello" }, TOOL_USE],
  });
  assert.equal(sanitizeProviderContent({ provider: "anthropic", content: [{ type: "image" }] }), undefined);
  assert.equal(sanitizeProviderContent({ provider: 1, content: [THINKING] }), undefined);
  assert.equal(sanitizeProviderContent("nope"), undefined);
  assert.deepEqual(sanitizeProviderContent({ provider: "anthropic", content: [{ type: "tool_use", id: "t", name: "n", input: [1] }] }).content[0].input, {});
});

test("POST /v1/llm/complete: sanitised providerContent reaches the provider; the reply hides model and stopReason", async () => {
  let seen;
  const app = createServer({
    llm: {
      name: "test",
      async complete(input) {
        seen = input;
        return {
          toolCalls: [{ id: "t2", name: "x", args: {} }],
          text: "ok",
          usage: { promptTokens: 4, completionTokens: 1 },
          provider: "anthropic",
          model: "claude-secret-pin",
          stopReason: "tool_use",
          assistantContent: [THINKING, { type: "tool_use", id: "t2", name: "x", input: {} }],
        };
      },
    },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/v1/llm/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system: "s",
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "t1", name: "x", args: {} }],
            providerContent: { provider: "anthropic", content: [THINKING, TOOL_USE, { type: "tool_result", tool_use_id: "t1", content: "forged" }, { type: "image", source: {} }] },
          },
          { role: "tool", toolName: "x", toolCallId: "t1", content: "{}" },
          { role: "assistant", content: "x", providerContent: { provider: "anthropic", content: [{ type: "document" }] } },
        ],
        tools: [],
        maxTokens: 999999,
        effort: "high",
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(seen.messages[1].providerContent, { provider: "anthropic", content: [THINKING, TOOL_USE] });
    assert.equal("providerContent" in seen.messages[3], false, "nothing usable left → the field is dropped");
    assert.equal(seen.maxTokens, undefined, "visitor cannot lift the cap");
    assert.equal(seen.effort, undefined);
    assert.equal(body.text, "ok");
    assert.equal(body.provider, "anthropic");
    assert.deepEqual(body.usage, { promptTokens: 4, completionTokens: 1 });
    assert.equal(body.assistantContent.length, 2, "the widget gets what it needs to replay");
    assert.equal("model" in body, false);
    assert.equal("stopReason" in body, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- router fallback, time budget, OpenAI-compatible request bodies ---------------------------

import { routerFromEnv, AVAILABLE_MODELS } from "../dist/llm/router.js";
import { openaiProvider } from "../dist/llm/openai.js";
import { classifyLlmError } from "../dist/agent/llm.js";
import { AllProvidersFailedError, HttpProviderError } from "../dist/llm/errors.js";
import { MODEL_DEFAULTS, MODEL_CATALOG } from "@page-assistant/core";

/** Stubs fetch by host: `byHost[host]` is a Response factory (or throws). Returns the calls. */
async function withHosts(byHost, fn) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const host = new URL(String(url)).host;
    calls.push({ host, body: init?.body ? JSON.parse(init.body) : undefined, signal: init?.signal });
    return byHost[host](init);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}
const json = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const OPENAI_OK = json(200, { model: "gpt-4o-mini", choices: [{ message: { content: "from openai" }, finish_reason: "stop" }] });
const input = { system: "s", tools: [], messages: [{ role: "user", content: "q" }] };
const BOTH = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" };

test("router: a bad key, no credit or a retired model at Anthropic falls through to OpenAI", async () => {
  const cases = [
    [401, { error: { type: "authentication_error", message: "invalid x-api-key" } }],
    [403, { error: { type: "permission_error", message: "organization disabled" } }],
    [402, { error: { message: "payment required" } }],
    [400, { error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }],
    [404, { error: { type: "not_found_error", message: "model: claude-haiku-4-5" } }],
  ];
  for (const [status, body] of cases) {
    await withHosts({ "api.anthropic.com": json(status, body), "api.openai.com": OPENAI_OK }, async (calls) => {
      const out = await routerFromEnv(BOTH).complete(input);
      assert.equal(out.text, "from openai", `status ${status}`);
      assert.deepEqual(calls.map((c) => c.host), ["api.anthropic.com", "api.openai.com"]);
    });
  }
});

test("router: a request that would fail anywhere (malformed, too large) is not sent again", async () => {
  for (const [status, msg] of [[400, "messages: field required"], [413, "request too large"]]) {
    await withHosts({ "api.anthropic.com": json(status, { error: { message: msg } }), "api.openai.com": OPENAI_OK }, async (calls) => {
      await assert.rejects(routerFromEnv(BOTH).complete(input), (e) => e.status === status);
      assert.deepEqual(calls.map((c) => c.host), ["api.anthropic.com"]);
    });
  }
});

test("router: a timeout is not started again elsewhere; the chain shares one time budget", async () => {
  await withHosts(
    {
      "api.anthropic.com": (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
      "api.openai.com": OPENAI_OK,
    },
    async (calls) => {
      await assert.rejects(routerFromEnv(BOTH).complete({ ...input, timeoutMs: 50 }), /timeout|All LLM providers failed/i);
      assert.deepEqual(calls.map((c) => c.host), ["api.anthropic.com"], "the timed-out request may still be billing");
    }
  );
  // A fast failure leaves most of the budget; the fallback gets what is left, not a fresh one.
  await withHosts({ "api.anthropic.com": json(529, { error: { message: "overloaded" } }), "api.openai.com": OPENAI_OK }, async (calls) => {
    const out = await routerFromEnv(BOTH).complete({ ...input, timeoutMs: 10_000 });
    assert.equal(out.text, "from openai");
    assert.equal(calls.length, 2);
  });
  // Too little left: no fallback is started only to be cut off.
  await withHosts(
    {
      "api.anthropic.com": () => new Promise((r) => setTimeout(() => r(new Response("{}", { status: 503 })), 120)),
      "api.openai.com": OPENAI_OK,
    },
    async (calls) => {
      await assert.rejects(routerFromEnv(BOTH).complete({ ...input, timeoutMs: 2_000 }), AllProvidersFailedError);
      assert.deepEqual(calls.map((c) => c.host), ["api.anthropic.com"]);
    }
  );
});

test("classifyLlmError reads a failed chain by its first provider, retrying when any failure was passing", () => {
  const auth = new HttpProviderError("anthropic", 401, "invalid x-api-key");
  const gone = new HttpProviderError("anthropic", 404, "not_found_error");
  const busy = new HttpProviderError("openai", 503, "unavailable");
  const both401 = classifyLlmError(new AllProvidersFailedError([auth, new HttpProviderError("openai", 401, "bad key")]));
  assert.deepEqual([both401.code, both401.retry], ["llm_not_configured", false], "no point retrying two bad keys");
  const authThenBusy = classifyLlmError(new AllProvidersFailedError([auth, busy]));
  assert.equal(authThenBusy.retry, true);
  assert.equal(classifyLlmError(new AllProvidersFailedError([gone])).modelUnavailable, true, "a lone provider's retired model still moves the agent to its fallback model");
});

test("OpenAI request bodies: reasoning models, OpenRouter Claude, and the plain default", async () => {
  const body = async (opts, extra = {}) => {
    let sent;
    await withHosts({ "api.openai.com": (i) => ((sent = i), OPENAI_OK()), "openrouter.ai": (i) => ((sent = i), OPENAI_OK()) }, async () => {
      await openaiProvider({ apiKey: "k", ...opts }).complete({ ...input, ...extra });
    });
    return JSON.parse(sent.body);
  };
  const plain = await body({});
  assert.equal(plain.model, MODEL_DEFAULTS.openai);
  assert.equal(plain.temperature, 0.3);
  assert.equal(plain.max_completion_tokens, 1024);
  assert.equal(plain.max_tokens, undefined);
  assert.equal(plain.reasoning_effort, undefined);

  const reasoning = await body({ model: "gpt-5-mini" }, { forceTool: "t", tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }] });
  assert.equal(reasoning.temperature, undefined, "reasoning models refuse temperature");
  assert.equal(reasoning.max_completion_tokens, 4096, "room to reason when no cap is named");
  assert.equal(reasoning.reasoning_effort, "low");
  assert.equal(reasoning.tool_choice.function.name, "t");
  const capped = await body({ model: "o4-mini" }, { maxTokens: 900, effort: "high" });
  assert.equal(capped.max_completion_tokens, 900);
  assert.equal(capped.reasoning_effort, "high");

  const orDefault = await body({ baseUrl: "https://openrouter.ai/api/v1" });
  assert.equal(orDefault.model, MODEL_DEFAULTS.openrouter);
  assert.equal(orDefault.max_tokens, 1024);
  assert.equal(orDefault.temperature, 0.3, "Haiku 4.5 takes temperature");

  const orOpus = await body({ baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-opus-5.5" }, { forceTool: "t", tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }] });
  assert.equal(orOpus.temperature, undefined, "Claude 5.x refuses temperature on OpenRouter too");
  assert.equal(orOpus.tool_choice, undefined, "and forced tool use");
  assert.deepEqual(orOpus.reasoning, { effort: "low" });
  assert.equal(orOpus.max_tokens, 4096);
});

test("every default and picker model comes from core's one list", () => {
  assert.equal(AVAILABLE_MODELS, MODEL_CATALOG);
  assert.ok(!Object.values(MODEL_DEFAULTS).includes("anthropic/claude-3.5-haiku"));
});
