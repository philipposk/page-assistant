import type { ChatSession, ChatGroup, ChatHistoryStore } from "./chatHistory.js";
import { CHAT_HISTORY_CHANGE_EVENT } from "./chatHistory.js";
import { DEFAULT_STRINGS, fmt, type WidgetStrings } from "./strings.js";

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

// Uses the theme CSS variables (--pa-*) so the sidebar matches light/dark like the rest
// of the panel instead of hardcoding dark colors.
const SIDEBAR_CSS = `
.sidebar {
  width: 220px; min-width: 220px; background: var(--pa-bg-sidebar); border-right: 1px solid var(--pa-border);
  display: flex; flex-direction: column; overflow: hidden; transition: width .2s, min-width .2s;
  position: relative;
}
.sidebar.collapsed { width: 0; min-width: 0; border: none; }
.sidebar-head { padding: 10px; border-bottom: 1px solid var(--pa-border); display: flex; gap: 6px; align-items: center; }
.sidebar-head input {
  flex: 1; background: var(--pa-bg-input); border: 1px solid var(--pa-border); color: var(--pa-text);
  border-radius: 8px; padding: 6px 8px; font-size: 12px; outline: none;
}
.sidebar-head button, .new-chat {
  background: var(--pa-border); border: none; color: var(--pa-text); border-radius: 8px; cursor: pointer;
  padding: 6px 8px; font-size: 12px; white-space: nowrap;
}
.new-chat { margin: 8px; width: calc(100% - 16px); font-weight: 600; background: var(--pa-accent); color: #fff; }
.sidebar-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.section-label {
  font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--pa-text-muted);
  padding: 8px 12px 4px; font-weight: 600;
}
.chat-item {
  display: flex; align-items: center; gap: 6px; padding: 8px 10px; cursor: pointer;
  font-size: 13px; color: var(--pa-text); border-left: 3px solid transparent;
}
.chat-item:hover { background: var(--pa-border); }
.chat-item.active { background: var(--pa-bg-msg-asst); border-left-color: var(--pa-accent); }
.chat-item.unread .chat-title { font-weight: 700; }
.chat-item.pinned .chat-title::before { content: "📌 "; font-size: 10px; }
.chat-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-menu-btn {
  background: none; border: none; color: var(--pa-text-muted); cursor: pointer; padding: 2px 4px;
  border-radius: 4px; font-size: 14px; opacity: 0;
}
.chat-item:hover .chat-menu-btn, .chat-item:focus-within .chat-menu-btn { opacity: 1; }
.chat-menu-btn:hover { background: var(--pa-border); color: var(--pa-text); }
.ctx-menu {
  position: fixed; z-index: 2147483647; background: var(--pa-bg-head); border: 1px solid var(--pa-border);
  border-radius: 8px; padding: 4px 0; min-width: 160px; box-shadow: 0 8px 24px rgba(0,0,0,.4);
}
.ctx-menu button {
  display: block; width: 100%; text-align: left; background: none; border: none;
  color: var(--pa-text); padding: 8px 14px; font-size: 13px; cursor: pointer;
}
.ctx-menu button:hover { background: var(--pa-border); }
.ctx-menu button.danger { color: var(--pa-danger, #f87171); }
.show-more {
  display: block; width: calc(100% - 16px); margin: 6px 8px; background: none; border: 1px dashed var(--pa-border);
  color: var(--pa-text-muted); border-radius: 8px; padding: 6px; font-size: 12px; cursor: pointer;
}
.show-more:hover { background: var(--pa-border); color: var(--pa-text); }
.toggle-sidebar {
  background: none; border: none; color: var(--pa-text-muted); cursor: pointer; font-size: 16px; padding: 2px 6px;
}
/* On narrow viewports the sidebar overlays the panel instead of squeezing the chat. */
@media (max-width: 520px) {
  .sidebar:not(.collapsed) {
    position: absolute; inset: 0 auto 0 0; width: 80%; min-width: 0; max-width: 260px;
    z-index: 5; box-shadow: 6px 0 24px rgba(0,0,0,.4);
  }
  .chat-menu-btn { opacity: 1; } /* touch has no hover — keep the ⋯ menu reachable */
}
@media (hover: none) {
  .chat-menu-btn { opacity: 1; }
}
`;

const PAGE_SIZE = 15;

export class ChatSidebar {
  private el!: HTMLDivElement;
  private listEl!: HTMLDivElement;
  private searchInput!: HTMLInputElement;
  private ctxMenu?: HTMLDivElement;
  private ctxMenuAnchor?: HTMLElement;
  private showLimit = PAGE_SIZE;
  private query = "";
  private onHistoryChange = () => this.refresh();
  private outsideClickHandler?: (e: Event) => void;

