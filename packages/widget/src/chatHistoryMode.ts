// Where chat history is kept — "account", "device" or "off" — and the switch between them.
//
// The host picks the default and may supply an adapter for "account". The user can change
// the mode in settings; that choice is remembered in this browser, per signed-in user.

import { ChatHistoryStore, CHAT_HISTORY_STORAGE_KEY, type ChatSession } from "./chatHistory.js";
import { AccountHistorySync, type AccountSyncStatus, type ChatHistoryAdapter } from "./chatHistoryAccount.js";

/**
 * - `account`: saved to the user's account through the host's adapter; follows them across devices.
 * - `device`: saved in this browser only (localStorage). What every earlier version did.
 * - `off`: kept in memory for this page only; nothing is saved.
 */
export type ChatHistoryMode = "account" | "device" | "off";

export const CHAT_HISTORY_MODES: readonly ChatHistoryMode[] = ["account", "device", "off"];
export const CHAT_HISTORY_MODE_STORAGE_KEY = "page_assistant_history_mode";

/** Why "account" cannot be used right now. */
export type AccountUnavailableReason = "no-adapter" | "signed-out";

export function isChatHistoryMode(v: unknown): v is ChatHistoryMode {
  return v === "account" || v === "device" || v === "off";
}

export interface ResolveChatHistoryModeInput {
  /** What the user chose, or the host default when they have not. */
  chosen: ChatHistoryMode;
  /** `disableChatHistory`: always "off". */
  locked?: boolean;
  hasAdapter: boolean;
  /** `undefined` while not known yet; treated as signed in until told otherwise. */
  signedIn?: boolean;
  /** Used instead of "account" when account is not possible. Default "device". */
  fallback?: "device" | "off";
}

/** The mode actually in effect, and why "account" is unavailable if it is. */
export function resolveChatHistoryMode(i: ResolveChatHistoryModeInput): {
  mode: ChatHistoryMode;
  unavailable?: AccountUnavailableReason;
} {
  if (i.locked) return { mode: "off" };
  const unavailable: AccountUnavailableReason | undefined = !i.hasAdapter
    ? "no-adapter"
    : i.signedIn === false
      ? "signed-out"
      : undefined;
  const chosen = isChatHistoryMode(i.chosen) ? i.chosen : "device";
  if (chosen !== "account") return { mode: chosen, unavailable };
  if (!unavailable) return { mode: "account" };
  return { mode: i.fallback === "off" ? "off" : "device", unavailable };
}

// --- The user's choice, remembered per user in this browser -----------------------------

interface StoredModes {
  v: 1;
  /** Who was signed in last time: a hint so the first render already uses their choice. null = nobody. */
  last?: string | null;
  modes: Record<string, ChatHistoryMode>;
}

const slot = (userId: string | null) => (userId === null ? "anon" : `user:${userId}`);

function readPrefs(key: string): StoredModes {
  if (typeof localStorage === "undefined") return { v: 1, modes: {} };
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    if (parsed && parsed.v === 1 && parsed.modes && typeof parsed.modes === "object") return parsed as StoredModes;
  } catch {
    /* unreadable: start over */
  }
  return { v: 1, modes: {} };
}

function writePrefs(key: string, prefs: StoredModes) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}

/** The mode this user picked in this browser, if they picked one. `null` = signed out. */
export function getStoredChatHistoryMode(
  userId: string | null,
  key = CHAT_HISTORY_MODE_STORAGE_KEY
): ChatHistoryMode | undefined {
  const m = readPrefs(key).modes[slot(userId)];
  return isChatHistoryMode(m) ? m : undefined;
}

export function setStoredChatHistoryMode(
  mode: ChatHistoryMode,
  userId: string | null,
  key = CHAT_HISTORY_MODE_STORAGE_KEY
) {
  const prefs = readPrefs(key);
  prefs.modes[slot(userId)] = mode;
  writePrefs(key, prefs);
}

// --- The manager ---------------------------------------------------------------------------

export interface ChatHistoryState {
  /** In effect now. */
  mode: ChatHistoryMode;
  /** What the user chose, or the host default. Differs from `mode` while account is unavailable. */
  chosen: ChatHistoryMode;
  /** The host turned history off (`disableChatHistory`); there is nothing to choose. */
  locked: boolean;
  accountUnavailable?: AccountUnavailableReason;
  status: "idle" | "loading" | "saving" | "error";
  /** What failed, while `status` is "error". */
  error?: "load" | "save";
  /** Chats with messages saved in this browser. */
  deviceChatCount: number;
  /** An adapter exists and someone is signed in, so their saved chats can be deleted. */
  canDeleteAccountChats: boolean;
  retentionMonths?: number;
}

