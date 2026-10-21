// Are the model ids page-assistant names still served? Checks every id in core's models.ts
// (MODEL_DEFAULTS and MODEL_CATALOG) against the providers' live model lists, so a retired
// model is caught before an app's assistant starts failing on it.
//
//   npm run build -w packages/core && node scripts/models/check.mjs
//
// Sources: OpenRouter's public list (no key) always; Anthropic's and OpenAI's own lists when
// ANTHROPIC_API_KEY / OPENAI_API_KEY are set. Without a key, a Claude or OpenAI id is looked up
// as OpenRouter lists it (`claude-haiku-4-5` → `anthropic/claude-haiku-4.5`), which tracks the
// same releases and retirements. OpenRouter also says when a model is due to go
// (`expiration_date`): one due within WARN_DAYS counts as gone already, so there is time to
// move. Exit 1 when anything is wrong; .github/workflows/models.yml runs this weekly and opens
// an issue.

import { pathToFileURL } from "node:url";

const OPENROUTER = "https://openrouter.ai/api/v1/models";
const ANTHROPIC = "https://api.anthropic.com/v1/models";
const OPENAI = "https://api.openai.com/v1/models";
export const WARN_DAYS = 60;

/** `claude-haiku-4-5` → `anthropic/claude-haiku-4.5`; `gpt-4o-mini` → `openai/gpt-4o-mini`. */
export function openRouterId(id, provider) {
  if (provider === "openrouter") return id;
  // The version's dash becomes a dot, wherever it sits: claude-haiku-4-5, claude-3-5-haiku.
  if (provider === "anthropic") return `anthropic/${id.replace(/-(\d+)-(\d+)(?=-|$)/, "-$1.$2")}`;
  return `openai/${id}`;
}

/** Anthropic lists dated ids (`claude-haiku-4-5-20251001`) next to or instead of the alias. */
function inAnthropicList(id, ids) {
  return ids.some((x) => x === id || (x.startsWith(`${id}-`) && /^\d{8}$/.test(x.slice(id.length + 1))));
}

async function getJson(fetch, url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function anthropicIds(fetch, key) {
  const ids = [];
  let after = "";
  for (let page = 0; page < 20; page++) {
    const data = await getJson(fetch, `${ANTHROPIC}?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`, {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    });
    for (const m of data.data ?? []) ids.push(m.id);
    if (!data.has_more || !data.last_id) break;
    after = data.last_id;
  }
  return ids;
}

/**
 * The check itself, with the network passed in (tests give it a stub).
 * `models`: [{ id, provider: "anthropic" | "openai" | "openrouter", kind: "chat" | "tts", where }].
 * Returns { problems, notes }: problems fail the check, notes are only printed.
 */
export async function checkModels({ models, fetch = globalThis.fetch, env = process.env, now = Date.now() }) {
  const problems = [];
  const notes = [];
  let openrouter;
  try {
    openrouter = new Map((await getJson(fetch, OPENROUTER)).data.map((m) => [m.id, m]));
  } catch (e) {
    problems.push({ id: "*", where: "OpenRouter", reason: `could not read the model list: ${e.message}` });
    return { problems, notes };
  }
  let anthropic = null;
  if (env.ANTHROPIC_API_KEY) {
    try {
      anthropic = await anthropicIds(fetch, env.ANTHROPIC_API_KEY);
    } catch (e) {
      notes.push(`Anthropic's list unavailable (${e.message}); Claude ids checked on OpenRouter instead.`);
    }
  }
  let openai = null;
  if (env.OPENAI_API_KEY) {
    try {
      openai = ((await getJson(fetch, OPENAI, { authorization: `Bearer ${env.OPENAI_API_KEY}` })).data ?? []).map((m) => m.id);
    } catch (e) {
      notes.push(`OpenAI's list unavailable (${e.message}); OpenAI ids checked on OpenRouter instead.`);
    }
  }

  const seen = new Set();
  for (const m of models) {
    const key = `${m.provider}:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fail = (reason) => problems.push({ id: m.id, where: m.where, reason });

    // The provider's own list, when there is a key for it, is the final word on whether it exists.
    if (m.provider === "anthropic" && anthropic) {
      if (!inAnthropicList(m.id, anthropic)) fail("not in Anthropic's model list");
    } else if (m.provider === "openai" && openai) {
      if (!openai.includes(m.id)) fail("not in OpenAI's model list");
    } else if (m.kind === "tts") {
      notes.push(`${m.id} (${m.where}) not checked: OpenRouter lists no speech models; set OPENAI_API_KEY to check it.`);
      continue;
    }

    // OpenRouter: existence when there was no own list, and a retirement date either way.
    const listed = openrouter.get(openRouterId(m.id, m.provider));
    const ownListUsed = (m.provider === "anthropic" && anthropic) || (m.provider === "openai" && openai);
    if (!listed) {
      if (!ownListUsed) fail(`not on OpenRouter as ${openRouterId(m.id, m.provider)}`);
      continue;
    }
    if (listed.expiration_date) {
      const due = Date.parse(listed.expiration_date);
      const days = Math.floor((due - now) / 86_400_000);
      if (Number.isFinite(due) && days <= WARN_DAYS) fail(`retires on ${listed.expiration_date} (${days} days)`);
    }
  }
  return { problems, notes };
}

async function main() {
  const { modelsInUse } = await import(new URL("../../packages/core/dist/models.js", import.meta.url));
  const { problems, notes } = await checkModels({ models: modelsInUse() });
  for (const n of notes) console.log(`note: ${n}`);
  if (!problems.length) {
    console.log(`All ${modelsInUse().length} model ids are served.`);
    return;
  }
  console.log("Model ids that need replacing (packages/core/src/models.ts):");
  for (const p of problems) console.log(`- ${p.id} (${p.where}): ${p.reason}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
