import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import type { Ticket, TicketStore } from "@page-assistant/core";

const MAX_TICKETS = 5000;

/**
 * JSON-file ticket store: feedback survives server restarts without needing a database.
 * Good default for small deployments; swap for a DB store at scale.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write can't leave a half-written
 * file. If the file IS somehow unparseable on load, we move it aside as `.corrupt` and
 * start fresh — instead of silently returning [] and then overwriting (wiping) all tickets
 * on the next save.
 */
export class JsonFileTicketStore implements TicketStore {
  constructor(private filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  private load(): Ticket[] {
    if (!existsSync(this.filePath)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return [];
    }
    if (!raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Corrupt store: preserve it for inspection rather than clobbering on next save.
      const aside = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        renameSync(this.filePath, aside);
        console.error(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            route: "ticket-store",
            msg: `ticket file unparseable; moved to ${aside}`,
          })
        );
      } catch {
        /* best effort */
      }
      return [];
    }
  }

  save(t: Ticket): void {
    const all = this.load();
    all.push({ ...t, createdAt: t.createdAt ?? new Date().toISOString() });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    // Write to a temp file then atomically rename over the target: a crash mid-write leaves
    // the old file intact rather than a truncated one.
    writeFileSync(tmp, JSON.stringify(all.slice(-MAX_TICKETS), null, 1));
    renameSync(tmp, this.filePath);
  }

  list(limit = 100): Ticket[] {
    return this.load().slice(-limit).reverse();
  }
}
