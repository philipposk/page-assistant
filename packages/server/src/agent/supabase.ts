// A PendingActionStore on Supabase, for serverless hosts (Vercel), where each instance has
// its own memory and a confirm click can land on an instance that never saw the card.
//
// Pass a SERVICE-ROLE supabase-js client created on the server (never one that reaches the
// browser): the table is server-only (packages/server/supabase/assistant_pending_actions.sql
// explains why users get no access to it). Every query filters on the user id, so one user's
// click can never run another user's card.
// No dependency on supabase-js: the client is typed by the few methods used here.

import type { PendingActionRecord, PendingActionStore } from "./pending.js";

export interface SupabaseLikeClient {
  from(table: string): any;
}

export interface SupabasePendingActionOptions {
  /** Default "assistant_pending_actions". */
  table?: string;
  /**
   * Keeps apps that share one table apart: a card made in one app can't be confirmed in
   * another. Required, so two apps can't both fall back to the same empty name.
   */
  app: string;
}

interface Row {
  token_hash: string;
  user_id: string;
  app: string;
  tool: string;
  args: Record<string, unknown>;
  title: string;
  details: string[];
  created_at: string;
  expires_at: string;
  tainted?: boolean | null;
}

const fromRow = (r: Row): PendingActionRecord => ({
  tokenHash: r.token_hash,
  userId: r.user_id,
  tool: r.tool,
  args: r.args ?? {},
  title: r.title,
  details: Array.isArray(r.details) ? r.details : [],
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  ...(r.tainted === true ? { tainted: true } : {}),
});

export function supabasePendingActionStore(client: SupabaseLikeClient, opts: SupabasePendingActionOptions): PendingActionStore {
  const table = opts?.table ?? "assistant_pending_actions";
  const app = typeof opts?.app === "string" ? opts.app.trim() : "";
  if (!app) throw new Error('supabasePendingActionStore: pass { app: "<your app name>" } so apps sharing the table stay apart.');
  const run = async <T>(q: PromiseLike<{ data: T; error: unknown }>): Promise<T> => {
    const { data, error } = await q;
    if (error) throw new Error(`pending actions: ${(error as { message?: string }).message ?? String(error)}`);
    return data;
  };
  return {
    async create(r) {
      await run(
        client.from(table).insert({
          token_hash: r.tokenHash,
          user_id: r.userId,
          app,
          tool: r.tool,
          args: r.args,
          title: r.title,
          details: r.details,
          created_at: r.createdAt,
          expires_at: r.expiresAt,
          tainted: r.tainted === true,
        })
      );
    },
    // DELETE ... RETURNING is atomic: of two concurrent clicks, one gets the row.
    async consume(tokenHash, userId, now) {
      const rows = await run<Row[] | null>(
        client.from(table).delete().eq("token_hash", tokenHash).eq("user_id", userId).eq("app", app).gt("expires_at", now.toISOString()).select()
      );
      return rows?.length ? fromRow(rows[0]) : null;
    },
    async withdraw(tokenHash, userId) {
      const rows = await run<Row[] | null>(client.from(table).delete().eq("token_hash", tokenHash).eq("user_id", userId).eq("app", app).select());
      return rows?.length ? fromRow(rows[0]) : null;
    },
  };
}
