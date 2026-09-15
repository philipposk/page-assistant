// A reply that is still loading when the chat changes under it: someone signs out, another
// account signs in, or another chat is opened. It must never be saved into what is on screen
// now — the signed-out slot the next visitor sees, or the next person's account.
//
// These drive the real controller from the built widget. Only its DOM-bound UI is swapped
// for a recorder, and the assistant backend for replies the test releases by hand.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_STRINGS } from "../dist/strings.js";

const KEY = "test_history";
const userSlot = (user) => `${KEY}:user:${user}`;

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
}`;

const tmp = await mkdtemp(join(tmpdir(), "pa-widget-"));
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

function fakeAdapter(user) {
  const db = new Map();
  const saves = [];
  let current = user;
  return {
    adapter: {
      currentUserId: async () => current,
      list: async () => [...db.values()].filter((c) => c.owner === current).map(({ owner, ...c }) => structuredClone(c)),
      get: async (id) => (db.get(id)?.owner === current ? structuredClone(db.get(id)) : null),
      save: async (c) => {
        saves.push({ user: current, chat: structuredClone(c) });
        db.set(c.id, { ...structuredClone(c), owner: current });
      },
      delete: async (id) => void db.delete(id),
      deleteAll: async () => db.clear(),
    },
    saves,
    setUser: (u) => (current = u),
  };
}

async function start(adapter, extra = {}) {
  const pa = PageAssistant.init({
    serverUrl: "https://assistant.example",
    capabilities: [],
    voice: false,
    autoScan: false,
    memory: "session",
    chatHistoryStorageKey: KEY,
    chatHistoryAdapter: adapter,
    ...extra,
  });
  await PageAssistant.refreshChatHistory(); // queued behind the first sign-in check
  return pa;
}

/** Every message text saved under a device key. */
const savedTexts = (key) =>
  (JSON.parse(storage.get(key) ?? "null")?.sessions ?? []).flatMap((s) => s.messages.map((m) => m.content));
const shownTexts = () => ui().log.map((m) => m.content);
const inStore = (pa, text) =>
  pa.historyMgr.store.list(true).some((s) => s.messages.some((m) => m.content.includes(text)));

beforeEach(() => {
  storage = new Map();
  llm = [];
});
afterEach(() => PageAssistant.destroy());

// --- the cases ------------------------------------------------------------------------------

test("a normal reply is still saved and shown", async () => {
  const { adapter } = fakeAdapter("alice");
  const pa = await start(adapter);
  const sent = ui().handlers.onSend("what's new?");
  await until(() => llm.length);
  answer("Three things.");
  await sent;
  assert.deepEqual(savedTexts(userSlot("alice")), ["what's new?", "Three things."]);
  assert.ok(shownTexts().includes("Three things."));
  assert.ok(!ui().toasts.includes(DEFAULT_STRINGS.historyReplyDiscarded));
  assert.ok(inStore(pa, "Three things."));
});

test("a normal reply in account mode reaches the same user's account", async () => {
  const { adapter, saves } = fakeAdapter("alice");
  const pa = await start(adapter, { chatHistoryMode: "account" });
  const sent = ui().handlers.onSend("what's new?");
  await until(() => llm.length);
  answer("Three things.");
  await sent;
  await pa.historyMgr.flush();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].user, "alice");
  assert.deepEqual(saves[0].chat.messages.map((m) => m.content), ["what's new?", "Three things."]);
});

test("signing out while a reply loads writes nothing to the signed-out slot", async () => {
  const { adapter, setUser } = fakeAdapter("alice");
  const pa = await start(adapter);
  const sent = ui().handlers.onSend("alice's private question");
  await until(() => llm.length);

  setUser(null);
  await PageAssistant.refreshChatHistory();
  answer("alice's private answer");
  await sent;

  assert.deepEqual(
    savedTexts(KEY).filter((t) => t.includes("alice")),
    [],
    "the next signed-out visitor must not find alice's question or its answer"
  );
  assert.equal(inStore(pa, "alice"), false);
  assert.ok(!shownTexts().some((t) => t.includes("alice's private answer")), "not rendered for the next person");
  assert.ok(ui().toasts.includes(DEFAULT_STRINGS.historyReplyDiscarded));
  assert.deepEqual(savedTexts(userSlot("alice")), [], "nor saved as alice's after she left");
});

test("another account signing in while a reply loads writes nothing to that account", async () => {
  const { adapter, setUser, saves } = fakeAdapter("alice");
  const pa = await start(adapter, { chatHistoryMode: "account" });
  const sent = ui().handlers.onSend("alice's question");
  await until(() => llm.length);

  setUser("bob"); // e.g. bob signed in from another tab
  await PageAssistant.refreshChatHistory();
  answer("the answer for alice");
  await sent;
  await pa.historyMgr.flush();

  assert.deepEqual(
    saves.filter((s) => s.chat.messages.some((m) => m.content.includes("alice"))),
    [],
    "nothing of alice's reaches bob's account"
  );
  assert.equal(inStore(pa, "alice"), false);
  assert.ok(!shownTexts().some((t) => t.includes("the answer for alice")));
});

test("the result of a confirmed action is not saved for the next person either", async () => {
  let finish;
  const archive = {
    name: "archive_item",
    description: "Archive the open item",
    parameters: { type: "object", properties: {} },
    confirm: true,
    run: () => new Promise((r) => (finish = r)),
    render: () => "Archived the item for alice.",
  };
  const { adapter, setUser } = fakeAdapter("alice");
  await start(adapter, { capabilities: [archive] });
  const sent = ui().handlers.onSend("archive this");
  await until(() => llm.length);
  answer("", [{ id: "c1", name: "archive_item", args: {} }]);
  await sent;

  const confirmed = ui().handlers.onConfirm(true);
  await until(() => finish);
  setUser(null);
  await PageAssistant.refreshChatHistory();
  finish({ ok: true });
  await confirmed;

  assert.deepEqual(savedTexts(KEY).filter((t) => t.includes("alice")), []);
  assert.ok(!shownTexts().some((t) => t.includes("Archived the item")));
});

test("opening another chat while a reply loads keeps the reply out of it", async () => {
  storage.set(
    userSlot("alice"),
    JSON.stringify({
      version: 1,
      activeId: null,
      groups: [],
      sessions: [
        {
          id: "other",
          title: "Other",
          messages: [
            { role: "user", content: "earlier" },
            { role: "assistant", content: "reply" },
          ],
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:00:00.000Z",
        },
      ],
    })
  );
  const { adapter } = fakeAdapter("alice");
  const pa = await start(adapter);
  ui().handlers.onNewChat();
  const sent = ui().handlers.onSend("a question in the new chat");
  await until(() => llm.length);
  await ui().handlers.onSelectChat("other");
  answer("the late answer");
  await sent;

  assert.deepEqual(
    pa.historyMgr.store.get("other").messages.map((m) => m.content),
    ["earlier", "reply"],
    "the chat now open is untouched"
  );
  assert.equal(inStore(pa, "the late answer"), false);
  assert.ok(!shownTexts().includes("the late answer"));
  assert.ok(ui().toasts.includes(DEFAULT_STRINGS.historyReplyDiscarded));
});

test("offerSignedOutChats reaches the history manager", async () => {
  storage.set(
    KEY,
    JSON.stringify({
      version: 1,
      activeId: null,
      groups: [],
      sessions: [
        {
          id: "visitor",
          title: "Visitor",
          messages: [{ role: "user", content: "signed out" }],
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:00:00.000Z",
        },
      ],
    })
  );
  const on = await start(fakeAdapter("alice").adapter);
  assert.equal(on.historyMgr.getState().signedOutDeviceChatCount, 1, "offered by default");
  PageAssistant.destroy();

  const off = await start(fakeAdapter("alice").adapter, { offerSignedOutChats: false });
  assert.equal(off.historyMgr.getState().signedOutDeviceChatCount, 0);
});
