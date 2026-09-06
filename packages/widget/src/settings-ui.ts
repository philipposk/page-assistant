// Self-contained voice settings panel + modal (shadow DOM, no host CSS required).

import {
  ELEVENLABS_VOICES,
  OPENAI_VOICES,
  VOICE_SETTINGS_CHANGE_EVENT,
  VOICE_SETTINGS_STORAGE_KEY,
  getVoiceSettings,
  setVoiceSettings,
  type SttMode,
  type TtsMode,
  type TtsProvider,
} from "./settings.js";

export interface VoiceSettingsUIOptions {
  storageKey?: string;
  /** Optional link shown in the modal footer (e.g. host app settings page). */
  settingsPageUrl?: string;
  title?: string;
}

const CSS = `
* { box-sizing: border-box; font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif; }
.wrap { color: #e7f5ec; font-size: 14px; line-height: 1.45; }
.hint { margin: 0 0 14px; font-size: 13px; color: #9ab4a6; }
.row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.label { width: 140px; flex-shrink: 0; color: #9ab4a6; font-size: 13px; }
.field { flex: 1; min-width: 180px; }
select, label.field { display: block; width: 100%; max-width: 320px; }
select {
  background: #0b1310; border: 1px solid #244234; color: #e7f5ec;
  border-radius: 8px; padding: 8px 10px; font-size: 14px;
}
.check { display: flex; align-items: center; gap: 8px; cursor: pointer; max-width: 320px; }
.modal-backdrop {
  position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.55);
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.modal {
  width: min(480px, 100%); max-height: 90vh; overflow: auto;
  background: #0f1715; border: 1px solid #1f3a2c; border-radius: 16px;
  padding: 18px 20px; box-shadow: 0 20px 60px rgba(0,0,0,.5);
}
.modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.modal-head h2 { margin: 0; font-size: 18px; font-weight: 600; }
.modal-foot { margin-top: 16px; display: flex; justify-content: flex-end; gap: 10px; align-items: center; }
.btn {
  border: none; border-radius: 8px; padding: 8px 14px; cursor: pointer; font-size: 14px; font-weight: 500;
}
.btn-ghost { background: transparent; color: #9ab4a6; }
.btn-ghost:hover { color: #e7f5ec; }
.btn-primary { background: #16a34a; color: #fff; }
.btn-primary:hover { background: #15803d; }
.link { color: #9ab4a6; font-size: 13px; text-decoration: none; }
.link:hover { color: #e7f5ec; }
`;

function renderForm(root: HTMLElement, storageKey: string): () => void {
  root.innerHTML = "";
  const wrap = el("div", "wrap");
  const hint = el("p", "hint");
  hint.textContent =
    "Text replies are free. Read-aloud uses your browser or the server (ElevenLabs / OpenAI). Mic defaults to the free browser recognizer; server Whisper costs per minute.";
  wrap.appendChild(hint);

  const addRow = (label: string, field: HTMLElement) => {
    const row = el("div", "row");
    const lab = el("span", "label");
    lab.textContent = label;
    row.append(lab, field);
    wrap.appendChild(row);
  };

  const speakLabel = el("label", "check field");
  const speakCb = el("input") as HTMLInputElement;
  speakCb.type = "checkbox";
  const speakText = el("span");
  const refreshSpeak = () => {
    const s = getVoiceSettings(storageKey);
    speakCb.checked = s.autoSpeak;
    speakText.textContent = s.autoSpeak ? "On (🔊 in assistant)" : "Off — text only (default)";
  };
  speakCb.onchange = () => {
    setVoiceSettings({ autoSpeak: speakCb.checked }, storageKey);
    refreshSpeak();
  };
  speakLabel.append(speakCb, speakText);
  refreshSpeak();
  addRow("Read aloud", speakLabel);

  const ttsSel = el("select", "field") as HTMLSelectElement;
  ttsSel.innerHTML = `<option value="browser">Browser (free, robotic)</option><option value="server">Server — ElevenLabs / OpenAI</option>`;
  addRow("Speech engine", ttsSel);

  const serverBlock = el("div");
  wrap.appendChild(serverBlock);

  const renderServerRows = () => {
    const s = getVoiceSettings(storageKey);
    ttsSel.value = s.ttsMode;
    serverBlock.innerHTML = "";
    if (s.ttsMode !== "server") return;

    const provRow = el("div", "row");
    provRow.innerHTML = `<span class="label">Provider</span>`;
    const provSel = el("select", "field") as HTMLSelectElement;
    provSel.innerHTML = `<option value="elevenlabs">ElevenLabs (recommended)</option><option value="openai">OpenAI TTS</option>`;
    provSel.value = s.ttsProvider;
    provSel.onchange = () => {
      setVoiceSettings({ ttsProvider: provSel.value as TtsProvider }, storageKey);
      renderServerRows();
    };
    provRow.appendChild(provSel);
    serverBlock.appendChild(provRow);

    const voiceRow = el("div", "row");
    voiceRow.innerHTML = `<span class="label">Voice</span>`;
    const voiceSel = el("select", "field") as HTMLSelectElement;
    const list = s.ttsProvider === "elevenlabs" ? ELEVENLABS_VOICES : OPENAI_VOICES;
    voiceSel.innerHTML = list.map((v) => `<option value="${v.id}">${escapeHtml(v.label)}</option>`).join("");
    voiceSel.value = s.ttsProvider === "elevenlabs" ? s.elevenLabsVoiceId : s.openaiVoice;
    voiceSel.onchange = () => {
      if (getVoiceSettings(storageKey).ttsProvider === "elevenlabs") {
        setVoiceSettings({ elevenLabsVoiceId: voiceSel.value }, storageKey);
      } else {
        setVoiceSettings({ openaiVoice: voiceSel.value }, storageKey);
      }
    };
    voiceRow.appendChild(voiceSel);
    serverBlock.appendChild(voiceRow);
  };

  ttsSel.onchange = () => {
    setVoiceSettings({ ttsMode: ttsSel.value as TtsMode }, storageKey);
    renderServerRows();
  };
  renderServerRows();

  const sttSel = el("select", "field") as HTMLSelectElement;
  sttSel.innerHTML = `<option value="browser">Browser (free)</option><option value="server">Server — Whisper</option>`;
  sttSel.value = getVoiceSettings(storageKey).sttMode;
  sttSel.onchange = () => {
    setVoiceSettings({ sttMode: sttSel.value as SttMode }, storageKey);
  };
  addRow("Mic input", sttSel);

  root.appendChild(wrap);

  const onExternal = () => {
    refreshSpeak();
    renderServerRows();
    sttSel.value = getVoiceSettings(storageKey).sttMode;
  };
  window.addEventListener(VOICE_SETTINGS_CHANGE_EVENT, onExternal);
  return () => window.removeEventListener(VOICE_SETTINGS_CHANGE_EVENT, onExternal);
}

