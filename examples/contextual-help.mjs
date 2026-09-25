/**
 * Contextual UI help — explainUiCapability + pageStateHint.
 *
 * Run: node examples/contextual-help.mjs
 */
import { explainUiCapability, pageStateHint } from "@page-assistant/core";

/** Fake org: no POS banks configured yet. */
const org = { posBanks: [] };

const explainPosCardField = explainUiCapability({
  name: "explain_pos_card_field",
  description:
    "Explain how the card field on the closing form works and how to set up card banks.",
  tags: ["settings", "help"],
  run: () => ({
    posBankCount: org.posBanks.length,
    canEditSettings: true,
  }),
  render(r) {
    if (r.posBankCount === 0) {
      return (
        "No card banks are set up yet. The card field still accepts today's total. " +
        "Open Settings → Banks, add a bank, and tick Has a card terminal."
      );
    }
    return "Card takings are split per terminal bank under More → Split per bank.";
  },
});

const pageState = pageStateHint(
  { path: "/day", screen: "day" },
  "If the user asks about a greyed card field, run explain_pos_card_field.",
);

console.log("Page state:", pageState);
console.log("Capability:", explainPosCardField.name, explainPosCardField.verbatim);
console.log(
  "Answer:",
  explainPosCardField.render(await explainPosCardField.run({}, { page: {}, memory: {}, caller: "user" }), {}),
);
