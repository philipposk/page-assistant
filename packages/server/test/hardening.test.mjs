import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rateLimit } from "../dist/ratelimit.js";
import { envInt, trustProxySetting } from "../dist/env.js";
import { JsonFileTicketStore } from "../dist/ticketFileStore.js";
import { UsageMeter, whisperFilename } from "../dist/index.js";
import { isRetryableConnectionError } from "../dist/llm/fetchWithRetry.js";

function fakeReqRes(ip = "1.2.3.4", headers = {}) {
  let statusCode = 200;
  let jsonBody;
  const res = {
    setHeader() {},
    status(c) {
      statusCode = c;
      return res;
    },
    json(b) {
      jsonBody = b;
      return res;
    },
  };
  return { req: { ip, headers }, res, get status() { return statusCode; }, get body() { return jsonBody; } };
}

// ---- NaN limiter fallback (fix #1). ----

test("envInt falls back to default on non-numeric input", () => {
  process.env.__PA_TEST_BAD = "not-a-number";
  assert.equal(envInt("__PA_TEST_BAD", 30), 30);
  delete process.env.__PA_TEST_BAD;
});

test("envInt falls back on negative input", () => {
  process.env.__PA_TEST_NEG = "-5";
  assert.equal(envInt("__PA_TEST_NEG", 10), 10);
  delete process.env.__PA_TEST_NEG;
});

test("envInt uses a valid override", () => {
  process.env.__PA_TEST_OK = "7";
  assert.equal(envInt("__PA_TEST_OK", 30), 7);
  delete process.env.__PA_TEST_OK;
});

test("rate limiter built from a bad env value STILL enforces (not silently off)", () => {
  // Previously Number("garbage") => NaN and `n > NaN` is always false → limiter disabled.
  const max = envInt("__NOPE", 3);
  const mw = rateLimit({ windowMs: 60_000, max });
  let passed = 0;
  for (let i = 0; i < 6; i++) {
    const ctx = fakeReqRes();
    mw(ctx.req, ctx.res, () => passed++);
  }
  assert.equal(passed, 3); // enforced, not unlimited
});

// ---- trust proxy parsing (fix #2). ----

test("trustProxySetting defaults off and parses common forms", () => {
  delete process.env.PA_TRUST_PROXY;
  assert.equal(trustProxySetting(), false);
  process.env.PA_TRUST_PROXY = "1";
  assert.equal(trustProxySetting(), true);
  process.env.PA_TRUST_PROXY = "true";
  assert.equal(trustProxySetting(), true);
  process.env.PA_TRUST_PROXY = "2";
  assert.equal(trustProxySetting(), 2);
  delete process.env.PA_TRUST_PROXY;
});

// ---- Atomic ticket write survives a corrupt file (fix #10). ----

test("ticket store moves a corrupt file aside instead of wiping tickets", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pa-tickets-"));
  const file = path.join(dir, "tickets.json");
  const store = new JsonFileTicketStore(file);
  store.save({ app: "a", source: "s", kind: "suggestion", summary: "keep me" });
  // Simulate a crash mid-write leaving garbage.
  writeFileSync(file, "{ this is not valid json");
  // Next save must NOT silently return [] and clobber — it moves the corrupt file aside.
  store.save({ app: "a", source: "s", kind: "suggestion", summary: "after corruption" });
  const listed = store.list(100);
  assert.ok(listed.some((t) => t.summary === "after corruption"));
  // A .corrupt sidecar was created preserving the bad file.
  const sidecars = readdirSync(dir).filter((f) => f.includes(".corrupt"));
  assert.equal(sidecars.length, 1);
});

test("ticket store writes are atomic (valid JSON after each save)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pa-tickets2-"));
  const file = path.join(dir, "tickets.json");
  const store = new JsonFileTicketStore(file);
  store.save({ app: "a", source: "s", kind: "other", summary: "one" });
  store.save({ app: "a", source: "s", kind: "other", summary: "two" });
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.length, 2);
});

// ---- Lazy dir creation: constructing the store must NOT create dirs (minor). ----

test("ticket store does NOT create its directory until the first write", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pa-tickets3-"));
  const nested = path.join(dir, "sub", "deeper");
  const file = path.join(nested, "tickets.json");
  const store = new JsonFileTicketStore(file);
  // Constructor alone must not have touched the filesystem.
  assert.equal(existsSync(nested), false);
  store.save({ app: "a", source: "s", kind: "other", summary: "first" });
  assert.equal(existsSync(nested), true); // created lazily on first write
});

// ---- fetchWithRetry: retry ONLY on pre-response connection errors, never a timeout. ----

test("isRetryableConnectionError retries connection failures but NOT timeouts", () => {
  const conn = new Error("connect ECONNREFUSED 127.0.0.1:443");
  conn.code = "ECONNREFUSED";
  assert.equal(isRetryableConnectionError(conn), true);

  const dns = new Error("getaddrinfo ENOTFOUND api.example.com");
  dns.code = "ENOTFOUND";
  assert.equal(isRetryableConnectionError(dns), true);

  const hangup = new Error("socket hang up");
  assert.equal(isRetryableConnectionError(hangup), true);

  // A timeout (AbortError) must NOT be retried — the request may already be billing.
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  assert.equal(isRetryableConnectionError(abort), false);

  const timeout = new Error("timed out");
  timeout.name = "TimeoutError";
  assert.equal(isRetryableConnectionError(timeout), false);

  // A wrapped (undici-style) cause is also inspected.
  const wrapped = new Error("fetch failed");
  wrapped.cause = Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
  assert.equal(isRetryableConnectionError(wrapped), true);
});

// ---- Whisper filename hint (minor: Safari mp4). ----

test("whisperFilename maps mp4 content type so iOS STT doesn't fail", () => {
  assert.equal(whisperFilename("audio/mp4"), "audio.mp4");
  assert.equal(whisperFilename("audio/webm"), "audio.webm");
  assert.equal(whisperFilename("audio/mpeg"), "audio.mp3");
  assert.equal(whisperFilename(undefined), "audio.webm");
});

// ---- Usage meter + daily budget (feature). ----

test("usage meter aggregates tokens by provider and capability", () => {
  const m = new UsageMeter();
  m.record({ usage: { promptTokens: 10, completionTokens: 4 }, provider: "anthropic", capabilities: ["sim"] });
  m.record({ usage: { promptTokens: 6, completionTokens: 2 }, provider: "openai", capabilities: ["sim", "count"] });
  const s = m.snapshot();
  assert.equal(s.requests, 2);
  assert.equal(s.totalTokens, 22);
  assert.equal(s.byProvider.anthropic.promptTokens, 10);
  assert.equal(s.byCapability.sim, 2);
});

test("daily token budget flips exceeded and gates further spend", () => {
  process.env.PA_DAILY_BUDGET = "20";
  const m = new UsageMeter();
  m.record({ usage: { promptTokens: 15, completionTokens: 0 }, provider: "anthropic" });
  assert.equal(m.isBudgetExceeded(), false);
  m.record({ usage: { promptTokens: 10, completionTokens: 0 }, provider: "anthropic" });
  assert.equal(m.isBudgetExceeded(), true);
  assert.equal(m.snapshot().budget.exceeded, true);
  delete process.env.PA_DAILY_BUDGET;
});
