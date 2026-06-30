import type { ChatSession, ChatGroup, ChatHistoryStore } from "./chatHistory.js";
import { CHAT_HISTORY_CHANGE_EVENT } from "./chatHistory.js";

export interface ChatSidebarHandlers {
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onArchive: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onRename: (id: string, title: string) => void;
  onFork: (id: string) => void;
  onMarkUnread: (id: string) => void;
  onShare: (id: string) => void;
  onSearch: (query: string) => void;
  onToggle: (open: boolean) => void;
}

const SIDEBAR_CSS = `
.sidebar {
  width: 220px; min-width: 220px; background: #0b1310; border-right: 1px solid #1f3a2c;
  display: flex; flex-direction: column; overflow: hidden; transition: width .2s, min-width .2s;
}
.sidebar.collapsed { width: 0; min-width: 0; border: none; }
.sidebar-head { padding: 10px; border-bottom: 1px solid #1f3a2c; display: flex; gap: 6px; align-items: center; }
.sidebar-head input {
  flex: 1; background: #0f1715; border: 1px solid #244234; color: #e7f5ec;
  border-radius: 8px; padding: 6px 8px; font-size: 12px; outline: none;
}
.sidebar-head button, .new-chat {
  background: #1f3a2c; border: none; color: #9ff0c2; border-radius: 8px; cursor: pointer;
  padding: 6px 8px; font-size: 12px; white-space: nowrap;
}
.new-chat { margin: 8px; width: calc(100% - 16px); font-weight: 600; }
.sidebar-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.section-label {
  font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #6a8a7a;
  padding: 8px 12px 4px; font-weight: 600;
}
.chat-item {
  display: flex; align-items: center; gap: 6px; padding: 8px 10px; cursor: pointer;
  font-size: 13px; color: #bfe9cd; border-left: 3px solid transparent;
}
.chat-item:hover { background: #16241c; }
.chat-item.active { background: #1a2a22; border-left-color: #4ade80; }
.chat-item.unread .chat-title { font-weight: 700; }
.chat-item.pinned .chat-title::before { content: "📌 "; font-size: 10px; }
.chat-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-menu-btn {
  background: none; border: none; color: #6a8a7a; cursor: pointer; padding: 2px 4px;
  border-radius: 4px; font-size: 14px; opacity: 0;
}
.chat-item:hover .chat-menu-btn { opacity: 1; }
.chat-menu-btn:hover { background: #244234; color: #e7f5ec; }
.ctx-menu {
  position: fixed; z-index: 2147483647; background: #12211a; border: 1px solid #244234;
  border-radius: 8px; padding: 4px 0; min-width: 160px; box-shadow: 0 8px 24px rgba(0,0,0,.4);
}
.ctx-menu button {
  display: block; width: 100%; text-align: left; background: none; border: none;
  color: #e7f5ec; padding: 8px 14px; font-size: 13px; cursor: pointer;
}
.ctx-menu button:hover { background: #1d3328; }
.ctx-menu button.danger { color: #f87171; }
.show-more {
  display: block; width: calc(100% - 16px); margin: 6px 8px; background: none; border: 1px dashed #244234;
  color: #9ab4a6; border-radius: 8px; padding: 6px; font-size: 12px; cursor: pointer;
}
.show-more:hover { background: #16241c; color: #e7f5ec; }
.toggle-sidebar {
  background: none; border: none; color: #9ab4a6; cursor: pointer; font-size: 16px; padding: 2px 6px;
}
`;

const PAGE_SIZE = 15;

export class ChatSidebar {
  private el!: HTMLDivElement;
  private listEl!: HTMLDivElement;
  private searchInput!: HTMLInputElement;
  private ctxMenu?: HTMLDivElement;
  private showLimit = PAGE_SIZE;
  private query = "";

  constructor(
    private store: ChatHistoryStore,
    private handlers: ChatSidebarHandlers,
    private activeId: string | null
  ) {}

  render(): HTMLDivElement {
    this.el = el("div", "sidebar");
    const style = document.createElement("style");
    style.textContent = SIDEBAR_CSS;
    this.el.appendChild(style);

    const head = el("div", "sidebar-head");
    this.searchInput = el("input") as HTMLInputElement;
    this.searchInput.placeholder = "Search chats…";
    this.searchInput.oninput = () => {
      this.query = this.searchInput.value;
      this.handlers.onSearch(this.query);
      this.refresh();
    };
    const toggleBtn = el("button", "toggle-sidebar") as HTMLButtonElement;
    toggleBtn.textContent = "◀";
    toggleBtn.title = "Collapse sidebar";
    toggleBtn.onclick = () => this.handlers.onToggle(false);
    head.append(this.searchInput, toggleBtn);

    const newBtn = el("button", "new-chat") as HTMLButtonElement;
    newBtn.textContent = "+ New chat";
    newBtn.onclick = () => this.handlers.onNew();

    this.listEl = el("div", "sidebar-list") as HTMLDivElement;
    this.el.append(head, newBtn, this.listEl);
    this.refresh();

    window.addEventListener(CHAT_HISTORY_CHANGE_EVENT, () => this.refresh());
    return this.el;
  }

