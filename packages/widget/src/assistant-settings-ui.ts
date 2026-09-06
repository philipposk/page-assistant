// Extended assistant settings: model, theme, export/import chats, analytics toggle.

import {
  ASSISTANT_SETTINGS_CHANGE_EVENT,
  ASSISTANT_SETTINGS_STORAGE_KEY,
  DEFAULT_MODELS,
  getAssistantSettings,
  setAssistantSettings,
  type ThemeMode,
} from "./assistant-settings.js";
import { panelStyle } from "./settings-ui-shared.js";
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
import { DEFAULT_STRINGS, resolveStrings, type WidgetStrings } from "./strings.js";
import { fetchModelCatalog, type ModelCatalog } from "./models.js";

export interface AssistantSettingsUIOptions {
  storageKey?: string;
  voiceStorageKey?: string;
  settingsPageUrl?: string;
  title?: string;
  chatStore?: ChatHistoryStore;
  serverUrl?: string;
  /** Bearer token forwarded to the capabilities probe if the deployment guards it. */
  authToken?: string;
  /**
   * Hide the model picker.
   *
   * Some deployments fix the model on the server — an unauthenticated proxy has
   * to, or a visitor could upgrade themselves to a costlier one. On those, a
   * dropdown that silently does nothing is worse than no dropdown, so say what
   * is actually happening instead.
   */
  showModel?: boolean;
  /** What to say in place of the picker when `showModel` is false. */
  modelFixedNote?: string;
  /**
   * `true`  — always show the picker.
   * `false` — never show it (same as `showModel: false`).
   * `"auto"` (default) — ask the server: `GET /v1/models` reports whether the model is
   * fixed server-side and which models it can actually serve.
   */
  modelPicker?: boolean | "auto";
  /** Chrome strings; anything omitted keeps its English default. */
  strings?: Partial<WidgetStrings>;
}

type TabId = "General" | "Voice" | "Data";
const TABS: TabId[] = ["General", "Voice", "Data"];

export function mountAssistantSettingsPanel(
  container: HTMLElement,
  opts: AssistantSettingsUIOptions = {}
): () => void {
  const storageKey = opts.storageKey ?? ASSISTANT_SETTINGS_STORAGE_KEY;
  const voiceKey = opts.voiceStorageKey ?? VOICE_SETTINGS_STORAGE_KEY;
  const str = resolveStrings(opts.strings);
  const host = document.createElement("div");
  container.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  // Themed, and re-themed live: the panel used to hardcode the dark palette, so a
  // light-themed app opened a black-green modal beside its own chrome.
  const applyTheme = () => {
    style.textContent = panelStyle(getAssistantSettings(storageKey).theme, EXTRA_CSS);
  };
  applyTheme();
  shadow.appendChild(style);
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : undefined;
  media?.addEventListener?.("change", applyTheme);

  let activeTab: TabId = "General";
  const root = el("div", "wrap");
  shadow.appendChild(root);

  // Server voice capabilities: unknown until the fetch resolves. Start browser-only so
  // nothing is falsely offered before we hear back; a re-render swaps in real values.
  let caps: VoiceCapabilities = BROWSER_ONLY_CAPABILITIES;
  // Model catalogue: unknown until the probe resolves. Until then assume the model IS
  // fixed, so a picker never flashes up on a deployment that pins it.
  let catalog: ModelCatalog | undefined;

  const render = () => {
    root.innerHTML = "";
    const tabs = el("div", "tabs");
    const tabLabel: Record<TabId, string> = {
      General: str.settingsTabGeneral,
      Voice: str.settingsTabVoice,
      Data: str.settingsTabData,
    };
    for (const t of TABS) {
      const btn = el("button", `tab${activeTab === t ? " active" : ""}`) as HTMLButtonElement;
      btn.textContent = tabLabel[t];
      btn.onclick = () => {
        activeTab = t;
        render();
      };
      tabs.appendChild(btn);
    }
    root.appendChild(tabs);

    const body = el("div", "tab-body");
    if (activeTab === "General") renderGeneral(body, storageKey, opts, str, catalog);
    else if (activeTab === "Voice") renderVoice(body, voiceKey, caps, str);
    else renderData(body, opts.chatStore, str);
    root.appendChild(body);
  };

  render();

  // Ask the server what it can actually do; grey out options it can't back.
  const abort = new AbortController();
  fetchVoiceCapabilities(opts.serverUrl, abort.signal, opts.authToken).then((c) => {
    caps = c;
    if (activeTab === "Voice") render();
  });
  // Ask what the server will actually honour for `model`, unless the host already decided.
  if (opts.modelPicker === undefined || opts.modelPicker === "auto") {
    fetchModelCatalog(opts.serverUrl, abort.signal, opts.authToken).then((c) => {
      catalog = c;
      if (activeTab === "General") render();
    });
  }

  const onChange = () => {
    applyTheme();
    render();
  };
  // The extended modal previously re-rendered only on ASSISTANT_SETTINGS_CHANGE_EVENT,
  // but changing the speech engine fires VOICE_SETTINGS_CHANGE_EVENT — so the Provider/
  // Voice rows never appeared until the modal was reopened. Listen to both.
  window.addEventListener(ASSISTANT_SETTINGS_CHANGE_EVENT, onChange);
  window.addEventListener(VOICE_SETTINGS_CHANGE_EVENT, onChange);
  return () => {
    abort.abort();
    media?.removeEventListener?.("change", applyTheme);
    window.removeEventListener(ASSISTANT_SETTINGS_CHANGE_EVENT, onChange);
    window.removeEventListener(VOICE_SETTINGS_CHANGE_EVENT, onChange);
    host.remove();
  };
}