/** What the settings panel drives. */
export interface ChatHistoryControls {
  getState(): ChatHistoryState;
  subscribe(listener: () => void): () => void;
  /** Re-check who is signed in and apply the mode that follows. */
  refresh(): Promise<void>;
  /** Choose a mode. `moveDeviceChats` also moves this browser's chats into the account. */
  setMode(mode: ChatHistoryMode, opts?: { moveDeviceChats?: boolean }): Promise<void>;
  /** In account mode: save this browser's chats to the account, then remove them from the browser. */
  moveDeviceChats(): Promise<{ moved: number; failed: number }>;
  /** Delete every chat: in this browser, in memory, and in the account when one is reachable. */
  deleteAll(): Promise<{ ok: boolean }>;
  /** Retry a failed load or save. */
  retry(): Promise<void>;
}

export interface ChatHistoryManagerOptions {
  storageKey?: string;
  modeStorageKey?: string;
  /** Mode until the user picks one. Default "device". */
  defaultMode?: ChatHistoryMode;
  /** Used when "account" is chosen but cannot be used. Default "device". */
  fallbackMode?: "device" | "off";
  /** `disableChatHistory`: always "off", nothing to choose. */
  disabled?: boolean;
  adapter?: ChatHistoryAdapter;
  debounceMs?: number;
  retryDelaysMs?: number[];
  onError?: (error: unknown) => void;
}

/**
 * Owns the chat store and moves it between modes. The UI keeps reading the same store
 * object; only where it keeps chats changes. Call `start()` once after construction.
 */
export class ChatHistoryManager implements ChatHistoryControls {
  readonly store: ChatHistoryStore;
  private storageKey: string;
  private modeKey: string;
  private defaultMode: ChatHistoryMode;
  private fallback: "device" | "off";
  private locked: boolean;
  private adapter?: ChatHistoryAdapter;
  private mode: ChatHistoryMode;
  private unavailable?: AccountUnavailableReason;
  /** `undefined` until checked; `null` = nobody signed in (or no adapter). */
  private userId: string | null | undefined;
  private hintUserId: string | null | undefined;
  private sync?: AccountHistorySync;
  private status: ChatHistoryState["status"] = "idle";
  private error?: ChatHistoryState["error"];
  private listeners = new Set<() => void>();
  private replacedListeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private onPageHide?: () => void;

