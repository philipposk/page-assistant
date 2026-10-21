/**
 * Cleans the provider-native assistant content a browser sends back to the Lite proxy.
 *
 * Lite's loop runs in the visitor's page, so the thinking blocks a model produced travel
 * out to the browser and back in on the next round. The browser is not trusted: this keeps
 * only the four block kinds a model's own turn is made of, each with just its expected
 * fields, so a visitor cannot slip arbitrary blocks (tool results, images, documents,
 * server tool use) into the conversation. Nothing here checks that a signature is genuine;
 * the provider does that and rejects a forged one.
 */

const MAX_BLOCKS = 64;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** One block, reduced to its known fields, or null if it is not a kind we pass through. */
function cleanBlock(b: unknown): Record<string, unknown> | null {
  if (!isObj(b)) return null;
  switch (b.type) {
    case "thinking":
      if (typeof b.thinking !== "string" || typeof b.signature !== "string") return null;
      return { type: "thinking", thinking: b.thinking, signature: b.signature };
    case "redacted_thinking":
      if (typeof b.data !== "string") return null;
      return { type: "redacted_thinking", data: b.data };
    case "text":
      if (typeof b.text !== "string") return null;
      return { type: "text", text: b.text };
    case "tool_use":
      if (typeof b.id !== "string" || typeof b.name !== "string") return null;
      return { type: "tool_use", id: b.id, name: b.name, input: isObj(b.input) ? b.input : {} };
    default:
      return null;
  }
}

/**
 * `providerContent` from a client message → a safe `{ provider, content }`, or undefined
 * when nothing usable is left (the message then falls back to its plain text and tool calls).
 */
export function sanitizeProviderContent(pc: unknown): { provider: string; content: unknown[] } | undefined {
  if (!isObj(pc) || typeof pc.provider !== "string" || !Array.isArray(pc.content)) return undefined;
  const content = pc.content.slice(0, MAX_BLOCKS).map(cleanBlock).filter((b): b is Record<string, unknown> => b !== null);
  return content.length ? { provider: pc.provider, content } : undefined;
}
