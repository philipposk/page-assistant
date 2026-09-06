// Language resolution + the localisable string set. These are the two things a host
// writes against, so they are pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVoiceLang, baseLang, voiceInputAvailable } from "../dist/voice.js";
import { DEFAULT_STRINGS, resolveStrings, fmt } from "../dist/strings.js";

// Node defines `navigator` as a getter-only global, so swap descriptors rather than assign.
const withGlobals = (globals, fn) => {
  const saved = new Map();
  for (const [k, v] of Object.entries(globals)) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  try {
    return fn();
  } finally {
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
  }
};

test("an explicit lang always wins over <html lang> and navigator", () => {
  // The live case this exists for: a host renders a fully Greek UI while its root element
  // still says lang="en". An explicit option must not be second-guessed.
  withGlobals(
    {
      document: { documentElement: { lang: "en" } },
      navigator: { language: "en-US" },
    },
    () => {
      assert.equal(resolveVoiceLang("el-GR"), "el-GR");
      assert.equal(resolveVoiceLang("  el-GR  "), "el-GR");
    }
  );
});

test("without an explicit lang, <html lang> then navigator.language then en-US", () => {
  withGlobals({ document: { documentElement: { lang: "el-GR" } }, navigator: { language: "en-US" } }, () =>
    assert.equal(resolveVoiceLang(), "el-GR")
  );
  withGlobals({ document: { documentElement: { lang: "" } }, navigator: { language: "fr-FR" } }, () =>
    assert.equal(resolveVoiceLang(), "fr-FR")
  );
  withGlobals({ document: { documentElement: { lang: "" } }, navigator: { language: "" } }, () =>
    assert.equal(resolveVoiceLang(), "en-US")
  );
  assert.equal(resolveVoiceLang(), "en-US"); // no DOM at all
});

test("lang is resolved per call, so a host that flips <html lang> is followed", () => {
  const documentElement = { lang: "en-US" };
  withGlobals({ document: { documentElement }, navigator: { language: "en-US" } }, () => {
    assert.equal(resolveVoiceLang(), "en-US");
    documentElement.lang = "el-GR"; // user switches language, no reload
    assert.equal(resolveVoiceLang(), "el-GR");
  });
});

test("baseLang reduces a BCP-47 tag to its language", () => {
  assert.equal(baseLang("el-GR"), "el");
  assert.equal(baseLang("EN_gb"), "en");
  assert.equal(baseLang("el"), "el");
});

test("voiceInputAvailable is false when nothing can back the mic", () => {
  assert.equal(voiceInputAvailable(), false); // no window
  withGlobals({ window: {}, navigator: {} }, () => {
    assert.equal(voiceInputAvailable(), false);
    assert.equal(voiceInputAvailable("https://api.example.com"), false); // no MediaRecorder
  });
  withGlobals({ window: { webkitSpeechRecognition: function () {} }, navigator: {} }, () =>
    assert.equal(voiceInputAvailable(), true)
  );
  withGlobals(
    { window: { MediaRecorder: function () {} }, navigator: { mediaDevices: { getUserMedia() {} } } },
    () => {
      assert.equal(voiceInputAvailable("https://api.example.com"), true);
      assert.equal(voiceInputAvailable(), false); // server STT needs a server
    }
  );
});

test("string overrides merge over the English defaults", () => {
  const s = resolveStrings({ confirm: "Επιβεβαίωση", cancel: "Άκυρο" });
  assert.equal(s.confirm, "Επιβεβαίωση");
  assert.equal(s.cancel, "Άκυρο");
  assert.equal(s.retry, DEFAULT_STRINGS.retry); // untranslated keys keep English
  assert.equal(resolveStrings().retry, DEFAULT_STRINGS.retry);
});

test("blank overrides are ignored rather than blanking a label", () => {
  const s = resolveStrings({ confirm: "", cancel: "   " });
  assert.equal(s.confirm, DEFAULT_STRINGS.confirm);
  assert.equal(s.cancel, DEFAULT_STRINGS.cancel);
});

test("placeholder keys interpolate, unknown tokens are left alone", () => {
  assert.equal(fmt(DEFAULT_STRINGS.launcherOpen, { title: "Daybook" }), "Open Daybook");
  assert.equal(fmt("Άνοιγμα {title}", { title: "Daybook" }), "Άνοιγμα Daybook");
  assert.equal(fmt("{a} {b}", { a: "x" }), "x {b}");
});

test("no default string is empty (every key is a real fallback)", () => {
  for (const [k, v] of Object.entries(DEFAULT_STRINGS)) {
    assert.equal(typeof v, "string", `${k} must be a string`);
    assert.ok(v.trim().length > 0, `${k} must not be blank`);
  }
});
