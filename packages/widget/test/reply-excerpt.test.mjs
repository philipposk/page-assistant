// The plain-text excerpt shown in the closed-panel reply bubble (ask()'s notification):
// links read as their label, never a raw URL, and anything past ~120 characters is cut with
// an ellipsis.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replyExcerpt } from "../dist/replyLinks.js";

test("short text is returned as-is", () => {
  assert.equal(replyExcerpt("Three things are new today."), "Three things are new today.");
});

test("links render as their label, never the raw URL", () => {
  assert.equal(
    replyExcerpt("Try [Aphrodite Garden](/places/aphrodite-garden) tonight."),
    "Try Aphrodite Garden tonight."
  );
});

test("text past the limit is cut with an ellipsis", () => {
  const long = "a".repeat(140);
  const out = replyExcerpt(long, 120);
  assert.equal(out, "a".repeat(120) + "…");
  assert.equal(out.length, 121); // 120 chars + the ellipsis
});

test("exactly at the limit is not cut", () => {
  const exact = "a".repeat(120);
  assert.equal(replyExcerpt(exact, 120), exact);
});

test("whitespace (including newlines) is collapsed before measuring", () => {
  assert.equal(replyExcerpt("Line one\n\nLine   two"), "Line one Line two");
});

test("default max is 120 characters", () => {
  const long = "a".repeat(200);
  assert.equal(replyExcerpt(long), "a".repeat(120) + "…");
});

test("a cut that lands on a space doesn't leave a dangling space before the ellipsis", () => {
  const words = "word ".repeat(40); // 200 chars, trims to 199; a 120-char slice ends on a space
  const out = replyExcerpt(words);
  assert.ok(!out.endsWith(" …"), out);
  assert.ok(out.endsWith("…"));
});
