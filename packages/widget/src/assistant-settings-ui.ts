// Extended assistant settings: model, theme, export/import chats, analytics toggle.

import {
  ASSISTANT_SETTINGS_CHANGE_EVENT,
  ASSISTANT_SETTINGS_STORAGE_KEY,
  DEFAULT_MODELS,
  getAssistantSettings,
  setAssistantSettings,
  type ThemeMode,
} from "./assistant-settings.js";
import { CSS as VOICE_CSS } from "./settings-ui-shared.js";
import { VOICE_SETTINGS_STORAGE_KEY, getVoiceSettings, setVoiceSettings } from "./settings.js";
import {
  ELEVENLABS_VOICES,
  OPENAI_VOICES,
  type SttMode,
  type TtsMode,
  type TtsProvider,
} from "./settings.js";
import type { ChatHistoryStore } from "./chatHistory.js";

export interface AssistantSettingsUIOptions {
  storageKey?: string;
  voiceStorageKey?: string;
  settingsPageUrl?: string;
  title?: string;
  chatStore?: ChatHistoryStore;
  serverUrl?: string;
}

const TABS = ["General", "Voice", "Data"] as const;

export function mountAssistantSettingsPanel(
  container: HTMLElement,
  opts: AssistantSettingsUIOptions = {}
): () => void {
  const storageKey = opts.storageKey ?? ASSISTANT_SETTINGS_STORAGE_KEY;
  const voiceKey = opts.voiceStorageKey ?? VOICE_SETTINGS_STORAGE_KEY;
  const host = document.createElement("div");
  container.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = VOICE_CSS + EXTRA_CSS;
  shadow.appendChild(style);

  let activeTab: (typeof TABS)[number] = "General";
  const root = el("div", "wrap");
  shadow.appendChild(root);

  const render = () => {
    root.innerHTML = "";
    const tabs = el("div", "tabs");
    for (const t of TABS) {
      const btn = el("button", `tab${activeTab === t ? " active" : ""}`) as HTMLButtonElement;
      btn.textContent = t;
      btn.onclick = () => {
        activeTab = t;
        render();
      };
      tabs.appendChild(btn);
    }
    root.appendChild(tabs);

    const body = el("div", "tab-body");
    if (activeTab === "General") renderGeneral(body, storageKey);
    else if (activeTab === "Voice") renderVoice(body, voiceKey);
    else renderData(body, opts.chatStore);
    root.appendChild(body);
  };

  render();
  const onChange = () => render();
  window.addEventListener(ASSISTANT_SETTINGS_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener(ASSISTANT_SETTINGS_CHANGE_EVENT, onChange);
    host.remove();
  };
}

function renderGeneral(root: HTMLElement, storageKey: string) {
  const s = getAssistantSettings(storageKey);
  addRow(root, "Model", () => {
    const sel = el("select", "field") as HTMLSelectElement;
    sel.innerHTML = DEFAULT_MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
    sel.value = s.model;
    sel.onchange = () => setAssistantSettings({ model: sel.value }, storageKey);
    return sel;
  });
  addRow(root, "Theme", () => {
    const sel = el("select", "field") as HTMLSelectElement;
    sel.innerHTML = `<option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option>`;
    sel.value = s.theme;
    sel.onchange = () => setAssistantSettings({ theme: sel.value as ThemeMode }, storageKey);
    return sel;
  });
  addRow(root, "Chat sidebar", () => {
    const lab = el("label", "check field");
    const cb = el("input") as HTMLInputElement;
    cb.type = "checkbox";
    cb.checked = s.sidebarOpen;
    cb.onchange = () => setAssistantSettings({ sidebarOpen: cb.checked }, storageKey);
    lab.append(cb, el("span", undefined, "Show history sidebar by default"));
    return lab;
  });
  addRow(root, "Analytics", () => {
    const lab = el("label", "check field");
    const cb = el("input") as HTMLInputElement;
    cb.type = "checkbox";
    cb.checked = s.analyticsEnabled;
    cb.onchange = () => setAssistantSettings({ analyticsEnabled: cb.checked }, storageKey);
    lab.append(cb, el("span", undefined, "Send anonymous usage events to server"));
    return lab;
  });
}

