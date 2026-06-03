import type { Capability } from "@page-assistant/core";

/** Identity helper that gives hosts type-checking + inference when declaring a capability. */
export function capability<A, R>(c: Capability<A, R>): Capability<A, R> {
  return c;
}
