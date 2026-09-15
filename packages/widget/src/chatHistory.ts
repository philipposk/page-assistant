import type { ChatMessage } from "@page-assistant/core";

/** A persisted conversation thread. */
export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  groupId?: string;
  order?: number;
  model?: string;
}

export interface ChatGroup {
  id: string;
  name: string;
  order?: number;
}

export interface ChatHistoryData {
  version: 1;
  activeId: string | null;
  sessions: ChatSession[];
  groups: ChatGroup[];
}

export const CHAT_HISTORY_STORAGE_KEY = "page_assistant_chat_history";
export const CHAT_HISTORY_CHANGE_EVENT = "page-assistant-chat-history-change";

/**
 * What changed in a store, for anything mirroring it elsewhere (account sync).
 *
 * - `upsert`: a chat's content or its synced metadata (title, pinned, archived, group) changed.
 * - `delete`: a chat was removed.
 * - `import`: a backup was imported; `ids` are the chats it brought in.
 * - `replace`: the whole contents were swapped (a mode switch, a load). Not a user edit.
 *
 * Selecting a chat, marking it unread and reordering are local-only and not reported.
 */
export type ChatStoreChange =
  | { kind: "upsert"; id: string }
  | { kind: "delete"; id: string }
  | { kind: "import"; ids: string[] }
  | { kind: "replace" };

export interface ChatHistoryStoreOptions {
  /**
   * `true` (default): read and write localStorage, as every earlier version did.
   * `false`: memory only. Nothing is read from or written to the device.
   */
  persist?: boolean;
}

const MAX_SESSIONS = 200;
const MAX_MESSAGES_PER_SESSION = 100;

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function emptyData(): ChatHistoryData {
  return { version: 1, activeId: null, sessions: [], groups: [] };
}

function titleFromMessage(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 48 ? t.slice(0, 46) + "…" : t || "New chat";
}

/**
 * Multi-chat store. The UI reads it synchronously; where it keeps chats is switchable:
 * localStorage (the default, and the only option before account history) or memory only.
 * Account sync mirrors it through `onChange` rather than living inside it.
 */
export class ChatHistoryStore {
  private data: ChatHistoryData;
  private persistLocal: boolean;
  private listeners = new Set<(change: ChatStoreChange) => void>();

  constructor(private storageKey = CHAT_HISTORY_STORAGE_KEY, opts: ChatHistoryStoreOptions = {}) {
    this.persistLocal = opts.persist !== false;
    this.data = this.persistLocal ? ChatHistoryStore.readLocal(this.storageKey) : emptyData();
  }

