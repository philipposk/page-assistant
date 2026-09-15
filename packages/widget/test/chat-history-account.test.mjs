// Chat history modes: account (through a host adapter), device (localStorage) and off.
// What matters most here is where chats end up — and where they must never end up.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ChatHistoryStore } from "../dist/chatHistory.js";
import { ChatHistoryManager, resolveChatHistoryMode } from "../dist/chatHistoryMode.js";
import { supabaseChatHistoryAdapter } from "../dist/adapters/supabase.js";
import { DEFAULT_STRINGS } from "../dist/strings.js";
import * as settingsUi from "../dist/assistant-settings-ui.js";

const KEY = "test_history";
const MODE_KEY = "test_history_mode";

// A Map-backed localStorage, fresh for every test.
let storage;
beforeEach(() => {
  storage = new Map();
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
});

// The signed-out slot is KEY itself (where every earlier version kept chats); a signed-in
// user's device chats live under their own key.
const deviceChats = (key = KEY) => JSON.parse(storage.get(key) ?? "null")?.sessions ?? [];
const userSlot = (user) => `${KEY}:user:${user}`;
const msgs = (...texts) => texts.map((t, i) => ({ role: i % 2 ? "assistant" : "user", content: t }));
const chat = (id, texts = ["hi", "hello"], at = "2026-09-01T10:00:00.000Z") => ({
  id,
  title: `Chat ${id}`,
  messages: msgs(...texts),
  pinned: false,
  archived: false,
  groupId: null,
  model: null,
  createdAt: at,
  updatedAt: at,
});

function fakeAdapter({ user = "u1", rows = [], omitMessages = false, failSave = () => false, retentionMonths } = {}) {
  const db = new Map(rows.map((r) => [r.id, structuredClone(r)]));
  const calls = { list: 0, get: [], save: [], delete: [], deleteAll: 0 };
  let currentUser = user;
  const adapter = {
    retentionMonths,
    currentUserId: async () => currentUser,
    async list() {
      calls.list++;
      if (retentionMonths) {
        // As the reference adapter does: inactive chats are deleted when the list is read.
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - retentionMonths);
        for (const [id, r] of db) if (r.updatedAt < cutoff.toISOString()) db.delete(id);
      }
      return [...db.values()].map((r) => {
        const copy = structuredClone(r);
        if (omitMessages) delete copy.messages;
        return copy;
      });
    },
    async get(id) {
      calls.get.push(id);
      return db.has(id) ? structuredClone(db.get(id)) : null;
    },
    async save(c) {
      if (failSave(c)) throw new Error("save refused");
      calls.save.push(structuredClone(c));
      db.set(c.id, structuredClone(c));
    },
    async delete(id) {
      calls.delete.push(id);
      db.delete(id);
    },
    async deleteAll() {
      calls.deleteAll++;
      db.clear();
    },
  };
  return { adapter, db, calls, setUser: (u) => (currentUser = u) };
}

const manager = (opts = {}) =>
  new ChatHistoryManager({ storageKey: KEY, modeStorageKey: MODE_KEY, debounceMs: 60_000, retryDelaysMs: [], ...opts });

// --- resolving the mode ---------------------------------------------------------------

test("resolveChatHistoryMode: the choice, unless account can't be used", () => {
  const base = { hasAdapter: true, signedIn: true };
  assert.deepEqual(resolveChatHistoryMode({ ...base, chosen: "account" }), { mode: "account" });
  assert.equal(resolveChatHistoryMode({ ...base, chosen: "device" }).mode, "device");
  assert.equal(resolveChatHistoryMode({ ...base, chosen: "off" }).mode, "off");
  assert.deepEqual(resolveChatHistoryMode({ chosen: "account", hasAdapter: false }), {
    mode: "device",
    unavailable: "no-adapter",
  });
  assert.deepEqual(resolveChatHistoryMode({ chosen: "account", hasAdapter: true, signedIn: false }), {
    mode: "device",
    unavailable: "signed-out",
  });
  assert.equal(
    resolveChatHistoryMode({ chosen: "account", hasAdapter: true, signedIn: false, fallback: "off" }).mode,
    "off"
  );
  // Not known yet: treated as signed in until the check says otherwise.
  assert.equal(resolveChatHistoryMode({ chosen: "account", hasAdapter: true }).mode, "account");
  assert.equal(resolveChatHistoryMode({ ...base, chosen: "account", locked: true }).mode, "off");
});

