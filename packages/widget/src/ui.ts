// Self-contained floating widget UI rendered in a shadow root (no host CSS bleed).
// Bottom-right launcher + panel + sidebar + animated mascot.

import type { ChatHistoryStore } from "./chatHistory.js";
import { ChatSidebar, type ChatSidebarHandlers } from "./chatSidebar.js";
import type { FileAttachment } from "./fileUpload.js";
import type { ThemeMode } from "./assistant-settings.js";
import { themeCssVars } from "./themes.js";

export type MascotState = "idle" | "listening" | "thinking" | "talking" | "scanning";

export interface UIHandlers {
  onSend: (text: string, attachments?: FileAttachment[]) => void;
  onMic: () => void;
  onConfirm: (approved: boolean) => void;
  onToggle?: (open: boolean) => void;
  onSettings?: () => void;
  onTtsToggle?: (enabled: boolean) => void;
  onNewChat?: () => void;
  onSelectChat?: (id: string) => void;
  onExportChat?: () => void;
}

export interface UIOptions {
  chatStore?: ChatHistoryStore;
  theme?: ThemeMode;
  sidebarOpen?: boolean;
  onSidebarHandlers?: (h: ChatSidebarHandlers) => void;
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif; }
.launcher {
  position: fixed; right: 22px; bottom: 22px; width: 60px; height: 60px; border-radius: 50%;
  border: none; cursor: pointer; z-index: 2147483646;
  background: radial-gradient(circle at 30% 30%, var(--pa-launcher-from), var(--pa-launcher-to));
  box-shadow: 0 8px 28px rgba(13,148,136,.45); transition: transform .25s, box-shadow .25s;
  display:flex; align-items:center; justify-content:center; color:#042f2e;
}
.launcher svg { width: 28px; height: 28px; fill: currentColor; }
.launcher:hover { transform: scale(1.08); }
.launcher.talking { animation: bob .5s infinite alternate; }
.launcher.thinking { animation: spin 1.2s linear infinite; }
.launcher.listening { box-shadow: 0 0 0 6px rgba(94,234,212,.35), 0 8px 28px rgba(13,148,136,.45); }
.launcher.scanning { animation: pulse .8s infinite; }
@keyframes bob { to { transform: translateY(-4px); } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 50% { box-shadow: 0 0 0 10px rgba(94,234,212,.25), 0 8px 28px rgba(13,148,136,.45); } }
.panel-wrap {
  position: fixed; right: 22px; bottom: 92px; z-index: 2147483646; display: none;
}
.panel-wrap.open { display: flex; }
.panel {
  width: 580px; max-width: calc(100vw - 32px);
  height: 520px; max-height: calc(100vh - 130px); background: var(--pa-bg); color: var(--pa-text);
  border: 1px solid var(--pa-border); border-radius: 16px;
  display: flex; flex-direction: row; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.5);
}
.panel-body { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.head { padding: 14px 16px; background: var(--pa-bg-head); border-bottom: 1px solid var(--pa-border); font-weight: 600; display:flex; align-items:center; gap:8px; }
.head .dot { width:8px;height:8px;border-radius:50%;background:#4ade80; }
.head .actions { margin-left: auto; display: flex; gap: 4px; align-items: center; }
.head button { background:none; border:none; color:var(--pa-text-muted); font-size:16px; cursor:pointer; padding:2px 6px; border-radius:6px; }
.head button:hover { background: var(--pa-border); color: var(--pa-text); }
.log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.msg { padding: 9px 12px; border-radius: 12px; max-width: 85%; line-height: 1.4; font-size: 14px; white-space: pre-wrap; }
.msg.user { align-self: flex-end; background: var(--pa-bg-msg-user); color: #fff; }
.msg.assistant { align-self: flex-start; background: var(--pa-bg-msg-asst); border: 1px solid var(--pa-border); }
.msg.system { align-self: center; font-size: 12px; opacity: .7; background: transparent; }
.confirm { display:flex; gap:8px; margin-top:6px; }
.confirm button { flex:1; padding:7px; border-radius:8px; border:none; cursor:pointer; font-weight:600; }
.confirm .yes { background:var(--pa-accent); color:#fff; } .confirm .no { background:var(--pa-border); color:var(--pa-text); }
.chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.chip { background:var(--pa-bg-sidebar); border:1px solid var(--pa-border); color:var(--pa-text); border-radius:14px; padding:6px 11px; font-size:12px; cursor:pointer; }
.chip:hover { opacity: .85; }
.attach-preview { display:flex; flex-wrap:wrap; gap:4px; padding: 4px 10px; }
.attach-tag { font-size:11px; background:var(--pa-bg-sidebar); border:1px solid var(--pa-border); border-radius:6px; padding:2px 6px; color:var(--pa-text-muted); }
.foot { padding: 10px; border-top: 1px solid var(--pa-border); display: flex; gap: 8px; align-items: center; }
.foot input[type=text] { flex: 1; background: var(--pa-bg-input); border: 1px solid var(--pa-border); color: var(--pa-text); border-radius: 10px; padding: 9px 12px; outline: none; font-size: 14px; }
.foot button { border: none; border-radius: 10px; padding: 0 12px; cursor: pointer; font-size: 16px; height: 36px; }
.foot .attach { background: var(--pa-border); color: var(--pa-text-muted); font-size: 14px; }
.foot .mic { background: var(--pa-border); color: #9ff0c2; }
.foot .mic.on { background:var(--pa-accent); color:#fff; }
.foot .tts { background: var(--pa-border); color: var(--pa-text-muted); font-size: 18px; }
.foot .tts.on { background:#0d9488; color:#ecfdf5; }
.foot .send { background: var(--pa-accent); color: #fff; }
.scanline { position:fixed; left:0; right:0; height:3px; background:linear-gradient(90deg,transparent,#4ade80,transparent); z-index:2147483645; display:none; animation: sweep 1.4s ease-in-out infinite; }
.scanline.on { display:block; }
@keyframes sweep { 0%{top:0} 100%{top:100vh} }
.kbd-hint { position:absolute; bottom:4px; left:50%; transform:translateX(-50%); font-size:10px; color:var(--pa-text-muted); opacity:.6; }
`;

export class WidgetUI {
  private root: ShadowRoot;
  private launcher!: HTMLButtonElement;
  private panelWrap!: HTMLDivElement;
  private panel!: HTMLDivElement;
  private log!: HTMLDivElement;
  private input!: HTMLInputElement;
  private micBtn!: HTMLButtonElement;
  private ttsBtn!: HTMLButtonElement;
  private scanline!: HTMLDivElement;
  private sidebar?: ChatSidebar;
  private sidebarEl?: HTMLDivElement;
  private attachPreview!: HTMLDivElement;
  private fileInput!: HTMLInputElement;
  private pendingAttachments: FileAttachment[] = [];
  private sidebarOpen: boolean;
  private theme: ThemeMode;
  private styleEl!: HTMLStyleElement;

  constructor(
    private title: string,
    private handlers: UIHandlers,
    private opts: UIOptions = {}
  ) {
    this.sidebarOpen = opts.sidebarOpen ?? true;
    this.theme = opts.theme ?? "dark";
    const host = document.createElement("div");
    host.id = "page-assistant-root";
    document.body.appendChild(host);
    this.root = host.attachShadow({ mode: "open" });
    this.render();
    this.bindKeyboard();
  }

  private render() {
    this.styleEl = document.createElement("style");
    this.styleEl.textContent = `:host { ${themeCssVars(this.theme)} } ${CSS}`;
    this.root.appendChild(this.styleEl);

    this.scanline = el("div", "scanline");
    this.launcher = el("button", "launcher") as HTMLButtonElement;
    this.launcher.innerHTML = PHONE_SVG;
    this.launcher.title = this.title;
    this.launcher.setAttribute("aria-label", `Open ${this.title}`);

    this.panelWrap = el("div", "panel-wrap") as HTMLDivElement;
    this.panel = el("div", "panel") as HTMLDivElement;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", this.title);

    if (this.opts.chatStore) {
      const handlers: ChatSidebarHandlers = {
        onSelect: (id) => this.handlers.onSelectChat?.(id),
        onNew: () => this.handlers.onNewChat?.(),
        onDelete: (id) => this.opts.chatStore!.delete(id),
        onArchive: (id) => {
          const s = this.opts.chatStore!.get(id);
          this.opts.chatStore!.archive(id, !s?.archived);
        },
        onPin: (id, pinned) => this.opts.chatStore!.pin(id, pinned),
        onRename: (id, title) => this.opts.chatStore!.rename(id, title),
        onFork: (id) => {
          this.opts.chatStore!.fork(id);
          this.handlers.onSelectChat?.(this.opts.chatStore!.getActiveId()!);
        },
        onMarkUnread: (id) => this.opts.chatStore!.markUnread(id, true),
        onShare: (id) => {
          const json = this.opts.chatStore!.share(id);
          if (json) navigator.clipboard?.writeText(json);
        },
        onSearch: () => {},
        onToggle: (open) => this.setSidebarOpen(open),
      };
      this.opts.onSidebarHandlers?.(handlers);
      this.sidebar = new ChatSidebar(this.opts.chatStore, handlers, this.opts.chatStore.getActiveId());
      this.sidebarEl = this.sidebar.render();
      if (!this.sidebarOpen) this.sidebar.setCollapsed(true);
      this.panel.appendChild(this.sidebarEl);
    }

    const body = el("div", "panel-body");
    const head = el("div", "head");
    head.innerHTML = `<span class="dot"></span>${escapeHtml(this.title)}`;
    const actions = el("div", "actions");
    if (this.opts.chatStore) {
      const sidebarToggle = el<HTMLButtonElement>("button");
      sidebarToggle.textContent = "☰";
      sidebarToggle.title = "Toggle chat history";
      sidebarToggle.onclick = () => this.setSidebarOpen(!this.sidebarOpen);
      actions.appendChild(sidebarToggle);
    }
    const exportBtn = el<HTMLButtonElement>("button");
    exportBtn.textContent = "↓";
    exportBtn.title = "Export chat";
    exportBtn.onclick = () => this.handlers.onExportChat?.();
    const settingsBtn = el<HTMLButtonElement>("button");
    settingsBtn.textContent = "⚙";
    settingsBtn.title = "Assistant settings";
    settingsBtn.onclick = () => this.handlers.onSettings?.();
    const closeBtn = el<HTMLButtonElement>("button");
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close assistant");
    closeBtn.onclick = () => this.toggle(false);
    actions.append(exportBtn, settingsBtn, closeBtn);
    head.appendChild(actions);

    this.log = el("div", "log") as HTMLDivElement;
    this.attachPreview = el("div", "attach-preview") as HTMLDivElement;

    const foot = el("div", "foot");
    this.fileInput = el("input") as HTMLInputElement;
    this.fileInput.type = "file";
    this.fileInput.multiple = true;
    this.fileInput.accept = ".txt,.md,.csv,.json,.js,.ts,.html,.css,.yaml,.yml,.xml,.log,image/*";
    this.fileInput.style.display = "none";
    this.fileInput.onchange = () => this.handleFiles();
    const attachBtn = el("button", "attach") as HTMLButtonElement;
    attachBtn.textContent = "📎";
    attachBtn.title = "Attach file";
    attachBtn.onclick = () => this.fileInput.click();
    this.input = el("input") as HTMLInputElement;
    this.input.type = "text";
    this.input.placeholder = "Ask or tell me to do something…";
    this.ttsBtn = el("button", "tts") as HTMLButtonElement;
    this.ttsBtn.textContent = "☎";
    this.ttsBtn.title = "Read replies aloud (off)";
    this.micBtn = el("button", "mic") as HTMLButtonElement;
    this.micBtn.textContent = "🎙";
    this.micBtn.setAttribute("aria-label", "Speak to the assistant");
    const send = el("button", "send") as HTMLButtonElement;
    send.textContent = "➤";
    send.setAttribute("aria-label", "Send message");

    foot.append(attachBtn, this.input, this.ttsBtn, this.micBtn, send);
    body.append(head, this.log, this.attachPreview, foot);
    this.panel.appendChild(body);
    this.panelWrap.appendChild(this.panel);
    this.root.append(this.scanline, this.launcher, this.panelWrap, this.fileInput);

    this.launcher.onclick = () => this.toggle();
    send.onclick = () => this.submit();
    this.input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) this.submit();
    };
    this.micBtn.onclick = () => this.handlers.onMic();
    this.ttsBtn.onclick = () => {
      const on = !this.ttsBtn.classList.contains("on");
      this.setTtsEnabled(on);
      this.handlers.onTtsToggle?.(on);
    };
  }

  private bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (!this.panelWrap.classList.contains("open")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "k") {
        e.preventDefault();
        this.input.focus();
      }
      if (mod && e.key === "n") {
        e.preventDefault();
        this.handlers.onNewChat?.();
      }
      if (mod && e.key === "b") {
        e.preventDefault();
        this.setSidebarOpen(!this.sidebarOpen);
      }
      if (e.key === "Escape") this.toggle(false);
    });
  }

  private async handleFiles() {
    const { readFileAttachment } = await import("./fileUpload.js");
    for (const file of Array.from(this.fileInput.files ?? [])) {
      const result = await readFileAttachment(file);
      if ("error" in result) {
        this.addMessage("system", result.error);
      } else {
        this.pendingAttachments.push(result);
      }
    }
    this.fileInput.value = "";
    this.refreshAttachPreview();
  }

  private refreshAttachPreview() {
    this.attachPreview.innerHTML = "";
    for (const a of this.pendingAttachments) {
      const tag = el("span", "attach-tag");
      tag.textContent = a.name;
      this.attachPreview.appendChild(tag);
    }
  }

  setSidebarOpen(open: boolean) {
    this.sidebarOpen = open;
    this.sidebar?.setCollapsed(!open);
  }

  setTheme(theme: ThemeMode) {
    this.theme = theme;
    this.styleEl.textContent = `:host { ${themeCssVars(theme)} } ${CSS}`;
  }

  setActiveChat(id: string | null) {
    this.sidebar?.setActive(id);
  }

  private submit() {
    const t = this.input.value.trim();
    if (!t && !this.pendingAttachments.length) return;
    this.input.value = "";
    const attachments = [...this.pendingAttachments];
    this.pendingAttachments = [];
    this.refreshAttachPreview();
    this.handlers.onSend(t, attachments.length ? attachments : undefined);
  }

  toggle(open?: boolean) {
    const willOpen = open ?? !this.panelWrap.classList.contains("open");
    this.panelWrap.classList.toggle("open", willOpen);
    if (willOpen) this.input.focus();
    this.handlers.onToggle?.(willOpen);
  }

  setMic(on: boolean) {
    this.micBtn.classList.toggle("on", on);
  }

  setTtsEnabled(on: boolean) {
    this.ttsBtn.classList.toggle("on", on);
    this.ttsBtn.title = on ? "Read replies aloud (on)" : "Read replies aloud (off)";
  }

  clearLog() {
    this.log.innerHTML = "";
  }

  loadMessages(messages: Array<{ role: string; content: string }>) {
    this.clearLog();
    for (const m of messages) {
      if (m.role === "user" || m.role === "assistant" || m.role === "system") {
        this.addMessage(m.role, m.content);
      }
    }
  }

  addMessage(role: "user" | "assistant" | "system", text: string) {
    const m = el("div", `msg ${role}`);
    m.textContent = text;
    this.log.appendChild(m);
    this.log.scrollTop = this.log.scrollHeight;
    return m;
  }

  addConfirm(preview: string) {
    const wrap = el("div", "msg assistant");
    wrap.textContent = preview;
    const row = el("div", "confirm");
    const yes = el("button", "yes") as HTMLButtonElement;
    yes.textContent = "Confirm";
    const no = el("button", "no") as HTMLButtonElement;
    no.textContent = "Cancel";
    yes.onclick = () => {
      row.remove();
      this.handlers.onConfirm(true);
    };
    no.onclick = () => {
      row.remove();
      this.handlers.onConfirm(false);
    };
    row.append(yes, no);
    wrap.appendChild(row);
    this.log.appendChild(wrap);
    this.log.scrollTop = this.log.scrollHeight;
  }

  addSuggestions(items: string[], onPick: (t: string) => void) {
    if (!items.length) return;
    const wrap = el("div", "msg system");
    wrap.textContent = "Try:";
    const row = el("div", "chips");
    for (const it of items.slice(0, 4)) {
      const c = el("button", "chip") as HTMLButtonElement;
      c.textContent = it.length > 48 ? it.slice(0, 46) + "…" : it;
      c.title = it;
      c.onclick = () => {
        row.parentElement?.remove();
        onPick(it);
      };
      row.appendChild(c);
    }
    wrap.appendChild(row);
    this.log.appendChild(wrap);
    this.log.scrollTop = this.log.scrollHeight;
  }

  setState(s: MascotState) {
    this.launcher.classList.remove("talking", "thinking", "listening", "scanning");
    if (s !== "idle") this.launcher.classList.add(s);
    this.scanline.classList.toggle("on", s === "scanning");
  }
}

function el<T extends HTMLElement = HTMLElement>(tag: string, cls?: string): T {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e as unknown as T;
}
function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

const PHONE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8c1.5 2.9 3.7 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>`;
