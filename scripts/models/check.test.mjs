// The model-id guard, without a network: every id the packages use lives in core's models.ts
// (so the weekly live check sees all of them), none is from a retired generation, and the
// check reports a missing or soon-retired model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { checkModels, openRouterId, WARN_DAYS } from "./check.mjs";
import { MODEL_CATALOG, MODEL_DEFAULTS, modelsInUse } from "../../packages/core/dist/models.js";

const repo = new URL("../../", import.meta.url);

async function sources(dir) {
  const out = [];
  for (const e of await readdir(new URL(dir, repo), { withFileTypes: true })) {
    const rel = `${dir}${e.name}`;
    if (e.isDirectory()) out.push(...(await sources(`${rel}/`)));
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

// A quoted string shaped like a chat or speech model id.
const MODEL_LITERAL = /["'`]((?:anthropic\/|openai\/)?(?:claude-[a-z0-9.-]+|gpt-[a-z0-9.-]+|o[134](?:-[a-z0-9-]+)?))["'`]/g;

test("no source file but core's models.ts spells a model id", async () => {
  const offenders = [];
  for (const pkg of ["core", "widget", "server", "react", "mcp", "cli"]) {
    for (const file of await sources(`packages/${pkg}/src/`)) {
      if (file === "packages/core/src/models.ts") continue;
      // Comments may name models; code may not.
      const code = (await readFile(new URL(file, repo), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      for (const m of code.matchAll(MODEL_LITERAL)) {
        // A family prefix used to match ids ("claude") is not an id.
        if (/^(?:claude|gpt|o\d)-?$/.test(m[1])) continue;
        offenders.push(`${file}: ${m[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "put the id in packages/core/src/models.ts and import it");
});

test("the example env file pins no model (a pinned id there goes stale unnoticed)", async () => {
  const env = await readFile(new URL(".env.example", repo), "utf8");
  assert.deepEqual(env.split("\n").filter((l) => /^\s*PA_\w*MODEL\w*\s*=\s*\S/.test(l)), []);
});

test("no default or catalog model is from a retired generation", () => {
  const retired = /^(?:anthropic\/)?claude-(?:instant|[1-3](?:[.-]|$))|^(?:anthropic\/)?claude-(?:opus|sonnet|haiku)-3|^(?:openai\/)?(?:gpt-3\.5|gpt-4(?:-|$)|gpt-4-turbo|text-|davinci|o1-(?:preview|mini))|-\d{8}$/;
  for (const m of modelsInUse()) assert.doesNotMatch(m.id, retired, `${m.id} (${m.where})`);
  assert.ok(MODEL_CATALOG.length > 0 && Object.values(MODEL_DEFAULTS).every(Boolean));
});

test("ids map to OpenRouter's spelling", () => {
  assert.equal(openRouterId("claude-haiku-4-5", "anthropic"), "anthropic/claude-haiku-4.5");
  assert.equal(openRouterId("claude-fable-5-1", "anthropic"), "anthropic/claude-fable-5.1");
  assert.equal(openRouterId("claude-opus-5", "anthropic"), "anthropic/claude-opus-5");
  assert.equal(openRouterId("claude-3-5-haiku", "anthropic"), "anthropic/claude-3.5-haiku");
  assert.equal(openRouterId("gpt-4o-mini", "openai"), "openai/gpt-4o-mini");
  assert.equal(openRouterId("anthropic/claude-haiku-4.5", "openrouter"), "anthropic/claude-haiku-4.5");
});

function stubFetch(lists) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const key = Object.keys(lists).find((k) => String(url).startsWith(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => lists[key] };
  };
  return { fetch, calls };
}

const NOW = Date.parse("2026-10-21T00:00:00Z");
const day = (n) => new Date(NOW + n * 86_400_000).toISOString().slice(0, 10);

test("checkModels: a missing id and one retiring soon are problems; one retiring later is fine", async () => {
  const { fetch } = stubFetch({
    "https://openrouter.ai/api/v1/models": {
      data: [
        { id: "anthropic/claude-haiku-4.5", expiration_date: null },
        { id: "openai/gpt-4o-mini", expiration_date: day(10) },
        { id: "anthropic/claude-sonnet-5.5", expiration_date: day(WARN_DAYS + 30) },
      ],
    },
  });
  const { problems } = await checkModels({
    fetch,
    env: {},
    now: NOW,
    models: [
      { id: "claude-haiku-4-5", provider: "anthropic", kind: "chat", where: "a" },
      { id: "gpt-4o-mini", provider: "openai", kind: "chat", where: "b" },
      { id: "anthropic/claude-sonnet-5.5", provider: "openrouter", kind: "chat", where: "c" },
      { id: "anthropic/claude-3.5-haiku", provider: "openrouter", kind: "chat", where: "d" },
    ],
  });
  assert.deepEqual(
    problems.map((p) => [p.id, /retires|not on/.exec(p.reason)?.[0]]),
    [
      ["gpt-4o-mini", "retires"],
      ["anthropic/claude-3.5-haiku", "not on"],
    ]
  );
});

test("checkModels: with a provider key its own list decides, dated ids included", async () => {
  const { fetch, calls } = stubFetch({
    "https://openrouter.ai/api/v1/models": { data: [] },
    "https://api.anthropic.com/v1/models": { data: [{ id: "claude-haiku-4-5-20251001" }], has_more: false },
    "https://api.openai.com/v1/models": { data: [{ id: "gpt-4o-mini-tts" }] },
  });
  const { problems } = await checkModels({
    fetch,
    env: { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" },
    now: NOW,
    models: [
      { id: "claude-haiku-4-5", provider: "anthropic", kind: "chat", where: "a" },
      { id: "claude-gone-1", provider: "anthropic", kind: "chat", where: "b" },
      { id: "gpt-4o-mini-tts", provider: "openai", kind: "tts", where: "c" },
    ],
  });
  assert.deepEqual(problems.map((p) => p.id), ["claude-gone-1"]);
  assert.ok(calls.some((u) => u.startsWith("https://api.anthropic.com/")));
});

test("checkModels: an unreadable OpenRouter list fails the check instead of passing it", async () => {
  const { problems } = await checkModels({ fetch: async () => ({ ok: false, status: 503 }), env: {}, models: modelsInUse() });
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /could not read/);
});