// --- device and off --------------------------------------------------------------------

test("device is the default and saves to this browser, as before", async () => {
  const m = manager();
  await m.start();
  assert.equal(m.getState().mode, "device");
  const s = m.store.create();
  m.store.saveMessages(s.id, msgs("hi"));
  assert.equal(deviceChats().length, 1);
  m.dispose();
});

test("off keeps chats for this page and writes nothing to the device", async () => {
  const m = manager({ defaultMode: "off" });
  await m.start();
  const s = m.store.create();
  m.store.saveMessages(s.id, msgs("private"));
  assert.equal(m.store.list().length, 1);
  assert.equal(storage.has(KEY), false);
  m.dispose();
});

test("disableChatHistory maps to off, and there is nothing to choose", async () => {
  const { adapter, calls } = fakeAdapter();
  const m = manager({ disabled: true, defaultMode: "account", adapter });
  await m.start();
  await m.setMode("device");
  const st = m.getState();
  assert.equal(st.mode, "off");
  assert.equal(st.locked, true);
  assert.equal(calls.list, 0, "a disabled history never asks the account");
  assert.equal(storage.has(KEY), false);
  m.dispose();
});

test("account is unavailable without an adapter, and settings is told why", async () => {
  const m = manager({ defaultMode: "account" });
  await m.start();
  assert.equal(m.getState().mode, "device");
  assert.equal(m.getState().accountUnavailable, "no-adapter");
  const off = manager({ defaultMode: "account", fallbackMode: "off" });
  await off.start();
  assert.equal(off.getState().mode, "off");
  m.dispose();
  off.dispose();
});

// --- account mode ------------------------------------------------------------------------

test("account mode loads the account into memory and writes nothing to the device", async () => {
  const { adapter } = fakeAdapter({ rows: [chat("a1")] });
  const m = manager({ defaultMode: "account", adapter });
  await m.start();
  assert.equal(m.getState().mode, "account");
  assert.ok(m.store.get("a1"));
  const s = m.store.create();
  m.store.saveMessages(s.id, msgs("hi"));
  await m.flush();
  assert.equal(storage.has(KEY), false, "account chats must not be copied into localStorage");
  m.dispose();
});

test("a chat is saved to the account once it has messages; an empty one never is", async () => {
  const { adapter, calls } = fakeAdapter();
  const m = manager({ defaultMode: "account", adapter });
  await m.start();
  const s = m.store.create();
  await m.flush();
  assert.equal(calls.save.length, 0, "every page load starts an empty chat; it is not worth a row");
  m.store.saveMessages(s.id, msgs("what's new?", "Three things."));
  await m.flush();
  assert.equal(calls.save.length, 1);
  assert.equal(calls.save[0].id, s.id);
  assert.equal(calls.save[0].messages.length, 2);
  m.dispose();
});

test("deleting one chat deletes it from the account", async () => {
  const { adapter, calls, db } = fakeAdapter({ rows: [chat("a1"), chat("a2")] });
  const m = manager({ defaultMode: "account", adapter });
  await m.start();
  m.store.delete("a1");
  await m.flush();
  assert.deepEqual(calls.delete, ["a1"]);
  assert.deepEqual([...db.keys()], ["a2"]);
  m.dispose();
});

test("a chat listed without its messages is fetched before it is saved", async () => {
  // Otherwise renaming it would overwrite the saved conversation with an empty one.
  const { adapter, calls, db } = fakeAdapter({ rows: [chat("a1", ["one", "two", "three"])], omitMessages: true });
  const m = manager({ defaultMode: "account", adapter });
  await m.start();
  assert.equal(m.needsLoad("a1"), true);
  m.store.rename("a1", "Renamed");
  await m.flush();
  assert.deepEqual(calls.get, ["a1"]);
  assert.equal(db.get("a1").title, "Renamed");
  assert.equal(db.get("a1").messages.length, 3);
  m.dispose();
});

