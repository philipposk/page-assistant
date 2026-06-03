import type { LLMProvider, LLMCompletionInput, LLMCompletionOutput, ChatMessage } from "@page-assistant/core";

/** OpenAI / OpenRouter compatible Chat Completions provider with tool calling. */
export function openaiProvider(opts: { apiKey: string; model?: string; baseUrl?: string }): LLMProvider {
  const baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
  const model = opts.model ?? "gpt-4o-mini";
  return {
    name: baseUrl.includes("openrouter") ? "openrouter" : "openai",
    async complete(input: LLMCompletionInput): Promise<LLMCompletionOutput> {
      const tools = input.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: { type: "object", ...t.parameters } },
      }));
      const body: any = {
        model,
        temperature: input.temperature ?? 0.3,
        messages: [{ role: "system", content: input.system }, ...toOpenAIMessages(input.messages)],
        tools,
      };
      if (input.forceTool) body.tool_choice = { type: "function", function: { name: input.forceTool } };

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
      const data: any = await res.json();
      const msg = data.choices?.[0]?.message ?? {};
      const toolCalls = (msg.tool_calls ?? []).map((tc: any) => ({
        name: tc.function.name,
        args: safeParse(tc.function.arguments),
      }));
      return { toolCalls, text: (msg.content ?? "").trim() };
    },
  };
}

function toOpenAIMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "user", content: `[result of ${m.toolName}]\n${m.content}` };
    return { role: m.role, content: m.content };
  });
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
