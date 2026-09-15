// Account-synced chat history: the contract a host implements, and the mirror that keeps a
// ChatHistoryStore and the host's backend in step.
//
// The widget never talks to a database. The host hands over an adapter that reads and writes
// the signed-in user's chats with that user's own credentials, so the host's access rules
// (for example row-level security) decide what anyone can see.

import type { ChatMessage } from "@page-assistant/core";
import type { ChatHistoryStore, ChatSession, ChatStoreChange } from "./chatHistory.js";

/** One saved chat, as the host's backend keeps it. */
export interface AccountChat {
  /** Made by the widget. Not a UUID for chats created before account history existed. */
  id: string;
  title: string;
  messages: ChatMessage[];
  pinned?: boolean;
  archived?: boolean;
  groupId?: string | null;
  model?: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. The last time the user did something with this chat. */
  updatedAt: string;
}

/** A chat in `list()`. `messages` may be left out to keep the list light; `get` then fills it in. */
export type AccountChatSummary = Omit<AccountChat, "messages"> & { messages?: ChatMessage[] };

/**
 * What a host implements for "account" mode. Every call acts as the signed-in user and only
 * ever sees that user's chats.
 */
export interface ChatHistoryAdapter {
  /**
   * The signed-in user's id, or null/undefined when nobody is signed in. While nobody is,
   * the widget falls back to its signed-out mode and says why in settings. Also keys the
   * user's saved choice of mode and their "device" chats, so two people sharing a browser
   * share neither. Without it the widget can't tell people apart: every device chat sits in
   * one signed-out slot and is never offered to anyone as their own.
   */
  currentUserId?(): string | null | undefined | Promise<string | null | undefined>;
  /** Every saved chat, newest first. Rows may leave out `messages`. */
  list(): Promise<AccountChatSummary[]>;
  /** One chat with its messages, or null if it no longer exists. */
  get(id: string): Promise<AccountChat | null>;
  /** Create or replace one chat. */
  save(chat: AccountChat): Promise<void>;
  /** Optional bulk form of `save`, used when moving this device's chats in one go. */
  saveMany?(chats: AccountChat[]): Promise<void>;
  delete(id: string): Promise<void>;
  /** Delete every chat this user has saved (in this app). */
  deleteAll(): Promise<void>;
  /** How long saved chats last without activity. Shown to the user when set. */
  retentionMonths?: number;
}