test("ensureLoaded fills in a chat before it is opened", async () => {
  const { adapter } = fakeAdapter({ rows: [chat("a1", ["q", "a"])], omitMessages: true });
  const m = manager({ defaultMode: "account", adapter });
  await m.start();
  assert.equal(m.store.get("a1").messages.length, 0);
  assert.equal(await m.ensureLoaded("a1"), true);
  assert.equal(m.store.get("a1").messages.length, 2);
  assert.equal(m.needsLoad("a1"), false);
  m.dispose();
});

test("moving to account uploads this device's chats, then removes them from the device", async () => {
  const { adapter, calls } = fakeAdapter({ rows: [chat("a1")] });
  const m = manager({ adapter });
  await m.start();
  const local = m.store.create();
  m.store.saveMessages(local.id, msgs("from this laptop"));
  m.store.create(); // empty: nothing to move
  assert.equal(m.getState().deviceChatCount, 1);

  await m.setMode("account", { moveDeviceChats: true });
  assert.equal(m.getState().mode, "account");
  assert.deepEqual(calls.save.map((c) => c.id), [local.id]);
  assert.ok(m.store.get(local.id), "the moved chat is in the account list");
  assert.ok(m.store.get("a1"));
  assert.equal(deviceChats(userSlot("u1")).some((s) => s.id === local.id), false, "moved, not copied");
  assert.equal(m.getState().deviceChatCount, 0);
  m.dispose();
});

test("switching to account without moving leaves the device's chats alone", async () => {
  const { adapter, calls } = fakeAdapter();
  const m = manager({ adapter });
  await m.start();
  const local = m.store.create();
  m.store.saveMessages(local.id, msgs("stay here"));
  await m.setMode("account");
  assert.equal(calls.save.length, 0);
  assert.equal(m.store.get(local.id), undefined, "device chats are not shown in account mode");
  assert.equal(deviceChats(userSlot("u1")).length, 1);
  assert.equal(m.getState().deviceChatCount, 1, "so settings can still offer to move them");
  m.dispose();
});

test("a chat that fails to move stays on the device", async () => {
  const { adapter } = fakeAdapter({ failSave: (c) => c.title.includes("bad") });
  const m = manager({ adapter });
  await m.start();
  const good = m.store.create();
  m.store.saveMessages(good.id, msgs("fine"));
  const bad = m.store.create();
  m.store.saveMessages(bad.id, msgs("bad one"));
  await m.setMode("account");
  const r = await m.moveDeviceChats();
  assert.deepEqual(r, { moved: 1, failed: 1 });
  assert.deepEqual(deviceChats(userSlot("u1")).map((s) => s.id), [bad.id]);
  m.dispose();
});

test("leaving account mode sends what was waiting and deletes nothing", async () => {
  const { adapter, calls } = fakeAdapter({ rows: [chat("a1")] });
  const m = manager({ defaultMode: "account", adapter });
  await m.start();
  const s = m.store.create();
  m.store.saveMessages(s.id, msgs("last words"));
  await m.setMode("device"); // before the debounce fired
  assert.deepEqual(calls.save.map((c) => c.id), [s.id], "the same user's last message still reaches the account");
  assert.equal(calls.delete.length, 0);
  assert.equal(calls.deleteAll, 0);
  assert.equal(m.store.get("a1"), undefined, "device mode shows device chats");
  assert.equal(m.getState().canDeleteAccountChats, true, "settings can still offer to delete them");
  m.dispose();
});

test("signing out drops the account's chats from the page and any unsent write", async () => {
  const { adapter, calls, setUser } = fakeAdapter({ rows: [chat("a1")] });
  const m = manager({ defaultMode: "account", adapter });
  await m.start();
  const s = m.store.create();
  m.store.saveMessages(s.id, msgs("unsent"));
  setUser(null);
  await m.refresh();
  const st = m.getState();
  assert.equal(st.mode, "device");
  assert.equal(st.accountUnavailable, "signed-out");
  assert.equal(m.store.get("a1"), undefined);
  assert.equal(calls.save.length, 0, "never written once nobody is signed in");
  m.dispose();
});

test("a write waiting for one user is never sent as the next user", async () => {
  const { adapter, calls, setUser } = fakeAdapter({ rows: [chat("a1")] });
  const m = manager({ defaultMode: "account", adapter });
  await m.start();
  const s = m.store.create();
  m.store.saveMessages(s.id, msgs("u1's message"));
  setUser("u2"); // the host switched accounts without reloading
  await m.flush();
  await m.refresh();
  assert.equal(calls.save.length, 0);
  assert.equal(m.store.get(s.id), undefined, "u1's chats are gone from the page");
  m.dispose();
});

