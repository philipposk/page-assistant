import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { Ticket, TicketStore } from "@page-assistant/core";

const MAX_TICKETS = 5000;

/**
 * JSON-file ticket store: feedback survives server restarts without needing a database.
 * Good default for small deployments; swap for a DB store at scale.
 */
export class JsonFileTicketStore implements TicketStore {
  constructor(private filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  private load(): Ticket[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      return [];
    }
  }

  save(t: Ticket): void {
    const all = this.load();
    all.push({ ...t, createdAt: t.createdAt ?? new Date().toISOString() });
    writeFileSync(this.filePath, JSON.stringify(all.slice(-MAX_TICKETS), null, 1));
  }

  list(limit = 100): Ticket[] {
    return this.load().slice(-limit).reverse();
  }
}
