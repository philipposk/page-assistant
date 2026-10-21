// Every model id the packages name: the defaults each provider and mode falls back to, and the
// list a model picker offers. One place on purpose. Providers retire models (OpenRouter's
// "anthropic/claude-3.5-haiku" went while it was still a default here), so:
//   - no other source file may spell a model id (a test fails if one does);
//   - scripts/models/check.mjs checks every id here against the providers' live model lists,
//     weekly in CI (.github/workflows/models.yml), and opens an issue when one is gone or
//     about to go.
// Ids are exact and carry no date suffix (`claude-haiku-4-5`, never `claude-haiku-4-5-20251001`).

export type ModelProvider = "anthropic" | "openai" | "openrouter";

/** The model each provider or mode uses when nothing else names one. */
export const MODEL_DEFAULTS = {
  /** Lite's Anthropic default (env PA_ANTHROPIC_MODEL). No thinking by default: fits a 1,024-token cap. */
  anthropic: "claude-haiku-4-5",
  /** Lite's OpenAI default (env PA_OPENAI_MODEL). */
  openai: "gpt-4o-mini",
  /** Lite's OpenRouter default (env PA_OPENROUTER_MODEL). */
  openrouter: "anthropic/claude-haiku-4.5",
  /** Agent mode's model (env PA_AGENT_MODEL). */
  agent: "claude-haiku-5-5",
  /** Agent mode's fallback when the provider refuses `agent` (env PA_AGENT_FALLBACK_MODEL). */
  agentFallback: "claude-haiku-4-5",
  /** OpenAI text-to-speech. */
  openaiTts: "gpt-4o-mini-tts",
} as const;

export interface CatalogModel {
  id: string;
  label: string;
  provider: ModelProvider;
}

/** What a model picker may offer (widget settings, GET /v1/models), most capable first. */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (most capable)", provider: "anthropic" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (balanced)", provider: "anthropic" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fast)", provider: "anthropic" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (fastest)", provider: "anthropic" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 (deep reasoning)", provider: "anthropic" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini (fast)", provider: "openai" },
  { id: "gpt-4o", label: "GPT-4o", provider: "openai" },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5 (OpenRouter)", provider: "openrouter" },
];

/** Every id above with its provider and kind, for the live check. */
export function modelsInUse(): Array<{ id: string; provider: ModelProvider; kind: "chat" | "tts"; where: string }> {
  const out: Array<{ id: string; provider: ModelProvider; kind: "chat" | "tts"; where: string }> = [
    { id: MODEL_DEFAULTS.anthropic, provider: "anthropic", kind: "chat", where: "MODEL_DEFAULTS.anthropic" },
    { id: MODEL_DEFAULTS.openai, provider: "openai", kind: "chat", where: "MODEL_DEFAULTS.openai" },
    { id: MODEL_DEFAULTS.openrouter, provider: "openrouter", kind: "chat", where: "MODEL_DEFAULTS.openrouter" },
    { id: MODEL_DEFAULTS.agent, provider: "anthropic", kind: "chat", where: "MODEL_DEFAULTS.agent" },
    { id: MODEL_DEFAULTS.agentFallback, provider: "anthropic", kind: "chat", where: "MODEL_DEFAULTS.agentFallback" },
    { id: MODEL_DEFAULTS.openaiTts, provider: "openai", kind: "tts", where: "MODEL_DEFAULTS.openaiTts" },
  ];
  for (const m of MODEL_CATALOG) out.push({ id: m.id, provider: m.provider, kind: "chat", where: "MODEL_CATALOG" });
  return out;
}