/**
 * Should the model picker be rendered at all?
 *
 * A picker that changes nothing is worse than no picker: a host whose server pins its own
 * model (so a visitor cannot upgrade themselves onto a costlier one) was still shown a
 * dropdown that silently did nothing. `modelPicker` decides, and `"auto"` asks the server.
 */
export function modelPickerVisible(opts: AssistantSettingsUIOptions, catalog: ModelCatalog | undefined): boolean {
  if (opts.showModel === false || opts.modelPicker === false) return false;
  if (opts.modelPicker === true) return true;
  // "auto" (the default): hide until the probe answers, so it never flashes up and
  // disappears on a deployment that pins the model.
  if (!catalog) return false;
  return !catalog.fixed && catalog.models.length > 1;
}

function renderGeneral(
  root: HTMLElement,
  storageKey: string,
  opts: AssistantSettingsUIOptions = {},
  str: WidgetStrings = DEFAULT_STRINGS,
  catalog?: ModelCatalog
) {
  const s = getAssistantSettings(storageKey);
  if (!modelPickerVisible(opts, catalog)) {
    const note = el("p", "hint");
    note.style.margin = "0 0 12px";
    note.textContent = opts.modelFixedNote ?? catalog?.reason ?? str.modelFixedNote;
    root.appendChild(note);
  } else {
    // Only offer models the server said it can actually serve; fall back to the built-in
    // list when the probe found nothing to go on.
    const models = catalog?.models?.length ? catalog.models : DEFAULT_MODELS;
    addRow(root, str.settingsModel, () => {
      const sel = el("select", "field") as HTMLSelectElement;
      sel.innerHTML =
        `<option value="">${escapeHtml(str.modelServerDefault)}</option>` +
        models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join("");
      sel.value = s.model;
      // A stored model this server no longer offers would otherwise select nothing and
      // read as blank; fall back to the server default rather than showing an empty box.
      if (sel.selectedIndex < 0) sel.value = "";
      sel.onchange = () => setAssistantSettings({ model: sel.value }, storageKey);
      return sel;
    });
    const modelNote = el("p", "hint");
    modelNote.style.margin = "-6px 0 12px 152px";
    modelNote.textContent = str.modelProviderNote;
    root.appendChild(modelNote);
  }
  addRow(root, str.settingsTheme, () => {
    const sel = el("select", "field") as HTMLSelectElement;
    sel.innerHTML =
      `<option value="dark">${escapeHtml(str.themeDark)}</option>` +
      `<option value="light">${escapeHtml(str.themeLight)}</option>` +
      `<option value="system">${escapeHtml(str.themeSystem)}</option>`;
    sel.value = s.theme;
    sel.onchange = () => setAssistantSettings({ theme: sel.value as ThemeMode }, storageKey);
    return sel;
  });
  addRow(root, str.settingsSidebar, () => {
    const lab = el("label", "check field");
    const cb = el("input") as HTMLInputElement;
    cb.type = "checkbox";
    cb.checked = s.sidebarOpen;
    cb.onchange = () => setAssistantSettings({ sidebarOpen: cb.checked }, storageKey);
    lab.append(cb, el("span", undefined, str.settingsSidebarDefaultOpen));
    return lab;
  });
  addRow(root, str.settingsAnalytics, () => {
    const lab = el("label", "check field");
    const cb = el("input") as HTMLInputElement;
    cb.type = "checkbox";
    cb.checked = s.analyticsEnabled;
    cb.onchange = () => setAssistantSettings({ analyticsEnabled: cb.checked }, storageKey);
    lab.append(cb, el("span", undefined, str.settingsAnalyticsOptIn));
    return lab;
  });
}

