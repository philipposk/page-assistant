// Self-contained floating widget UI rendered in a shadow root (no host CSS bleed).
// Bottom-right launcher + panel + animated mascot with idle/listening/thinking/talking states.

export type MascotState = "idle" | "listening" | "thinking" | "talking" | "scanning";

export interface UIHandlers {
  onSend: (text: string) => void;
  onMic: () => void;
  onConfirm: (approved: boolean) => void;
  /** Fired whenever the panel opens/closes — controller hooks onboarding + voice stop here. */
  onToggle?: (open: boolean) => void;
  onSettings?: () => void;
  onTtsToggle?: (enabled: boolean) => void;
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif; }
.launcher {
  position: fixed; right: 22px; bottom: 22px; width: 60px; height: 60px; border-radius: 50%;
  border: none; cursor: pointer; z-index: 2147483646;
  background: radial-gradient(circle at 30% 30%, #5eead4, #0d9488);
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
.panel {
  position: fixed; right: 22px; bottom: 92px; width: 360px; max-width: calc(100vw - 32px);
  height: 520px; max-height: calc(100vh - 130px); background: #0f1715; color: #e7f5ec;
  border: 1px solid #1f3a2c; border-radius: 16px; z-index: 2147483646; display: none;
  flex-direction: column; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.5);
}
.panel.open { display: flex; }
.head { padding: 14px 16px; background: #12211a; border-bottom: 1px solid #1f3a2c; font-weight: 600; display:flex; align-items:center; gap:8px; }
.head .dot { width:8px;height:8px;border-radius:50%;background:#4ade80; }
.head .close { margin-left:auto; background:none; border:none; color:#9ab4a6; font-size:18px; cursor:pointer; padding:2px 6px; border-radius:6px; }
.head .settings { background:none; border:none; color:#9ab4a6; font-size:16px; cursor:pointer; padding:2px 6px; border-radius:6px; margin-left:auto; }
.head .settings:hover, .head .close:hover { background:#1d3328; color:#e7f5ec; }
.log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.msg { padding: 9px 12px; border-radius: 12px; max-width: 85%; line-height: 1.4; font-size: 14px; white-space: pre-wrap; }
.msg.user { align-self: flex-end; background: #1f6f43; }
.msg.assistant { align-self: flex-start; background: #1a2a22; border: 1px solid #244234; }
.msg.system { align-self: center; font-size: 12px; opacity: .7; background: transparent; }
.confirm { display:flex; gap:8px; margin-top:6px; }
.confirm button { flex:1; padding:7px; border-radius:8px; border:none; cursor:pointer; font-weight:600; }
.confirm .yes { background:#16a34a; color:#fff; } .confirm .no { background:#33403a; color:#cde; }
.chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.chip { background:#16241c; border:1px solid #2a4636; color:#bfe9cd; border-radius:14px; padding:6px 11px; font-size:12px; cursor:pointer; }
.chip:hover { background:#1d3328; }
.foot { padding: 10px; border-top: 1px solid #1f3a2c; display: flex; gap: 8px; }
.foot input { flex: 1; background: #0b1310; border: 1px solid #244234; color: #e7f5ec; border-radius: 10px; padding: 9px 12px; outline: none; font-size: 14px; }
.foot button { border: none; border-radius: 10px; padding: 0 12px; cursor: pointer; font-size: 16px; }
.foot .mic { background: #1f3a2c; color: #9ff0c2; }
.foot .mic.on { background:#16a34a; color:#fff; }
.foot .tts { background: #1f3a2c; color: #7a9a8a; font-size: 18px; }
.foot .tts.on { background:#0d9488; color:#ecfdf5; }
.foot .send { background: #16a34a; color: #fff; }
.scanline { position:fixed; left:0; right:0; height:3px; background:linear-gradient(90deg,transparent,#4ade80,transparent); z-index:2147483645; display:none; animation: sweep 1.4s ease-in-out infinite; }
.scanline.on { display:block; }
@keyframes sweep { 0%{top:0} 100%{top:100vh} }
`;

export class WidgetUI {
  private root: ShadowRoot;
  private launcher!: HTMLButtonElement;
  private panel!: HTMLDivElement;
  private log!: HTMLDivElement;
  private input!: HTMLInputElement;
  private micBtn!: HTMLButtonElement;
  private ttsBtn!: HTMLButtonElement;
  private scanline!: HTMLDivElement;

  constructor(
    private title: string,
    private handlers: UIHandlers,
    private launcherIcon?: string,
  ) {
    const host = document.createElement("div");
    host.id = "page-assistant-root";
    document.body.appendChild(host);
    this.root = host.attachShadow({ mode: "open" });
    this.render();
  }

  private render() {
    const style = document.createElement("style");
    style.textContent = CSS;
    this.root.appendChild(style);

    this.scanline = el("div", "scanline");
    this.launcher = el("button", "launcher") as HTMLButtonElement;
    this.launcher.innerHTML = resolveLauncherIcon(this.launcherIcon);
    this.launcher.title = this.title;
    this.launcher.setAttribute("aria-label", `Open ${this.title}`);

    this.panel = el("div", "panel") as HTMLDivElement;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", this.title);
    const head = el("div", "head");
    head.innerHTML = `<span class="dot"></span>${escapeHtml(this.title)}`;
    const settingsBtn = el<HTMLButtonElement>("button", "settings");
    settingsBtn.textContent = "⚙";
    settingsBtn.title = "Assistant settings";
    settingsBtn.setAttribute("aria-label", "Assistant settings");
    settingsBtn.onclick = () => this.handlers.onSettings?.();
    const closeBtn = el<HTMLButtonElement>("button", "close");
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close assistant");
    closeBtn.onclick = () => this.toggle(false);
    head.append(settingsBtn, closeBtn);
    this.log = el("div", "log") as HTMLDivElement;
    const foot = el("div", "foot");
    this.input = el("input") as HTMLInputElement;
    this.input.placeholder = "Ask or tell me to do something…";
    this.ttsBtn = el("button", "tts") as HTMLButtonElement;
    this.ttsBtn.textContent = "☎";
    this.ttsBtn.title = "Read replies aloud (off)";
    this.ttsBtn.setAttribute("aria-label", "Toggle read aloud");
    this.micBtn = el("button", "mic") as HTMLButtonElement;
    this.micBtn.textContent = "🎙";
    this.micBtn.setAttribute("aria-label", "Speak to the assistant");
    const send = el("button", "send") as HTMLButtonElement;
    send.textContent = "➤";
    send.setAttribute("aria-label", "Send message");

    foot.append(this.input, this.ttsBtn, this.micBtn, send);
    this.panel.append(head, this.log, foot);
    this.root.append(this.scanline, this.launcher, this.panel);

    this.launcher.onclick = () => this.toggle();
    send.onclick = () => this.submit();
    this.input.onkeydown = (e) => {
      if (e.key === "Enter") this.submit();
    };
    this.micBtn.onclick = () => this.handlers.onMic();
    this.ttsBtn.onclick = () => {
      const on = !this.ttsBtn.classList.contains("on");
      this.setTtsEnabled(on);
      this.handlers.onTtsToggle?.(on);
    };
  }

  private submit() {
    const t = this.input.value.trim();
    if (!t) return;
    this.input.value = "";
    this.handlers.onSend(t);
  }

  toggle(open?: boolean) {
    const willOpen = open ?? !this.panel.classList.contains("open");
    this.panel.classList.toggle("open", willOpen);
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

