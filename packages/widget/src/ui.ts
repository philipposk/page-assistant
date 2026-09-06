// Self-contained floating widget UI rendered in a shadow root (no host CSS bleed).
// Bottom-right launcher + panel + sidebar + animated mascot.

import type { ChatHistoryStore } from "./chatHistory.js";
import { ChatSidebar, type ChatSidebarHandlers } from "./chatSidebar.js";
import type { FileAttachment } from "./fileUpload.js";
import type { ThemeMode } from "./assistant-settings.js";
import { themeCssVars } from "./themes.js";
import { DEFAULT_STRINGS, fmt, type WidgetStrings } from "./strings.js";

export type MascotState = "idle" | "listening" | "thinking" | "talking" | "scanning";

/**
 * The read-aloud toggle. It used to be a telephone (☎), which reads as "call support"
 * rather than "speak this reply" — and the launcher's telephone was already removed for
 * the same reason. On/off are visibly different marks, not just a colour change, so the
 * state is readable without relying on the accent colour.
 */
const TTS_GLYPH = { on: "🔊", off: "🔈" } as const;

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
  /** Return true if the deleted/archived id was the active chat (so the store op ran). */
  onDeleteChat?: (id: string) => void;
  onArchiveChat?: (id: string) => void;
}

export interface UIOptions {
  /** The mark on the launcher button: a name from LAUNCHER_ICONS, raw SVG, or a character. */
  launcherIcon?: string;
  chatStore?: ChatHistoryStore;
  theme?: ThemeMode;
  sidebarOpen?: boolean;
  imagesEnabled?: boolean;
  onSidebarHandlers?: (h: ChatSidebarHandlers) => void;
  /** Fully-resolved chrome strings (defaults merged with host overrides). */
  strings?: WidgetStrings;
  /**
   * False when nothing can back the mic (no SpeechRecognition AND no server STT). The
   * button is then rendered visibly disabled with an explanation instead of silently
   * doing nothing when tapped.
   */
  micAvailable?: boolean;
  /** BCP-47 language, set on the widget host so assistive tech pronounces it correctly. */
  lang?: string;
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif; }
.launcher {
  position: fixed; right: calc(22px + env(safe-area-inset-right)); bottom: calc(22px + env(safe-area-inset-bottom));
  width: 60px; height: 60px; border-radius: 50%;
  border: none; cursor: pointer; z-index: 2147483646;
  background: radial-gradient(circle at 30% 30%, var(--pa-launcher-from), var(--pa-launcher-to));
  box-shadow: 0 8px 28px rgba(13,148,136,.45); transition: transform .25s, box-shadow .25s;
  display:flex; align-items:center; justify-content:center; color:#042f2e;
}
.launcher svg { width: 28px; height: 28px; fill: currentColor; }
.launcher .glyph { font-size: 24px; line-height: 1; }
.launcher:hover { transform: scale(1.08); }
.launcher.talking { animation: bob .5s infinite alternate; }
.launcher.thinking { animation: spin 1.2s linear infinite; }
.launcher.listening { box-shadow: 0 0 0 6px rgba(94,234,212,.35), 0 8px 28px rgba(13,148,136,.45); }
.launcher.scanning { animation: pulse .8s infinite; }
@keyframes bob { to { transform: translateY(-4px); } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 50% { box-shadow: 0 0 0 10px rgba(94,234,212,.25), 0 8px 28px rgba(13,148,136,.45); } }
.panel-wrap {
  position: fixed; right: calc(22px + env(safe-area-inset-right)); bottom: calc(92px + env(safe-area-inset-bottom));
  z-index: 2147483646; display: none;
}
.panel-wrap.open { display: flex; }
.panel {
  position: relative;
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
.msg.system { align-self: center; font-size: 12px; opacity: .75; background: transparent; }
.msg.error {
  align-self: center; background: var(--pa-error-bg); color: var(--pa-error-text);
  border: 1px solid var(--pa-error-border); font-size: 13px; opacity: 1; max-width: 92%;
  display: flex; flex-direction: column; gap: 6px;
}
.msg.error .retry {
  align-self: flex-start; background: var(--pa-accent); color: #fff; border: none;
  border-radius: 8px; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer;
}
.typing { align-self: flex-start; display: flex; gap: 4px; padding: 11px 14px; background: var(--pa-bg-msg-asst); border: 1px solid var(--pa-border); border-radius: 12px; }
.typing span { width: 7px; height: 7px; border-radius: 50%; background: var(--pa-text-muted); opacity: .5; animation: blink 1.2s infinite; }
.typing span:nth-child(2) { animation-delay: .2s; }
.typing span:nth-child(3) { animation-delay: .4s; }
@keyframes blink { 0%,60%,100% { opacity:.3; transform:translateY(0);} 30% { opacity:1; transform:translateY(-3px);} }
.confirm { display:flex; gap:8px; margin-top:6px; }
.confirm button { flex:1; padding:7px; border-radius:8px; border:none; cursor:pointer; font-weight:600; }
.confirm .yes { background:var(--pa-accent); color:#fff; } .confirm .no { background:var(--pa-border); color:var(--pa-text); }
.chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.chip { background:var(--pa-bg-sidebar); border:1px solid var(--pa-border); color:var(--pa-text); border-radius:14px; padding:6px 11px; font-size:12px; cursor:pointer; }
.chip:hover { opacity: .85; }
.attach-preview { display:flex; flex-wrap:wrap; gap:4px; padding: 4px 10px; }
.attach-tag { font-size:11px; background:var(--pa-bg-sidebar); border:1px solid var(--pa-border); border-radius:6px; padding:2px 6px; color:var(--pa-text-muted); display:inline-flex; align-items:center; gap:4px; }
.attach-tag button { background:none; border:none; color:var(--pa-text-muted); cursor:pointer; font-size:12px; line-height:1; padding:0; }
.attach-tag button:hover { color:var(--pa-text); }
.foot { padding: 10px; border-top: 1px solid var(--pa-border); display: flex; gap: 8px; align-items: center; }
.foot input[type=text] { flex: 1; background: var(--pa-bg-input); border: 1px solid var(--pa-border); color: var(--pa-text); border-radius: 10px; padding: 9px 12px; outline: none; font-size: 16px; }
.foot input[type=text]:disabled { opacity: .6; }
.foot button { border: none; border-radius: 10px; padding: 0 12px; cursor: pointer; font-size: 16px; height: 36px; }
.foot button:disabled { opacity: .5; cursor: default; }
.foot .attach { background: var(--pa-border); color: var(--pa-text-muted); font-size: 14px; }
.foot .mic { background: var(--pa-border); color: var(--pa-mic-glyph); position: relative; }
.foot .mic.on { background:var(--pa-accent); color:#fff; }
.foot .mic .countdown { position:absolute; top:-6px; right:-4px; background:var(--pa-accent); color:#fff; font-size:9px; min-width:14px; height:14px; border-radius:7px; display:none; align-items:center; justify-content:center; padding:0 3px; }
.foot .mic.counting .countdown { display:flex; }
.foot .mic.unavailable { opacity:.4; cursor:not-allowed; }
.foot .tts { background: var(--pa-border); color: var(--pa-text-muted); font-size: 18px; }
.foot .tts.on { background:#0d9488; color:#ecfdf5; }
.foot .send { background: var(--pa-accent); color: #fff; }
.scanline { position:fixed; left:0; right:0; height:3px; background:linear-gradient(90deg,transparent,#4ade80,transparent); z-index:2147483645; display:none; animation: sweep 1.4s ease-in-out infinite; }
.scanline.on { display:block; }
@keyframes sweep { 0%{top:0} 100%{top:100vh} }
.toast { position:fixed; left:50%; bottom:100px; transform:translateX(-50%); background:var(--pa-bg-head); color:var(--pa-text); border:1px solid var(--pa-border); border-radius:10px; padding:8px 14px; font-size:13px; z-index:2147483647; box-shadow:0 8px 24px rgba(0,0,0,.4); opacity:0; transition:opacity .2s; pointer-events:none; }
.toast.show { opacity:1; }
/* Highlight ring for the visual action preview — drawn in the shadow root, never in host DOM. */
.pa-highlight { position:fixed; z-index:2147483644; border:3px solid var(--pa-accent); border-radius:8px; box-shadow:0 0 0 3px rgba(22,163,74,.35), 0 0 20px rgba(22,163,74,.5); pointer-events:none; transition:all .2s ease; }
.pa-highlight::after { content:"👉"; position:absolute; left:-26px; top:50%; transform:translateY(-50%); font-size:18px; }
.kbd-hint { position:absolute; bottom:4px; left:50%; transform:translateX(-50%); font-size:10px; color:var(--pa-text-muted); opacity:.6; }
/* Scrim behind the overlay sidebar on phones — tap it to dismiss the sidebar. */
.sidebar-scrim { position: absolute; inset: 0; z-index: 4; background: rgba(0,0,0,.4); display: none; }
.sidebar-scrim.show { display: block; }
@media (min-width: 521px) { .sidebar-scrim { display: none !important; } }
@media (max-width: 520px) {
  .panel { width: calc(100vw - 16px); height: calc(100dvh - 110px); max-height: calc(100dvh - 110px); }
  .panel-wrap { right: 8px; left: 8px; bottom: calc(84px + env(safe-area-inset-bottom)); }
}
@media (prefers-reduced-motion: reduce) {
  .launcher.talking, .launcher.thinking, .launcher.scanning { animation: none; }
  .launcher.listening { box-shadow: 0 0 0 6px rgba(94,234,212,.35), 0 8px 28px rgba(13,148,136,.45); }
  .scanline { animation: none; top: 50%; }
  .typing span { animation: none; opacity: .6; }
}
`;

// Contrast tokens layered on top of the theme vars. Fixes AA failures:
// user bubble was #fff on #059669 (~3.7:1) and mic glyph #9ff0c2 on light border.
const CONTRAST_VARS: Record<"dark" | "light", string> = {
  dark: "--pa-mic-glyph:#9ff0c2; --pa-error-bg:#3a1414; --pa-error-text:#fecaca; --pa-error-border:#7f1d1d;",
  light: "--pa-mic-glyph:#047857; --pa-error-bg:#fef2f2; --pa-error-text:#991b1b; --pa-error-border:#fecaca;",
};

export class WidgetUI {
  private root: ShadowRoot;
  private host: HTMLDivElement;
  private launcher!: HTMLButtonElement;
  private panelWrap!: HTMLDivElement;
  private panel!: HTMLDivElement;
  private log!: HTMLDivElement;
  private input!: HTMLInputElement;
  private micBtn!: HTMLButtonElement;
  private micCountdown!: HTMLSpanElement;
  private ttsBtn!: HTMLButtonElement;
  private sendBtn!: HTMLButtonElement;
  private attachBtn!: HTMLButtonElement;
  private scanline!: HTMLDivElement;
  private toastEl!: HTMLDivElement;
  private sidebar?: ChatSidebar;
  private sidebarEl?: HTMLDivElement;
  private sidebarScrim?: HTMLDivElement;
  private attachPreview!: HTMLDivElement;
  private fileInput!: HTMLInputElement;
  private pendingAttachments: FileAttachment[] = [];
  private sidebarOpen: boolean;
  private theme: ThemeMode;
  private styleEl!: HTMLStyleElement;
  private typingEl?: HTMLDivElement;
  private confirmRow?: HTMLDivElement;
  private highlightEl?: HTMLDivElement;
  private highlightTarget?: Element;
  private highlightReanchor?: () => void;
  private busy = false;
  private lastFocused?: HTMLElement;
  private keydownHandler?: (e: KeyboardEvent) => void;
  private viewportHandler?: () => void;
  /** Resolved chrome strings — every user-facing literal below reads from here. */
  private s: WidgetStrings = DEFAULT_STRINGS;

  constructor(
    private title: string,
    private handlers: UIHandlers,
    private opts: UIOptions = {}
  ) {
    // On phones the sidebar overlays the chat, so defaulting it open hides the conversation
    // behind it on first open. Default it CLOSED at ≤520px regardless of the stored setting.
    const isNarrow = typeof matchMedia !== "undefined" && matchMedia("(max-width: 520px)").matches;
    this.sidebarOpen = isNarrow ? false : opts.sidebarOpen ?? true;
    this.theme = opts.theme ?? "dark";
    this.s = opts.strings ?? DEFAULT_STRINGS;
    this.host = document.createElement("div");
    this.host.id = "page-assistant-root";
    if (opts.lang) this.host.lang = opts.lang;
    document.body.appendChild(this.host);
    this.root = this.host.attachShadow({ mode: "open" });
    this.render();
    this.bindKeyboard();
    this.bindViewport();
  }

  private themeStyle(theme: ThemeMode): string {
    const resolved = theme === "light" || (theme === "system" && matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
    return `:host { ${themeCssVars(theme)}; ${CONTRAST_VARS[resolved]} } ${CSS}`;
  }

  private render() {
    this.styleEl = document.createElement("style");
    this.styleEl.textContent = this.themeStyle(this.theme);
    this.root.appendChild(this.styleEl);

    this.scanline = el("div", "scanline");
    this.toastEl = el("div", "toast") as HTMLDivElement;
    this.launcher = el("button", "launcher") as HTMLButtonElement;
    this.launcher.innerHTML = resolveLauncherIcon(this.opts.launcherIcon);
    this.launcher.title = this.title;
    this.launcher.setAttribute("aria-label", fmt(this.s.launcherOpen, { title: this.title }));
    this.launcher.setAttribute("aria-expanded", "false");

    this.panelWrap = el("div", "panel-wrap") as HTMLDivElement;
    this.panel = el("div", "panel") as HTMLDivElement;
    this.panel.setAttribute("role", "dialog");
    // NOT aria-modal: this is a non-modal floating panel — the host page stays interactive,
    // so marking it modal would make screen readers treat the whole page as inert.
    this.panel.setAttribute("aria-label", this.title);

    if (this.opts.chatStore) {
      const handlers: ChatSidebarHandlers = {
        onSelect: (id) => this.handlers.onSelectChat?.(id),
        onNew: () => this.handlers.onNewChat?.(),
        // Route delete/archive through the controller so it can detect when the ACTIVE
        // chat was removed and start a fresh one (otherwise persistCurrentChat no-ops).
        onDelete: (id) => this.handlers.onDeleteChat?.(id),
        onArchive: (id) => this.handlers.onArchiveChat?.(id),
        onPin: (id, pinned) => this.opts.chatStore!.pin(id, pinned),
        onRename: (id, title) => this.opts.chatStore!.rename(id, title),
        onFork: (id) => {
          this.opts.chatStore!.fork(id);
          this.handlers.onSelectChat?.(this.opts.chatStore!.getActiveId()!);
        },
        onMarkUnread: (id) => this.opts.chatStore!.markUnread(id, true),
        onShare: (id) => {
          const json = this.opts.chatStore!.share(id);
          if (json) {
            navigator.clipboard?.writeText(json).then(
              () => this.toast(this.s.copied),
              () => this.toast(this.s.copyFailed)
            );
          }
        },
        onSearch: () => {},
        onToggle: (open) => this.setSidebarOpen(open),
      };
      this.opts.onSidebarHandlers?.(handlers);
      this.sidebar = new ChatSidebar(this.opts.chatStore, handlers, this.opts.chatStore.getActiveId());
      this.sidebarEl = this.sidebar.render();
      if (!this.sidebarOpen) this.sidebar.setCollapsed(true);
      this.panel.appendChild(this.sidebarEl);
      // Scrim behind the overlay sidebar on phones: tapping outside the sidebar closes it.
      const scrim = el("div", "sidebar-scrim") as HTMLDivElement;
      scrim.onclick = () => this.setSidebarOpen(false);
      if (this.sidebarOpen) scrim.classList.add("show");
      this.sidebarScrim = scrim;
      this.panel.appendChild(scrim);
    }

    const body = el("div", "panel-body");
    const head = el("div", "head");
    head.innerHTML = `<span class="dot"></span>${escapeHtml(this.title)}`;
    const actions = el("div", "actions");
    if (this.opts.chatStore) {
      const sidebarToggle = el<HTMLButtonElement>("button");
      sidebarToggle.textContent = "☰";
      sidebarToggle.title = this.s.historyToggle;
      sidebarToggle.setAttribute("aria-label", this.s.historyToggle);
      sidebarToggle.setAttribute("aria-pressed", String(this.sidebarOpen));
      sidebarToggle.onclick = () => {
        this.setSidebarOpen(!this.sidebarOpen);
        sidebarToggle.setAttribute("aria-pressed", String(this.sidebarOpen));
      };
      actions.appendChild(sidebarToggle);
    }
    const exportBtn = el<HTMLButtonElement>("button");
    exportBtn.textContent = "↓";
    exportBtn.title = this.s.exportChat;
    exportBtn.setAttribute("aria-label", this.s.exportChat);
    exportBtn.onclick = () => this.handlers.onExportChat?.();
    const settingsBtn = el<HTMLButtonElement>("button");
    settingsBtn.textContent = "⚙";
    settingsBtn.title = this.s.settings;
    settingsBtn.setAttribute("aria-label", this.s.settings);
    settingsBtn.onclick = () => this.handlers.onSettings?.();
    const closeBtn = el<HTMLButtonElement>("button");
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", this.s.close);
    closeBtn.onclick = () => this.toggle(false);
    actions.append(exportBtn, settingsBtn, closeBtn);
    head.appendChild(actions);

    this.log = el("div", "log") as HTMLDivElement;
    // Screen readers announce assistant/system replies as they arrive.
    this.log.setAttribute("role", "log");
    this.log.setAttribute("aria-live", "polite");
    this.log.setAttribute("aria-relevant", "additions");
    this.attachPreview = el("div", "attach-preview") as HTMLDivElement;

    const foot = el("div", "foot");
    this.fileInput = el("input") as HTMLInputElement;
    this.fileInput.type = "file";
    this.fileInput.multiple = true;
    // Only advertise image/* in the picker when the host wired up vision support.
    this.fileInput.accept = ".txt,.md,.csv,.json,.js,.ts,.html,.css,.yaml,.yml,.xml,.log" + (this.opts.imagesEnabled ? ",image/*" : "");
    this.fileInput.style.display = "none";
    this.fileInput.onchange = () => this.handleFiles();
    const attachBtn = el("button", "attach") as HTMLButtonElement;
    attachBtn.textContent = "📎";
    attachBtn.title = this.s.attach;
    attachBtn.setAttribute("aria-label", this.s.attach);
    attachBtn.onclick = () => this.fileInput.click();
    this.attachBtn = attachBtn;
    this.input = el("input") as HTMLInputElement;
    this.input.type = "text";
    this.input.placeholder = this.s.inputPlaceholder;
    this.input.setAttribute("aria-label", this.s.inputLabel);
    this.ttsBtn = el("button", "tts") as HTMLButtonElement;
    this.ttsBtn.textContent = TTS_GLYPH.off;
    this.ttsBtn.title = this.s.readAloudOff;
    this.ttsBtn.setAttribute("aria-label", this.s.readAloud);
    this.ttsBtn.setAttribute("aria-pressed", "false");
    this.micBtn = el("button", "mic") as HTMLButtonElement;
    this.micBtn.textContent = "🎙";
    this.micCountdown = el("span", "countdown") as HTMLSpanElement;
    this.micBtn.appendChild(this.micCountdown);
    this.micBtn.setAttribute("aria-label", this.s.mic);
    this.micBtn.setAttribute("aria-pressed", "false");
    // A control that cannot work must not look like one that can.
    if (this.opts.micAvailable === false) {
      this.micBtn.disabled = true;
      this.micBtn.classList.add("unavailable");
      this.micBtn.title = this.s.micUnavailable;
      this.micBtn.setAttribute("aria-label", this.s.micUnavailable);
      this.micBtn.setAttribute("aria-disabled", "true");
    }
    this.sendBtn = el("button", "send") as HTMLButtonElement;
    this.sendBtn.textContent = "➤";
    this.sendBtn.setAttribute("aria-label", this.s.send);

    foot.append(attachBtn, this.input, this.ttsBtn, this.micBtn, this.sendBtn);
    body.append(head, this.log, this.attachPreview, foot);
    this.panel.appendChild(body);
    this.panelWrap.appendChild(this.panel);
    this.root.append(this.scanline, this.toastEl, this.launcher, this.panelWrap, this.fileInput);

    this.launcher.onclick = () => this.toggle();
    this.sendBtn.onclick = () => this.submit();
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
    this.keydownHandler = (e: KeyboardEvent) => {
      if (!this.panelWrap.classList.contains("open")) return;
      const mod = e.metaKey || e.ctrlKey;
      // Only capture the shortcut when focus is inside the widget, so host-app
      // Cmd/Ctrl+K/N/B keep working when the user isn't in the assistant.
      const inside = this.root.contains((e.composedPath?.()[0] as Node) ?? (e.target as Node));
      if (mod && inside && e.key === "k") {
        e.preventDefault();
        this.input.focus();
      }
      if (mod && inside && e.key === "n") {
        e.preventDefault();
        this.handlers.onNewChat?.();
      }
      if (mod && inside && e.key === "b") {
        e.preventDefault();
        this.setSidebarOpen(!this.sidebarOpen);
      }
      if (e.key === "Escape") {
        // If a chat context menu is open, Escape dismisses the MENU first, not the panel.
        if (this.sidebar?.closeContextMenuIfOpen()) {
          e.preventDefault();
          return;
        }
        // Scope Escape to the widget like the other shortcuts — a non-modal floating panel
        // must not swallow Escape from the host page (forms, other dialogs, etc.).
        if (!inside) return;
        e.preventDefault();
        this.toggle(false);
      }
      if (e.key === "Tab") this.trapFocus(e);
    };
    document.addEventListener("keydown", this.keydownHandler);
  }

  private bindViewport() {
    // Keep the panel above the on-screen keyboard on mobile (visualViewport shrinks
    // when the keyboard opens). Offset the launcher/panel by the covered height.
    const vv = (window as any).visualViewport as VisualViewport | undefined;
    if (!vv) return;
    this.viewportHandler = () => {
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      const px = overlap > 60 ? overlap : 0; // ignore small toolbar jitter
      this.panelWrap.style.transform = px ? `translateY(-${px}px)` : "";
    };
    vv.addEventListener("resize", this.viewportHandler);
    vv.addEventListener("scroll", this.viewportHandler);
  }

  private focusables(): HTMLElement[] {
    const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    return [...this.panel.querySelectorAll<HTMLElement>(sel)].filter(
      (e) => !e.hasAttribute("disabled") && e.offsetParent !== null
    );
  }

  private trapFocus(e: KeyboardEvent) {
    const items = this.focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = (this.root.activeElement as HTMLElement) ?? document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  private async handleFiles() {
    const { readFileAttachment } = await import("./fileUpload.js");
    for (const file of Array.from(this.fileInput.files ?? [])) {
      const result = await readFileAttachment(file, { imagesEnabled: this.opts.imagesEnabled });
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
    this.pendingAttachments.forEach((a, i) => {
      const tag = el("span", "attach-tag");
      const label = el("span");
      label.textContent = a.name;
      const rm = el("button") as HTMLButtonElement;
      rm.textContent = "×";
      rm.setAttribute("aria-label", fmt(this.s.removeAttachment, { name: a.name }));
      rm.onclick = () => {
        this.pendingAttachments.splice(i, 1);
        this.refreshAttachPreview();
      };
      tag.append(label, rm);
      this.attachPreview.appendChild(tag);
    });
  }

  setSidebarOpen(open: boolean) {
    this.sidebarOpen = open;
    this.sidebar?.setCollapsed(!open);
    this.sidebarScrim?.classList.toggle("show", open);
  }

  setTheme(theme: ThemeMode) {
    this.theme = theme;
    this.styleEl.textContent = this.themeStyle(theme);
  }

  setActiveChat(id: string | null) {
    this.sidebar?.setActive(id);
  }

  toast(text: string) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("show");
    setTimeout(() => this.toastEl.classList.remove("show"), 2200);
  }

  private submit() {
    if (this.busy) return; // guard: no double-send while a request is in flight
    const t = this.input.value.trim();
    if (!t && !this.pendingAttachments.length) return;
    this.input.value = "";
    const attachments = [...this.pendingAttachments];
    this.pendingAttachments = [];
    this.refreshAttachPreview();
    this.handlers.onSend(t, attachments.length ? attachments : undefined);
  }

  /** Lock/unlock all input affordances while a request is in flight. */
  setBusy(busy: boolean) {
    this.busy = busy;
    this.input.disabled = busy;
    this.sendBtn.disabled = busy;
    // Also lock mic + attach + suggestion chips: tapping the mic mid-request started a
    // concurrent handleUser that raced the history.
    this.micBtn.disabled = busy;
    this.attachBtn.disabled = busy;
    this.log.querySelectorAll<HTMLButtonElement>(".chip").forEach((c) => (c.disabled = busy));
    if (busy) this.showTyping();
    else this.hideTyping();
  }

  private showTyping() {
    if (this.typingEl) return;
    const t = el("div", "typing") as HTMLDivElement;
    t.setAttribute("aria-label", this.s.thinking);
    t.innerHTML = "<span></span><span></span><span></span>";
    this.log.appendChild(t);
    this.typingEl = t;
    this.log.scrollTop = this.log.scrollHeight;
  }

  private hideTyping() {
    this.typingEl?.remove();
    this.typingEl = undefined;
  }

  toggle(open?: boolean) {
    const willOpen = open ?? !this.panelWrap.classList.contains("open");
    this.panelWrap.classList.toggle("open", willOpen);
    this.launcher.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) {
      this.lastFocused = (document.activeElement as HTMLElement) ?? undefined;
      this.input.focus();
    } else {
      // Closing must not leave a green action-preview ring floating on the host page.
      this.clearHighlight();
      // Return focus to whatever launched the dialog (falls back to the launcher).
      (this.lastFocused ?? this.launcher).focus();
    }
    this.handlers.onToggle?.(willOpen);
  }

  setMic(on: boolean) {
    this.micBtn.classList.toggle("on", on);
    this.micBtn.setAttribute("aria-pressed", String(on));
    this.micBtn.setAttribute("aria-label", on ? this.s.micStop : this.s.mic);
    if (!on) this.setMicCountdown(null);
  }

  /** Show a remaining-seconds badge on the mic during the server-STT capture window. */
  setMicCountdown(seconds: number | null) {
    if (seconds === null) {
      this.micBtn.classList.remove("counting");
      this.micCountdown.textContent = "";
    } else {
      this.micBtn.classList.add("counting");
      this.micCountdown.textContent = String(Math.ceil(seconds));
    }
  }

  setTtsEnabled(on: boolean) {
    this.ttsBtn.classList.toggle("on", on);
    this.ttsBtn.textContent = on ? TTS_GLYPH.on : TTS_GLYPH.off;
    this.ttsBtn.title = on ? this.s.readAloudOn : this.s.readAloudOff;
    this.ttsBtn.setAttribute("aria-pressed", String(on));
  }

  clearLog() {
    this.clearConfirm();
    this.hideTyping();
    this.clearHighlight();
    this.log.innerHTML = "";
    this.typingEl = undefined;
  }

  loadMessages(messages: Array<{ role: string; content: string }>) {
    this.clearLog();
    // Bulk-restoring a chat would otherwise dump the ENTIRE conversation into the polite
    // live region, so a screen reader re-reads the whole history on every switch. Suspend
    // announcements for the bulk insert, then restore live so new replies still announce.
    this.log.setAttribute("aria-live", "off");
    for (const m of messages) {
      if (m.role === "user" || m.role === "assistant" || m.role === "system") {
        this.addMessage(m.role, m.content);
      }
    }
    this.log.setAttribute("aria-live", "polite");
  }

  addMessage(role: "user" | "assistant" | "system", text: string) {
    const m = el("div", `msg ${role}`);
    m.textContent = text;
    this.log.appendChild(m);
    this.log.scrollTop = this.log.scrollHeight;
    return m;
  }

  /** Error bubble with readable styling and optional retry. */
  addError(text: string, onRetry?: () => void) {
    const m = el("div", "msg error") as HTMLDivElement;
    // No role="alert" here: this bubble lives INSIDE the polite role="log" live region, so
    // an alert would make screen readers announce the error twice. The log announces the
    // addition once, which is enough.
    const line = el("div");
    line.textContent = text;
    m.appendChild(line);
    if (onRetry) {
      const btn = el("button", "retry") as HTMLButtonElement;
      btn.textContent = this.s.retry;
      btn.onclick = () => {
        m.remove();
        onRetry();
      };
      m.appendChild(btn);
    }
    this.log.appendChild(m);
    this.log.scrollTop = this.log.scrollHeight;
    return m;
  }

  private clearConfirm() {
    this.confirmRow?.remove();
    this.confirmRow = undefined;
  }

  /** Remove any stale confirm row (called when the controller clears `pending`). */
  removeConfirm() {
    this.clearConfirm();
  }

  addConfirm(preview: string) {
    this.clearConfirm(); // never leave a previous confirm row live in the DOM
    const wrap = el("div", "msg assistant") as HTMLDivElement;
    wrap.textContent = preview;
    const row = el("div", "confirm") as HTMLDivElement;
    const yes = el("button", "yes") as HTMLButtonElement;
    yes.textContent = this.s.confirm;
    const no = el("button", "no") as HTMLButtonElement;
    no.textContent = this.s.cancel;
    yes.onclick = () => {
      this.clearConfirm();
      this.clearHighlight();
      this.handlers.onConfirm(true);
    };
    no.onclick = () => {
      this.clearConfirm();
      this.clearHighlight();
      this.handlers.onConfirm(false);
    };
    row.append(yes, no);
    wrap.appendChild(row);
    this.log.appendChild(wrap);
    this.confirmRow = wrap;
    this.log.scrollTop = this.log.scrollHeight;
  }

  // ---- Visual action preview: highlight the control the assistant will operate ----

  /** Draw a highlight ring over a page element (in the shadow root). Defensive: no-op if gone. */
  highlightElement(selector: string): boolean {
    this.clearHighlight();
    let target: Element | null = null;
    try {
      target = document.querySelector(selector);
    } catch {
      return false;
    }
    if (!target) return false;
    const rect0 = target.getBoundingClientRect();
    if (!rect0.width && !rect0.height) return false;

    const ring = el("div", "pa-highlight") as HTMLDivElement;
    this.root.appendChild(ring);
    this.highlightEl = ring;
    this.highlightTarget = target;

    // Position the ring from the target's CURRENT rect. Called after the scroll settles and
    // on every scroll/resize so the ring tracks the element instead of being frozen at the
    // pre-scroll coordinates (the off-screen case is exactly the one that broke before).
    const place = () => {
      if (!this.highlightEl || !this.highlightTarget) return;
      const r = this.highlightTarget.getBoundingClientRect();
      if (!r.width && !r.height) return;
      const pad = 4;
      this.highlightEl.style.top = `${r.top - pad}px`;
      this.highlightEl.style.left = `${r.left - pad}px`;
      this.highlightEl.style.width = `${r.width + pad * 2}px`;
      this.highlightEl.style.height = `${r.height + pad * 2}px`;
    };
    place(); // draw immediately at the pre-scroll position so there's no flash of an unplaced ring

    // Measure AFTER the smooth scroll settles. Prefer the native scrollend event; fall back
    // to a rAF loop that waits until the target's rect stops moving.
    let scrollSettled = false;
    const onScrollEnd = () => {
      if (scrollSettled) return;
      scrollSettled = true;
      window.removeEventListener("scrollend", onScrollEnd);
      place();
    };
    if ("onscrollend" in window) {
      window.addEventListener("scrollend", onScrollEnd, { once: true });
    }
    // rAF-until-stable fallback (also covers browsers without scrollend and the case where
    // the element was already on-screen so scrollend never fires).
    let lastTop = rect0.top;
    let stableFrames = 0;
    let raf = 0;
    const settle = () => {
      if (!this.highlightEl) return;
      const t = this.highlightTarget!.getBoundingClientRect().top;
      if (Math.abs(t - lastTop) < 0.5) {
        if (++stableFrames >= 3) {
          onScrollEnd();
          return;
        }
      } else {
        stableFrames = 0;
      }
      lastTop = t;
      place();
      raf = requestAnimationFrame(settle);
    };

    try {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch {
      /* ignore */
    }
    raf = requestAnimationFrame(settle);

    // Re-anchor while the ring is shown: the page can scroll/resize independently.
    const reanchor = () => place();
    window.addEventListener("scroll", reanchor, { passive: true, capture: true });
    window.addEventListener("resize", reanchor, { passive: true });
    this.highlightReanchor = () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", reanchor, { capture: true });
      window.removeEventListener("resize", reanchor);
      window.removeEventListener("scrollend", onScrollEnd);
    };
    return true;
  }

  clearHighlight() {
    this.highlightReanchor?.();
    this.highlightReanchor = undefined;
    this.highlightTarget = undefined;
    this.highlightEl?.remove();
    this.highlightEl = undefined;
  }

  addSuggestions(items: string[], onPick: (t: string) => void) {
    if (!items.length) return;
    const wrap = el("div", "msg system");
    wrap.textContent = this.s.suggestionsLabel;
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

  /** Tear down all DOM + listeners this UI created (for destroy()). */
  destroy() {
    if (this.keydownHandler) document.removeEventListener("keydown", this.keydownHandler);
    const vv = (window as any).visualViewport as VisualViewport | undefined;
    if (vv && this.viewportHandler) {
      vv.removeEventListener("resize", this.viewportHandler);
      vv.removeEventListener("scroll", this.viewportHandler);
    }
    this.sidebar?.destroy();
    this.clearHighlight();
    this.host.remove();
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

/* ----------------------------------------------------------------
   Launcher marks

   The launcher used to be a telephone, always. That reads as "call
   support" — a queue and a person — when the thing behind it is an
   assistant that answers immediately and types. It also cannot be
   right for every host: a book-keeping app, a shop and a helpdesk
   want different marks.

   So the mark is a choice. Named ones are here; anything else can be
   passed as raw SVG or as a character.
   ---------------------------------------------------------------- */

const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

export const LAUNCHER_ICONS: Record<string, string> = {
  /** A phone. The historical default, kept so nothing changes silently. */
  phone: svg(
    `<path d="M6.6 10.8c1.5 2.9 3.7 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/>`,
  ),
  /** A speech bubble. What most people read as "talk to something here". */
  chat: svg(
    `<path d="M12 3c-4.97 0-9 3.36-9 7.5 0 2.32 1.27 4.39 3.26 5.76-.14 1.06-.6 2.31-1.5 3.53-.2.28.06.66.39.56 2.2-.66 3.72-1.6 4.6-2.26.72.14 1.47.21 2.25.21 4.97 0 9-3.36 9-7.5S16.97 3 12 3z"/>`,
  ),
  /** A four-pointed sparkle: the convention for "this is a model". */
  sparkle: svg(
    `<path d="M12 2l1.9 5.7c.2.6.7 1.1 1.3 1.3L21 11l-5.7 1.9c-.6.2-1.1.7-1.3 1.3L12 20l-1.9-5.7c-.2-.6-.7-1.1-1.3-1.3L3 11l5.7-1.9c.6-.2 1.1-.7 1.3-1.3L12 2z"/><path d="M19 3l.7 2 2 .7-2 .7L19 8.5l-.7-2-2-.7 2-.7L19 3z" opacity=".7"/>`,
  ),
  /** A microphone, for a host where voice is the point. */
  mic: svg(
    `<path d="M12 14a3.5 3.5 0 003.5-3.5V6a3.5 3.5 0 10-7 0v4.5A3.5 3.5 0 0012 14z"/><path d="M18 11a1 1 0 10-2 0 4 4 0 01-8 0 1 1 0 10-2 0 6 6 0 005 5.9V20h-2a1 1 0 100 2h6a1 1 0 100-2h-2v-3.1A6 6 0 0018 11z"/>`,
  ),
  /** A ruled page: an assistant that reads a ledger rather than a website. */
  book: svg(
    `<path d="M6 3h11a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z"/><path d="M8 7h7M8 11h7M8 15h4" stroke="#fff" stroke-width="1.6" stroke-linecap="round" fill="none"/>`,
  ),
  /** A question mark, for help desks. */
  help: svg(
    `<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm.1 15.5a1.2 1.2 0 110-2.4 1.2 1.2 0 010 2.4zm1.7-5.1c-.7.5-.9.8-.9 1.4v.3h-1.8v-.4c0-1.2.5-1.9 1.4-2.5.7-.5.9-.8.9-1.3 0-.6-.5-1-1.3-1-.7 0-1.2.4-1.4 1L9 9.4C9.3 8 10.4 7.1 12.1 7.1c1.8 0 3 1 3 2.5 0 1.1-.5 1.7-1.3 2.3z"/>`,
  ),
};

/** Resolve whatever the host asked for into markup for the launcher.
 *  A name picks one of the above; raw SVG passes through; anything else
 *  short (an emoji, a letter) is rendered as a character. */
export function resolveLauncherIcon(icon: string | undefined): string {
  if (!icon) return LAUNCHER_ICONS.chat;
  const named = LAUNCHER_ICONS[icon];
  if (named) return named;
  if (icon.trim().startsWith("<svg")) return icon;
  return `<span class="glyph">${escapeHtml(icon)}</span>`;
}
