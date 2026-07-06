import type { LLMProvider, LLMCompletionInput, LLMCompletionOutput, ChatMessage } from "@page-assistant/core";
import { fetchWithRetry, llmTimeoutMs, maxTokens } from "./fetchWithRetry.js";
import { HttpProviderError } from "./errors.js";

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
        max_tokens: maxTokens(),
        temperature: input.temperature ?? 0.3,
        system: input.system,
        messages: toAnthropicMessages(input.messages),
        tools,
      };
      if (input.forceTool) body.tool_choice = { type: "tool", name: input.forceTool };

      const res = await fetchWithRetry(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        },
        { timeoutMs: llmTimeoutMs() }
      );
      if (!res.ok) {
        // Keep the raw provider body server-side only; surface a clean typed error.
        throw new HttpProviderError("anthropic", res.status, await safeText(res));
      }
      const data: any = await res.json();
      const toolCalls: LLMCompletionOutput["toolCalls"] = [];
      let text = "";
      for (const block of data.content ?? []) {
        if (block.type === "text") text += block.text;
        // Preserve the provider's tool_use id so grounding can thread the result back natively.
        else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
      }
      const usage = data.usage
        ? { promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens }
        : undefined;
      return { toolCalls, text: text.trim(), usage, provider: "anthropic" };
    },
  };
}

/**
 * Our ChatMessage history → Anthropic message blocks. Assistant tool-call turns become
 * content blocks with tool_use ids; tool results become tool_result blocks keyed by that
 * id. This lets the model recognize the calls it actually made instead of seeing bare
 * "[result of X]" user text it has no record of requesting.
 */
function toAnthropicMessages(messages: ChatMessage[]) {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.toolCalls?.length) {
        const content: any[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls) content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
        out.push({ role: "assistant", content });
      } else {
        out.push({ role: "assistant", content: m.content });
      }
    } else if (m.role === "tool") {
      const block: any = { type: "tool_result", content: m.content };
      if (m.toolCallId) block.tool_use_id = m.toolCallId;
      // Anthropic tool_result blocks must ride on a user turn; coalesce consecutive ones.
      const prev = out[out.length - 1];
      if (m.toolCallId && prev && prev.role === "user" && Array.isArray(prev.content)) prev.content.push(block);
      else if (m.toolCallId) out.push({ role: "user", content: [block] });
      else out.push({ role: "user", content: `[result of ${m.toolName}]\n${m.content}` });
    }
  }
  // Anthropic requires the first message to be a user turn.
  if (out.length && out[0].role !== "user") out.unshift({ role: "user", content: "(continue)" });
  return out;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
