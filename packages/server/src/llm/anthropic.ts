import { MODEL_DEFAULTS, type LLMProvider, type LLMCompletionInput, type LLMCompletionOutput, type ChatMessage } from "@page-assistant/core";
import { fetchWithRetry, llmTimeoutMs, maxTokens } from "./fetchWithRetry.js";
import { HttpProviderError } from "./errors.js";
import { acceptsEffort, acceptsForcedTool, acceptsSampling, thinksByDefault } from "./modelRules.js";

/** The smallest output cap for a model that thinks by default when the caller names none. */
const THINKING_MIN_MAX_TOKENS = 4096;

/** Anthropic Messages API provider with tool calling. */
export function anthropicProvider(opts: { apiKey: string; model?: string }): LLMProvider {
  // The alias, not a dated snapshot id. Lite stays on Haiku 4.5; Agent mode passes claude-haiku-5-5.
  const model = opts.model ?? MODEL_DEFAULTS.anthropic;
  return {
    name: "anthropic",
    async complete(input: LLMCompletionInput): Promise<LLMCompletionOutput> {
      const tools = (input.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: { type: "object", ...t.parameters },
      }));
      // A model that thinks by default spends max_tokens on thinking first, so Lite's 1024
      // can run out before any reply. With no cap named by the caller, give it room and ask
      // for little thinking; a caller that names maxTokens or effort keeps its own.
      const thinks = thinksByDefault(model);
      const unsetCap = input.maxTokens === undefined;
      const body: any = {
        model,
        max_tokens: input.maxTokens ?? (thinks ? Math.max(maxTokens(), THINKING_MIN_MAX_TOKENS) : maxTokens()),
        system: input.system,
        messages: toAnthropicMessages(input.messages),
        tools,
      };
      // Newer models answer a non-default temperature with a 400, so it is only sent where taken.
      if (acceptsSampling(model)) body.temperature = input.temperature ?? 0.3;
      // A model that refuses forced tool use gets `auto`; the caller's prompt names the tool.
      if (input.forceTool && acceptsForcedTool(model)) body.tool_choice = { type: "tool", name: input.forceTool };
      const effort = input.effort ?? (thinks && unsetCap ? "low" : undefined);
      if (effort && acceptsEffort(model)) body.output_config = { effort };
      if (input.promptCache) body.cache_control = { type: "ephemeral" };

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
        { timeoutMs: input.timeoutMs ?? llmTimeoutMs(), signal: input.signal }
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
      // With prompt caching on, `input_tokens` counts only what came after the cached prefix
      // (often tens), so the real prompt size adds the cache reads and writes back in.
      const u = data.usage;
      const cacheRead = Number(u?.cache_read_input_tokens) || 0;
      const cacheCreation = Number(u?.cache_creation_input_tokens) || 0;
      const usage = u
        ? {
            promptTokens: (Number(u.input_tokens) || 0) + cacheRead + cacheCreation,
            completionTokens: u.output_tokens,
            ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
            ...(cacheCreation ? { cacheCreationTokens: cacheCreation } : {}),
          }
        : undefined;
      return {
        toolCalls,
        text: text.trim(),
        usage,
        provider: "anthropic",
        model: typeof data.model === "string" ? data.model : model,
        stopReason: typeof data.stop_reason === "string" ? data.stop_reason : undefined,
        // The whole content (thinking blocks included) so a tool round can hand it back as is.
        assistantContent: Array.isArray(data.content) ? data.content : undefined,
      };
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
      // A model with thinking on needs its own blocks back, unchanged, with the tool results.
      if (m.providerContent?.provider === "anthropic" && Array.isArray(m.providerContent.content)) {
        out.push({ role: "assistant", content: m.providerContent.content });
      } else if (m.toolCalls?.length) {
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
