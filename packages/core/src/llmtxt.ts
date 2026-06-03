import type { Capability } from "./types.js";

export interface LlmTxtMeta {
  appName: string;
  appUrl: string;
  description: string;
  /** URL other agents POST to to drive the assistant, e.g. https://app/.well-known/assistant */
  agentEndpoint: string;
}

/**
 * Generate an llm.txt describing the live assistant + every capability an external
 * agent may invoke. This is the machine-readable contract that lets OTHER agents
 * both understand the app and talk to the assistant living on it.
 */
export function generateLlmTxt(meta: LlmTxtMeta, caps: Capability[]): string {
  const exposed = caps.filter((c) => c.exposeToAgents !== false);
  const lines: string[] = [];
  lines.push(`# ${meta.appName}`);
  lines.push("");
  lines.push(`> ${meta.description}`);
  lines.push("");
  lines.push(`This app ships a grounded in-page assistant. Other agents can drive it.`);
  lines.push("");
  lines.push(`## Talk to the assistant`);
  lines.push("");
  lines.push(`POST ${meta.agentEndpoint}`);
  lines.push("Content-Type: application/json");
  lines.push(`Body: { "message": "<natural language request>", "page": { "url": "${meta.appUrl}", "path": "/" } }`);
  lines.push(`Returns: { "message": string, "invocations": [{ name, args, ok, result }] }`);
  lines.push("");
  lines.push(`The assistant only performs the capabilities below and never fabricates results.`);
  lines.push("");
  lines.push(`## Capabilities`);
  lines.push("");
  for (const c of exposed) {
    lines.push(`### ${c.name}`);
    lines.push(c.description);
    const props = c.parameters.properties ?? {};
    if (Object.keys(props).length) {
      lines.push("");
      lines.push("Parameters:");
      for (const [k, v] of Object.entries(props)) {
        const req = (c.parameters.required ?? []).includes(k) ? " (required)" : "";
        lines.push(`- \`${k}\`${req}: ${(v as any).type ?? "any"} — ${(v as any).description ?? ""}`);
      }
    }
    if (c.confirm) lines.push("\n_Requires user confirmation when invoked by the on-page user._");
    lines.push("");
  }
  return lines.join("\n");
}

/** Same data as a machine-first JSON manifest for /.well-known/llm-actions.json */
export function generateActionsJson(meta: LlmTxtMeta, caps: Capability[]) {
  return {
    schemaVersion: "1.0",
    app: { name: meta.appName, url: meta.appUrl, description: meta.description },
    agentEndpoint: meta.agentEndpoint,
    capabilities: caps
      .filter((c) => c.exposeToAgents !== false)
      .map((c) => ({ name: c.name, description: c.description, parameters: c.parameters, confirm: !!c.confirm })),
  };
}