test("the mode choice is remembered per user, so a shared browser doesn't share it", async () => {
  const a = fakeAdapter({ user: "alice" });
  const m1 = manager({ adapter: a.adapter });
  await m1.start();
  await m1.setMode("account");
  m1.dispose();

  const again = manager({ adapter: a.adapter });
  await again.start();
  assert.equal(again.getState().mode, "account", "alice's choice is kept");
  again.dispose();

  const b = fakeAdapter({ user: "bob" });
  const m2 = manager({ adapter: b.adapter });
  await m2.start();
  assert.equal(m2.getState().mode, "device", "bob gets the host default, not alice's opt-in");
  m2.dispose();
});

// --- device chats on a shared browser ------------------------------------------------------

test("two people on one browser never see or move each other's device chats", async () => {
  const alice = fakeAdapter({ user: "alice" });
  const m1 = manager({ adapter: alice.adapter });
  await m1.start();
  const s = m1.store.create();
  m1.store.saveMessages(s.id, msgs("alice's private question"));
  m1.dispose();

  // Bob signs in on the same browser. The last-user hint still says alice.
  const bob = fakeAdapter({ user: "bob" });
  const m2 = manager({ adapter: bob.adapter });
  assert.equal(m2.store.get(s.id), undefined, "not even for a moment before the sign-in check");
  await m2.start();
  assert.equal(m2.getState().mode, "device");
  assert.equal(m2.store.get(s.id), undefined);
  assert.equal(m2.getState().deviceChatCount, 0);
  assert.equal(m2.getState().signedOutDeviceChatCount, 0);

  await m2.setMode("account", { moveDeviceChats: true });
  assert.deepEqual(await m2.moveDeviceChats(), { moved: 0, failed: 0 });
  assert.deepEqual(await m2.moveDeviceChats({ from: "signed-out" }), { moved: 0, failed: 0 });
  assert.equal(bob.calls.save.length, 0, "nothing of alice's reaches bob's account");
  assert.equal(m2.store.get(s.id), undefined);
  m2.dispose();

  const m3 = manager({ adapter: alice.adapter });
  await m3.start();
  assert.ok(m3.store.get(s.id), "alice's chat is still hers, on this device");
  m3.dispose();
});

test("after a sign-out or a change of user, the page shows only the new person's device chats", async () => {
  const { adapter, setUser } = fakeAdapter({ user: "alice" });
  const m = manager({ adapter });
  await m.start();
  const a = m.store.create();
  m.store.saveMessages(a.id, msgs("alice"));

  setUser(null);
  await m.refresh();
  assert.equal(m.store.get(a.id), undefined, "signed out: alice's chats leave the page");
  const visitor = m.store.create();
  m.store.saveMessages(visitor.id, msgs("a visitor"));

  setUser("bob");
  await m.refresh();
  assert.equal(m.store.get(a.id), undefined);
  assert.equal(m.store.get(visitor.id), undefined, "signed-out chats aren't shown as bob's either");
  assert.equal(m.getState().deviceChatCount, 0);

  setUser("alice");
  await m.refresh();
  assert.ok(m.store.get(a.id), "alice gets her own back");
  assert.equal(m.store.get(visitor.id), undefined);
  m.dispose();
});

