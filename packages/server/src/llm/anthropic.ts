import type { LLMProvider, LLMCompletionInput, LLMCompletionOutput, ChatMessage } from "@page-assistant/core";

/** Anthropic Messages API provider with tool calling. */
export function anthropicProvider(opts: { apiKey: string; model?: string }): LLMProvider {
  const model = opts.model ?? "claude-haiku-4-5-20251001";
  return {
    name: "anthropic",
    async complete(input: LLMCompletionInput): Promise<LLMCompletionOutput> {
      const tools = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: { type: "object", ...t.parameters },
      }));
      const body: any = {
        model,
        max_tokens: 1024,
        temperature: input.temperature ?? 0.3,
        system: input.system,
        messages: toAnthropicMessages(input.messages),
        tools,
      };
      if (input.forceTool) body.tool_choice = { type: "tool", name: input.forceTool };

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
      const data: any = await res.json();
      const toolCalls: LLMCompletionOutput["toolCalls"] = [];
      let text = "";
      for (const block of data.content ?? []) {
        if (block.type === "text") text += block.text;
        else if (block.type === "tool_use") toolCalls.push({ name: block.name, args: block.input ?? {} });
      }
      return { toolCalls, text: text.trim() };
    },
  };
}

/** Our ChatMessage history → Anthropic message blocks. Tool results become user turns. */
function toAnthropicMessages(messages: ChatMessage[]) {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") out.push({ role: "assistant", content: m.content });
    else if (m.role === "tool")
      out.push({ role: "user", content: `[result of ${m.toolName}]\n${m.content}` });
  }
  // Anthropic requires the first message to be a user turn.
  if (out.length && out[0].role !== "user") out.unshift({ role: "user", content: "(continue)" });
  return out;
}