  constructor(
    private store: ChatHistoryStore,
    private handlers: ChatSidebarHandlers,
    private activeId: string | null,
    /** Resolved chrome strings. Defaults keep this constructor's old 3-arg call sites working. */
    private s: WidgetStrings = DEFAULT_STRINGS
  ) {}

  render(): HTMLDivElement {
    this.el = el("div", "sidebar");
    const style = document.createElement("style");
    style.textContent = SIDEBAR_CSS;
    this.el.appendChild(style);

    const head = el("div", "sidebar-head");
    this.searchInput = el("input") as HTMLInputElement;
    this.searchInput.placeholder = this.s.sidebarSearch;
    this.searchInput.setAttribute("aria-label", this.s.sidebarSearch);
    this.searchInput.oninput = () => {
      this.query = this.searchInput.value;
      this.handlers.onSearch(this.query);
      this.refresh();
    };
    const toggleBtn = el("button", "toggle-sidebar") as HTMLButtonElement;
    toggleBtn.textContent = "◀";
    toggleBtn.title = this.s.sidebarCollapse;
    toggleBtn.setAttribute("aria-label", this.s.sidebarCollapse);
    toggleBtn.onclick = () => this.handlers.onToggle(false);
    head.append(this.searchInput, toggleBtn);

    const newBtn = el("button", "new-chat") as HTMLButtonElement;
    newBtn.textContent = this.s.sidebarNewChat;
    newBtn.setAttribute("aria-label", this.s.sidebarNewChatLabel);
    newBtn.onclick = () => this.handlers.onNew();

    this.listEl = el("div", "sidebar-list") as HTMLDivElement;
    this.el.append(head, newBtn, this.listEl);
    this.refresh();

    window.addEventListener(CHAT_HISTORY_CHANGE_EVENT, this.onHistoryChange);
    return this.el;
  }

  /** Detach the history listener and any open menu (for widget teardown). */
  destroy() {
    window.removeEventListener(CHAT_HISTORY_CHANGE_EVENT, this.onHistoryChange);
    this.closeContextMenu();
  }

  setActive(id: string | null) {
    this.activeId = id;
    this.refresh();
  }

  setCollapsed(collapsed: boolean) {
    this.el.classList.toggle("collapsed", collapsed);
    if (collapsed) this.closeContextMenu();
  }

  refresh() {
    this.closeContextMenu();
    this.listEl.innerHTML = "";
    const sessions = this.query ? this.store.search(this.query) : this.store.list();
    const groups = this.store.listGroups();
    const pinned = sessions.filter((s) => s.pinned && !s.archived);
    const unpinned = sessions.filter((s) => !s.pinned && !s.archived);
    const archived = sessions.filter((s) => s.archived);

    if (pinned.length) {
      this.addSection(this.s.sidebarPinned);
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
      this.addSection(this.s.sidebarRecent);
      const visible = ungrouped.slice(0, this.showLimit);
      for (const s of visible) this.addItem(s);
      if (ungrouped.length > this.showLimit) {
        const more = el("button", "show-more") as HTMLButtonElement;
        more.textContent = fmt(this.s.sidebarShowMore, { count: String(ungrouped.length - this.showLimit) });
        more.onclick = () => {
          this.showLimit += PAGE_SIZE;
          this.refresh();
        };
        this.listEl.appendChild(more);
      }
    }

    if (archived.length) {
      this.addSection(this.s.sidebarArchived);
      for (const s of archived.slice(0, 5)) this.addItem(s);
    }

    if (!sessions.length) {
      const empty = el("div", "section-label");
      empty.textContent = this.s.sidebarEmpty;
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
    menuBtn.setAttribute("aria-label", fmt(this.s.sidebarChatActions, { title: session.title }));
    menuBtn.setAttribute("aria-haspopup", "menu");
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      // Clicking the same ⋯ that opened the menu toggles it closed.
      if (this.ctxMenu && this.ctxMenuAnchor === menuBtn) {
        this.closeContextMenu();
        return;
      }
      this.openContextMenu(session, menuBtn);
    };

    item.onclick = () => this.handlers.onSelect(session.id);
    item.append(title, menuBtn);
    this.listEl.appendChild(item);
  }