  setActive(id: string | null) {
    this.activeId = id;
    this.refresh();
  }

  setCollapsed(collapsed: boolean) {
    this.el.classList.toggle("collapsed", collapsed);
  }

  refresh() {
    this.listEl.innerHTML = "";
    const sessions = this.query ? this.store.search(this.query) : this.store.list();
    const groups = this.store.listGroups();
    const pinned = sessions.filter((s) => s.pinned && !s.archived);
    const unpinned = sessions.filter((s) => !s.pinned && !s.archived);
    const archived = sessions.filter((s) => s.archived);

    if (pinned.length) {
      this.addSection("Pinned");
      for (const s of pinned) this.addItem(s);
    }

    const grouped = new Map<string, ChatSession[]>();
    const ungrouped: ChatSession[] = [];
    for (const s of unpinned) {
      if (s.groupId) {
        const arr = grouped.get(s.groupId) ?? [];
        arr.push(s);
        grouped.set(s.groupId, arr);
      } else {
        ungrouped.push(s);
      }
    }

    for (const g of groups) {
      const items = grouped.get(g.id);
      if (!items?.length) continue;
      this.addSection(g.name);
      for (const s of items.slice(0, this.showLimit)) this.addItem(s);
    }

    if (ungrouped.length) {
      this.addSection("Recent");
      const visible = ungrouped.slice(0, this.showLimit);
      for (const s of visible) this.addItem(s);
      if (ungrouped.length > this.showLimit) {
        const more = el("button", "show-more") as HTMLButtonElement;
        more.textContent = `Show ${ungrouped.length - this.showLimit} more…`;
        more.onclick = () => {
          this.showLimit += PAGE_SIZE;
          this.refresh();
        };
        this.listEl.appendChild(more);
      }
    }

    if (archived.length) {
      this.addSection("Archived");
      for (const s of archived.slice(0, 5)) this.addItem(s);
    }

    if (!sessions.length) {
      const empty = el("div", "section-label");
      empty.textContent = "No chats yet";
      this.listEl.appendChild(empty);
    }
  }

  private addSection(label: string) {
    const s = el("div", "section-label");
    s.textContent = label;
    this.listEl.appendChild(s);
  }

  private addItem(session: ChatSession) {
    const item = el("div", "chat-item");
    if (session.id === this.activeId) item.classList.add("active");
    if (session.unread) item.classList.add("unread");
    if (session.pinned) item.classList.add("pinned");

    const title = el("span", "chat-title");
    title.textContent = session.title;
    title.title = session.title;

    const menuBtn = el("button", "chat-menu-btn") as HTMLButtonElement;
    menuBtn.textContent = "⋯";
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      this.openContextMenu(session, menuBtn);
    };

    item.onclick = () => this.handlers.onSelect(session.id);
    item.append(title, menuBtn);
    this.listEl.appendChild(item);
  }

  private openContextMenu(session: ChatSession, anchor: HTMLElement) {
    this.closeContextMenu();
    const menu = el("div", "ctx-menu") as HTMLDivElement;
    const items: Array<{ label: string; action: () => void; danger?: boolean }> = [
      { label: "Rename", action: () => this.promptRename(session) },
      { label: "Fork", action: () => this.handlers.onFork(session.id) },
      { label: session.pinned ? "Unpin" : "Pin", action: () => this.handlers.onPin(session.id, !session.pinned) },
      { label: "Mark unread", action: () => this.handlers.onMarkUnread(session.id) },
      { label: "Share (copy JSON)", action: () => this.handlers.onShare(session.id) },
      { label: session.archived ? "Unarchive" : "Archive", action: () => this.handlers.onArchive(session.id) },
      { label: "Delete", action: () => this.handlers.onDelete(session.id), danger: true },
    ];
    for (const it of items) {
      const btn = el("button") as HTMLButtonElement;
      btn.textContent = it.label;
      if (it.danger) btn.classList.add("danger");
      btn.onclick = () => {
        this.closeContextMenu();
        it.action();
      };
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.min(rect.left, window.innerWidth - 180)}px`;
    this.ctxMenu = menu;
    setTimeout(() => {
      document.addEventListener("click", this.closeContextMenuOnce, { once: true });
    }, 0);
  }

  private closeContextMenuOnce = () => this.closeContextMenu();

  private closeContextMenu() {
    this.ctxMenu?.remove();
    this.ctxMenu = undefined;
  }

  private promptRename(session: ChatSession) {
    const title = prompt("Rename chat:", session.title);
    if (title?.trim()) this.handlers.onRename(session.id, title.trim());
  }
}

function el<T extends HTMLElement = HTMLElement>(tag: string, cls?: string): T {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e as unknown as T;
}
