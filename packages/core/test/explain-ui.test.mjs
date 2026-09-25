import assert from "node:assert/strict";
import test from "node:test";

import { explainUiCapability, pageStateHint } from "../dist/explainUi.js";

test("explainUiCapability builds a verbatim help tool with no parameters", () => {
  const cap = explainUiCapability({
    name: "explain_pos_card_field",
    description: "Explain how the card field works.",
    run: () => ({ banks: 0 }),
    render: (r) => `Banks: ${r.banks}`,
  });
  assert.equal(cap.name, "explain_pos_card_field");
  assert.equal(cap.verbatim, true);
  assert.deepEqual(cap.parameters, { type: "object", properties: {} });
  assert.deepEqual(cap.tags, ["help"]);
});

test("explainUiCapability run/render use host state", async () => {
  const cap = explainUiCapability({
    name: "explain_thing",
    description: "Explain the thing.",
    run: async () => ({ mode: "split" }),
    render: (r) => `Mode: ${r.mode}`,
  });
  const ctx = { page: { url: "/", title: "" }, memory: {}, caller: "user" };
  const result = await cap.run({}, ctx);
  assert.deepEqual(result, { mode: "split" });
  assert.equal(cap.render(result, {}), "Mode: split");
});

test("pageStateHint adds a hint field for the current screen", () => {
  const state = pageStateHint({ path: "/day", screen: "day" }, "run explain_pos_card_field");
  assert.equal(state.hint, "run explain_pos_card_field");
  assert.equal(state.path, "/day");
});
