// ask() lets a host send a message to the assistant from code, exactly like a typed one, and
// notifies the visitor (reply bubble + unread badge) when the panel is closed. These drive
// the real controller from the built widget; only its DOM-bound UI is swapped for a recorder
// that also tracks open/closed state and notification calls (same pattern as
// reply-in-flight.test.mjs — the real WidgetUI's DOM/CSS is exercised only by hand/in a
// browser, not by this node:test suite).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// --- a browser, just enough of one ----------------------------------------------------------

let storage;
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
globalThis.window = new EventTarget();
globalThis.document = {
  title: "Test page",
  // A discovery <link> "already exists", so the widget doesn't probe for one.
  querySelector: () => ({}),
  querySelectorAll: () => [],
  documentElement: { lang: "en" },
};
globalThis.location = new URL("https://app.example/page");

// The assistant backend: each request waits until the test answers it.
let llm;
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/v1/llm/complete")) {
    return new Promise((resolve) => llm.push(resolve));
  }
  return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
};
const answer = (text, toolCalls = []) => {
  const resolve = llm.shift();
  assert.ok(resolve, "a request is waiting for its answer");
  resolve({ ok: true, json: async () => ({ toolCalls, text }) });
};
const until = async (cond) => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(cond(), "timed out waiting");
};

// --- the controller, with a recording UI --------------------------------------------------

const FAKE_UI = `
export class WidgetUI {
  constructor(title, handlers) {
    this.handlers = handlers;
    this.log = [];
    this.toasts = [];
    this.openState = false;
    this.bubbles = [];
    this.unread = 0;
    globalThis.__ui = this;
    // Every other UI call is a no-op.
    return new Proxy(this, { get: (t, p) => (p in t ? t[p] : () => {}) });
  }
  addMessage(role, content) { this.log.push({ role, content }); }
  addConfirm(content) { this.log.push({ role: "confirm", content }); }
  addError(content) { this.log.push({ role: "error", content }); }
  loadMessages(messages) { this.log = messages.map((m) => ({ role: m.role, content: m.content })); }
  clearLog() { this.log = []; }
  toast(text) { this.toasts.push(text); }
  isOpen() { return this.openState; }
  toggle(open) {
    this.openState = open ?? !this.openState;
    if (this.openState) { this.bubbles = []; this.unread = 0; }
    this.handlers.onToggle?.(this.openState);
    return this.openState;
  }
  markUnread() { this.unread++; }
  showReplyPreview(text) { this.bubbles.push(text); this.unread++; }
  hideReplyPreview() { this.bubbles = []; }
  clearUnread() { this.unread = 0; this.bubbles = []; }
}`;

const tmp = await mkdtemp(join(tmpdir(), "pa-widget-ask-"));
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
  plugins: [
    {
      name: "fake-ui",
      setup(b) {
        b.onResolve({ filter: /^\.\/ui\.js$/ }, () => ({ path: "ui", namespace: "fake-ui" }));
        b.onLoad({ filter: /.*/, namespace: "fake-ui" }, () => ({ contents: FAKE_UI, loader: "js" }));
      },
    },
  ],
});
await writeFile(join(tmp, "widget.mjs"), bundled.outputFiles[0].text);
const { PageAssistant } = await import(pathToFileURL(join(tmp, "widget.mjs")).href);
await rm(tmp, { recursive: true, force: true });

const ui = () => globalThis.__ui;

async function start(extra = {}) {
  return PageAssistant.init({
    serverUrl: "https://assistant.example",
    capabilities: [],
    voice: false,
    autoScan: false,
    memory: "session",
    disableChatHistory: true,
    ...extra,
  });
}

beforeEach(() => {
  storage = new Map();
  llm = [];
});
afterEach(() => PageAssistant.destroy());

// --- ask() sends through the same path as typed input ----------------------------------------

test("ask() sends the text through the same path as typed input", async () => {
  await start();
  const sent = PageAssistant.ask("what's new?");
  await until(() => llm.length);
  answer("Three things.");
  await sent;
  assert.deepEqual(
    ui().log.map((m) => [m.role, m.content]),
    [
      ["user", "what's new?"],
      ["assistant", "Three things."],
    ]
  );
});

test("the instance method (returned by init) works the same way", async () => {
  const pa = await start();
  const sent = pa.ask("what's new?");
  await until(() => llm.length);
  answer("Three things.");
  await sent;
  assert.ok(ui().log.some((m) => m.role === "user" && m.content === "what's new?"));
});