function renderVoice(root: HTMLElement, voiceKey: string, caps: VoiceCapabilities, s: WidgetStrings = DEFAULT_STRINGS) {
  const hint = el("p", "hint");
  hint.textContent = s.settingsVoiceHint;
  root.appendChild(hint);

  const speakLabel = el("label", "check field");
  const speakCb = el("input") as HTMLInputElement;
  speakCb.type = "checkbox";
  speakCb.checked = getVoiceSettings(voiceKey).autoSpeak;
  speakCb.onchange = () => setVoiceSettings({ autoSpeak: speakCb.checked }, voiceKey);
  speakLabel.append(speakCb, el("span", undefined, s.readAloud));
  addRow(root, s.settingsReadAloud, () => speakLabel);

  const vs = getVoiceSettings(voiceKey);
  const serverTts = caps.tts.server;
  const serverStt = caps.stt.server;

  const ttsSel = el("select", "field") as HTMLSelectElement;
  ttsSel.innerHTML =
    `<option value="browser">${escapeHtml(s.optionBrowserFree)}</option>` +
    `<option value="server"${serverTts ? "" : " disabled"}>${escapeHtml(s.optionServerTts + (serverTts ? "" : s.suffixNotConfigured))}</option>`;
  ttsSel.value = vs.ttsMode;
  ttsSel.onchange = () => setVoiceSettings({ ttsMode: ttsSel.value as TtsMode }, voiceKey);
  addRow(root, s.settingsSpeechEngine, () => ttsSel);

  const sttSel = el("select", "field") as HTMLSelectElement;
  sttSel.innerHTML =
    `<option value="browser">${escapeHtml(s.optionBrowserFree)}</option>` +
    `<option value="server"${serverStt ? "" : " disabled"}>${escapeHtml(s.optionServerWhisper + (serverStt ? "" : s.suffixNotConfigured))}</option>`;
  sttSel.value = vs.sttMode;
  sttSel.onchange = () => setVoiceSettings({ sttMode: sttSel.value as SttMode }, voiceKey);
  addRow(root, s.settingsMicInput, () => sttSel);

  if (vs.ttsMode === "server") {
    const provSel = el("select", "field") as HTMLSelectElement;
    const provOpts: Array<[TtsProvider, string]> = [
      ["elevenlabs", s.providerElevenLabs],
      ["openai", s.providerOpenAiTts],
    ];
    provSel.innerHTML = provOpts
      .map(([id, label]) => {
        const ok = !serverTts || caps.tts.providers.length === 0 || caps.tts.providers.includes(id);
        return `<option value="${id}"${ok ? "" : " disabled"}>${escapeHtml(label + (ok ? "" : s.suffixNoServerKey))}</option>`;
      })
      .join("");
    provSel.value = vs.ttsProvider;
    provSel.onchange = () => setVoiceSettings({ ttsProvider: provSel.value as TtsProvider }, voiceKey);
    addRow(root, s.settingsTtsProvider, () => provSel);

    const voiceSel = el("select", "field") as HTMLSelectElement;
    const list = vs.ttsProvider === "elevenlabs" ? ELEVENLABS_VOICES : OPENAI_VOICES;
    voiceSel.innerHTML = list.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.label)}</option>`).join("");
    voiceSel.value = vs.ttsProvider === "elevenlabs" ? vs.elevenLabsVoiceId : vs.openaiVoice;
    voiceSel.onchange = () => {
      if (getVoiceSettings(voiceKey).ttsProvider === "elevenlabs") {
        setVoiceSettings({ elevenLabsVoiceId: voiceSel.value }, voiceKey);
      } else {
        setVoiceSettings({ openaiVoice: voiceSel.value }, voiceKey);
      }
    };
    addRow(root, s.settingsVoiceName, () => voiceSel);
  }

  // Explain any greyed-out options + warn if a stored preference can't be honored.
  const note = el("p", "hint");
  note.style.marginTop = "12px";
  if (!serverTts && !serverStt) {
    note.textContent = s.voiceNoteNoServerKeys;
    root.appendChild(note);
  } else if ((vs.ttsMode === "server" && !serverTts) || (vs.sttMode === "server" && !serverStt)) {
    note.textContent = s.voiceNoteSavedUnavailable;
    root.appendChild(note);
  } else if (!serverTts || !serverStt) {
    note.textContent = s.voiceNoteSomeGreyed;
    root.appendChild(note);
  }
}

function renderData(root: HTMLElement, chatStore?: ChatHistoryStore, s: WidgetStrings = DEFAULT_STRINGS) {
  const hint = el("p", "hint");
  hint.textContent = s.settingsDataHint;
  root.appendChild(hint);

  const exportBtn = el("button", "btn btn-primary") as HTMLButtonElement;
  exportBtn.textContent = s.settingsExportChats;
  exportBtn.onclick = () => {
    if (!chatStore) return;
    downloadFile("page-assistant-chats.json", chatStore.exportAll());
  };
  root.appendChild(exportBtn);

  const importLabel = el("label", "btn btn-ghost") as HTMLLabelElement;
  importLabel.textContent = s.settingsImportChats;
  const importInput = el("input") as HTMLInputElement;
  importInput.type = "file";
  importInput.accept = ".json";
  importInput.style.display = "none";
  importInput.onchange = async () => {
    const file = importInput.files?.[0];
    if (!file || !chatStore) return;
    const ok = chatStore.importAll(await file.text());
    alert(ok ? s.settingsImportOk : s.settingsImportFailed);
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
  const str = resolveStrings(opts.strings);
  const storageKey = opts.storageKey ?? ASSISTANT_SETTINGS_STORAGE_KEY;
  const shadow = modalHost.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  const applyTheme = () => {
    style.textContent = panelStyle(getAssistantSettings(storageKey).theme, EXTRA_CSS);
  };
  applyTheme();
  shadow.appendChild(style);
  window.addEventListener(ASSISTANT_SETTINGS_CHANGE_EVENT, applyTheme);
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : undefined;
  media?.addEventListener?.("change", applyTheme);

  const backdrop = el("div", "modal-backdrop");
  backdrop.onclick = (e) => {
    if (e.target === backdrop) closeAssistantSettingsModal();
  };
  const modal = el("div", "modal");
  modal.onclick = (e) => e.stopPropagation();
  const head = el("div", "modal-head");
  const h2 = el("h2");
  h2.textContent = opts.title ?? str.settingsTitle;
  const closeBtn = el("button", "btn btn-ghost") as HTMLButtonElement;
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", str.close);
  closeBtn.onclick = () => closeAssistantSettingsModal();
  head.append(h2, closeBtn);

  const mount = el("div");
  modal.append(head, mount);
  backdrop.appendChild(modal);
  shadow.appendChild(backdrop);

  const cleanup = mountAssistantSettingsPanel(mount, opts);
  (modalHost as any)._cleanup = () => {
    window.removeEventListener(ASSISTANT_SETTINGS_CHANGE_EVENT, applyTheme);
    media?.removeEventListener?.("change", applyTheme);
    cleanup();
  };
}

export function closeAssistantSettingsModal() {
  if (!modalHost) return;
  (modalHost as any)._cleanup?.();
  modalHost.remove();
  modalHost = undefined;
}

const EXTRA_CSS = `
.tabs { display: flex; gap: 4px; margin-bottom: 14px; border-bottom: 1px solid var(--pa-border); padding-bottom: 8px; }
.tab { background: none; border: none; color: var(--pa-text-muted); padding: 6px 12px; cursor: pointer; border-radius: 6px; font-size: 13px; }
.tab.active { background: var(--pa-bg-elevated); color: var(--pa-text); }
.tab-body { min-height: 200px; }
.btn { margin-top: 8px; display: inline-block; }
`;

function escapeHtml(v: string) {
  return v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

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