export function toAccountChat(s: ChatSession): AccountChat {
  return {
    id: s.id,
    title: s.title,
    messages: [...s.messages],
    pinned: !!s.pinned,
    archived: !!s.archived,
    groupId: s.groupId ?? null,
    model: s.model ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function fromAccountChat(c: AccountChatSummary): ChatSession {
  const now = new Date().toISOString();
  return {
    id: String(c.id),
    title: typeof c.title === "string" && c.title.trim() ? c.title : "New chat",
    messages: Array.isArray(c.messages) ? c.messages : [],
    createdAt: c.createdAt || c.updatedAt || now,
    updatedAt: c.updatedAt || c.createdAt || now,
    pinned: c.pinned ? true : undefined,
    archived: c.archived ? true : undefined,
    groupId: c.groupId ?? undefined,
    model: c.model ?? undefined,
  };
}

export type AccountSyncStatus = "idle" | "saving" | "error";

export interface AccountHistorySyncOptions {
  /** Wait this long after a change before sending, so a burst becomes one write. Default 800. */
  debounceMs?: number;
  /** Automatic retries after a failed send. Default [2000, 10000, 30000]; then the next change retries. */
  retryDelaysMs?: number[];
  /** Resolves false once the signed-in user is not the one this mirror started for. */
  sameUser?: () => Promise<boolean>;
  /** Called when `sameUser` said no. Pending writes have been dropped by then. */
  onUserChanged?: () => void;
  onStatus?: (status: AccountSyncStatus, error?: unknown) => void;
}

/**
 * Mirrors one ChatHistoryStore into a ChatHistoryAdapter.
 *
 * Writes are queued per chat and sent after a short pause. A chat is never saved with no
 * messages (every page load starts an empty one), and a chat whose messages were left out of
 * `list()` is fetched before it is saved, so a rename cannot blank the saved copy.
 */
export class AccountHistorySync {
  private dirty = new Set<string>();
  private deleted = new Set<string>();
  private partial = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private attempts = 0;
  private active = false;
  private unsubscribe?: () => void;

  constructor(
    private store: ChatHistoryStore,
    private adapter: ChatHistoryAdapter,
    private opts: AccountHistorySyncOptions = {}
  ) {}

  /** The account's chats as sessions. Remembers which arrived without their messages. */
  async fetch(): Promise<ChatSession[]> {
    const rows = await this.adapter.list();
    const sessions: ChatSession[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || (typeof row.id !== "string" && typeof row.id !== "number")) continue;
      const s = fromAccountChat(row);
      if (Array.isArray(row.messages)) this.partial.delete(s.id);
      else this.partial.add(s.id);
      sessions.push(s);
    }
    return sessions;
  }

  /** Start sending the store's changes. */
  start() {
    if (this.active) return;
    this.active = true;
    this.unsubscribe = this.store.onChange((c) => this.onChange(c));
  }

  /** Queue chats for saving that changed before `start()` (created while the list was loading). */
  markDirty(ids: string[]) {
    if (!this.active || !ids.length) return;
    for (const id of ids) this.dirty.add(id);
    this.schedule(this.opts.debounceMs ?? 800);
  }

  /** True when this chat's messages have not been fetched yet. */
  needsLoad(id: string): boolean {
    return this.partial.has(id);
  }

  /** Fetch one chat's messages into the store. "gone" when the account no longer has it. */
  async load(id: string): Promise<"loaded" | "gone"> {
    const full = await this.adapter.get(id);
    this.partial.delete(id);
    if (!full) {
      this.store.forget([id]);
      return "gone";
    }
    this.store.hydrate(id, Array.isArray(full.messages) ? full.messages : []);
    return "loaded";
  }

  /** Save these chats now. Returns the ids that were saved. */
  async saveChats(sessions: ChatSession[]): Promise<string[]> {
    const chats = sessions.map(toAccountChat);
    if (!chats.length) return [];
    if (this.adapter.saveMany) {
      try {
        await this.adapter.saveMany(chats);
        return chats.map((c) => c.id);
      } catch {
        /* fall back to one at a time, so one bad chat does not block the rest */
      }
    }
    const saved: string[] = [];
    for (const chat of chats) {
      try {
        await this.adapter.save(chat);
        saved.push(chat.id);
      } catch {
        /* reported by the caller as "not moved"; nothing retries it automatically */
      }
    }
    return saved;
  }

  get pending(): boolean {
    return this.dirty.size + this.deleted.size > 0;
  }

  /** Send everything waiting now. Resolves when the queue is empty or a send failed. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.running) await this.running;
    if (!this.active || !this.pending) return;
    this.running = this.send().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Forget unsent writes and wait for one in flight to finish. */
  async settle() {
    this.dropPending();
    while (this.running) await this.running;
  }

  /**
   * Stop mirroring. `flush: true` sends what is waiting first — a deliberate switch by the
   * same user. `false` drops it: after a sign-out or a change of user it would be written
   * as the wrong person.
   */
  async stop(opts: { flush: boolean }) {
    if (opts.flush) await this.flush();
    this.active = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.settle();
  }

  private dropPending() {
    this.dirty.clear();
    this.deleted.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private onChange(c: ChatStoreChange) {
    if (!this.active) return;
    if (c.kind === "upsert") {
      this.dirty.add(c.id);
      this.deleted.delete(c.id);
    } else if (c.kind === "delete") {
      this.dirty.delete(c.id);
      this.partial.delete(c.id);
      this.deleted.add(c.id);
    } else if (c.kind === "import") {
      for (const id of c.ids) {
        this.dirty.add(id);
        this.deleted.delete(id);
        this.partial.delete(id);
      }
    } else {
      return; // "replace": loaded from somewhere else, nothing to send
    }
    this.attempts = 0;
    this.schedule(this.opts.debounceMs ?? 800);
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, ms);
  }

  private async send() {
    this.opts.onStatus?.("saving");
    let failed: unknown;
    let hasFailure = false;
    try {
      if (this.opts.sameUser && !(await this.opts.sameUser())) {
        this.dropPending();
        this.opts.onUserChanged?.();
        return;
      }
    } catch (e) {
      failed = e;
      hasFailure = true;
    }
    if (!hasFailure) {
      for (const id of [...this.deleted]) {
        if (!this.active) return;
        this.deleted.delete(id);
        try {
          await this.adapter.delete(id);
        } catch (e) {
          this.deleted.add(id);
          if (!hasFailure) failed = e;
          hasFailure = true;
        }
      }
      for (const id of [...this.dirty]) {
        if (!this.active) return;
        this.dirty.delete(id);
        try {
          if (this.partial.has(id) && (await this.load(id)) === "gone") continue;
          const s = this.store.get(id);
          if (!s || !s.messages.length) continue;
          await this.adapter.save(toAccountChat(s));
        } catch (e) {
          this.dirty.add(id);
          if (!hasFailure) failed = e;
          hasFailure = true;
        }
      }
    }
    if (hasFailure) {
      this.opts.onStatus?.("error", failed);
      const delay = (this.opts.retryDelaysMs ?? [2000, 10000, 30000])[this.attempts++];
      if (delay !== undefined && this.active) this.schedule(delay);
      return;
    }
    this.attempts = 0;
    // Changes made while this pass ran have their own timer.
    this.opts.onStatus?.(this.pending ? "saving" : "idle");
  }
}
