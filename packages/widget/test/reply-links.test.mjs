// Rendering a reply with links: real <a> elements only for safe hrefs, built from text
// nodes and textContent (never innerHTML), and clicks that go through the host's router
// or a normal page load.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renderReply, followLink } from "../dist/replyLinks.js";

// --- just enough of a document ---------------------------------------------------------------

function node(tag) {
  const n = {
    tag,
    children: [],
    listeners: {},
    textContent: "",
    href: undefined,
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  };
  Object.defineProperty(n, "innerHTML", {
    set() {
      throw new Error("innerHTML must never be used for reply text");
    },
  });
  return n;
}

const doc = {
  createElement: (tag) => node(tag),
  createTextNode: (t) => ({ tag: "#text", text: t }),
};

let assigned;
beforeEach(() => {
  assigned = [];
  globalThis.location = { origin: "https://samos.6x7.gr", assign: (h) => assigned.push(h) };
  globalThis.window = { location: globalThis.location };
});

function render(text, opts) {
  const parent = node("div");
  parent.ownerDocument = doc;
  renderReply(parent, text, opts);
  return parent.children;
}

/** What the user sees: text nodes as text, links as {a: label, href}. */
const view = (children) => children.map((c) => (c.tag === "#text" ? c.text : { a: c.textContent, href: c.href }));

function click(a, over = {}) {
  const e = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...over,
  };
  a.listeners.click(e);
  return e;
}

// --- rendering -------------------------------------------------------------------------------

test("safe links become <a>, the rest stays text", () => {
  const out = render("Try [Aphrodite Garden](/places/aphrodite-garden) or […και 68 ακόμα.](/places?cat=food)");
  assert.deepEqual(view(out), [
    "Try ",
    { a: "Aphrodite Garden", href: "/places/aphrodite-garden" },
    " or ",
    { a: "…και 68 ακόμα.", href: "/places?cat=food" },
  ]);
});

test("unsafe links show only their label", () => {
  const out = render(
    "[a](//evil.com) [b](javascript:alert(1)) [c](data:text/html,x) [d](https://evil.com) [e](/\\evil.com)"
  );
  assert.equal(out.some((c) => c.tag === "a"), false);
  assert.equal(out.map((c) => c.text).join(""), "a b c d e");
});

test("absolute links on a listed origin are allowed", () => {
  const out = render("[Map](https://maps.example.com/p?q=1)", { linkOrigins: ["https://maps.example.com"] });
  assert.deepEqual(view(out), [{ a: "Map", href: "https://maps.example.com/p?q=1" }]);
});

test("markup in a reply is text, not HTML", () => {
  const out = render('<img src=x onerror="alert(1)"> [<b>x</b>](/p/1)');
  assert.deepEqual(view(out), ['<img src=x onerror="alert(1)"> ', { a: "<b>x</b>", href: "/p/1" }]);
});

// --- clicking --------------------------------------------------------------------------------

test("a click goes through the host's onNavigate, then onFollowed", () => {
  const calls = [];
  const [a] = render("[Yamas](/places/yamas)", {
    onNavigate: (h) => calls.push(["nav", h]),
    onFollowed: (h) => calls.push(["followed", h]),
  });
  const e = click(a);
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(calls, [["nav", "/places/yamas"], ["followed", "/places/yamas"]]);
  assert.deepEqual(assigned, []);
});

test("without onNavigate a click loads the page", () => {
  const [a] = render("[Yamas](/places/yamas)");
  click(a);
  assert.deepEqual(assigned, ["/places/yamas"]);
});

test("new-tab clicks are left to the browser", () => {
  const calls = [];
  const [a] = render("[Yamas](/places/yamas)", { onNavigate: (h) => calls.push(h), onFollowed: (h) => calls.push(h) });
  for (const over of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
    const e = click(a, over);
    assert.equal(e.defaultPrevented, false, JSON.stringify(over));
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(assigned, []);
});

test("a host router that throws or rejects falls back to a page load", async () => {
  followLink("/a", () => {
    throw new Error("no router");
  });
  followLink("/b", () => Promise.reject(new Error("aborted")));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(assigned, ["/a", "/b"]);
});