  constructor(private opts: ChatHistoryManagerOptions = {}) {
    this.storageKey = opts.storageKey ?? CHAT_HISTORY_STORAGE_KEY;
    this.modeKey = opts.modeStorageKey ?? CHAT_HISTORY_MODE_STORAGE_KEY;
    this.defaultMode = isChatHistoryMode(opts.defaultMode) ? opts.defaultMode : "device";
    this.fallback = opts.fallbackMode === "off" ? "off" : "device";
    this.locked = !!opts.disabled;
    this.adapter = opts.adapter;

    // First guess, so the first render is usually already right: whoever was signed in
    // last time is usually who is here now. `start()` checks.
    if (!this.adapter) {
      this.userId = null;
    } else {
      const last = readPrefs(this.modeKey).last;
      this.hintUserId = last === undefined ? undefined : last;
    }
    const r = resolveChatHistoryMode({
      chosen: this.chosen(),
      locked: this.locked,
      hasAdapter: !!this.adapter,
      signedIn: this.adapter ? (this.hintUserId === null ? false : undefined) : false,
      fallback: this.fallback,
    });
    this.mode = r.mode;
    this.unavailable = r.unavailable;
    // Only "device" touches localStorage. Account mode loads into memory.
    this.store = new ChatHistoryStore(this.storageKey, { persist: this.mode === "device" });

    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      this.onPageHide = () => void this.sync?.flush();
      window.addEventListener("pagehide", this.onPageHide);
    }
  }

  /** Check who is signed in and load the account's chats if that is the mode. */
  start(): Promise<void> {
    return this.enqueue(() => this.apply());
  }

  refresh(): Promise<void> {
    return this.enqueue(() => this.apply());
  }

  setMode(mode: ChatHistoryMode, opts: { moveDeviceChats?: boolean } = {}): Promise<void> {
    if (this.locked || !isChatHistoryMode(mode)) return Promise.resolve();
    return this.enqueue(() => this.apply({ choose: mode, move: !!opts.moveDeviceChats }));
  }

  moveDeviceChats(): Promise<{ moved: number; failed: number }> {
    return this.enqueue(async () => {
      const r = await this.moveNow();
      this.emitState();
      return r;
    });
  }

  deleteAll(): Promise<{ ok: boolean }> {
    return this.enqueue(async () => {
      let ok = true;
      if (this.adapter && typeof this.userId === "string") {
        // A write still waiting would bring a chat back after the delete.
        await this.sync?.settle();
        try {
          await this.adapter.deleteAll();
        } catch (e) {
          ok = false;
          this.report(e);
        }
      }
      ChatHistoryStore.clearLocal(this.storageKey);
      // If the account could not be emptied, keep showing what it still holds.
      if (ok || this.mode !== "account") this.store.clearAll();
      this.emitReplaced();
      this.emitState();
      return { ok };
    });
  }

  retry(): Promise<void> {
    if (this.error === "save" && this.sync) return this.sync.flush();
    return this.enqueue(() => this.apply({ reload: true }));
  }

  /** True when this chat's messages still have to be fetched from the account. */
  needsLoad(id: string): boolean {
    return !!this.sync?.needsLoad(id);
  }

  /** Make sure a chat's messages are here before it is opened or copied. False if it is gone. */
  async ensureLoaded(id: string): Promise<boolean> {
    if (!this.sync?.needsLoad(id)) return !!this.store.get(id);
    return (await this.sync.load(id)) === "loaded";
  }

  /** Send any waiting account writes now. */
  flush(): Promise<void> {
    return this.sync?.flush() ?? Promise.resolve();
  }

  getState(): ChatHistoryState {
    return {
      mode: this.mode,
      chosen: this.chosen(),
      locked: this.locked,
      accountUnavailable: this.locked ? undefined : this.unavailable,
      status: this.status,
      error: this.status === "error" ? this.error : undefined,
      deviceChatCount: this.locked
        ? 0
        : ChatHistoryStore.readLocal(this.storageKey).sessions.filter((s) => s.messages?.length).length,
      canDeleteAccountChats: !!this.adapter && typeof this.userId === "string",
      retentionMonths: this.adapter?.retentionMonths,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Told when the store's contents were swapped: the active chat may be gone. */
  onReplaced(listener: () => void): () => void {
    this.replacedListeners.add(listener);
    return () => this.replacedListeners.delete(listener);
  }

  dispose() {
    if (this.onPageHide && typeof window !== "undefined") window.removeEventListener("pagehide", this.onPageHide);
    const sync = this.sync;
    this.sync = undefined;
    void sync?.stop({ flush: true });
    this.listeners.clear();
    this.replacedListeners.clear();
  }

  // --- internals ---------------------------------------------------------------------------

  private chosen(): ChatHistoryMode {
    if (this.locked) return "off";
    const who = this.userId !== undefined ? this.userId : this.hintUserId ?? null;
    return getStoredChatHistoryMode(this.adapter ? who : null, this.modeKey) ?? this.defaultMode;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readUserId(): Promise<string | null> {
    if (!this.adapter) return null;
    if (!this.adapter.currentUserId) return "";
    try {
      const id = await this.adapter.currentUserId();
      return id ? String(id) : null;
    } catch (e) {
      this.report(e);
      return null;
    }
  }

  private async apply(opts: { choose?: ChatHistoryMode; move?: boolean; reload?: boolean } = {}) {
    if (this.locked) return;
    const userId = await this.readUserId();
    const first = this.userId === undefined;
    const userChanged = !first && userId !== this.userId;
    this.userId = userId;
    if (this.adapter) this.rememberLastUser(userId);
    if (opts.choose) setStoredChatHistoryMode(opts.choose, this.adapter ? userId : null, this.modeKey);

    const { mode: next, unavailable } = resolveChatHistoryMode({
      chosen: this.chosen(),
      hasAdapter: !!this.adapter,
      signedIn: userId !== null,
      fallback: this.fallback,
    });
    this.unavailable = unavailable;
    const prev = this.mode;
    const load = next === "account" && (prev !== "account" || first || userChanged || opts.reload || !this.sync);
    if (next === prev && !load) {
      this.emitState();
      return;
    }

    // Leave the old mode. The same person switching: send what is waiting. A different
    // person (or nobody): drop it, it would be saved as the wrong user.
    if (this.sync && (next !== "account" || userChanged)) {
      const old = this.sync;
      this.sync = undefined;
      await old.stop({ flush: !userChanged });
    }
    const activeBefore = this.store.getActiveId();

    if (next !== "account") {
      this.status = "idle";
      this.error = undefined;
    }
    if (next === "device") {
      this.mode = "device";
      this.store.useLocalStorage();
    } else if (next === "off") {
      // Keep the conversation on screen for this page; nothing is written anywhere.
      const carry = !userChanged && prev !== "off" ? this.store.getActive() : null;
      this.mode = "off";
      this.store.useMemory(carry ? { sessions: [carry], activeId: carry.id } : undefined);
    } else {
      this.mode = "account";
      // Loading keeps what is already here when it is this same page's account copy (first
      // load, or a retry); anything else is replaced so no other copy leaks into the account.
      const keep = prev === "account" && !userChanged;
      const sync =
        this.sync ??
        new AccountHistorySync(this.store, this.adapter!, {
          debounceMs: this.opts.debounceMs,
          retryDelaysMs: this.opts.retryDelaysMs,
          sameUser: async () => (await this.readUserIdStrict()) === this.userId,
          onUserChanged: () => void this.refresh(),
          onStatus: (s, e) => this.onSyncStatus(s, e),
        });
      this.sync = sync;
      if (keep) sync.start();
      this.setStatus("loading");
      let sessions: ChatSession[] | undefined;
      try {
        sessions = await sync.fetch();
        this.error = undefined;
        this.setStatus("idle");
      } catch (e) {
        this.report(e);
        this.error = "load";
        this.setStatus("error");
      }
      if (keep) {
        const loaded = new Set((sessions ?? []).map((s) => s.id));
        if (sessions) this.store.merge(sessions);
        // Chats started here while the list was loading were never sent.
        sync.markDirty(
          this.store
            .list(true)
            .filter((s) => !loaded.has(s.id) && s.messages.length)
            .map((s) => s.id)
        );
      } else {
        this.store.useMemory({ sessions: sessions ?? [] });
        sync.start();
      }
      if (opts.move) await this.moveNow();
      if (activeBefore && this.store.get(activeBefore)) this.store.setActive(activeBefore);
    }
    this.emitReplaced();
    this.emitState();
  }

  /** Like readUserId, but lets an error through so a failed check is retried, not taken as sign-out. */
  private async readUserIdStrict(): Promise<string | null> {
    if (!this.adapter) return null;
    if (!this.adapter.currentUserId) return "";
    const id = await this.adapter.currentUserId();
    return id ? String(id) : null;
  }

  private async moveNow(): Promise<{ moved: number; failed: number }> {
    if (this.mode !== "account" || !this.sync) return { moved: 0, failed: 0 };
    const local = ChatHistoryStore.readLocal(this.storageKey).sessions.filter((s) => s.messages?.length);
    if (!local.length) return { moved: 0, failed: 0 };
    const saved = new Set(await this.sync.saveChats(local));
    this.store.merge(local.filter((s) => saved.has(s.id)));
    // Moved, not copied: the browser copy goes only once the account has it.
    ChatHistoryStore.removeLocal([...saved], this.storageKey);
    return { moved: saved.size, failed: local.length - saved.size };
  }

  private rememberLastUser(userId: string | null) {
    const prefs = readPrefs(this.modeKey);
    if (prefs.last === userId) return;
    prefs.last = userId;
    writePrefs(this.modeKey, prefs);
  }

  private onSyncStatus(s: AccountSyncStatus, e?: unknown) {
    if (s === "error") {
      this.report(e);
      this.error = "save";
      this.setStatus("error");
    } else {
      if (this.error === "save") this.error = undefined;
      // Don't let a background save paper over a failed load.
      if (this.error !== "load") this.setStatus(s);
    }
  }

  private setStatus(s: ChatHistoryState["status"]) {
    if (this.status === s) return;
    this.status = s;
    this.emitState();
  }

  private report(e: unknown) {
    try {
      this.opts.onError?.(e);
    } catch {
      /* a host logger must not break history */
    }
  }

  private emitState() {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* a listener must not break the manager */
      }
    }
  }

  private emitReplaced() {
    for (const l of this.replacedListeners) {
      try {
        l();
      } catch {
        /* ditto */
      }
    }
  }
}
