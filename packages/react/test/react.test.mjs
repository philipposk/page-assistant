import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import {
  AgentDock,
  Markdown,
  parseBlocks,
  createActionRunner,
  emitPaAction,
  onPaAction,
  clearPendingPaActions,
  REPLAY_WINDOW_MS,
  isSafeInAppPath,
  isSafeNavigationPath,
  isExternalHttpUrl,
  normalizeNavigationPath,
  normaliseReply,
  readEvents,
  postTurn,
  AgentRequestError,
  toHistoryTurns,
  toSavable,
  linesFromSaved,
  failureFromError,
  retryForReply,
  isFailureReply,
  hasExpired,
  cardOnArrival,
  CARD_TTL_MS,
  localChatHistory,
  speakableText,
  paAnchor,
  isAnchorName,
  MAX_HISTORY_TURNS,
  MAX_HISTORY_BYTES,
} from "../dist/index.js";
import * as anchorsEntry from "../dist/anchors.js";

// --- navigation safety -------------------------------------------------------------------------

test("isSafeInAppPath follows only same-app absolute paths", () => {
  for (const ok of ["/", "/items", "/items?x=1#y", " /trimmed "]) assert.equal(isSafeInAppPath(ok), true, ok);
  for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "/javascript:x", "items", "/a\nb", 42, null]) {
    assert.equal(isSafeInAppPath(bad), false, String(bad));
  }
  assert.equal(isExternalHttpUrl("https://x.example/a"), true);
  assert.equal(isExternalHttpUrl("javascript:alert(1)"), false);
});

test("anchors are names, never selectors", () => {
  assert.deepEqual(paAnchor("items.add"), { "data-pa-anchor": "items.add" });
  assert.equal(isAnchorName('x"] , body [a="'), false);
  assert.equal(isAnchorName("companies.table"), true);
});

// --- event bus with replay ---------------------------------------------------------------------

test("an action emitted before its listener mounts is replayed once, inside the window", () => {
  clearPendingPaActions();
  emitPaAction("select_rows", { ids: [1] }, 1000);
  const got = [];
  const off = onPaAction("select_rows", (d) => got.push(d), () => 1000 + REPLAY_WINDOW_MS - 1);
  off();
  assert.deepEqual(got, [{ ids: [1] }]);
  const again = [];
  onPaAction("select_rows", (d) => again.push(d), () => 1001)();
  assert.deepEqual(again, [], "handled once — a remount never replays it");
});

test("a stale buffered action is dropped, and live events reach a mounted listener", () => {
  clearPendingPaActions();
  emitPaAction("open_panel", { id: "x" }, 0);
  const got = [];
  onPaAction("open_panel", (d) => got.push(d), () => REPLAY_WINDOW_MS + 1)();
  assert.deepEqual(got, []);

  const prev = globalThis.window;
  globalThis.window = new EventTarget();
  try {
    const live = [];
    const off = onPaAction("open_panel", (d) => live.push(d));
    emitPaAction("open_panel", { id: "y" });
    off();
    emitPaAction("open_panel", { id: "z" });
    assert.deepEqual(live, [{ id: "y" }]);
  } finally {
    globalThis.window = prev;
    clearPendingPaActions();
  }
});

// --- action runner -----------------------------------------------------------------------------

function fakeDeps(overrides = {}) {
  const log = [];
  const deps = {
    navigate: (p) => log.push(["navigate", p]),
    narrate: (t, s) => log.push(["narrate", t, s]),
    setHighlight: (t) => log.push(["highlight", t ? t.label ?? t.element.id : null]),
    setRunning: (r) => log.push(["running", r]),
    waitForAnchor: async (name) => (name === "missing" ? null : { id: name, scrollIntoView() {} }),
    emit: (type, detail) => log.push(["emit", type, detail]),
    sleep: async (ms) => log.push(["sleep", ms]),
    beatMs: 1,
    lingerMs: 1,
    ...overrides,
  };
  return { deps, log };
}

test("immediate mode applies everything, drops off-site navigation, routes custom actions", async () => {
  const handled = [];
  const { deps, log } = fakeDeps({ handlers: { open_item: (a) => handled.push(a) } });
  const r = createActionRunner(deps);
  await r.run([
    { type: "navigate", to: "https://evil.example" },
    { type: "navigate", to: "/items" },
    { type: "narrate", text: "Here", speak: true },
    { type: "highlight", anchor: "items.add", label: "Add" },
    { type: "wait", ms: 5000 },
    { type: "open_item", id: 3 },
    { type: "select_rows", ids: [1, 2] },
  ]);
  assert.deepEqual(log, [
    ["highlight", null], // every run starts with the last ring cleared
    ["navigate", "/items"],
    ["narrate", "Here", true],
    ["highlight", "Add"],
    ["emit", "select_rows", { ids: [1, 2] }],
  ]);
  assert.deepEqual(handled, [{ type: "open_item", id: 3 }]);
});

