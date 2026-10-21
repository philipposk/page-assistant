// Saved chats. The dock speaks the same ChatHistoryAdapter contract as the widget, so the
// widget's Supabase adapter (and its assistant_chats.sql table) work unchanged:
//
//   import { supabaseChatHistoryAdapter } from "@page-assistant/react";
//   <AgentDock history={supabaseChatHistoryAdapter(supabase, { app: "recall" })} ... />
//
// Without an adapter the dock keeps chats on this device (localStorage), under the signed-in
// user's `userId`. With no `userId` it keeps none: one shared slot would hand a chat to
// whoever signs in next on the same browser.

import type { AccountChat, AccountChatSummary, ChatHistoryAdapter } from "@page-assistant/widget";

export type { AccountChat, AccountChatSummary, ChatHistoryAdapter };
export { supabaseChatHistoryAdapter } from "@page-assistant/widget/supabase";
export type { SupabaseChatHistoryOptions, SupabaseClientLike } from "@page-assistant/widget/supabase";

const MAX_CHATS = 100;
const MAX_MESSAGES = 200;

/** Chats in this browser only. Nothing leaves the device. */
export function localChatHistory(opts: { key?: string; userId?: string | null } = {}): ChatHistoryAdapter {
  const key = `${opts.key ?? "pa_agent_chats"}${opts.userId ? `:${opts.userId}` : ""}`;
  const read = (): AccountChat[] => {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const write = (chats: AccountChat[]) => {
    try {
      if (typeof localStorage === "undefined") return;
      const kept = [...chats].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, MAX_CHATS);
      localStorage.setItem(key, JSON.stringify(kept));
    } catch {
      /* storage full or blocked: chats stay in memory for this visit */
    }
  };
  return {
    currentUserId: () => opts.userId ?? null,
    async list() {
      return read()
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map(({ messages: _m, ...rest }) => rest);
    },
    async get(id) {
      return read().find((c) => c.id === id) ?? null;
    },
    async save(chat) {
      const chats = read().filter((c) => c.id !== chat.id);
      chats.push({ ...chat, messages: chat.messages.slice(-MAX_MESSAGES) });
      write(chats);
    },
    async delete(id) {
      write(read().filter((c) => c.id !== id));
    },
    async deleteAll() {
      write([]);
    },
  };
}
