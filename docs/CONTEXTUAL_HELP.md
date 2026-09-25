# Contextual UI help

The widget answers questions by **running capabilities** — it cannot see your hover
tooltips. When a field looks broken (greyed out, missing button, empty list), users ask
the assistant. Without explicit guidance it guesses.

Use **three layers** together: inline `?` tooltips in your UI, background `knowledge`,
and one or more **`explain_*` capabilities** grounded in the user's real configuration.

Reference implementation: [Daybook](https://github.com/philipposk/daybook) —
`explain_pos_card_field`, `HelpTip`, `pa_knowledge`, `/api/pa/llm.txt`.

## 1. Hover tooltips (host UI)

Copy [`snippets/HelpTip.tsx`](./snippets/HelpTip.tsx) and
[`snippets/help-tip.css`](./snippets/help-tip.css) into your app. Map the CSS variables
(`--hairline`, `--surface`, `--accent`, …) to your design tokens.

The snippet renders the panel in a **fixed portal** and flips above/below so tips on page
titles (near the top of the viewport) are not clipped.

Put tips only where people get stuck — greyed fields, profit-chain lines that look like
expenses, modules that need setup first. Not on every label.

## 2. Background knowledge

In `PageAssistant.init({ knowledge: "…" })`, add short procedural paragraphs:

- What a greyed-out control means (computed vs disabled)
- Where setup lives (Settings → Banks, etc.)
- Which capability name answers setup questions (`explain_pos_card_field`)

Keep it factual. No per-user numbers — figures must come from capabilities.

## 3. Explain capabilities

For answers that depend on org state, register a read-only tool:

```typescript
import { explainUiCapability, pageStateHint } from "@page-assistant/core";

const explainPosCardField = explainUiCapability({
  name: "explain_pos_card_field",
  description:
    "Explain how the card/POS field on the closing form works and how to set up card banks.",
  tags: ["settings", "help"],
  async run() {
    const banks = await listBanks(db, orgId);
    const posBanks = banks.filter((b) => b.pos && !b.archived);
    return {
      scenario: posBanks.length === 0 ? "no_banks" : posBanks.length === 1 ? "one" : "multi",
      posBankCount: posBanks.length,
      canEditSettings: can(membership, "settings.write"),
    };
  },
  render(r) {
    if (r.scenario === "no_banks") return "No card banks yet. The field still works…";
    if (r.scenario === "one") return "One terminal bank. Type on the main Card field…";
    return "Several terminals: the headline Card field is read-only and shows the sum…";
  },
});
```

`explainUiCapability` sets `verbatim: true` and empty parameters so the grounding
validator keeps your exact wording.

## 4. Page state hints

Tell the model which explain tool fits the current screen:

```typescript
getPageState: () => {
  const path = location.pathname;
  const base = { path, screen: path.startsWith("/day") ? "day" : "other" };
  if (path.startsWith("/day")) {
    return pageStateHint(
      base,
      "If the user asks about a greyed card field, run explain_pos_card_field.",
    );
  }
  return base;
},
```

## 5. Suggestion chips and llm.txt

Add chips for common questions:

```typescript
suggestions: ["How does the card field work?", "What did we take today?"],
```

In your `llm.txt` route, add a prose section for external agents (same concepts as
`knowledge`, no user-specific data). See Daybook's "Card terminals and banks" section in
`src/app/api/pa/llm.txt/route.ts`.

## Checklist

- [ ] `?` tooltips on the confusing controls (portal positioning, not clipped)
- [ ] `knowledge` mentions grey fields and setup paths
- [ ] `explain_*` capability per state-dependent confusion
- [ ] `getPageState()` hint on relevant screens
- [ ] Suggestion chip for the most common "how does X work?" question
- [ ] Matching `llm.txt` section for agent discovery