test("guided mode plays beats in order, honours waits (capped at 10 s) and skips a missing anchor", async () => {
  const { deps, log } = fakeDeps();
  const r = createActionRunner(deps);
  await r.run(
    [
      { type: "navigate", to: "/a" },
      { type: "highlight", anchor: "missing" },
      { type: "wait", ms: 60000 },
      { type: "highlight", anchor: "x", label: "There" },
    ],
    "guided"
  );
  assert.deepEqual(log, [
    ["highlight", null],
    ["running", true],
    ["navigate", "/a"],
    ["sleep", 1],
    ["highlight", null],
    ["sleep", 1],
    ["sleep", 10000],
    ["highlight", "There"],
    ["sleep", 1],
    ["running", false],
  ]);
});

test("cancel stops a running tour at the next beat", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { deps, log } = fakeDeps({ sleep: async (ms) => { log.push(["sleep", ms]); await gate; } });
  const r = createActionRunner(deps);
  const done = r.run([{ type: "navigate", to: "/a" }, { type: "navigate", to: "/b" }], "guided");
  await new Promise((res) => setTimeout(res, 5));
  r.cancel();
  release();
  await done;
  assert.ok(log.some((e) => e[0] === "navigate" && e[1] === "/a"));
  assert.ok(!log.some((e) => e[0] === "navigate" && e[1] === "/b"));
});

// --- transport ---------------------------------------------------------------------------------

function sseBody(text, chunk = 7) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
      c.close();
    },
  });
}

test("readEvents: status events stream in, the reply resolves, split across chunks", async () => {
  const statuses = [];
  const reply = await readEvents(
    sseBody(': ping\n\nevent: status\ndata: {"phase":"thinking"}\n\nevent: status\ndata: {"phase":"tool","label":"Searching"}\n\nevent: reply\ndata: {"message":"hi","uiActions":[]}\n\n'),
    (s) => statuses.push(s)
  );
  assert.deepEqual(statuses, [{ phase: "thinking" }, { phase: "tool", label: "Searching" }]);
  assert.equal(reply.message, "hi");
  assert.equal(reply.uiActionMode, "immediate");
  assert.equal(reply.pendingAction, null);
});

test("readEvents: a stream that closes without a reply is an error, not a silent empty answer", async () => {
  await assert.rejects(readEvents(sseBody("event: status\ndata: {}\n\n")), (e) => e instanceof AgentRequestError && e.status === 0);
});

test("postTurn: sends the bearer token, maps 429 to a typed error with Retry-After", async () => {
  let seen;
  const fakeFetch = async (_url, init) => {
    seen = init;
    return new Response(JSON.stringify({ error: "Slow down", retryAfterSeconds: 30 }), { status: 429, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(postTurn({ endpoint: "/api/pa/agent", fetch: fakeFetch, getAuthToken: () => "tok" }, { message: "hi" }), (e) => {
    assert.equal(e.status, 429);
    assert.equal(e.retryAfterSeconds, 30);
    assert.equal(e.detail, "Slow down");
    return true;
  });
  assert.equal(seen.headers.authorization, "Bearer tok");
  assert.equal(seen.credentials, "same-origin");
});

test("postTurn: a 500 that carries a readable reply is a reply", async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ message: "Something went wrong", errorCode: "internal_error" }), { status: 500 });
  const r = await postTurn({ endpoint: "/x", fetch: fakeFetch }, { message: "hi" });
  assert.equal(r.errorCode, "internal_error");
});

// --- chat rules --------------------------------------------------------------------------------

