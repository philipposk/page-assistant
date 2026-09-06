// The model picker's visibility contract, the model list itself, and the string set the
// settings surfaces now depend on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODELS, getAssistantSettings } from "../dist/assistant-settings.js";
import { fetchModelCatalog } from "../dist/models.js";
import { modelPickerVisible } from "../dist/assistant-settings-ui.js";
import { DEFAULT_STRINGS, resolveStrings } from "../dist/strings.js";

const withGlobals = async (globals, fn) => {
  const saved = new Map();
  for (const [k, v] of Object.entries(globals)) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
  }
};

// --- the list -------------------------------------------------------------

test("model ids carry no date suffix", () => {
  // "claude-haiku-4-5-20251001" and "claude-sonnet-4-20250514" were both wrong in shape
  // as well as stale. Current ids are complete as written.
  for (const m of DEFAULT_MODELS) {
    assert.ok(!/-\d{8}$/.test(m.id), `${m.id} still carries a date suffix`);
    assert.ok(m.id && m.label, "every entry needs an id and a label");
  }
});

test("the current Claude family is offered, newest first", () => {
  const ids = DEFAULT_MODELS.map((m) => m.id);
  for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1"]) {
    assert.ok(ids.includes(id), `${id} missing from the picker`);
  }
  assert.equal(ids[0], "claude-opus-5", "most capable model should lead the list");
  assert.ok(!ids.some((id) => id.includes("claude-3.5") || id === "claude-sonnet-4"), "superseded models removed");
});

test("the default model is 'let the server choose'", () => {
  // Naming gpt-4o-mini by default made every widget send an OpenAI model, which an
  // Anthropic-only server rejects outright.
  assert.equal(getAssistantSettings().model, "");
});

// --- the probe ------------------------------------------------------------

test("fetchModelCatalog falls back to the built-in list when there is no server", async () => {
  const c = await fetchModelCatalog(undefined);
  assert.equal(c.fixed, false);
  assert.ok(c.models.length > 1);
});

test("fetchModelCatalog reports a server that pins its model", async () => {
  await withGlobals(
    {
      fetch: async () => ({
        ok: true,
        json: async () => ({ models: [], fixed: true, reason: "Fixed by this site." }),
      }),
    },
    async () => {
      const c = await fetchModelCatalog("https://api.example.com");
      assert.equal(c.fixed, true);
      assert.equal(c.reason, "Fixed by this site.");
    }
  );
});

test("an older server that only returns {models} still gets a working picker", async () => {
  await withGlobals(
    { fetch: async () => ({ ok: true, json: async () => ({ models: [{ id: "a", label: "A" }, { id: "b" }] }) }) },
    async () => {
      const c = await fetchModelCatalog("https://api.example.com");
      assert.equal(c.fixed, false);
      assert.deepEqual(c.models.map((m) => m.id), ["a", "b"]);
      assert.equal(c.models[1].label, "b", "a label-less entry falls back to its id, never undefined");
    }
  );
});

test("a broken probe never breaks the panel", async () => {
  await withGlobals({ fetch: async () => { throw new Error("offline"); } }, async () => {
    const c = await fetchModelCatalog("https://api.example.com");
    assert.equal(c.fixed, false);
    assert.ok(c.models.length > 1);
  });
});

// --- visibility -----------------------------------------------------------

test("the picker is hidden unless there is a real choice to make", () => {
  const many = { models: [{ id: "a", label: "A" }, { id: "b", label: "B" }], fixed: false };
  // Host decides outright.
  assert.equal(modelPickerVisible({ modelPicker: false }, many), false);
  assert.equal(modelPickerVisible({ showModel: false }, many), false);
  assert.equal(modelPickerVisible({ modelPicker: true }, undefined), true);
  // "auto" (the default): hidden until the probe answers, so it never flashes and vanishes.
  assert.equal(modelPickerVisible({}, undefined), false);
  assert.equal(modelPickerVisible({}, many), true);
  assert.equal(modelPickerVisible({}, { models: [], fixed: true }), false);
  // One model is not a choice.
  assert.equal(modelPickerVisible({}, { models: [{ id: "a", label: "A" }], fixed: false }), false);
});

// --- strings --------------------------------------------------------------

test("the settings and sidebar surfaces have defaults for every key they read", () => {
  for (const k of [
    "sidebarSearch", "sidebarCollapse", "sidebarNewChat", "sidebarNewChatLabel", "sidebarShowMore",
    "sidebarEmpty", "sidebarPinned", "sidebarRecent", "sidebarArchived", "sidebarChatActions",
    "menuRename", "menuFork", "menuPin", "menuUnpin", "menuMarkUnread", "menuShare",
    "menuArchive", "menuUnarchive", "menuDelete", "renameChatPrompt", "deleteChatConfirm",
    "settingsTitle", "settingsDone", "settingsTabGeneral", "settingsModel", "modelServerDefault",
    "modelFixedNote", "themeDark", "settingsExportChats", "settingsImportFailed",
  ]) {
    assert.equal(typeof DEFAULT_STRINGS[k], "string", `${k} missing`);
    assert.ok(DEFAULT_STRINGS[k].trim(), `${k} blank`);
  }
});

test("a host that has never heard of a key falls back rather than failing", () => {
  // A host written against 0.5.0 knows none of the sidebar/settings keys added in 0.5.1.
  const s = resolveStrings({ confirm: "Επιβεβαίωση" });
  assert.equal(s.confirm, "Επιβεβαίωση");
  assert.equal(s.menuDelete, DEFAULT_STRINGS.menuDelete);
  assert.equal(s.settingsTabGeneral, DEFAULT_STRINGS.settingsTabGeneral);
});

test("a key this version has dropped is ignored, not thrown on", () => {
  const s = resolveStrings({ someKeyFromTheFuture: "x", menuDelete: "Διαγραφή" });
  assert.equal(s.someKeyFromTheFuture, undefined);
  assert.equal(s.menuDelete, "Διαγραφή");
});
