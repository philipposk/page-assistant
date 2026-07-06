import type { LLMProvider, LLMCompletionInput, LLMCompletionOutput, ChatMessage } from "@page-assistant/core";
import { fetchWithRetry, llmTimeoutMs, maxTokens } from "./fetchWithRetry.js";
import { HttpProviderError } from "./errors.js";

/** OpenAI / OpenRouter compatible Chat Completions provider with tool calling. */
export function openaiProvider(opts: { apiKey: string; model?: string; baseUrl?: string }): LLMProvider {
  const baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
  const model = opts.model ?? "gpt-4o-mini";
  const providerName = baseUrl.includes("openrouter") ? "openrouter" : "openai";
  return {
    name: providerName,
    async complete(input: LLMCompletionInput): Promise<LLMCompletionOutput> {
      const tools = input.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: { type: "object", ...t.parameters } },
      }));
      const body: any = {
        model,
        // Cap output tokens: gpt-4o will otherwise happily emit up to 16k and bill for it.
        max_tokens: maxTokens(),
        temperature: input.temperature ?? 0.3,
        messages: [{ role: "system", content: input.system }, ...toOpenAIMessages(input.messages)],
        tools,
      };
      if (input.forceTool) body.tool_choice = { type: "function", function: { name: input.forceTool } };

      const res = await fetchWithRetry(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify(body),
        },
        { timeoutMs: llmTimeoutMs() }
      );
      if (!res.ok) throw new HttpProviderError(providerName, res.status, await safeText(res));
      const data: any = await res.json();
      const msg = data.choices?.[0]?.message ?? {};
      const toolCalls = (msg.tool_calls ?? []).map((tc: any) => ({
        id: tc.id, // preserve so results can be threaded back as role:"tool" with tool_call_id
        name: tc.function.name,
        args: safeParse(tc.function.arguments),
      }));
      const usage = data.usage
        ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
        : undefined;
      return { toolCalls, text: (msg.content ?? "").trim(), usage, provider: providerName };
    },
  };
}

/**
 * Our ChatMessage history → OpenAI chat messages. Assistant tool-call turns become an
 * assistant message with a `tool_calls` array; tool results become role:"tool" messages
 * keyed by tool_call_id. This makes the model see a proper call→result pairing instead of
 * plain-text "[result of X]" that it never asked for.
 */
function toOpenAIMessages(messages: ChatMessage[]) {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        })),
      });
    } else if (m.role === "tool") {
      if (m.toolCallId) out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
      else out.push({ role: "user", content: `[result of ${m.toolName}]\n${m.content}` });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