test("chats made while signed out are offered to a signed-in user only as exactly that", async () => {
  const { adapter, setUser, calls } = fakeAdapter({ user: null });
  const m = manager({ adapter });
  await m.start();
  const visitor = m.store.create();
  m.store.saveMessages(visitor.id, msgs("made while signed out"));

  setUser("alice");
  await m.setMode("account", { moveDeviceChats: true });
  const st = m.getState();
  assert.equal(st.mode, "account");
  assert.equal(st.deviceChatCount, 0, "not counted as alice's own");
  assert.equal(st.signedOutDeviceChatCount, 1);
  assert.equal(calls.save.length, 0, "moving 'my chats' on the switch leaves them alone");
  assert.deepEqual(await m.moveDeviceChats(), { moved: 0, failed: 0 });

  const offers = settingsUi.historyMoveOffers(st);
  assert.deepEqual(offers.map((o) => o.from), ["signed-out"]);
  assert.match(offers[0].text, /made while signed out on this device: 1\./);
  assert.match(offers[0].text, /only if they're yours/);

  // Only that explicit offer moves them.
  assert.deepEqual(await m.moveDeviceChats({ from: "signed-out" }), { moved: 1, failed: 0 });
  assert.deepEqual(calls.save.map((c) => c.id), [visitor.id]);
  assert.equal(deviceChats().length, 0);
  assert.equal(m.getState().signedOutDeviceChatCount, 0);
  m.dispose();
});

test("settings words each move offer for whose chats they are", () => {
  const base = { chosen: "account", locked: false, status: "idle", canDeleteAccountChats: true };
  const both = settingsUi.historyMoveOffers({ ...base, mode: "account", deviceChatCount: 2, signedOutDeviceChatCount: 3 });
  assert.deepEqual(both.map((o) => o.from), ["mine", "signed-out"]);
  assert.equal(both[0].text, "Your chats saved only on this device: 2.");
  assert.match(both[1].text, /^Chats made while signed out on this device: 3\./);
  assert.ok(!/signed out/.test(both[0].text));

  // Device mode: signed-out chats can join the user's own, with the same wording.
  const device = settingsUi.historyMoveOffers({ ...base, mode: "device", deviceChatCount: 2, signedOutDeviceChatCount: 1 });
  assert.deepEqual(device.map((o) => o.from), ["signed-out"]);
  assert.equal(device[0].button, DEFAULT_STRINGS.historyMoveSignedOutToDeviceButton);

  assert.deepEqual(settingsUi.historyMoveOffers({ ...base, mode: "off", deviceChatCount: 2, signedOutDeviceChatCount: 1 }), []);
  assert.deepEqual(settingsUi.historyMoveOffers({ ...base, mode: "account", deviceChatCount: 0, signedOutDeviceChatCount: 0 }), []);
});

test("in device mode a signed-in user can take the signed-out chats as their own, only when asked", async () => {
  const { adapter, setUser } = fakeAdapter({ user: null });
  const m = manager({ adapter });
  await m.start();
  const visitor = m.store.create();
  m.store.saveMessages(visitor.id, msgs("signed out"));
  setUser("alice");
  await m.refresh();
  assert.equal(m.store.get(visitor.id), undefined);
  assert.equal(m.getState().signedOutDeviceChatCount, 1);
  assert.deepEqual(await m.moveDeviceChats({ from: "signed-out" }), { moved: 1, failed: 0 });
  assert.ok(m.store.get(visitor.id));
  assert.deepEqual(deviceChats(userSlot("alice")).map((s) => s.id), [visitor.id]);
  assert.equal(deviceChats().length, 0);
  m.dispose();
});

test("offerSignedOutChats: true (the default) offers the signed-out chats; false never does", async () => {
  const seedSignedOut = () =>
    storage.set(KEY, JSON.stringify({ version: 1, activeId: null, sessions: [chat("visitor")], groups: [] }));

  // true: offered, and moved on the explicit choice.
  seedSignedOut();
  const yes = fakeAdapter({ user: "alice" });
  const on = manager({ adapter: yes.adapter, offerSignedOutChats: true });
  await on.start();
  assert.equal(on.getState().signedOutDeviceChatCount, 1);
  assert.deepEqual(settingsUi.historyMoveOffers(on.getState()).map((o) => o.from), ["signed-out"]);
  assert.deepEqual(await on.moveDeviceChats({ from: "signed-out" }), { moved: 1, failed: 0 });
  on.dispose();

  // false: never counted, offered or moved — in device mode or in account mode.
  storage.clear();
  seedSignedOut();
  const no = fakeAdapter({ user: "alice" });
  const off = manager({ adapter: no.adapter, offerSignedOutChats: false });
  await off.start();
  assert.equal(off.getState().signedOutDeviceChatCount, 0);
  assert.deepEqual(settingsUi.historyMoveOffers(off.getState()), []);
  assert.deepEqual(await off.moveDeviceChats({ from: "signed-out" }), { moved: 0, failed: 0 });
  await off.setMode("account", { moveDeviceChats: true });
  assert.equal(off.getState().signedOutDeviceChatCount, 0);
  assert.deepEqual(settingsUi.historyMoveOffers(off.getState()), []);
  assert.deepEqual(await off.moveDeviceChats({ from: "signed-out" }), { moved: 0, failed: 0 });
  assert.equal(no.calls.save.length, 0, "nothing of the signed-out slot reaches the account");
  assert.deepEqual(deviceChats().map((s) => s.id), ["visitor"], "left where it was");
  assert.equal(deviceChats(userSlot("alice")).length, 0);
  off.dispose();
});

test("chats saved by earlier versions stay where they were: the signed-out slot", async () => {
  storage.set(KEY, JSON.stringify({ version: 1, activeId: "old", sessions: [chat("old")], groups: [] }));
  const plain = manager(); // no adapter: read synchronously, exactly as before
  assert.ok(plain.store.get("old"));
  plain.dispose();

  const { adapter } = fakeAdapter({ user: null });
  const out = manager({ adapter });
  await out.start();
  assert.ok(out.store.get("old"), "a signed-out visitor still sees them");
  out.dispose();
});

test("an adapter that can't name users keeps one device store and never calls it anyone's", async () => {
  const { adapter, calls } = fakeAdapter();
  delete adapter.currentUserId;
  const m = manager({ adapter });
  await m.start();
  const s = m.store.create();
  m.store.saveMessages(s.id, msgs("whose?"));
  assert.deepEqual(deviceChats().map((x) => x.id), [s.id], "the plain key, as before");
  await m.setMode("account", { moveDeviceChats: true });
  assert.equal(calls.save.length, 0);
  assert.equal(m.getState().deviceChatCount, 0);
  assert.equal(m.getState().signedOutDeviceChatCount, 1);
  assert.deepEqual(await m.moveDeviceChats({ from: "signed-out" }), { moved: 1, failed: 0 });
  m.dispose();
});

// --- retention and moving ---------------------------------------------------------------

test("a move counts as activity: a 13-month-old chat survives being moved to the account", async () => {
  const { adapter, calls, db } = fakeAdapter({ retentionMonths: 12 });
  const m = manager({ adapter });
  await m.start();
  const d = new Date();
  d.setMonth(d.getMonth() - 13);
  const longAgo = d.toISOString();
  m.store.importAll(
    JSON.stringify({ version: 1, activeId: null, sessions: [chat("old1", ["last year", "noted"], longAgo)], groups: [] })
  );
  assert.equal(m.getState().deviceChatCount, 1);

  const before = Date.now();
  await m.setMode("account", { moveDeviceChats: true });
  assert.deepEqual(calls.save.map((c) => c.id), ["old1"]);
  assert.ok(Date.parse(calls.save[0].updatedAt) >= before, "saved as active now");
  assert.equal(calls.save[0].createdAt, longAgo, "it keeps its real age");
  assert.ok(m.store.get("old1"));
  m.dispose();

  // The next visit reads the list, which applies the account's retention.
  const next = manager({ adapter });
  await next.start();
  assert.equal(next.getState().mode, "account");
  assert.ok(next.store.get("old1"), "still there after the retention check");
  assert.ok(db.has("old1"));
  assert.equal(deviceChats(userSlot("u1")).length, 0);
  next.dispose();
});

test("delete all empties the account and this device", async () => {
  const { adapter, calls, db } = fakeAdapter({ rows: [chat("a1")] });
  const m = manager({ adapter });
  await m.start();
  const s = m.store.create();
  m.store.saveMessages(s.id, msgs("local"));
  assert.deepEqual(await m.deleteAll(), { ok: true });
  assert.equal(calls.deleteAll, 1);
  assert.equal(db.size, 0);
  assert.equal(deviceChats(userSlot("u1")).length, 0);
  assert.equal(m.store.list(true).length, 0);
  m.dispose();
});

test("if the account can't be emptied, delete all says so and keeps showing what's left", async () => {
  const { adapter } = fakeAdapter({ rows: [chat("a1")] });
  adapter.deleteAll = async () => {
    throw new Error("offline");
  };
  const m = manager({ defaultMode: "account", adapter });
  await m.start();
  assert.deepEqual(await m.deleteAll(), { ok: false });
  assert.ok(m.store.get("a1"));
  m.dispose();
});

test("a failed load is reported and retried", async () => {
  const { adapter } = fakeAdapter({ rows: [chat("a1")] });
  const list = adapter.list;
  let fail = true;
  adapter.list = async () => {
    if (fail) throw new Error("network");
    return list();
  };
  const errors = [];
  const m = manager({ defaultMode: "account", adapter, onError: (e) => errors.push(e) });
  await m.start();
  assert.equal(m.getState().status, "error");
  assert.equal(m.getState().error, "load");
  assert.equal(errors.length, 1);
  fail = false;
  await m.retry();
  assert.equal(m.getState().status, "idle");
  assert.ok(m.store.get("a1"));
  m.dispose();
});

test("the store reports edits but not selection or unread", () => {
  const store = new ChatHistoryStore(KEY, { persist: false });
  const seen = [];
  store.onChange((c) => seen.push(c.kind));
  const s = store.create();
  store.setActive(s.id);
  store.markUnread(s.id);
  store.rename(s.id, "x");
  store.delete(s.id);
  assert.deepEqual(seen, ["upsert", "upsert", "delete"]);
  assert.equal(storage.has(KEY), false);
});

// --- the Supabase reference adapter ------------------------------------------------------

function fakeSupabase({ userId = "u1", respond = () => ({ data: [], error: null }) } = {}) {
  const queries = [];
  const client = {
    auth: { getSession: async () => ({ data: { session: userId ? { user: { id: userId } } : null } }) },
    from(table) {
      const q = { table, ops: [] };
      queries.push(q);
      const builder = new Proxy(
        {},
        {
          get(_, prop) {
            if (prop === "then") return (ok, bad) => Promise.resolve(respond(q)).then(ok, bad);
            return (...args) => {
              q.ops.push([prop, ...args]);
              return builder;
            };
          },
        }
      );
      return builder;
    },
  };
  return { client, queries };
}
const op = (q, name) => q.ops.filter((o) => o[0] === name);

test("supabase adapter: list is the user's own, in this app, recent only, without messages", async () => {
  const { client, queries } = fakeSupabase({
    respond: (q) =>
      op(q, "select").length
        ? { data: [{ id: "c1", title: "T", pinned: true, archived: false, group_id: null, model: null, created_at: "x", updated_at: "y" }], error: null }
        : { data: null, error: null },
  });
  const adapter = supabaseChatHistoryAdapter(client, { app: "notes" });
  assert.equal(adapter.retentionMonths, 12);
  const rows = await adapter.list();
  assert.deepEqual(rows, [
    { id: "c1", title: "T", pinned: true, archived: false, groupId: null, model: null, createdAt: "x", updatedAt: "y" },
  ]);
  const [prune, list] = queries;
  assert.equal(prune.table, "assistant_chats");
  assert.equal(op(prune, "delete").length, 1, "the user's own inactive chats are pruned first");
  assert.deepEqual(op(prune, "eq"), [["eq", "user_id", "u1"], ["eq", "app", "notes"]]);
  assert.equal(op(prune, "lt")[0][1], "updated_at");
  assert.ok(!op(list, "select")[0][1].includes("messages"), "the list stays light");
  assert.deepEqual(op(list, "eq"), [["eq", "user_id", "u1"], ["eq", "app", "notes"]]);
  assert.equal(op(list, "gte")[0][1], "updated_at");
  assert.deepEqual(op(list, "order")[0], ["order", "updated_at", { ascending: false }]);
});

test("supabase adapter: save upserts as the signed-in user", async () => {
  const { client, queries } = fakeSupabase({ respond: () => ({ data: null, error: null }) });
  const adapter = supabaseChatHistoryAdapter(client);
  await adapter.save(chat("c1"));
  const [upsert] = op(queries[0], "upsert");
  assert.equal(upsert[1].user_id, "u1");
  assert.equal(upsert[1].app, "");
  assert.equal(upsert[1].group_id, null);
  assert.equal(upsert[1].updated_at, "2026-09-01T10:00:00.000Z");
  assert.equal(upsert[1].messages.length, 2);
});

test("supabase adapter: upserts conflict on (user_id, app, id), so apps sharing a table stay apart", async () => {
  // On (user_id, id), saving chat "c1" in one app would overwrite the same user's "c1" in another.
  const { client, queries } = fakeSupabase({ respond: () => ({ data: null, error: null }) });
  const adapter = supabaseChatHistoryAdapter(client, { app: "notes" });
  await adapter.save(chat("c1"));
  await adapter.saveMany([chat("c2"), chat("c3")]);
  const [one] = op(queries[0], "upsert");
  const [many] = op(queries[1], "upsert");
  assert.deepEqual(one[2], { onConflict: "user_id,app,id" });
  assert.deepEqual(many[2], { onConflict: "user_id,app,id" });
  assert.equal(one[1].app, "notes");
  assert.deepEqual(many[1].map((r) => [r.app, r.id]), [["notes", "c2"], ["notes", "c3"]]);
});

test("supabase adapter: delete all is scoped to this user and app", async () => {
  const { client, queries } = fakeSupabase({ respond: () => ({ data: null, error: null }) });
  await supabaseChatHistoryAdapter(client, { app: "notes" }).deleteAll();
  assert.equal(op(queries[0], "delete").length, 1);
  assert.deepEqual(op(queries[0], "eq"), [["eq", "user_id", "u1"], ["eq", "app", "notes"]]);
});

test("supabase adapter: signed out, errors and missing rows", async () => {
  const out = supabaseChatHistoryAdapter(fakeSupabase({ userId: null }).client);
  assert.equal(await out.currentUserId(), null);
  await assert.rejects(out.list(), /nobody is signed in/);

  const failing = supabaseChatHistoryAdapter(
    fakeSupabase({ respond: () => ({ data: null, error: { message: "permission denied" } }) }).client
  );
  await assert.rejects(failing.save(chat("c1")), /permission denied/);

  const empty = supabaseChatHistoryAdapter(fakeSupabase({ respond: () => ({ data: null, error: null }) }).client);
  assert.equal(await empty.get("nope"), null);
});

// --- the reference migration ---------------------------------------------------------------

test("the migration locks every row to its owner and sweeps inactive chats", async () => {
  const sql = await readFile(new URL("../supabase/assistant_chats.sql", import.meta.url), "utf8");
  assert.match(sql, /references auth\.users \(id\) on delete cascade/);
  assert.match(sql, /default auth\.uid\(\)/);
  assert.match(sql, /enable row level security/);
  for (const action of ["select", "insert", "update", "delete"]) {
    const policy = new RegExp(`for ${action} to authenticated\\s+(using|with check) \\(\\(select auth\\.uid\\(\\)\\) = user_id\\)`);
    assert.match(sql, policy, `${action} policy must be restricted to the owner`);
  }
  assert.match(sql, /revoke all on table public\.assistant_chats from anon/);
  assert.match(sql, /updated_at < now\(\) - interval '12 months'/);
  assert.match(sql, /revoke execute on function public\.assistant_chats_delete_inactive\(\) from public, anon, authenticated/);
  assert.match(sql, /cron\.schedule/);
});

test("the migration keys chats on (user_id, app, id) and re-keys a table made by the old file", async () => {
  const sql = await readFile(new URL("../supabase/assistant_chats.sql", import.meta.url), "utf8");
  const create = sql.slice(sql.indexOf("create table"), sql.indexOf(");", sql.indexOf("create table")));
  assert.match(create, /primary key \(user_id, app, id\)/, "the adapter upserts on exactly this key");
  assert.doesNotMatch(create, /primary key \(user_id, id\)/);
  assert.match(sql, /pg_get_constraintdef\(oid\) = 'PRIMARY KEY \(user_id, id\)'/);
  assert.match(sql, /add constraint assistant_chats_pkey primary key \(user_id, app, id\)/);
});

test("every history string has an English default", () => {
  const keys = Object.keys(DEFAULT_STRINGS).filter((k) => k.startsWith("history") || k === "settingsHistory");
  assert.ok(keys.length >= 25);
  for (const k of keys) assert.ok(DEFAULT_STRINGS[k].trim(), `${k} blank`);
  assert.match(DEFAULT_STRINGS.historyRetention, /\{months\}/);
  assert.match(DEFAULT_STRINGS.historyMovePrompt, /\{count\}/);
});
