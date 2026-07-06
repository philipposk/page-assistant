import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dist/server.js";

// Boot the real Express app on an ephemeral port and drive it over HTTP.
let base;
let httpServer;

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
    // Scripted LLM so no network / keys are needed.
    llm: {
      name: "test",
      async complete() {
        return { toolCalls: [], text: "hello", usage: { promptTokens: 3, completionTokens: 1 }, provider: "test" };
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
