import type { Capability } from "./types.js";

/**
 * Built-in capability: let the assistant remember a fact about the user. Writes go to
 * the configured MemoryStore (persistent in the widget via localStorage), and recall is
 * automatic — relevant facts are injected into the system prompt on every turn.
 */
export const rememberFactCapability: Capability<{ topic: string; fact: string }, { saved: boolean; topic: string }> = {
  name: "remember_fact",
  description:
    "Remember a stable fact about the user or their preferences for future conversations (e.g. 'grows indoors in a 2m tent'). Use when the user states something worth keeping.",
  tags: ["memory"],
  exposeToAgents: false,
  parameters: {
    type: "object",
    properties: {
      topic: { type: "string", description: "Short topic key, e.g. 'grow setup'." },
      fact: { type: "string", description: "The fact, one sentence." },
    },
    required: ["topic", "fact"],
  },
  run: async ({ topic, fact }, ctx) => {
    await ctx.memory.remember({ topic: String(topic).slice(0, 80), content: String(fact).slice(0, 400) });
    return { saved: true, topic };
  },
  render: (r) => `Noted — I'll remember that (${r.topic}).`,
};