/** Embed the voice settings form in a host container (e.g. app settings page). Returns cleanup. */
export function mountVoiceSettingsPanel(
  container: HTMLElement,
  opts: VoiceSettingsUIOptions = {}
): () => void {
  const storageKey = opts.storageKey ?? VOICE_SETTINGS_STORAGE_KEY;
  const host = document.createElement("div");
  container.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.appendChild(style);
  const formRoot = el("div");
  shadow.appendChild(formRoot);
  const cleanupForm = renderForm(formRoot, storageKey);
  return () => {
    cleanupForm();
    host.remove();
  };
}

let modalHost: HTMLElement | undefined;

/** Open the built-in voice settings modal. */
export function openVoiceSettingsModal(opts: VoiceSettingsUIOptions = {}) {
  closeVoiceSettingsModal();
  const storageKey = opts.storageKey ?? VOICE_SETTINGS_STORAGE_KEY;
  const title = opts.title ?? "Page assistant";

  modalHost = document.createElement("div");
  document.body.appendChild(modalHost);
  const shadow = modalHost.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.appendChild(style);

  const backdrop = el("div", "modal-backdrop");
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-label", title);
  backdrop.onclick = (e) => {
    if (e.target === backdrop) closeVoiceSettingsModal();
  };

  const modal = el("div", "modal");
  modal.onclick = (e) => e.stopPropagation();

  const head = el("div", "modal-head");
  const h2 = el("h2");
  h2.textContent = title;
  const closeBtn = el("button", "btn btn-ghost") as HTMLButtonElement;
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.onclick = () => closeVoiceSettingsModal();
  head.append(h2, closeBtn);

  const formRoot = el("div");
  const cleanupForm = renderForm(formRoot, storageKey);

  const foot = el("div", "modal-foot");
  if (opts.settingsPageUrl) {
    const link = el("a", "link") as HTMLAnchorElement;
    link.href = opts.settingsPageUrl;
    link.textContent = "All settings →";
    link.onclick = () => closeVoiceSettingsModal();
    foot.appendChild(link);
  }
  const done = el("button", "btn btn-primary") as HTMLButtonElement;
  done.textContent = "Done";
  done.onclick = () => closeVoiceSettingsModal();
  foot.appendChild(done);

  modal.append(head, formRoot, foot);
  backdrop.appendChild(modal);
  shadow.appendChild(backdrop);

  const prevCleanup = (modalHost as any)._cleanup as (() => void) | undefined;
  (modalHost as any)._cleanup = () => {
    cleanupForm();
    prevCleanup?.();
  };
}

export function closeVoiceSettingsModal() {
  if (!modalHost) return;
  (modalHost as any)._cleanup?.();
  modalHost.remove();
  modalHost = undefined;
}

function el<T extends HTMLElement = HTMLElement>(tag: string, cls?: string): T {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e as unknown as T;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
