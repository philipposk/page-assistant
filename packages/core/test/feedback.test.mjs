import { test } from "node:test";
import assert from "node:assert/strict";
import { ticketsFromRun, normalizeTicket, MemoryTicketStore, feedbackWellKnown } from "../dist/index.js";

test("a failed capability auto-files an error/missing ticket", () => {
  const res = { message: "x", invocations: [{ name: "do_thing", args: {}, ok: false, error: "unknown capability" }] };
  const t = ticketsFromRun("MyApp", "agent-7", "do the thing", res);
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, "missing_capability");
  assert.equal(t[0].app, "MyApp");
});

test("a caught hallucination becomes a ticket", () => {
  const res = { message: "x", invocations: [{ name: "sim", args: {}, ok: true, rendered: "42" }], corrected: true };
  const t = ticketsFromRun("MyApp", "pa", "sim", res);
  assert.ok(t.some((x) => x.kind === "hallucination_caught"));
});

test("no capability matched → missing_capability ticket", () => {
  const t = ticketsFromRun("MyApp", "pa", "make me a sandwich", { message: "can't", invocations: [] });
  assert.equal(t[0].kind, "missing_capability");
});

test("normalizeTicket rejects junk, accepts valid", () => {
  assert.ok("error" in normalizeTicket({}));
  const ok = normalizeTicket({ summary: "height units unclear", kind: "confusion" });
  assert.equal(ok.kind, "confusion");
});

test("store round-trips", () => {
  const s = new MemoryTicketStore();
  s.save({ app: "a", source: "b", kind: "suggestion", summary: "add dark mode" });
  assert.equal(s.list()[0].summary, "add dark mode");
});

test("well-known discovery doc has endpoint + schema", () => {
  const wk = feedbackWellKnown("MyApp", "https://x/v1/feedback");
  assert.equal(wk.feedbackEndpoint, "https://x/v1/feedback");
  assert.ok(wk.ticketSchema.summary);
});
