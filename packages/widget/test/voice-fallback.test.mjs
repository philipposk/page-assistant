// STT fallback in BOTH directions, and the rule that no path may end in silence.
// The bug this file exists for: a mic tap that produced no transcript, no error and no
// message, because every failure resolved to "".
import { test } from "node:test";
import assert from "node:assert/strict";
import { Voice, VoiceError } from "../dist/voice.js";
import { setVoiceDefaults, getVoiceDefaults, getVoiceSettings } from "../dist/settings.js";

// Node defines `navigator` as a getter-only global, so swap descriptors rather than assign.
// Awaits fn: restoring synchronously would pull the fake globals out from under an
// in-flight recognition callback.
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

/** A SpeechRecognition stand-in that fires one `error` event and then `end`. */
function failingRecognition(error) {
  return function SR() {
    const r = this;
    r.start = () => {
      setTimeout(() => {
        r.onerror?.({ error });
        r.onend?.();
      }, 0);
    };
    r.stop = () => {};
    r.abort = () => {};
  };
}

const noServerEnv = (SR) => ({
  window: { SpeechRecognition: SR },
  navigator: { language: "en-US" },
  document: { documentElement: { lang: "" } },
});

test("a refused microphone reaches the caller as not-allowed, never as an empty string", async () => {
  await withGlobals(noServerEnv(failingRecognition("not-allowed")), async () => {
    const v = new Voice();
    await assert.rejects(
      () => v.listenOnce(),
      (e) => e instanceof VoiceError && e.reason === "not-allowed"
    );
  });
});

test("silence reaches the caller as no-speech", async () => {
  await withGlobals(noServerEnv(failingRecognition("no-speech")), async () => {
    const v = new Voice();
    await assert.rejects(
      () => v.listenOnce(),
      (e) => e instanceof VoiceError && e.reason === "no-speech"
    );
  });
});

test("a service failure is distinguished from a refused mic", async () => {
  for (const err of ["service-not-allowed", "network", "language-not-supported"]) {
    await withGlobals(noServerEnv(failingRecognition(err)), async () => {
      const v = new Voice();
      await assert.rejects(
        () => v.listenOnce(),
        (e) => e instanceof VoiceError && e.reason === "service",
        `${err} should be a service failure, not a permission one`
      );
    });
  }
});

test("no recogniser and no server fails loudly instead of resolving empty", async () => {
  await withGlobals(
    { window: {}, navigator: { language: "en-US" }, document: { documentElement: { lang: "" } } },
    async () => {
      const v = new Voice();
      await assert.rejects(
        () => v.listenOnce(),
        (e) => e instanceof VoiceError && e.reason === "service"
      );
    }
  );
});

test("a broken browser recogniser retries ONCE through server STT (the iOS PWA case)", async () => {
  let calls = 0;
  await withGlobals(
    {
      window: { SpeechRecognition: failingRecognition("service-not-allowed"), MediaRecorder: function () {} },
      navigator: {
        language: "en-US",
        mediaDevices: {
          getUserMedia: async () => {
            calls++;
            throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
          },
        },
      },
      document: { documentElement: { lang: "" } },
    },
    async () => {
      const v = new Voice({ serverUrl: "https://api.example.com" });
      let notified = 0;
      await assert.rejects(
        () => v.listenOnce({ onBrowserFallback: () => notified++ }),
        (e) => e instanceof VoiceError && e.reason === "not-allowed"
      );
      assert.equal(notified, 1, "user is told once which path is being used");
      assert.equal(calls, 1, "exactly one retry, never a loop");
    }
  );
});

test("a refused mic is NOT retried through the server (same permission, same failure)", async () => {
  let calls = 0;
  await withGlobals(
    {
      window: { SpeechRecognition: failingRecognition("not-allowed"), MediaRecorder: function () {} },
      navigator: { language: "en-US", mediaDevices: { getUserMedia: async () => { calls++; } } },
      document: { documentElement: { lang: "" } },
    },
    async () => {
      const v = new Voice({ serverUrl: "https://api.example.com" });
      let notified = 0;
      await assert.rejects(
        () => v.listenOnce({ onBrowserFallback: () => notified++ }),
        (e) => e instanceof VoiceError && e.reason === "not-allowed"
      );
      assert.equal(calls, 0);
      assert.equal(notified, 0);
    }
  );
});

// --- voiceDefaults layering ------------------------------------------------

test("voiceDefaults sit between the shipped defaults and the user's stored choices", async () => {
  try {
    assert.equal(getVoiceDefaults().sttMode, "browser"); // shipped default: the free path
    setVoiceDefaults({ sttMode: "server" });
    assert.equal(getVoiceDefaults().sttMode, "server"); // host's starting point
    assert.equal(getVoiceDefaults().ttsProvider, "elevenlabs"); // untouched keys unchanged

    // A user who picked something else in the settings panel still wins.
    const store = { page_assistant_voice_settings: JSON.stringify({ sttMode: "browser" }) };
    await withGlobals({ localStorage: { getItem: (k) => store[k] ?? null } }, () => {
      assert.equal(getVoiceSettings().sttMode, "browser");
    });
  } finally {
    setVoiceDefaults(undefined);
  }
});

test("setVoiceDefaults ignores unknown keys and resets cleanly", () => {
  setVoiceDefaults({ sttMode: "server", nonsense: true });
  assert.equal(getVoiceDefaults().sttMode, "server");
  assert.equal(getVoiceDefaults().nonsense, undefined);
  setVoiceDefaults(undefined);
  assert.equal(getVoiceDefaults().sttMode, "browser"); // shipped default restored
});
