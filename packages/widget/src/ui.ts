// Self-contained floating widget UI rendered in a shadow root (no host CSS bleed).
// Bottom-right launcher + panel + animated mascot with idle/listening/thinking/talking states.

export type MascotState = "idle" | "listening" | "thinking" | "talking" | "scanning";

export interface UIHandlers {
  onSend: (text: string) => void;
  onMic: () => void;
  onConfirm: (approved: boolean) => void;
  /** Fired whenever the panel opens/closes — controller hooks onboarding + voice stop here. */
  onToggle?: (open: boolean) => void;
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif; }
.launcher {
  position: fixed; right: 22px; bottom: 22px; width: 60px; height: 60px; border-radius: 50%;
  border: none; cursor: pointer; z-index: 2147483646;
  background: radial-gradient(circle at 30% 30%, #4ade80, #16a34a);
  box-shadow: 0 8px 28px rgba(22,163,74,.45); transition: transform .25s, box-shadow .25s;
}
.launcher:hover { transform: scale(1.08); }
.launcher .eye { position:absolute; width:9px; height:9px; border-radius:50%; background:#0b3d1f; top:23px; }
.launcher .eye.l { left:18px; } .launcher .eye.r { right:18px; }
.launcher.talking { animation: bob .5s infinite alternate; }
.launcher.thinking { animation: spin 1.2s linear infinite; }
.launcher.listening { box-shadow: 0 0 0 6px rgba(74,222,128,.35), 0 8px 28px rgba(22,163,74,.45); }
.launcher.scanning { animation: pulse .8s infinite; }
@keyframes bob { to { transform: translateY(-4px); } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 50% { box-shadow: 0 0 0 10px rgba(74,222,128,.25), 0 8px 28px rgba(22,163,74,.45); } }
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
.head .close:hover { background:#1d3328; color:#e7f5ec; }
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
  private scanline!: HTMLDivElement;

  constructor(private title: string, private handlers: UIHandlers) {
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
    this.launcher.innerHTML = `<span class="eye l"></span><span class="eye r"></span>`;
    this.launcher.title = this.title;
    this.launcher.setAttribute("aria-label", `Open ${this.title}`);

    this.panel = el("div", "panel") as HTMLDivElement;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", this.title);
    const head = el("div", "head");
    head.innerHTML = `<span class="dot"></span>${escapeHtml(this.title)}`;
    const closeBtn = el<HTMLButtonElement>("button", "close");
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close assistant");
    closeBtn.onclick = () => this.toggle(false);
    head.appendChild(closeBtn);
    this.log = el("div", "log") as HTMLDivElement;
    const foot = el("div", "foot");
    this.input = el("input") as HTMLInputElement;
    this.input.placeholder = "Ask or tell me to do something…";
    this.micBtn = el("button", "mic") as HTMLButtonElement;
    this.micBtn.textContent = "🎙";
    this.micBtn.setAttribute("aria-label", "Speak to the assistant");
    const send = el("button", "send") as HTMLButtonElement;
    send.textContent = "➤";
    send.setAttribute("aria-label", "Send message");

    foot.append(this.input, this.micBtn, send);
    this.panel.append(head, this.log, foot);
    this.root.append(this.scanline, this.launcher, this.panel);

    this.launcher.onclick = () => this.toggle();
    send.onclick = () => this.submit();
    this.input.onkeydown = (e) => {
      if (e.key === "Enter") this.submit();
    };
    this.micBtn.onclick = () => this.handlers.onMic();
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
