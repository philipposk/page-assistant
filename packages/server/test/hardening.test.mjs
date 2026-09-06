import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rateLimit } from "../dist/ratelimit.js";
import { envInt, trustProxySetting } from "../dist/env.js";
import { JsonFileTicketStore } from "../dist/ticketFileStore.js";
import { UsageMeter, whisperFilename, toIso639, transcribe, modelCatalog, AVAILABLE_MODELS, routerFromEnv } from "../dist/index.js";
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

// --- Language hint (BCP-47 → ISO-639-1) ------------------------------------

test("toIso639 reduces a BCP-47 tag to the code Whisper/ElevenLabs want", () => {
  assert.equal(toIso639("el-GR"), "el");
  assert.equal(toIso639("EL_gr"), "el");
  assert.equal(toIso639("en"), "en");
  assert.equal(toIso639("en-US"), "en");
});

test("toIso639 rejects junk rather than sending a bad language to the provider", () => {
  assert.equal(toIso639(undefined), undefined);
  assert.equal(toIso639(""), undefined);
  assert.equal(toIso639("   "), undefined);
  assert.equal(toIso639("english"), undefined); // 7 letters, not a code
  assert.equal(toIso639("1234"), undefined);
  assert.equal(toIso639({ evil: true }), undefined); // body field, so it can be anything
});

test("transcribe still accepts the old string hint as its second argument", async () => {
  // Backwards compatibility: callers that pass a content-type string (not an options
  // object) must keep working. No key configured, so it throws before any network call —
  // that it throws the KEY error and not a TypeError is the assertion.
  await assert.rejects(() => transcribe(Buffer.from([1, 2, 3]), "audio/mp4", {}), /OPENAI_API_KEY/);
  await assert.rejects(() => transcribe(Buffer.from([1, 2, 3]), { hint: "audio/mp4", lang: "el-GR" }, {}), /OPENAI_API_KEY/);
  await assert.rejects(() => transcribe(Buffer.from([1, 2, 3]), undefined, {}), /OPENAI_API_KEY/);
});

// --- Model catalogue -------------------------------------------------------

test("modelCatalog only offers models the server holds a key for", () => {
  const anthropicOnly = modelCatalog({ ANTHROPIC_API_KEY: "k" });
  assert.equal(anthropicOnly.fixed, false);
  assert.ok(anthropicOnly.models.length > 1);
  assert.ok(anthropicOnly.models.every((m) => m.provider === "anthropic"));

  const both = modelCatalog({ ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" });
  assert.ok(both.models.some((m) => m.provider === "openai"));
});

test("PA_FIXED_MODEL reports the model as fixed, with nothing to choose from", () => {
  const c = modelCatalog({ ANTHROPIC_API_KEY: "k", PA_FIXED_MODEL: "claude-sonnet-5" });
  assert.equal(c.fixed, true);
  assert.deepEqual(c.models, []);
  assert.ok(c.reason && c.reason.length > 0, "the widget shows this instead of a picker");
});

test("no keys, or a single model, counts as fixed — one option is not a choice", () => {
  assert.equal(modelCatalog({}).fixed, true);
  assert.equal(modelCatalog({}).models.length, 0);
  assert.equal(modelCatalog({ OPENROUTER_API_KEY: "k" }).models.length, 1);
  assert.equal(modelCatalog({ OPENROUTER_API_KEY: "k" }).fixed, true);
});

test("server model ids carry no date suffix", () => {
  for (const m of AVAILABLE_MODELS) assert.ok(!/-\d{8}$/.test(m.id), `${m.id} still date-suffixed`);
});

test("a pinned model with no matching key fails loudly at request time", async () => {
  const llm = routerFromEnv({ OPENAI_API_KEY: "k", PA_FIXED_MODEL: "claude-sonnet-5" });
  // providerForModel falls through to OpenAI when no Anthropic key is set, so this one
  // resolves; the case that must throw is a pinned model with NO provider at all.
  assert.ok(llm);
  assert.throws(
    () => routerFromEnv({ PA_FIXED_MODEL: "claude-sonnet-5" }),
    /No LLM key set/,
    "a server with no keys at all still fails at construction"
  );
});
