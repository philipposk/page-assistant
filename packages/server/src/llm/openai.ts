import { MODEL_DEFAULTS, type LLMProvider, type LLMCompletionInput, type LLMCompletionOutput, type ChatMessage } from "@page-assistant/core";
import { defaultMaxTokens, fetchWithRetry, llmTimeoutMs } from "./fetchWithRetry.js";
import { HttpProviderError } from "./errors.js";
import { acceptsForcedTool, acceptsSampling, claudeIdFromOpenRouter, isOpenAIReasoningModel, thinksByDefault } from "./modelRules.js";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** The smallest output cap for a model that reasons by default when the caller names none. */
const THINKING_MIN_MAX_TOKENS = 4096;

/**
 * OpenAI / OpenRouter compatible Chat Completions provider with tool calling. What each
 * model accepts differs, and a field it rejects fails the call with a 400, so the body is
 * built per model: OpenAI's reasoning models get no `temperature` and a cap with room to
 * reason; a Claude model on OpenRouter follows the same rules as on Anthropic (modelRules).
 */
export function openaiProvider(opts: { apiKey: string; model?: string; baseUrl?: string }): LLMProvider {
  const baseUrl = opts.baseUrl ?? OPENAI_BASE_URL;
  const providerName = baseUrl.includes("openrouter") ? "openrouter" : "openai";
  const model = opts.model ?? (providerName === "openrouter" ? MODEL_DEFAULTS.openrouter : MODEL_DEFAULTS.openai);
  const isOpenAI = baseUrl === OPENAI_BASE_URL;
  const claude = providerName === "openrouter" ? claudeIdFromOpenRouter(model) : null;
  const reasons = isOpenAIReasoningModel(model);
  const thinks = reasons || (claude !== null && thinksByDefault(claude));
  return {
    name: providerName,
    async complete(input: LLMCompletionInput): Promise<LLMCompletionOutput> {
      const tools = (input.tools ?? []).map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: { type: "object", ...t.parameters } },
      }));
      // Cap output tokens: gpt-4o will otherwise happily emit up to 16k and bill for it. A
      // model that reasons first spends the cap on that too, so with no cap named it gets room
      // and is asked to reason little; a caller that names maxTokens or effort keeps its own.
      const unsetCap = input.maxTokens === undefined;
      const cap = input.maxTokens ?? defaultMaxTokens(thinks, THINKING_MIN_MAX_TOKENS);
      const effort = input.effort ?? (thinks && unsetCap ? "low" : undefined);
      const body: any = {
        model,
        messages: [{ role: "system", content: input.system }, ...toOpenAIMessages(input.messages)],
      };
      // OpenAI itself takes max_completion_tokens on every current model (reasoning models
      // refuse max_tokens); OpenRouter and other compatible backends know max_tokens.
      if (isOpenAI) body.max_completion_tokens = cap;
      else body.max_tokens = cap;
      if (!reasons && (claude === null || acceptsSampling(claude))) body.temperature = input.temperature ?? 0.3;
      if (effort && thinks) {
        if (providerName === "openrouter") body.reasoning = { effort };
        else body.reasoning_effort = effort;
      }
      // Omit `tools` entirely when empty: some OpenAI-compatible backends reject `tools: []`.
      if (tools.length) body.tools = tools;
      // A Claude model that refuses forced tool use gets `auto`; the caller's prompt names the tool.
      if (input.forceTool && (claude === null || acceptsForcedTool(claude))) {
        body.tool_choice = { type: "function", function: { name: input.forceTool } };
      }

      const res = await fetchWithRetry(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify(body),
        },
        { timeoutMs: input.timeoutMs ?? llmTimeoutMs(), signal: input.signal }
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
      const finish = data.choices?.[0]?.finish_reason;
      return {
        toolCalls,
        text: (msg.content ?? "").trim(),
        usage,
        provider: providerName,
        model: typeof data.model === "string" ? data.model : model,
        stopReason: typeof finish === "string" ? finish : undefined,
      };
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