test("history sends real turns only; saved chats keep real turns only", () => {
  const lines = [
    { id: "1", role: "user", content: "hi" },
    { id: "2", role: "assistant", content: "Step", kind: "narration" },
    { id: "3", role: "assistant", content: "Oops", kind: "error" },
    { id: "4", role: "assistant", content: "Hello" },
  ];
  assert.deepEqual(toHistoryTurns(lines), [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello" }]);
  assert.deepEqual(toSavable(lines), [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello" }]);
});

test("failures: rate limits wait, daily limits get no button, refusals roll back", () => {
  const f429 = failureFromError(new AgentRequestError(429, "Slow", 20));
  assert.equal(f429.rollback, true);
  assert.equal(f429.retry.waitSeconds, 20);
  assert.equal(failureFromError(new AgentRequestError(429, "Daily", 80000)).retry, undefined);
  assert.equal(failureFromError(new AgentRequestError(401)).content, "Sign in to use the assistant.");
  assert.equal(failureFromError(new AgentRequestError(0)).rollback, false, "a dropped stream may have run steps");
  assert.equal(retryForReply({ errorCode: "llm_busy" }).label, "Retry");
  assert.equal(retryForReply({ errorCode: "internal_error" }).label, "Try again");
  assert.equal(retryForReply({ errorCode: "llm_too_large" }), undefined);
  assert.equal(isFailureReply({ errorCode: "incomplete" }), false);
});

test("a reopened chat says a card is gone and a question went unanswered", () => {
  const lines = linesFromSaved([
    { role: "user", content: "delete it" },
    { role: "assistant", content: "This needs your OK. Confirm on the card below." },
    { role: "user", content: "and?" },
  ]);
  assert.match(lines[1].note, /was not done/);
  assert.match(lines[2].note, /No answer/);
});

test("confirm card expiry: naive UTC strings, a clock running ahead, unreadable times", () => {
  assert.equal(hasExpired("2026-01-01T00:00:00", Date.parse("2026-01-01T00:00:01Z")), true);
  assert.equal(hasExpired("not a date"), false);
  const now = Date.now();
  const card = { token: "t", tool: "x", title: "X?", details: [], confirmLabel: "OK", expiresAt: new Date(now - 1000).toISOString() };
  assert.equal(Date.parse(cardOnArrival(card, now).expiresAt), now + CARD_TTL_MS);
});

test("localChatHistory keeps chats per user, newest first, and deletes", async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  try {
    const a = localChatHistory({ userId: "a" });
    const b = localChatHistory({ userId: "b" });
    await a.save({ id: "1", title: "one", messages: [{ role: "user", content: "x" }], createdAt: "2026-01-01", updatedAt: "2026-01-01" });
    await a.save({ id: "2", title: "two", messages: [], createdAt: "2026-01-02", updatedAt: "2026-01-02" });
    assert.deepEqual((await a.list()).map((c) => c.id), ["2", "1"]);
    assert.equal((await a.list())[0].messages, undefined, "the list is light");
    assert.deepEqual(await b.list(), []);
    await a.delete("2");
    assert.deepEqual((await a.list()).map((c) => c.id), ["1"]);
  } finally {
    delete globalThis.localStorage;
  }
});

test("speakableText drops markdown and links' targets", () => {
  assert.equal(speakableText("**Hi** see [the list](/items)\n\n---\n\n`x`"), "Hi see the list x");
});

// --- rendering ---------------------------------------------------------------------------------

test("Markdown renders text nodes only: no HTML, no javascript: links", () => {
  const html = renderToString(
    h(Markdown, {
      text: "**Bold** <img src=x onerror=alert(1)> [bad](javascript:alert(1)) [ext](https://x.example) [in](/items)\n\n- one\n- two\n\n---\n\n1. a",
    })
  );
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /<a href="https:\/\/x\.example\/" target="_blank" rel="noopener noreferrer nofollow" title="https:\/\/x\.example\/">ext<\/a>/);
  assert.match(html.replace(/<!-- -->/g, ""), /\(x\.example\)/, "an external link shows where it goes");
  assert.match(html, /<a href="\/items">in<\/a>/);
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<hr\/>/);
  assert.equal(parseBlocks("a\nb\n\nc").length, 2);
});

test("server-cleaned text (\\<) shows a literal <", () => {
  // (React's SSR puts <!-- --> between adjacent text nodes; the browser shows plain text.)
  assert.match(renderToString(h(Markdown, { text: "a \\<b> c" })).replace(/<!-- -->/g, ""), /a &lt;b&gt; c/);
});

test("AgentDock renders on the server (Next.js prerender) closed and open", () => {
  const closed = renderToString(h(AgentDock, { endpoint: "/api/pa/agent", title: "Ada" }));
  assert.match(closed, /Ask Ada/);
  const open = renderToString(h(AgentDock, { endpoint: "/api/pa/agent", title: "Ada", defaultOpen: true, intro: "Hello there", suggestions: [{ label: "Tour", prompt: "show me around" }], voice: true }));
  assert.match(open, /pa-agent-panel/);
  assert.match(open, /Hello there/);
  assert.match(open, /Tour/);
  assert.match(open, /data-pa-anchor="assistant.dock"/);
});

// --- security review fixes ---------------------------------------------------------------------

test("navigate actions never go to API routes or sign-out", async () => {
  assert.equal(isSafeNavigationPath("/api/delete?id=1"), false);
  assert.equal(isSafeNavigationPath("/auth/sign-out"), false);
  assert.equal(isSafeNavigationPath("/apiary"), true);
  const { deps, log } = fakeDeps();
  await createActionRunner(deps).run([{ type: "navigate", to: "/api/x" }, { type: "navigate", to: "/ok" }]);
  assert.deepEqual(log.filter((e) => e[0] === "navigate"), [["navigate", "/ok"]]);
});

test("unknown failures keep the question and offer only a manual try", () => {
  for (const err of [new AgentRequestError(502), new AgentRequestError(504), new TypeError("Failed to fetch"), new AgentRequestError(0)]) {
    const f = failureFromError(err);
    assert.equal(f.rollback, false, String(err));
    assert.equal(f.retry.label, "Try again");
  }
});

test("a tainted reply is tagged in history, kept when saved, and restored when reopened", () => {
  assert.equal(normaliseReply({ message: "x", tainted: true }).tainted, true);
  assert.equal(normaliseReply({ message: "x" }).tainted, false);
  const lines = [{ id: "1", role: "user", content: "read it" }, { id: "2", role: "assistant", content: "It says…", tainted: true }];
  assert.deepEqual(toHistoryTurns(lines)[1], { role: "assistant", content: "It says…", tainted: true });
  const saved = toSavable(lines);
  assert.equal(saved[1].tainted, true);
  assert.equal(linesFromSaved(saved)[1].tainted, true);
  assert.equal(linesFromSaved(saved)[0].tainted, undefined);
});

test("Markdown renders hostile input in linear time", () => {
  for (const unit of ["[](", "[", "**", "`", "_a"]) {
    const t0 = Date.now();
    renderToString(h(Markdown, { text: unit.repeat(15_000) }));
    assert.ok(Date.now() - t0 < 1500, `${unit} took ${Date.now() - t0} ms`);
  }
});

// --- review fixes: navigation ------------------------------------------------------------------

test("navigation is resolved before it is judged, and the resolved path is what is followed", () => {
  for (const bad of ["/notes/../api/x", "/./logout", "/%2e/api/x", "/users/sign_out", "/account/logout", "/a/%2e%2e/api", "/x/sign-off", "/x/log_off/", "/api", "/%2E%2E/api/x", "//evil.example", "/\\evil.example", "https://evil.example"]) {
    assert.equal(normalizeNavigationPath(bad), null, bad);
    assert.equal(isSafeNavigationPath(bad), false, bad);
  }
  assert.equal(normalizeNavigationPath("/notes/../items?x=1#y"), "/items?x=1#y");
  assert.equal(normalizeNavigationPath(" /a/./b "), "/a/b");
  assert.equal(normalizeNavigationPath("/apiary"), "/apiary");
  assert.equal(normalizeNavigationPath("/signature"), "/signature");
});

test("the runner navigates to the resolved path and refuses the tricks", async () => {
  const { deps, log } = fakeDeps();
  await createActionRunner(deps).run([
    { type: "navigate", to: "/notes/../api/x" },
    { type: "navigate", to: "/%2e/api/x" },
    { type: "navigate", to: "/./logout" },
    { type: "navigate", to: "/users/sign_out" },
    { type: "navigate", to: "/a/./b/../c" },
  ]);
  assert.deepEqual(log.filter((e) => e[0] === "navigate"), [["navigate", "/a/c"]]);
});

test("in-app links in a reply use the same filter as navigate", () => {
  const html = renderToString(h(Markdown, { text: "[a](/api/delete) [b](/logout) [c](/x/../api/y) [d](/notes/../items?q=1)" })).replace(/<!-- -->/g, "");
  assert.doesNotMatch(html, /href="[^"]*(?:api|logout)/);
  assert.match(html, /<a href="\/items\?q=1">d<\/a>/);
});

