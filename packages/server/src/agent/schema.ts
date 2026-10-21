// A deeper argument check than core's validateArgs (which looks at required keys and
// top-level types only): enums, integers, nested objects and array items, recursively.
// Used on model-supplied tool arguments, on stored confirm-card arguments before they run,
// and on custom UI actions.

import type { JSONSchema } from "@page-assistant/core";

const MAX_DEPTH = 8;

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

/** A readable problem for the model ("argument "status" must be one of: open, done"), or null. */
export function schemaProblem(value: unknown, schema: JSONSchema | undefined, path = "", depth = 0): string | null {
  if (!schema || typeof schema !== "object" || depth > MAX_DEPTH) return null;
  const name = path || "value";
  if (value === undefined || value === null) return null; // absence is `required`'s business
  if (Array.isArray(schema.enum) && schema.enum.length && !schema.enum.some((e) => e === value)) {
    return `argument "${name}" must be one of: ${schema.enum.slice(0, 20).map(String).join(", ")}.`;
  }
  const want = typeof schema.type === "string" ? schema.type : undefined;
  const got = typeOf(value);
  if (want === "integer") {
    if (!(typeof value === "number" && Number.isInteger(value))) return `argument "${name}" must be a whole number.`;
  } else if (want === "number") {
    if (got !== "number" || !Number.isFinite(value as number)) return `argument "${name}" must be a number.`;
  } else if (want && want !== got) {
    return `argument "${name}" must be a ${want} (got ${got}).`;
  }
  if (got === "array" && schema.items) {
    const items = value as unknown[];
    for (let i = 0; i < Math.min(items.length, 1000); i++) {
      const p = schemaProblem(items[i], schema.items, `${name}[${i}]`, depth + 1);
      if (p) return p;
    }
  }
  if (got === "object" && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (obj[key] === undefined || obj[key] === null || obj[key] === "") return `argument "${name}.${key}" is required.`;
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      const p = schemaProblem(obj[key], sub, path ? `${path}.${key}` : key, depth + 1);
      if (p) return p;
    }
  }
  return null;
}
