// Confirm cards: single-use tokens for actions that wait on the user's OK.
//
// A model tool call is not consent: a pasted or injected message can steer the model. So a
// `confirm`-tier tool never runs from a tool call. The call stores a pending action and the
// reply carries a card; the action runs only when the client sends the card's token back,
// and that path never involves the model. The confirmed run happens as the confirming
// request's user, so the tool's own permission checks run again.
//
// Tokens are random (32 bytes) and stored only as a SHA-256 hash. Each works once, only for
// the user (and app) it was issued to, and expires after the TTL. Uses Web Crypto, so the
// same code runs on Node 20+, Vercel and edge runtimes.

export interface PendingActionRecord {
  tokenHash: string;
  userId: string;
  tool: string;
  /** Exactly what the confirmed run gets back: checked, normalised values. */
  args: Record<string, unknown>;
  title: string;
  details: string[];
  createdAt: string;
  expiresAt: string;
}

/**
 * Where pending actions wait. `consume` and `withdraw` must be atomic (delete-and-return),
 * so a token can never run twice — two concurrent clicks get one action between them.
 */
export interface PendingActionStore {
  create(record: PendingActionRecord): Promise<void>;
  /** The record, deleted, when the hash matches this user and it has not expired; else null. */
  consume(tokenHash: string, userId: string, now: Date): Promise<PendingActionRecord | null>;
  /** Delete a record whose card the client can't show (no expiry check). */
  withdraw(tokenHash: string, userId: string): Promise<PendingActionRecord | null>;
}

export const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * In-process store. Fine for one long-running server; on serverless (Vercel) each instance
 * has its own memory, so a click can land on an instance that never saw the card — use
 * `supabasePendingActionStore` (or your own shared store) there.
 */
export class MemoryPendingActionStore implements PendingActionStore {
  private rows = new Map<string, PendingActionRecord>();
  constructor(private maxRows = 10_000) {}

  async create(record: PendingActionRecord): Promise<void> {
    this.sweep(new Date());
    while (this.rows.size >= this.maxRows) {
      const oldest = this.rows.keys().next().value;
      if (oldest === undefined) break;
      this.rows.delete(oldest);
    }
    this.rows.set(record.tokenHash, { ...record, args: { ...record.args }, details: [...record.details] });
  }

  async consume(tokenHash: string, userId: string, now: Date): Promise<PendingActionRecord | null> {
    const row = this.rows.get(tokenHash);
    if (!row || row.userId !== userId) return null;
    this.rows.delete(tokenHash);
    return Date.parse(row.expiresAt) > now.getTime() ? row : null;
  }

  async withdraw(tokenHash: string, userId: string): Promise<PendingActionRecord | null> {
    const row = this.rows.get(tokenHash);
    if (!row || row.userId !== userId) return null;
    this.rows.delete(tokenHash);
    return row;
  }

  /** For tests and metrics. */
  get size(): number {
    return this.rows.size;
  }

  private sweep(now: Date) {
    for (const [k, row] of this.rows) if (Date.parse(row.expiresAt) <= now.getTime()) this.rows.delete(k);
  }
}

type WebCrypto = typeof globalThis.crypto;

function webCrypto(): WebCrypto {
  const c = (globalThis as { crypto?: WebCrypto }).crypto;
  if (!c?.getRandomValues || !c.subtle) throw new Error("Web Crypto is not available (needs Node 20+ or an edge runtime).");
  return c;
}

/** A fresh token: 32 random bytes, base64url. */
export function newToken(): string {
  const bytes = webCrypto().getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Shaped like a token newToken() makes (base64url of 32 bytes). Says nothing about whether it is live. */
export function isTokenShaped(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** SHA-256 hex of a token: the only form a store ever sees. */
export async function hashToken(token: string): Promise<string> {
  const digest = await webCrypto().subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
