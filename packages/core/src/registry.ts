import type { Capability } from "./types.js";

/** Tool names every supported provider accepts (OpenAI and Anthropic share this rule). */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Keys whose values are data, not nested schemas, so the walk must not descend into them. */
const DATA_KEYS = new Set(["enum", "const", "default", "examples"]);

/**
 * Thrown when capabilities are registered with a schema the assistant cannot use.
 *
 * The whole tool list is sent on every chat turn, so one schema a provider rejects fails
 * every message, not just calls to that capability. Registration is the one place such a
 * mistake can be reported once, with the capability's name, instead of per turn.
 */
export class CapabilitySchemaError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid capability registration:\n- ${problems.join("\n- ")}`);
    this.name = "CapabilitySchemaError";
  }
}

/** Every problem with a set of capabilities, as readable lines. Empty when all are usable. */
export function capabilitySchemaProblems(caps: Capability[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  caps.forEach((cap, i) => {
    const name = typeof cap?.name === "string" ? cap.name : "";
    const label = name || `capabilities[${i}]`;
    if (!TOOL_NAME_RE.test(name)) {
      problems.push(`${label}: name must be 1-64 letters, digits, "_" or "-"; providers reject anything else.`);
    } else if (seen.has(name)) {
      problems.push(`${name}: registered twice; the second would silently replace the first.`);
    }
    seen.add(name);

    const params = cap?.parameters;
    if (!params || typeof params !== "object" || params.type !== "object") {
      problems.push(`${label}: parameters must be a JSON schema with "type": "object".`);
      return;
    }
    walkSchema(params, `${label}.parameters`, problems);
    const props = params.properties ?? {};
    for (const key of Array.isArray(params.required) ? params.required : []) {
      if (!(key in props)) {
        problems.push(`${label}: "${key}" is required but not declared in properties, so it would be stripped before run().`);
      }
    }
  });
  return problems;
}

function walkSchema(node: unknown, path: string, problems: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walkSchema(child, `${path}[${i}]`, problems));
    return;
  }
  if (!node || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;
  // A list-valued type ("type": ["number", "null"]) is valid JSON Schema, but not every
  // provider accepts it, and this SDK's own argument check compares a single type — so
  // every value for that argument would be refused. Optional arguments already accept null.
  if (Array.isArray(schema.type)) {
    problems.push(
      `${path}: "type" is a list (${JSON.stringify(schema.type)}). Declare one type; an optional argument already accepts null.`
    );
  }
  for (const [key, child] of Object.entries(schema)) {
    if (!DATA_KEYS.has(key)) walkSchema(child, `${path}.${key}`, problems);
  }
}

/**
 * Whether a capability is available right now (see `Capability.enabled`). A flag that
 * throws counts as off: a broken check must not advertise a feature that may not work.
 */
export function isCapabilityEnabled(cap: Capability): boolean {
  const enabled = cap.enabled;
  if (typeof enabled === "function") {
    try {
      return Boolean(enabled());
    } catch {
      return false;
    }
  }
  return enabled !== false;
}

/** Throw a CapabilitySchemaError listing every problem, or return quietly. */
export function validateCapabilities(caps: Capability[]): void {
  const problems = capabilitySchemaProblems(caps);
  if (problems.length) throw new CapabilitySchemaError(problems);
}
