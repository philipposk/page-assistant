// What the server will actually honour for `model`.
//
// The picker used to be a hardcoded list shown unconditionally. On a deployment that pins
// the model server-side — which an unauthenticated proxy has to do, or a visitor could
// upgrade themselves onto a costlier model — choosing from it changed nothing at all.

import { DEFAULT_MODELS } from "./assistant-settings.js";

export interface ModelChoice {
  id: string;
  label: string;
  provider?: string;
}

export interface ModelCatalog {
  /** Models this server can actually serve (it has the provider key). */
  models: ModelChoice[];
  /** True when the server ignores the client's `model` and uses its own. */
  fixed: boolean;
  /** Optional server-supplied explanation, shown in place of the picker. */
  reason?: string;
}

/**
 * Ask `GET {serverUrl}/v1/models`.
 *
 * A server that does not answer (404, network, bad JSON, no serverUrl) is taken to fix the
 * model: most hosts proxy through their own route, which ignores the client's `model`, so a
 * picker there changed nothing. Only a server that lists models gets one; an older server
 * that returns just `{models}` still does. A server that says `fixed` wins.
 */
export async function fetchModelCatalog(
  serverUrl: string | undefined,
  signal?: AbortSignal,
  authToken?: string
): Promise<ModelCatalog> {
  const fallback: ModelCatalog = { models: [...DEFAULT_MODELS], fixed: true };
  if (!serverUrl || typeof fetch === "undefined") return fallback;
  const base = serverUrl.replace(/\/$/, "");
  try {
    const headers: Record<string, string> = {};
    if (authToken) headers.authorization = `Bearer ${authToken}`;
    const res = await fetch(`${base}/v1/models`, { signal, headers });
    if (!res.ok) return fallback;
    const raw = (await res.json()) as { models?: unknown; fixed?: unknown; reason?: unknown };
    const models = Array.isArray(raw?.models)
      ? raw.models
          .filter((m): m is ModelChoice => !!m && typeof (m as ModelChoice).id === "string")
          .map((m) => ({ id: m.id, label: typeof m.label === "string" && m.label ? m.label : m.id, provider: m.provider }))
      : [];
    const reason = typeof raw?.reason === "string" && raw.reason.trim() ? raw.reason : undefined;
    // An answer without a single model offers no choice either, unless it says otherwise.
    if (!models.length && raw?.fixed !== false) return { ...fallback, reason };
    return { models: models.length ? models : fallback.models, fixed: raw?.fixed === true, reason };
  } catch {
    return fallback;
  }
}