// --- review fixes: markdown tokenizer ----------------------------------------------------------

test("a link address with markup in it is not a link, so no second link can hide in it", () => {
  for (const text of [
    "\\[a](/x[b](https://evil.com/?d=SECRET)",
    "`[a](/x`[b](https://evil.com/?d=SECRET)",
    "`x [a](/y`[b](https://evil.com/?d=SECRET)",
    "**[a](/x**[b](https://evil.com/?d=SECRET)",
    "[a](/x\"y) [b](/x'y) [c](/x<y) [d](/x\\y)",
  ]) {
    const html = renderToString(h(Markdown, { text, untrusted: true }));
    assert.doesNotMatch(html, /evil\.com/, text);
    assert.doesNotMatch(html, /<a /, text);
  }
  const ok = renderToString(h(Markdown, { text: "[fine](/items) and [ext](https://good.example/p?a=1)", untrusted: true }));
  assert.equal((ok.match(/<a /g) ?? []).length, 2);
});

test("the strict link rule is for tainted replies only: an ordinary reply keeps a link with a quote in it", () => {
  const text = "[post](https://site.example/it's)";
  assert.match(renderToString(h(Markdown, { text })), /<a [^>]*href="https:\/\/site\.example\/it&#x27;s"/);
  assert.doesNotMatch(renderToString(h(Markdown, { text, untrusted: true })), /<a /);
});