  /** What localStorage holds under `storageKey`, without touching any store. */
  static readLocal(storageKey = CHAT_HISTORY_STORAGE_KEY): ChatHistoryData {
    if (typeof localStorage === "undefined") return emptyData();
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return emptyData();
      const parsed = JSON.parse(raw) as ChatHistoryData;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return emptyData();
      return { version: 1, activeId: parsed.activeId ?? null, sessions: parsed.sessions, groups: parsed.groups ?? [] };
    } catch {
      return emptyData();
    }
  }

  /** Remove every chat this device holds under `storageKey`. */
  static clearLocal(storageKey = CHAT_HISTORY_STORAGE_KEY) {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* storage blocked — nothing to clear */
    }
  }

  /** Remove the given chats from what localStorage holds under `storageKey`, leaving the rest. */
  static removeLocal(ids: string[], storageKey = CHAT_HISTORY_STORAGE_KEY) {
    if (typeof localStorage === "undefined" || !ids.length) return;
    const drop = new Set(ids);
    const data = ChatHistoryStore.readLocal(storageKey);
    data.sessions = data.sessions.filter((s) => !drop.has(s.id));
    if (data.activeId && drop.has(data.activeId)) data.activeId = null;
    try {
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch {
      /* storage blocked — nothing more to do */
    }
  }

  /** True while this store reads and writes localStorage. */
  get persistsLocally(): boolean {
    return this.persistLocal;
  }

  /** The localStorage key this store reads and writes while it persists. */
  get localKey(): string {
    return this.storageKey;
  }

  /** Be told about every change that another copy would need to mirror. */
  onChange(listener: (change: ChatStoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Switch to localStorage and show what it holds. `storageKey` moves the store to another
   * key (another person's slot); nothing is written to the key it leaves.
   */
  useLocalStorage(storageKey?: string) {
    if (storageKey) this.storageKey = storageKey;
    this.persistLocal = true;
    this.data = ChatHistoryStore.readLocal(this.storageKey);
    this.commit({ kind: "replace" });
  }

  /** Switch to memory only, starting from `data` (empty by default). Writes nothing to the device. */
  useMemory(data?: Partial<ChatHistoryData>) {
    this.persistLocal = false;
    this.data = {
      version: 1,
      activeId: data?.activeId ?? null,
      sessions: data?.sessions ? [...data.sessions] : [],
      groups: data?.groups ? [...data.groups] : [],
    };
    this.commit({ kind: "replace" });
  }

  /**
   * Add chats loaded from elsewhere. A chat already here that is newer than the incoming
   * copy is kept — it has edits the other copy has not seen yet. The active chat is kept.
   */
  merge(sessions: ChatSession[]) {
    for (const incoming of sessions) {
      const existing = this.get(incoming.id);
      if (!existing) this.data.sessions.push({ ...incoming });
      else if (existing.updatedAt < incoming.updatedAt) Object.assign(existing, incoming);
    }
    this.commit({ kind: "replace" });
  }

  /** Drop chats from this store without reporting it: they are gone elsewhere already. */
  forget(ids: string[]) {
    const drop = new Set(ids);
    this.data.sessions = this.data.sessions.filter((s) => !drop.has(s.id));
    if (this.data.activeId && drop.has(this.data.activeId)) this.data.activeId = null;
    this.commit({ kind: "replace" });
  }

  /** Empty the store (and localStorage, while persisting). Not reported as per-chat deletes. */
  clearAll() {
    this.data = emptyData();
    this.commit({ kind: "replace" });
  }

  /** Fill in a chat's messages without counting it as an edit. */
  hydrate(id: string, messages: ChatMessage[]) {
    const s = this.get(id);
    if (!s) return;
    s.messages = messages.slice(-MAX_MESSAGES_PER_SESSION);
    this.commit({ kind: "replace" });
  }

  private commit(...changes: ChatStoreChange[]) {
    if (this.persistLocal) this.writeLocal();
    if (typeof window !== "undefined" && typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent(CHAT_HISTORY_CHANGE_EVENT));
    }
    for (const change of changes) {
      for (const l of this.listeners) {
        try {
          l(change);
        } catch {
          /* a listener must not break the store */
        }
      }
    }
  }

  private writeLocal() {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.data));
    } catch {
      /* quota exceeded — trim oldest archived */
      const archived = this.data.sessions.filter((s) => s.archived).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      for (const s of archived.slice(0, 5)) this.data.sessions = this.data.sessions.filter((x) => x.id !== s.id);
      try {
        localStorage.setItem(this.storageKey, JSON.stringify(this.data));
      } catch {
        /* give up */
      }
    }
  }

  getActiveId(): string | null {
    return this.data.activeId;
  }

  getActive(): ChatSession | null {
    if (!this.data.activeId) return null;
    return this.data.sessions.find((s) => s.id === this.data.activeId) ?? null;
  }

  list(includeArchived = false): ChatSession[] {
    const sessions = includeArchived ? [...this.data.sessions] : this.data.sessions.filter((s) => !s.archived);
    return sessions.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      const ao = a.order ?? 0;
      const bo = b.order ?? 0;
      if (ao !== bo) return bo - ao;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  listGroups(): ChatGroup[] {
    return [...this.data.groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  get(id: string): ChatSession | undefined {
    return this.data.sessions.find((s) => s.id === id);
  }

  create(opts?: { title?: string; model?: string }): ChatSession {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: uid(),
      title: opts?.title ?? "New chat",
      messages: [],
      createdAt: now,
      updatedAt: now,
      model: opts?.model,
    };
    this.data.sessions.unshift(session);
    this.data.activeId = session.id;
    this.trimSessions();
    this.commit({ kind: "upsert", id: session.id });
    return session;
  }

  setActive(id: string | null) {
    this.data.activeId = id;
    if (id) {
      const s = this.get(id);
      if (s) {
        s.unread = false;
      }
    }
    this.commit();
  }

  saveMessages(id: string, messages: ChatMessage[], opts?: { model?: string }) {
    const s = this.get(id);
    if (!s) return;
    s.messages = messages.slice(-MAX_MESSAGES_PER_SESSION);
    s.updatedAt = new Date().toISOString();
    if (opts?.model) s.model = opts.model;
    const firstUser = s.messages.find((m) => m.role === "user");
    if (firstUser && (s.title === "New chat" || !s.title)) {
      s.title = titleFromMessage(firstUser.content);
    }
    this.commit({ kind: "upsert", id });
  }

  rename(id: string, title: string) {
    const s = this.get(id);
    if (!s) return;
    s.title = title.trim() || s.title;
    s.updatedAt = new Date().toISOString();
    this.commit({ kind: "upsert", id });
  }

  delete(id: string) {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    if (this.data.activeId === id) {
      this.data.activeId = this.data.sessions.find((s) => !s.archived)?.id ?? null;
    }
    this.commit({ kind: "delete", id });
  }

  archive(id: string, archived = true) {
    const s = this.get(id);
    if (!s) return;
    s.archived = archived;
    s.updatedAt = new Date().toISOString();
    if (archived && this.data.activeId === id) {
      this.data.activeId = this.data.sessions.find((x) => !x.archived && x.id !== id)?.id ?? null;
    }
    this.commit({ kind: "upsert", id });
  }

  pin(id: string, pinned = true) {
    const s = this.get(id);
    if (!s) return;
    s.pinned = pinned;
    s.updatedAt = new Date().toISOString();
    this.commit({ kind: "upsert", id });
  }

  markUnread(id: string, unread = true) {
    const s = this.get(id);
    if (!s) return;
    s.unread = unread;
    this.commit();
  }

  fork(id: string): ChatSession | null {
    const src = this.get(id);
    if (!src) return null;
    const now = new Date().toISOString();
    const forked: ChatSession = {
      id: uid(),
      title: `${src.title} (fork)`,
      messages: [...src.messages],
      createdAt: now,
      updatedAt: now,
      model: src.model,
      groupId: src.groupId,
    };
    this.data.sessions.unshift(forked);
    this.data.activeId = forked.id;
    this.trimSessions();
    this.commit({ kind: "upsert", id: forked.id });
    return forked;
  }

  reorder(ids: string[]) {
    ids.forEach((id, i) => {
      const s = this.get(id);
      if (s) s.order = ids.length - i;
    });
    this.commit();
  }

  setGroup(sessionId: string, groupId: string | undefined) {
    const s = this.get(sessionId);
    if (!s) return;
    s.groupId = groupId;
    s.updatedAt = new Date().toISOString();
    this.commit({ kind: "upsert", id: sessionId });
  }

  createGroup(name: string): ChatGroup {
    const g: ChatGroup = { id: uid(), name, order: this.data.groups.length };
    this.data.groups.push(g);
    this.commit();
    return g;
  }

  renameGroup(id: string, name: string) {
    const g = this.data.groups.find((x) => x.id === id);
    if (!g) return;
    g.name = name.trim() || g.name;
    this.commit();
  }

  deleteGroup(id: string) {
    this.data.groups = this.data.groups.filter((g) => g.id !== id);
    const touched: string[] = [];
    for (const s of this.data.sessions) {
      if (s.groupId === id) {
        s.groupId = undefined;
        touched.push(s.id);
      }
    }
    this.commit(...touched.map((sid): ChatStoreChange => ({ kind: "upsert", id: sid })));
  }

  /** Export session as shareable JSON (no secrets). */
  share(id: string): string | null {
    const s = this.get(id);
    if (!s) return null;
    return JSON.stringify({ title: s.title, messages: s.messages, exportedAt: new Date().toISOString() }, null, 2);
  }

  /** Export all chats as JSON backup. */
  exportAll(): string {
    return JSON.stringify(this.data, null, 2);
  }

  importAll(json: string): boolean {
    try {
      const parsed = JSON.parse(json) as ChatHistoryData;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return false;
      this.data = { version: 1, activeId: parsed.activeId ?? null, sessions: parsed.sessions, groups: parsed.groups ?? [] };
      this.commit({ kind: "import", ids: parsed.sessions.map((x) => x.id) });
      return true;
    } catch {
      return false;
    }
  }

  search(query: string): ChatSession[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.list();
    return this.list(true).filter((s) => {
      if (s.title.toLowerCase().includes(q)) return true;
      return s.messages.some((m) => m.content.toLowerCase().includes(q));
    });
  }

  private trimSessions() {
    if (this.data.sessions.length <= MAX_SESSIONS) return;
    const sorted = [...this.data.sessions]
      .filter((s) => !s.pinned && s.archived)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const s of sorted) {
      if (this.data.sessions.length <= MAX_SESSIONS) break;
      this.data.sessions = this.data.sessions.filter((x) => x.id !== s.id);
    }
  }
}