test("ask({ open: true }) opens the panel before the turn starts, like typing does", async () => {
  await start();
  assert.equal(ui().openState, false);
  const sent = PageAssistant.ask("hi", { open: true });
  assert.equal(ui().openState, true, "opened synchronously, before the reply arrives");
  await until(() => llm.length);
  answer("hello");
  await sent;
});

test("ask() without open leaves the panel exactly as it was", async () => {
  await start();
  const sent = PageAssistant.ask("hi");
  assert.equal(ui().openState, false);
  await until(() => llm.length);
  answer("hello");
  await sent;
});

// --- reply bubble + unread badge --------------------------------------------------------------

test("a reply to ask() shows a bubble and marks the badge while the panel is closed", async () => {
  await start();
  const sent = PageAssistant.ask("what's new?");
  await until(() => llm.length);
  answer("Three things worth a look today.");
  await sent;
  assert.deepEqual(ui().bubbles, ["Three things worth a look today."]);
  assert.equal(ui().unread, 1);
});

test("ask({ notify: false }) shows neither a bubble nor the badge", async () => {
  await start();
  const sent = PageAssistant.ask("what's new?", { notify: false });
  await until(() => llm.length);
  answer("Three things.");
  await sent;
  assert.deepEqual(ui().bubbles, []);
  assert.equal(ui().unread, 0);
});

test("no bubble or badge when the panel is already open", async () => {
  await start();
  ui().toggle(true);
  const sent = PageAssistant.ask("what's new?");
  await until(() => llm.length);
  answer("Three things.");
  await sent;
  assert.deepEqual(ui().bubbles, []);
  assert.equal(ui().unread, 0);
});

test("an ordinary (typed) reply that lands after the visitor closes the panel mid-turn marks the badge, not a bubble", async () => {
  await start();
  ui().toggle(true);
  const sent = ui().handlers.onSend("what's new?");
  await until(() => llm.length);
  ui().toggle(false); // visitor closes while the reply is still loading
  answer("Three things.");
  await sent;
  assert.deepEqual(ui().bubbles, [], "typed replies never get a bubble");
  assert.equal(ui().unread, 1);
});

test("opening the panel clears the badge and bubble", async () => {
  await start();
  const sent = PageAssistant.ask("what's new?");
  await until(() => llm.length);
  answer("Three things.");
  await sent;
  assert.equal(ui().unread, 1);
  ui().toggle(true);
  assert.equal(ui().unread, 0);
  assert.deepEqual(ui().bubbles, []);
});

// --- edge cases --------------------------------------------------------------------------------

test("empty or whitespace-only text is ignored: no turn, no crash", async () => {
  await start();
  await PageAssistant.ask("");
  await PageAssistant.ask("   ");
  assert.equal(llm.length, 0);
  assert.deepEqual(ui().log, []);
});

test("a second ask() while one is in flight is queued, not raced", async () => {
  await start();
  const first = PageAssistant.ask("first question");
  await until(() => llm.length === 1);
  const second = PageAssistant.ask("second question");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(llm.length, 1, "the second turn must not start until the first is answered");
  assert.equal(ui().log.length, 1, "only the first user message is in the log so far");

  answer("first answer");
  await first;
  await until(() => llm.length === 1);
  answer("second answer");
  await second;

  assert.deepEqual(ui().log.map((m) => m.content), [
    "first question",
    "first answer",
    "second question",
    "second answer",
  ]);
});

test("ask() called while a typed turn is in flight queues behind it too", async () => {
  await start();
  const typed = ui().handlers.onSend("typed question");
  await until(() => llm.length === 1);
  const asked = PageAssistant.ask("asked question");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(llm.length, 1, "ask() did not start a second, concurrent turn");

  answer("typed answer");
  await typed;
  await until(() => llm.length === 1);
  answer("asked answer");
  await asked;

  assert.deepEqual(ui().log.map((m) => m.content), [
    "typed question",
    "typed answer",
    "asked question",
    "asked answer",
  ]);
});

test("PageAssistant.ask() before init(), or after destroy(), resolves without throwing", async () => {
  await PageAssistant.ask("nobody home"); // no instance yet
  const pa = await start();
  PageAssistant.destroy();
  await pa.ask("widget is gone"); // instance torn down
  assert.equal(llm.length, 0);
});
