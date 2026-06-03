import type { MemoryFact, MemoryStore } from "./types.js";

/**
 * Tiny keyword memory, ported in spirit from AI-OS / Daisy memory.py (SQLite keyword
 * recall) but dependency-free so it runs in the browser, in Node, or behind a real DB.
 * Swap this for a Supabase/sqlite-backed store in production; the interface is the contract.
 */
export class InMemoryStore implements MemoryStore {
  private facts: MemoryFact[] = [];
  private seq = 0;

  remember(fact: MemoryFact): void {
    this.facts.push({ ...fact, id: String(++this.seq), createdAt: new Date().toISOString() });
  }

  recall(query: string, limit = 5): MemoryFact[] {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    return this.facts
      .map((f) => ({ f, score: terms.reduce((s, t) => s + (`${f.topic} ${f.content}`.toLowerCase().includes(t) ? 1 : 0), 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.f);
  }
}
