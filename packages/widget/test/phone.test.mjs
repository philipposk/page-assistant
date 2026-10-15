// Phones: read-aloud on iOS, and the keyboard measurement that keeps the panel on screen.
// The bug behind the voice tests: server speech made a new Audio() per reply, which iOS refuses
// to play outside a tap, so read-aloud on an iPhone was silent with no error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Voice } from "../dist/voice.js";
import { keyboardOverlap } from "../dist/ui.js";

// Node defines `navigator` as a getter-only global, so swap descriptors rather than assign.
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

const until = async (cond) => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(cond(), "timed out waiting");
};

/**
 * A browser whose <audio> elements, like iOS's, refuse to play outside a tap until they have
 * played inside one, and a speech engine that records what it was asked to say. `inTap` says
 * whether the code is running inside a tap right now (always, by default, like a desktop).
 */
function phone({ inTap = () => true, tts = async () => ({ ok: true, blob: async () => new Blob(["mp3"]) }) } = {}) {
  const made = [];
  class Audio {
    constructor() {
      this.src = "";
      this.paused = true;
      this.plays = [];
      made.push(this);
    }
    play() {
      this.plays.push(this.src);
      if (!this.unlocked && !inTap()) {
        return Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
      }
      this.unlocked = true;
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
  }
  const spoken = [];
  const speechSynthesis = {
    speak(u) {
      spoken.push(u);
      setTimeout(() => u.onend?.(), 0);
    },
    cancel() {},
    getVoices: () => [],
  };
  class SpeechSynthesisUtterance {
    constructor(text) {
      this.text = text;
    }
  }
  return {
    made,
    spoken,
    globals: {
      window: { speechSynthesis },
      speechSynthesis,
      SpeechSynthesisUtterance,
      Audio,
      document: { documentElement: { lang: "en" } },
      fetch: tts,
    },
  };
}

const server = { ttsMode: "server", serverUrl: "https://assistant.example" };

test("every server reply plays through the one element prime() unlocked in a tap", async () => {
  let tapping = true;
  const p = phone({ inTap: () => tapping });
  await withGlobals(p.globals, async () => {
    const v = new Voice(server);
    v.prime();
    tapping = false; // the replies arrive seconds later, outside the tap
    assert.equal(p.made.length, 1);
    const [audio] = p.made;
    assert.match(audio.plays[0], /^data:audio\/wav/, "unlocked by playing silence");

    for (const text of ["one", "two"]) {
      const said = v.speak(text);
      await until(() => audio.plays.length && audio.plays.at(-1).startsWith("blob:") && !audio.paused);
      audio.onended();
      await said;
      audio.paused = true;
    }
    assert.equal(p.made.length, 1, "no new Audio() per reply");
    assert.equal(audio.plays.filter((s) => s.startsWith("blob:")).length, 2);
  });
});

test("a refused play() reads the reply with the browser's voice instead of staying silent", async () => {
  const p = phone({ inTap: () => false }); // prime() was never called in a tap
  await withGlobals(p.globals, async () => {
    const v = new Voice(server);
    await v.speak("hello there");
    assert.equal(p.spoken.at(-1)?.text, "hello there");
    assert.equal(v.isSpeaking, false);
  });
});

test("stop() ends server playback and settles its speak()", async () => {
  const p = phone();
  await withGlobals(p.globals, async () => {
    const v = new Voice(server);
    const said = v.speak("a long reply");
    await until(() => p.made[0] && !p.made[0].paused);
    v.stop();
    await said; // used to hang: a paused element never fires "ended"
    assert.equal(p.made[0].paused, true);
    assert.equal(v.isSpeaking, false);
  });
});

test("a reply still downloading when stop() is called is never played", async () => {
  let deliver;
  const p = phone({ tts: () => new Promise((r) => (deliver = r)) });
  await withGlobals(p.globals, async () => {
    const v = new Voice(server);
    const said = v.speak("too late");
    await until(() => deliver);
    v.stop(); // the panel was closed while the audio was being made
    deliver({ ok: true, blob: async () => new Blob(["mp3"]) });
    await said;
    assert.equal(p.made.length, 0);
    assert.equal(p.spoken.length, 0);
  });
});

test("prime() speaks one silent utterance, and leaves audio alone for browser speech", async () => {
  const p = phone();
  await withGlobals(p.globals, async () => {
    const v = new Voice({ ttsMode: "browser" });
    v.prime();
    v.prime();
    assert.equal(p.spoken.length, 1);
    assert.equal(p.spoken[0].volume, 0);
    // Playing even silence pauses whatever else the phone is playing.
    assert.equal(p.made.length, 0);
  });
});

test("keyboardOverlap: a keyboard lifts the panel; toolbars and shrinking pages do not", () => {
  // iPhone Safari, 375×664 visible, keyboard 336px tall.
  assert.equal(keyboardOverlap(664, 328, 0), 336);
  // The page scrolled the focused box into view: what is covered is measured from the visible bottom.
  assert.equal(keyboardOverlap(664, 328, 100), 236);
  // The URL bar showing or hiding.
  assert.equal(keyboardOverlap(664, 610, 0), 0);
  // An installed web app: the keyboard shrinks the page itself, fixed elements already move up.
  assert.equal(keyboardOverlap(328, 328, 0), 0);
});
