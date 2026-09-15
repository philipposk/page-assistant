// The script-tag build, dist/page-assistant.global.js, is what apps copy into public/vendor.
// Their only handle on it is window.PageAssistant, so a name missing there is missing for them,
// and nothing says so: 0.6.0's global had no supabaseChatHistoryAdapter, and account chat
// history quietly stayed on the device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const repo = new URL("../../../", import.meta.url);
// Docs that tell an app what to call. Anything they import from @page-assistant/widget, or
// call as PageAssistant.x, must be on the global too.
const DOCS = ["INTEGRATION.md", "README.md", "AGENTS.md", "packages/widget/README.md"];

/** Run the bundle the way a classic <script> would, against a bare window. */
async function loadGlobal() {
  const code = await readFile(new URL("../dist/page-assistant.global.js", import.meta.url), "utf8");
  const window = {};
  const ctx = vm.createContext({ window });
  vm.runInContext(code, ctx);
  return { global: window.PageAssistant, bundle: ctx.PageAssistantBundle };
}

/** Names the docs use: named imports from the widget, and PageAssistant.x / PageAssistantBundle.x. */
async function namesFromDocs() {
  const imported = new Set();
  const called = new Set();
  for (const doc of DOCS) {
    const text = await readFile(new URL(doc, repo), "utf8");
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@page-assistant\/widget["']/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim();
        if (name && !name.startsWith("type ")) imported.add(name.split(/\s+as\s+/)[0]);
      }
    }
    for (const m of text.matchAll(/\bPageAssistant(?:Bundle)?\.([A-Za-z_$][\w$]*)/g)) called.add(m[1]);
  }
  return { imported: [...imported], called: [...called] };
}

test("the global carries every runtime export of the module", async () => {
  const { global, bundle } = await loadGlobal();
  assert.ok(global, "window.PageAssistant is set");
  assert.ok(bundle, "PageAssistantBundle (the module's exports) is defined");
  const missing = Object.keys(bundle).filter((k) => !(k in global));
  assert.deepEqual(missing, [], `missing from window.PageAssistant: ${missing.join(", ")}`);
});

test("the global has what the docs tell an app to call", async () => {
  const { global } = await loadGlobal();
  const { imported, called } = await namesFromDocs();
  // Guards against the patterns silently matching nothing.
  assert.ok(imported.includes("supabaseChatHistoryAdapter"), "docs import supabaseChatHistoryAdapter");
  assert.ok(called.includes("supabaseChatHistoryAdapter"), "docs call PageAssistant.supabaseChatHistoryAdapter");
  const missing = [
    ...imported.filter((n) => n !== "PageAssistant" && !(n in global)),
    ...called.filter((n) => !(n in global)),
  ];
  assert.deepEqual(missing, [], `the docs name these but window.PageAssistant lacks them: ${missing.join(", ")}`);
});

test("the controller's own methods win over module exports on the global", async () => {
  const { global, bundle } = await loadGlobal();
  for (const k of Object.keys(bundle.PageAssistant)) assert.equal(global[k], bundle.PageAssistant[k], k);
});

test("PageAssistant.supabaseChatHistoryAdapter from the global builds a working adapter", async () => {
  const { global } = await loadGlobal();
  const calls = [];
  const query = {
    eq: (...a) => (calls.push(["eq", ...a]), query),
    upsert: (row, opts) => (calls.push(["upsert", row.app, opts.onConflict]), query),
    then: (ok) => ok({ data: null, error: null }),
  };
  const client = {
    from: (table) => (calls.push(["from", table]), query),
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) },
  };
  const adapter = global.supabaseChatHistoryAdapter(client, { table: "samos_assistant_chats", app: "samos" });
  assert.equal(await adapter.currentUserId(), "u1");
  await adapter.save({ id: "c1", title: "t", messages: [], createdAt: "x", updatedAt: "x" });
  assert.deepEqual(calls, [
    ["from", "samos_assistant_chats"],
    ["upsert", "samos", "user_id,app,id"],
  ]);
});