  private openContextMenu(session: ChatSession, anchor: HTMLElement) {
    this.closeContextMenu();
    const menu = el("div", "ctx-menu") as HTMLDivElement;
    menu.setAttribute("role", "menu");
    const items: Array<{ label: string; action: () => void; danger?: boolean }> = [
      { label: this.s.menuRename, action: () => this.promptRename(session) },
      { label: this.s.menuFork, action: () => this.handlers.onFork(session.id) },
      { label: session.pinned ? this.s.menuUnpin : this.s.menuPin, action: () => this.handlers.onPin(session.id, !session.pinned) },
      { label: this.s.menuMarkUnread, action: () => this.handlers.onMarkUnread(session.id) },
      { label: this.s.menuShare, action: () => this.handlers.onShare(session.id) },
      { label: session.archived ? this.s.menuUnarchive : this.s.menuArchive, action: () => this.handlers.onArchive(session.id) },
      {
        label: this.s.menuDelete,
        action: () => {
          // Deletion is destructive and irreversible — confirm first.
          if (typeof confirm === "function" && !confirm(fmt(this.s.deleteChatConfirm, { title: session.title }))) return;
          this.handlers.onDelete(session.id);
        },
        danger: true,
      },
    ];
    for (const it of items) {
      const btn = el("button") as HTMLButtonElement;
      btn.textContent = it.label;
      btn.setAttribute("role", "menuitem");
      if (it.danger) btn.classList.add("danger");
      btn.onclick = () => {
        this.closeContextMenu();
        it.action();
      };
      menu.appendChild(btn);
    }
    // Render at the TOP of the shadow root — not inside the sidebar/panel-wrap. The
    // panel-wrap gets a visualViewport `transform` on mobile, and a transformed ancestor
    // makes position:fixed resolve against that ancestor (clipped/mispositioned) instead of
    // the viewport. Appending to the shadow root escapes the transform; the .ctx-menu styles
    // still apply because they live in the same shadow tree.
    const root = this.el.getRootNode() as ShadowRoot | Document;
    (root instanceof ShadowRoot ? root : this.el).appendChild(menu);
    this.ctxMenu = menu;
    this.ctxMenuAnchor = anchor;
    // Measure the menu now that it's in the DOM so we can flip it above when it would
    // overflow the bottom of the viewport (the old code clamped the TOP, which pushed a
    // tall menu off-screen and made "Delete" unreachable).
    const rect = anchor.getBoundingClientRect();
    const width = 180;
    const menuH = menu.offsetHeight || 8 + items.length * 34;
    const margin = 8;
    const spaceBelow = window.innerHeight - rect.bottom;
    let top: number;
    if (spaceBelow >= menuH + margin || rect.top < menuH + margin) {
      // Enough room below, or not enough room above either → below, clamped to bottom edge.
      top = Math.min(rect.bottom + 4, window.innerHeight - menuH - margin);
    } else {
      // Flip above the anchor.
      top = Math.max(margin, rect.top - menuH - 4);
    }
    menu.style.top = `${Math.max(margin, top)}px`;
    menu.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
    this.outsideClickHandler = (e: Event) => {
      // Ignore the click on the anchor that toggles the menu (its own handler manages that).
      if (this.ctxMenuAnchor && (e.target === this.ctxMenuAnchor || this.ctxMenuAnchor.contains(e.target as Node))) return;
      if (this.ctxMenu && !this.ctxMenu.contains(e.target as Node)) this.closeContextMenu();
    };
    setTimeout(() => {
      // Listen inside the shadow root AND on document so a click anywhere dismisses it.
      this.el.getRootNode().addEventListener("click", this.outsideClickHandler!, { capture: true });
      document.addEventListener("click", this.outsideClickHandler!, { capture: true });
    }, 0);
  }

  private closeContextMenu() {
    this.ctxMenu?.remove();
    this.ctxMenu = undefined;
    this.ctxMenuAnchor = undefined;
    if (this.outsideClickHandler) {
      this.el?.getRootNode().removeEventListener("click", this.outsideClickHandler, { capture: true });
      document.removeEventListener("click", this.outsideClickHandler, { capture: true });
      this.outsideClickHandler = undefined;
    }
  }

  /** Close the context menu if it's open; returns true if there was one to close (for Escape). */
  closeContextMenuIfOpen(): boolean {
    if (!this.ctxMenu) return false;
    this.closeContextMenu();
    return true;
  }

  private promptRename(session: ChatSession) {
    const title = prompt(this.s.renameChatPrompt, session.title);
    if (title?.trim()) this.handlers.onRename(session.id, title.trim());
  }
}

function el<T extends HTMLElement = HTMLElement>(tag: string, cls?: string): T {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e as unknown as T;
}
