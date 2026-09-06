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
import {
  VOICE_SETTINGS_CHANGE_EVENT,
  VOICE_SETTINGS_STORAGE_KEY,
  getVoiceSettings,
  setVoiceSettings,
} from "./settings.js";
import {
  BROWSER_ONLY_CAPABILITIES,
  ELEVENLABS_VOICES,
  OPENAI_VOICES,
  fetchVoiceCapabilities,
  type SttMode,
  type TtsMode,
  type TtsProvider,
  type VoiceCapabilities,
} from "./settings.js";
import type { ChatHistoryStore } from "./chatHistory.js";

export interface AssistantSettingsUIOptions {
  storageKey?: string;
  voiceStorageKey?: string;
  settingsPageUrl?: string;
  title?: string;
  chatStore?: ChatHistoryStore;
  serverUrl?: string;
  /** Bearer token forwarded to the capabilities probe if the deployment guards it. */
  authToken?: string;
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

  // Server voice capabilities: unknown until the fetch resolves. Start browser-only so
  // nothing is falsely offered before we hear back; a re-render swaps in real values.
  let caps: VoiceCapabilities = BROWSER_ONLY_CAPABILITIES;

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
    else if (activeTab === "Voice") renderVoice(body, voiceKey, caps);
    else renderData(body, opts.chatStore);
    root.appendChild(body);
  };

  render();

  // Ask the server what it can actually do; grey out options it can't back.
  const abort = new AbortController();
  fetchVoiceCapabilities(opts.serverUrl, abort.signal, opts.authToken).then((c) => {
    caps = c;
    if (activeTab === "Voice") render();
  });

  const onChange = () => render();
  // The extended modal previously re-rendered only on ASSISTANT_SETTINGS_CHANGE_EVENT,
  // but changing the speech engine fires VOICE_SETTINGS_CHANGE_EVENT — so the Provider/
  // Voice rows never appeared until the modal was reopened. Listen to both.
  window.addEventListener(ASSISTANT_SETTINGS_CHANGE_EVENT, onChange);
  window.addEventListener(VOICE_SETTINGS_CHANGE_EVENT, onChange);
  return () => {
    abort.abort();
    window.removeEventListener(ASSISTANT_SETTINGS_CHANGE_EVENT, onChange);
    window.removeEventListener(VOICE_SETTINGS_CHANGE_EVENT, onChange);
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
  // The list is static; a model only works if the server's LLM router has a key/route
  // for its provider. Say so instead of letting a bad pick fail silently at chat time.
  const modelNote = el("p", "hint");
  modelNote.style.margin = "-6px 0 12px 152px";
  modelNote.textContent = "Models depend on the server's configured providers — an unsupported one will error when you send.";
  root.appendChild(modelNote);
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

function renderVoice(root: HTMLElement, voiceKey: string, caps: VoiceCapabilities) {
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

  const vs = getVoiceSettings(voiceKey);
  const serverTts = caps.tts.server;
  const serverStt = caps.stt.server;

  const ttsSel = el("select", "field") as HTMLSelectElement;
  ttsSel.innerHTML = `<option value="browser">Browser (free)</option><option value="server"${serverTts ? "" : " disabled"}>Server TTS${serverTts ? "" : " (not configured)"}</option>`;
  ttsSel.value = vs.ttsMode;
  ttsSel.onchange = () => setVoiceSettings({ ttsMode: ttsSel.value as TtsMode }, voiceKey);
  addRow(root, "Speech engine", () => ttsSel);

  const sttSel = el("select", "field") as HTMLSelectElement;
  sttSel.innerHTML = `<option value="browser">Browser mic</option><option value="server"${serverStt ? "" : " disabled"}>Server Whisper${serverStt ? "" : " (not configured)"}</option>`;
  sttSel.value = vs.sttMode;
  sttSel.onchange = () => setVoiceSettings({ sttMode: sttSel.value as SttMode }, voiceKey);
  addRow(root, "Mic input", () => sttSel);

  if (vs.ttsMode === "server") {
    const provSel = el("select", "field") as HTMLSelectElement;
    const provOpts: Array<[TtsProvider, string]> = [
      ["elevenlabs", "ElevenLabs"],
      ["openai", "OpenAI"],
    ];
    provSel.innerHTML = provOpts
      .map(([id, label]) => {
        const ok = !serverTts || caps.tts.providers.length === 0 || caps.tts.providers.includes(id);
        return `<option value="${id}"${ok ? "" : " disabled"}>${label}${ok ? "" : " (no server key)"}</option>`;
      })
      .join("");
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

  // Explain any greyed-out options + warn if a stored preference can't be honored.
  const note = el("p", "hint");
  note.style.marginTop = "12px";
  if (!serverTts && !serverStt) {
    note.textContent =
      "This server has no voice keys configured, so only the free browser voice and mic are available. Server TTS/STT (ElevenLabs · OpenAI · Whisper) are greyed out.";
    root.appendChild(note);
  } else if ((vs.ttsMode === "server" && !serverTts) || (vs.sttMode === "server" && !serverStt)) {
    note.textContent =
      "A saved option isn't available on this server and will fall back to the browser. Greyed-out choices need a server API key.";
    root.appendChild(note);
  } else if (!serverTts || !serverStt) {
    note.textContent = "Greyed-out server options aren't configured on this server; the browser handles them for free.";
    root.appendChild(note);
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
