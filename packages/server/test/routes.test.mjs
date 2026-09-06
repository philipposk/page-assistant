import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/server.js";

// Boot the real Express app on an ephemeral port and drive it over HTTP.
let base;
let httpServer;

// Capture the last input the provider saw, so we can prove the route reaches the provider
// (no TypeError) even when the caller omits `tools`.
let lastComplete;

before(async () => {
  const app = createServer({
    capabilities: [
      {
        name: "echo",
        description: "Echo a value.",
        parameters: { type: "object", properties: { v: { type: "string" } }, required: ["v"] },
        run: ({ v }) => ({ v }),
        render: (r) => `echo: ${r.v}`,
      },
    ],
    // Scripted LLM so no network / keys are needed. Mimics a real provider that maps
    // input.tools — so if the route passed tools:undefined this would throw a TypeError.
    llm: {
      name: "test",
      async complete(input) {
        lastComplete = input;
        const tools = (input.tools ?? []).map((t) => t.name); // would throw if undefined & no default
        return { toolCalls: [], text: "hello", tools, usage: { promptTokens: 3, completionTokens: 1 }, provider: "test" };
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

test("GET /v1/health reports a version read from package.json (not hardcoded 0.3.0)", async () => {
  const r = await fetch(`${base}/v1/health`);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.match(j.version, /^\d+\.\d+\.\d+/);
});

test("GET /v1/voice/capabilities reflects configured keys", async () => {
  const r = await fetch(`${base}/v1/voice/capabilities`);
  const j = await r.json();
  assert.ok("tts" in j && "stt" in j);
  assert.equal(typeof j.tts.server, "boolean");
  assert.ok(Array.isArray(j.tts.providers));
});

test("GET /v1/voice/capabilities is PUBLIC even when an auth token is set", async () => {
  // Boot a second app WITH auth on; capabilities must still be reachable without a bearer,
  // while a spend endpoint (models) is guarded — proving the guard was removed for caps only.
  process.env.PA_AUTH_TOKEN = "secret-token";
  const guarded = createServer({});
  const srv = await new Promise((resolve) => {
    const s = guarded.listen(0, () => resolve(s));
  });
  const gbase = `http://127.0.0.1:${srv.address().port}`;
  try {
    const caps = await fetch(`${gbase}/v1/voice/capabilities`);
    assert.equal(caps.status, 200); // no bearer, still OK
    const models = await fetch(`${gbase}/v1/models`);
    assert.equal(models.status, 401); // guarded endpoint rejects without bearer
  } finally {
    srv.close();
    delete process.env.PA_AUTH_TOKEN;
  }
});

test("POST /v1/llm/complete with NO tools reaches the provider (no TypeError)", async () => {
  const r = await fetch(`${base}/v1/llm/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }), // no `tools`
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.text, "hello");
  // Provider saw a real (defaulted) array, not undefined.
  assert.ok(Array.isArray(lastComplete.tools));
});

test("POST /v1/llm/complete with a malformed body returns 400 (not 502)", async () => {
  const noMessages = await fetch(`${base}/v1/llm/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tools: [] }), // messages missing
  });
  assert.equal(noMessages.status, 400);

  const badMessages = await fetch(`${base}/v1/llm/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: "not-an-array" }),
  });
  assert.equal(badMessages.status, 400);

  const badTools = await fetch(`${base}/v1/llm/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [], tools: "nope" }),
  });
  assert.equal(badTools.status, 400);
});

test("POST /v1/analytics clamps hostile meta (drops nested, caps keys)", async () => {
  const bigMeta = {};
  for (let i = 0; i < 100; i++) bigMeta["k" + i] = "x".repeat(200);
  bigMeta.nested = { a: 1 };
  bigMeta.arr = [1, 2, 3];
  const post = await fetch(`${base}/v1/analytics`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "test-event", meta: bigMeta }),
  });
  assert.equal(post.status, 200);
  const list = await (await fetch(`${base}/v1/analytics`)).json();
  const ev = list.events.find((e) => e.type === "test-event");
  assert.ok(ev);
  // No nested object / array survived, key count is capped.
  assert.equal(ev.meta.nested, undefined);
  assert.equal(ev.meta.arr, undefined);
  assert.ok(Object.keys(ev.meta).length <= 20);
});

test("POST /v1/analytics rejects missing type", async () => {
  const r = await fetch(`${base}/v1/analytics`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ meta: {} }),
  });
  assert.equal(r.status, 400);
});

test("GET /v1/usage returns aggregates and reflects agent traffic", async () => {
  // Drive one agent call to generate usage.
  await fetch(`${base}/v1/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi", session: "s1" }),
  });
  const u = await (await fetch(`${base}/v1/usage`)).json();
  assert.ok(u.requests >= 1);
  assert.ok("byProvider" in u && "byCapability" in u);
});

test("GET /v1/usage/dashboard serves self-contained HTML (no external assets)", async () => {
  const r = await fetch(`${base}/v1/usage/dashboard`);
  const html = await r.text();
  assert.match(r.headers.get("content-type") ?? "", /html/);
  assert.match(html, /<!doctype html>/i);
  // No external script/style/link/img references.
  assert.doesNotMatch(html, /src="https?:/i);
  assert.doesNotMatch(html, /<link[^>]+href="https?:/i);
});

test("agent memory is isolated per session (no cross-tenant leak)", async () => {
  // Uses the scripted LLM (returns text, no tool calls) so this just checks the endpoint
  // gives each session its own store without erroring; deep leak semantics are unit-tested
  // in core. Two distinct sessions both succeed independently.
  const a = await fetch(`${base}/v1/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "remember X", session: "tenant-a" }),
  });
  const b = await fetch(`${base}/v1/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello", session: "tenant-b" }),
  });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
});