function renderVoice(root: HTMLElement, voiceKey: string) {
  const hint = el("p", "hint");
  hint.textContent = "Voice settings apply to read-aloud and microphone input.";
  root.appendChild(hint);

  const speakLabel = el("label", "check field");
  const speakCb = el("input") as HTMLInputElement;
  speakCb.type = "checkbox";
  speakCb.checked = getVoiceSettings(voiceKey).autoSpeak;
  speakCb.onchange = () => setVoiceSettings({ autoSpeak: speakCb.checked }, voiceKey);
  speakLabel.append(speakCb, el("span", undefined, "Read replies aloud"));
  addRow(root, "Read aloud", () => speakLabel);

  const ttsSel = el("select", "field") as HTMLSelectElement;
  ttsSel.innerHTML = `<option value="browser">Browser (free)</option><option value="server">Server TTS</option>`;
  ttsSel.value = getVoiceSettings(voiceKey).ttsMode;
  ttsSel.onchange = () => setVoiceSettings({ ttsMode: ttsSel.value as TtsMode }, voiceKey);
  addRow(root, "Speech engine", () => ttsSel);

  const sttSel = el("select", "field") as HTMLSelectElement;
  sttSel.innerHTML = `<option value="browser">Browser mic</option><option value="server">Server Whisper</option>`;
  sttSel.value = getVoiceSettings(voiceKey).sttMode;
  sttSel.onchange = () => setVoiceSettings({ sttMode: sttSel.value as SttMode }, voiceKey);
  addRow(root, "Mic input", () => sttSel);

  const vs = getVoiceSettings(voiceKey);
  if (vs.ttsMode === "server") {
    const provSel = el("select", "field") as HTMLSelectElement;
    provSel.innerHTML = `<option value="elevenlabs">ElevenLabs</option><option value="openai">OpenAI</option>`;
    provSel.value = vs.ttsProvider;
    provSel.onchange = () => setVoiceSettings({ ttsProvider: provSel.value as TtsProvider }, voiceKey);
    addRow(root, "TTS provider", () => provSel);

    const voiceSel = el("select", "field") as HTMLSelectElement;
    const list = vs.ttsProvider === "elevenlabs" ? ELEVENLABS_VOICES : OPENAI_VOICES;
    voiceSel.innerHTML = list.map((v) => `<option value="${v.id}">${v.label}</option>`).join("");
    voiceSel.value = vs.ttsProvider === "elevenlabs" ? vs.elevenLabsVoiceId : vs.openaiVoice;
    voiceSel.onchange = () => {
      if (getVoiceSettings(voiceKey).ttsProvider === "elevenlabs") {
        setVoiceSettings({ elevenLabsVoiceId: voiceSel.value }, voiceKey);
      } else {
        setVoiceSettings({ openaiVoice: voiceSel.value }, voiceKey);
      }
    };
    addRow(root, "Voice", () => voiceSel);
  }
}

function renderData(root: HTMLElement, chatStore?: ChatHistoryStore) {
  const hint = el("p", "hint");
  hint.textContent = "Export or import your chat history. Data stays in your browser unless you share it.";
  root.appendChild(hint);

  const exportBtn = el("button", "btn btn-primary") as HTMLButtonElement;
  exportBtn.textContent = "Export all chats (JSON)";
  exportBtn.onclick = () => {
    if (!chatStore) return;
    downloadFile("page-assistant-chats.json", chatStore.exportAll());
  };
  root.appendChild(exportBtn);

  const importLabel = el("label", "btn btn-ghost") as HTMLLabelElement;
  importLabel.textContent = "Import chats…";
  const importInput = el("input") as HTMLInputElement;
  importInput.type = "file";
  importInput.accept = ".json";
  importInput.style.display = "none";
  importInput.onchange = async () => {
    const file = importInput.files?.[0];
    if (!file || !chatStore) return;
    const ok = chatStore.importAll(await file.text());
    alert(ok ? "Imported successfully" : "Invalid backup file");
    importInput.value = "";
  };
  importLabel.appendChild(importInput);
  importLabel.onclick = () => importInput.click();
  root.appendChild(importLabel);
}

let modalHost: HTMLElement | undefined;

export function openAssistantSettingsModal(opts: AssistantSettingsUIOptions = {}) {
  closeAssistantSettingsModal();
  modalHost = document.createElement("div");
  document.body.appendChild(modalHost);
  const shadow = modalHost.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = VOICE_CSS + EXTRA_CSS;
  shadow.appendChild(style);

  const backdrop = el("div", "modal-backdrop");
  backdrop.onclick = (e) => {
    if (e.target === backdrop) closeAssistantSettingsModal();
  };
  const modal = el("div", "modal");
  modal.onclick = (e) => e.stopPropagation();
  const head = el("div", "modal-head");
  const h2 = el("h2");
  h2.textContent = opts.title ?? "Assistant settings";
  const closeBtn = el("button", "btn btn-ghost") as HTMLButtonElement;
  closeBtn.textContent = "×";
  closeBtn.onclick = () => closeAssistantSettingsModal();
  head.append(h2, closeBtn);

  const mount = el("div");
  modal.append(head, mount);
  backdrop.appendChild(modal);
  shadow.appendChild(backdrop);

  const cleanup = mountAssistantSettingsPanel(mount, opts);
  (modalHost as any)._cleanup = cleanup;
}

export function closeAssistantSettingsModal() {
  if (!modalHost) return;
  (modalHost as any)._cleanup?.();
  modalHost.remove();
  modalHost = undefined;
}

const EXTRA_CSS = `
.tabs { display: flex; gap: 4px; margin-bottom: 14px; border-bottom: 1px solid #244234; padding-bottom: 8px; }
.tab { background: none; border: none; color: #9ab4a6; padding: 6px 12px; cursor: pointer; border-radius: 6px; font-size: 13px; }
.tab.active { background: #1d3328; color: #e7f5ec; }
.tab-body { min-height: 200px; }
.btn { margin-top: 8px; display: inline-block; }
`;

function addRow(root: HTMLElement, label: string, fieldFn: () => HTMLElement) {
  const row = el("div", "row");
  const lab = el("span", "label");
  lab.textContent = label;
  row.append(lab, fieldFn());
  root.appendChild(row);
}

function downloadFile(name: string, content: string) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function el<T extends HTMLElement = HTMLElement>(tag: string, cls?: string, text?: string): T {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e as unknown as T;
}