test("a link never spans a list item's line break (the server reads links line by line)", () => {
  for (const untrusted of [false, true]) {
    for (const text of ["- [Re-login\n  ](https://evil.com/?d=S3CR3T)", "1. a [x\n   ](https://evil.com/?d=S)", "- ok\n  [y](https://evil.com/?d=S) z"]) {
      const html = renderToString(h(Markdown, { text, untrusted }));
      if (text.includes("[y]")) assert.match(html, /evil\.com/, "a whole link on one line still renders");
      else assert.doesNotMatch(html, /href="https:\/\/evil/, text);
    }
  }
  const parsed = parseBlocks("- a\n  b\n- c");
  assert.deepEqual(parsed[0].items, [["a", "b"], ["c"]]);
});

test("fuzz: nothing the server's cleaner lets through renders as a link it dropped", async () => {
  const { cleanMarkdown } = await import("../../server/dist/agent/index.js");
  const keep = new Set(["https://good.com/a"]);
  const T = ["[", "]", "(", ")", "\\", "`", "*", "**", "_", "__", "[a](/x", "[a](/x)", "](https://evil.com/?d=S)", "[b](https://evil.com/?d=S)", "(https://evil.com/?d=S)", "https://evil.com/?d=S", "[g](https://good.com/a)", "](", " ", "\n", "\n  ", "\n- ", "- ", "1. ", '"t"', "<", "!", "a", "```", "\n\n", "[a", "\\["];
  let seed = 12345;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  for (let i = 0; i < 20_000; i++) {
    let src = rnd(3) === 0 ? "- " : "";
    for (let j = 3 + rnd(12); j > 0; j--) src += T[rnd(T.length)];
    const cleaned = cleanMarkdown(src, { keepUrls: keep });
    if (!cleaned.includes("evil.com")) continue;
    const html = renderToString(h(Markdown, { text: cleaned, untrusted: true }));
    assert.doesNotMatch(html, /href="https:\/\/evil/, JSON.stringify(src));
  }
});

// --- review fixes: chat rules ------------------------------------------------------------------

test("history is the latest real turns, capped in count and bytes, keeping the taint tag", () => {
  const lines = [];
  for (let i = 0; i < 60; i++) {
    lines.push({ id: `u${i}`, role: "user", content: `question ${i}` });
    lines.push({ id: `n${i}`, role: "assistant", content: "narration", kind: "narration" });
    lines.push({ id: `e${i}`, role: "assistant", content: "error", kind: "error" });
    lines.push({ id: `a${i}`, role: "assistant", content: `answer ${i}`, ...(i === 59 ? { tainted: true } : {}) });
  }
  const turns = toHistoryTurns(lines);
  assert.equal(turns.length, MAX_HISTORY_TURNS);
  assert.ok(turns.every((t) => t.kind === undefined && t.content !== "narration" && t.content !== "error"));
  assert.deepEqual(turns.at(-1), { role: "assistant", content: "answer 59", tainted: true });
  assert.equal(turns[0].content, "question 48");

  const big = [];
  for (let i = 0; i < 40; i++) big.push({ id: `${i}`, role: i % 2 ? "assistant" : "user", content: `${i}:`.padEnd(30_000, "é") });
  const capped = toHistoryTurns(big);
  const bytes = new TextEncoder().encode(JSON.stringify(capped)).length;
  assert.ok(bytes <= MAX_HISTORY_BYTES, `${bytes} bytes`);
  assert.ok(MAX_HISTORY_BYTES < 128 * 1024);
  assert.ok(capped.length >= 1 && capped.length < 24);
  assert.ok(capped.at(-1).content.startsWith("39:"), "the newest turn is the one kept");

  const one = toHistoryTurns([{ id: "1", role: "user", content: "\u0001".repeat(32_000) }]);
  assert.ok(new TextEncoder().encode(JSON.stringify(one)).length <= MAX_HISTORY_BYTES, "one huge turn is cut down to fit");
});

test("speakableText takes 40k brackets quickly", () => {
  for (const unit of ["[", "![", "[](", "```"]) {
    const t0 = Date.now();
    const out = speakableText(unit.repeat(40_000));
    assert.ok(Date.now() - t0 < 200, `${unit} took ${Date.now() - t0} ms`);
    assert.ok(out.length <= 2000);
  }
  assert.equal(speakableText("[".repeat(40_000)), "[".repeat(2000));
  assert.equal(speakableText("see [the list](/items) and ![img](/x.png) ok"), "see the list and ok");
});

// --- review fixes: the dock --------------------------------------------------------------------

test("device chats need a user: no userId, no saved-chats button", () => {
  const open = (extra) => renderToString(h(AgentDock, { endpoint: "/api/pa/agent", defaultOpen: true, intro: "Hi", suggestions: [], ...extra }));
  assert.doesNotMatch(open({}), /aria-label="Chats"/, "one shared slot would leak between accounts");
  assert.doesNotMatch(open({ history: "local" }), /aria-label="Chats"/);
  assert.match(open({ userId: "u1" }), /aria-label="Chats"/);
  assert.doesNotMatch(open({ userId: "u1", history: false }), /aria-label="Chats"/);
  const adapter = { list: async () => [], get: async () => null, save: async () => {}, delete: async () => {}, deleteAll: async () => {} };
  assert.match(open({ history: adapter }), /aria-label="Chats"/);
});

test("the server-safe entry holds only pure helpers", () => {
  assert.deepEqual(Object.keys(anchorsEntry).sort(), ["isAnchorName", "paAnchor"]);
  assert.deepEqual(anchorsEntry.paAnchor("a.b"), { "data-pa-anchor": "a.b" });
});

// --- review fixes: the runner ------------------------------------------------------------------

const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

test("a run clears the last ring first, and a ring from an immediate run fades too", async () => {
  const { deps, log } = fakeDeps({ lingerMs: 5 });
  const r = createActionRunner(deps);
  await r.run([{ type: "highlight", anchor: "x", label: "Here" }]);
  assert.deepEqual(log, [["highlight", null], ["highlight", "Here"]]);
  await settle();
  assert.deepEqual(log.at(-1), ["highlight", null], "the ring let go on its own");
  log.length = 0;
  await r.run([{ type: "navigate", to: "/a" }]);
  await settle();
  assert.deepEqual(log, [["highlight", null], ["navigate", "/a"]], "nothing was lit, so nothing to fade");
});

test("a newer run is not cut short by the fade of an older one", async () => {
  const { deps, log } = fakeDeps({ lingerMs: 10 });
  const r = createActionRunner(deps);
  await r.run([{ type: "highlight", anchor: "x", label: "One" }]);
  await r.run([{ type: "highlight", anchor: "y", label: "Two" }]);
  await settle(8);
  assert.deepEqual(log.at(-1), ["highlight", "Two"]);
  await settle(20);
  assert.deepEqual(log.at(-1), ["highlight", null]);
  assert.equal(log.filter((e) => e[0] === "highlight" && e[1] === null).length, 3, "start of run one, start of run two, one fade");
});

test("cancel drops only what this runner put on the bus", async () => {
  clearPendingPaActions();
  emitPaAction("someone_elses", { keep: true });
  const r = createActionRunner({ navigate() {}, narrate() {}, setHighlight() {}, waitForAnchor: async () => null, sleep: async () => {} });
  await r.run([{ type: "select_rows", ids: [1] }]);
  r.cancel();
  const mine = [];
  onPaAction("select_rows", (d) => mine.push(d))();
  assert.deepEqual(mine, []);
  const theirs = [];
  onPaAction("someone_elses", (d) => theirs.push(d))();
  assert.deepEqual(theirs, [{ keep: true }]);
  clearPendingPaActions();
});
