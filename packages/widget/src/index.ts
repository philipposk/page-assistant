import {
  Assistant,
  InMemoryStore,
  rememberFactCapability,
  type Capability,
  type ChatMessage,
  type PageContext,
} from "@page-assistant/core";
import { proxyProvider } from "./llmProxy.js";
import { Voice, type VoiceOptions } from "./voice.js";
import { WidgetUI } from "./ui.js";
import { fullScan, scanPage } from "./scanner.js";
import { LocalMemoryStore } from "./localMemory.js";
import { pageActionCapabilities } from "./pageActions.js";
import {
  VOICE_SETTINGS_CHANGE_EVENT,
  VOICE_SETTINGS_STORAGE_KEY,
  getVoiceSettings,
  voiceOptionsFromSettings,
} from "./settings.js";
import { openVoiceSettingsModal, mountVoiceSettingsPanel, closeVoiceSettingsModal } from "./settings-ui.js";
import {
  ASSISTANT_SETTINGS_CHANGE_EVENT,
  ASSISTANT_SETTINGS_STORAGE_KEY,
  getAssistantSettings,
} from "./assistant-settings.js";
import {
  openAssistantSettingsModal,
  closeAssistantSettingsModal,
  mountAssistantSettingsPanel,
} from "./assistant-settings-ui.js";
import { ChatHistoryStore } from "./chatHistory.js";
import { formatAttachmentsForPrompt, type FileAttachment } from "./fileUpload.js";
import { trackEvent } from "./analytics.js";

export interface PageAssistantConfig {
  serverUrl: string;
  appName?: string;
  persona?: string;
  capabilities: Capability[];
  getPageState?: () => Record<string, unknown>;
  voice?: boolean | VoiceOptions;
  autoScan?: boolean;
  greeting?: string;
  knowledge?: string;
  knowledgeUrl?: string;
  suggestions?: string[];
  autoSpeak?: boolean;
  /** Use extended settings modal (model, theme, chat export). Default true. */
  useExtendedSettings?: boolean;
  onSettings?: () => void;
  settingsPageUrl?: string;
  settingsStorageKey?: string;
  assistantSettingsStorageKey?: string;
  chatHistoryStorageKey?: string;
  useVoiceSettings?: boolean;
  authToken?: string;
  memory?: "persistent" | "session";
  /** Disable chat history sidebar. Default false (enabled). */
  disableChatHistory?: boolean;
}

export { capability } from "./capability.js";
export type { Capability } from "@page-assistant/core";
export { scanPage, fullScan } from "./scanner.js";
export { LocalMemoryStore } from "./localMemory.js";
export { pageActionCapabilities } from "./pageActions.js";
export { ChatHistoryStore, CHAT_HISTORY_STORAGE_KEY } from "./chatHistory.js";
export {
  getAssistantSettings,
  setAssistantSettings,
  DEFAULT_MODELS,
  ASSISTANT_SETTINGS_STORAGE_KEY,
  type AssistantSettings,
  type ThemeMode,
} from "./assistant-settings.js";
export {
  getVoiceSettings,
  setVoiceSettings,
  voiceOptionsFromSettings,
  ELEVENLABS_VOICES,
  OPENAI_VOICES,
  VOICE_SETTINGS_STORAGE_KEY,
  VOICE_SETTINGS_CHANGE_EVENT,
  type VoiceSettings,
  type TtsMode,
  type TtsProvider,
  type SttMode,
} from "./settings.js";
export {
  mountVoiceSettingsPanel,
  openVoiceSettingsModal,
  closeVoiceSettingsModal,
  type VoiceSettingsUIOptions,
} from "./settings-ui.js";
export {
  mountAssistantSettingsPanel,
  openAssistantSettingsModal,
  closeAssistantSettingsModal,
  type AssistantSettingsUIOptions,
} from "./assistant-settings-ui.js";
export { trackEvent, getLocalAnalytics, exportAnalyticsMarkdown } from "./analytics.js";
export { readFileAttachment, formatAttachmentsForPrompt, type FileAttachment } from "./fileUpload.js";

class PageAssistantController {
  private assistant: Assistant;
  private ui: WidgetUI;
  private voice?: Voice;
  private history: ChatMessage[] = [];
  private chatStore: ChatHistoryStore;
  private activeChatId: string | null = null;
  private scanned = false;
  private listening = false;
  private ttsEnabled: boolean;
  private pending?: { name: string; args: Record<string, unknown> };
  private map?: PageContext["map"];
  private settingsKey: string;
  private assistantSettingsKey: string;
  private onSettingsChange: () => void;
  private onAssistantSettingsChange: () => void;

  constructor(private cfg: PageAssistantConfig) {
    this.settingsKey = cfg.settingsStorageKey ?? VOICE_SETTINGS_STORAGE_KEY;
    this.assistantSettingsKey = cfg.assistantSettingsStorageKey ?? ASSISTANT_SETTINGS_STORAGE_KEY;
    const assistantSettings = getAssistantSettings(this.assistantSettingsKey);
    const stored = getVoiceSettings(this.settingsKey);
    const useStored = cfg.useVoiceSettings !== false;
    this.ttsEnabled = cfg.autoSpeak ?? (useStored ? stored.autoSpeak : false);

    this.chatStore = new ChatHistoryStore(cfg.chatHistoryStorageKey);
    if (!cfg.disableChatHistory) {
      const active = this.chatStore.getActive();
      if (active) {
        this.activeChatId = active.id;
        this.history = [...active.messages];
      } else {
        const created = this.chatStore.create({ model: assistantSettings.model });
        this.activeChatId = created.id;
      }
    }

    const memory = cfg.memory === "session" ? new InMemoryStore() : new LocalMemoryStore();
    const builtins = [
      rememberFactCapability,
      ...pageActionCapabilities(
        () => this.map,
        async () => {
          this.map = await fullScan();
          return this.map;
        }
      ),
    ].filter((b) => !cfg.capabilities.some((c) => c.name === b.name));

    this.assistant = new Assistant({
      capabilities: [...cfg.capabilities, ...builtins],
      llm: proxyProvider(cfg.serverUrl, cfg.authToken, () => getAssistantSettings(this.assistantSettingsKey).model),
      memory,
      appName: cfg.appName,
      persona: cfg.persona,
      knowledge: cfg.knowledge,
      suggestions: cfg.suggestions,
    });

    if (cfg.voice !== false) {
      let vo: VoiceOptions;
      if (cfg.voice === true || cfg.voice === undefined) {
        vo = useStored ? voiceOptionsFromSettings(cfg.serverUrl, stored) : { serverUrl: cfg.serverUrl };
      } else {
        vo = { serverUrl: cfg.serverUrl, ...cfg.voice };
      }
      if (cfg.authToken) vo = { ...vo, authToken: cfg.authToken };
      this.voice = new Voice(vo);
    }

    const settingsUiOpts = {
      storageKey: this.settingsKey,
      settingsPageUrl: cfg.settingsPageUrl,
      title: cfg.appName ? `${cfg.appName} assistant` : "Page assistant",
      chatStore: cfg.disableChatHistory ? undefined : this.chatStore,
      serverUrl: cfg.serverUrl,
    };

    this.ui = new WidgetUI(cfg.appName ?? "Assistant", {
      onSend: (t, attachments) => this.handleUser(t, attachments),
      onMic: () => this.toggleMic(),
      onConfirm: (ok) => this.handleConfirm(ok),
      onToggle: (open) => this.handleToggle(open),
      onSettings: () =>
        cfg.onSettings?.() ??
        (cfg.useExtendedSettings !== false
          ? openAssistantSettingsModal(settingsUiOpts)
          : openVoiceSettingsModal(settingsUiOpts)),
      onTtsToggle: (on) => {
        this.ttsEnabled = on;
      },
      onNewChat: () => this.newChat(),
      onSelectChat: (id) => this.switchChat(id),
      onExportChat: () => this.exportCurrentChat(),
    }, {
      chatStore: cfg.disableChatHistory ? undefined : this.chatStore,
      theme: assistantSettings.theme,
      sidebarOpen: assistantSettings.sidebarOpen,
    });

    if (this.activeChatId && this.history.length) {
      this.ui.loadMessages(this.history.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system"));
      this.ui.setActiveChat(this.activeChatId);
    }

    this.ui.setTtsEnabled(this.ttsEnabled);

    this.onSettingsChange = () => {
      if (cfg.useVoiceSettings === false || cfg.voice === false) return;
      const s = getVoiceSettings(this.settingsKey);
      this.updateConfig({
        autoSpeak: cfg.autoSpeak ?? s.autoSpeak,
        voice: voiceOptionsFromSettings(cfg.serverUrl, s),
      });
    };
    this.onAssistantSettingsChange = () => {
      const s = getAssistantSettings(this.assistantSettingsKey);
      this.ui.setTheme(s.theme);
      this.ui.setSidebarOpen(s.sidebarOpen);
    };
    window.addEventListener(VOICE_SETTINGS_CHANGE_EVENT, this.onSettingsChange);
    window.addEventListener(ASSISTANT_SETTINGS_CHANGE_EVENT, this.onAssistantSettingsChange);
    injectDiscoveryHint(cfg.serverUrl, cfg.knowledgeUrl);
  }

  dispose() {
    window.removeEventListener(VOICE_SETTINGS_CHANGE_EVENT, this.onSettingsChange);
    window.removeEventListener(ASSISTANT_SETTINGS_CHANGE_EVENT, this.onAssistantSettingsChange);
  }

  updateConfig(patch: Partial<Pick<PageAssistantConfig, "autoSpeak" | "voice">>) {
    if (patch.autoSpeak !== undefined) {
      this.ttsEnabled = patch.autoSpeak;
      this.ui.setTtsEnabled(this.ttsEnabled);
    }
    if (patch.voice !== undefined) {
      if (patch.voice === false) {
        this.voice = undefined;
      } else {
        const vo: VoiceOptions =
          patch.voice === true
            ? { serverUrl: this.cfg.serverUrl, authToken: this.cfg.authToken }
            : { serverUrl: this.cfg.serverUrl, authToken: this.cfg.authToken, ...patch.voice };
        this.voice = new Voice(vo);
      }
    }
  }

  private newChat() {
    const model = getAssistantSettings(this.assistantSettingsKey).model;
    const session = this.chatStore.create({ model });
    this.activeChatId = session.id;
    this.history = [];
    this.pending = undefined;
    this.ui.clearLog();
    this.ui.setActiveChat(session.id);
    trackEvent("chat_new", { id: session.id }, this.analyticsUrl());
  }

  private switchChat(id: string) {
    const session = this.chatStore.get(id);
    if (!session) return;
    this.persistCurrentChat();
    this.activeChatId = id;
    this.chatStore.setActive(id);
    this.history = [...session.messages];
    this.pending = undefined;
    this.ui.clearLog();
    this.ui.loadMessages(this.history.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system"));
    this.ui.setActiveChat(id);
    trackEvent("chat_switch", { id }, this.analyticsUrl());
  }

  private persistCurrentChat() {
    if (!this.activeChatId || this.cfg.disableChatHistory) return;
    const model = getAssistantSettings(this.assistantSettingsKey).model;
    this.chatStore.saveMessages(this.activeChatId, this.history, { model });
  }

  private exportCurrentChat() {
    if (!this.activeChatId) return;
    const json = this.chatStore.share(this.activeChatId);
    if (!json) return;
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "chat-export.json";
    a.click();
    URL.revokeObjectURL(url);
    trackEvent("chat_export", { id: this.activeChatId }, this.analyticsUrl());
  }

  private analyticsUrl() {
    const s = getAssistantSettings(this.assistantSettingsKey);
    return s.analyticsEnabled ? this.cfg.serverUrl : undefined;
  }

  private async handleToggle(open: boolean) {
    if (!open) {
      this.voice?.stop();
      this.persistCurrentChat();
      return;
    }
    if (this.scanned) return;
    this.scanned = true;
    trackEvent("widget_open", {}, this.analyticsUrl());
    if (this.cfg.greeting && !this.history.length) this.ui.addMessage("assistant", this.cfg.greeting);
    if (this.cfg.suggestions?.length && !this.history.length) {
      this.ui.addSuggestions(this.cfg.suggestions, (t) => this.handleUser(t));
    }
    if (this.cfg.knowledgeUrl) {
      try {
        const url = new URL(this.cfg.knowledgeUrl, location.href);
        if (url.origin !== location.origin) {
          this.ui.addMessage("system", "Skipped knowledge fetch: cross-origin URLs are not allowed.");
        } else {
          const res = await fetch(url.href);
          if (res.ok) this.assistant.setKnowledge((await res.text()).slice(0, 6000));
        }
      } catch {
        /* best-effort */
      }
    }
    if (this.cfg.autoScan !== false) {
      this.ui.setState("scanning");
      this.ui.addMessage("system", "Reading this app…");
      try {
        this.map = await fullScan();
      } catch {
        this.map = { scannedAt: new Date().toISOString(), pages: [], controls: scanPage() };
      }
      this.ui.setState("idle");
      this.ui.addMessage("system", `Ready — mapped ${this.map?.pages.length ?? 0} pages, ${this.map?.controls.length ?? 0} controls.`);
    }
  }

  private pageContext(): PageContext {
    return {
      url: location.href,
      path: location.pathname,
      title: document.title,
      state: this.cfg.getPageState?.(),
      map: this.map,
    };
  }

  private async handleUser(text: string, attachments?: FileAttachment[]) {
    if (this.pending) {
      this.pending = undefined;
      this.ui.addMessage("system", "Previous pending action cancelled.");
    }
    const message = formatAttachmentsForPrompt(text, attachments ?? []);
    if (!message.trim()) return;
    this.ui.addMessage("user", text + (attachments?.length ? `\n📎 ${attachments.map((a) => a.name).join(", ")}` : ""));
    this.ui.setState("thinking");
    try {
      const res = await this.assistant.chat({ message, page: this.pageContext(), history: this.history });
      this.history.push({ role: "user", content: message }, { role: "assistant", content: res.message });
      this.persistCurrentChat();

      if (res.pendingConfirmation) {
        this.pending = { name: res.pendingConfirmation.name, args: res.pendingConfirmation.args };
        this.ui.addConfirm(res.message);
        this.ui.setState("idle");
        return;
      }
      this.ui.addMessage("assistant", res.message);
      await this.say(res.message);
      trackEvent("message_sent", { len: message.length }, this.analyticsUrl());
    } catch (e) {
      this.ui.addMessage("system", `Error: ${e instanceof Error ? e.message : e}`);
      this.ui.setState("idle");
    }
  }

  private async handleConfirm(approved: boolean) {
    if (!approved || !this.pending) {
      this.pending = undefined;
      this.ui.addMessage("system", "Cancelled.");
      return;
    }
    this.ui.setState("thinking");
    try {
      const res = await this.assistant.confirmAndRun(this.pending.name, this.pending.args, this.pageContext());
      this.history.push({ role: "assistant", content: res.message });
      this.persistCurrentChat();
      this.ui.addMessage("assistant", res.message);
      await this.say(res.message);
    } catch (e) {
      this.ui.addMessage("system", `Error: ${e instanceof Error ? e.message : e}`);
      this.ui.setState("idle");
    } finally {
      this.pending = undefined;
    }
  }

  private async say(text: string) {
    if (!this.voice || !this.ttsEnabled) {
      this.ui.setState("idle");
      return;
    }
    this.ui.setState("talking");
    try {
      await this.voice.speak(text);
    } catch {
      /* TTS failure must not freeze mascot */
    }
    this.ui.setState("idle");
  }

  private async toggleMic() {
    if (!this.voice) {
      this.ui.addMessage("system", "Voice is off for this app.");
      return;
    }
    if (this.listening) return;
    this.listening = true;
    this.ui.setMic(true);
    this.ui.setState("listening");
    let text = "";
    try {
      text = await this.voice.listenOnce();
    } catch {
      this.ui.addMessage("system", "I couldn't access the microphone.");
    } finally {
      this.listening = false;
      this.ui.setMic(false);
      this.ui.setState("idle");
    }
    if (text.trim()) this.handleUser(text.trim());
  }
}

let instance: PageAssistantController | undefined;

export const PageAssistant = {
  init(cfg: PageAssistantConfig) {
    if (instance) return instance;
    instance = new PageAssistantController(cfg);
    return instance;
  },
  configure(patch: Partial<Pick<PageAssistantConfig, "autoSpeak" | "voice">>) {
    instance?.updateConfig(patch);
  },
  openVoiceSettings: openVoiceSettingsModal,
  closeVoiceSettings: closeVoiceSettingsModal,
  mountVoiceSettingsPanel,
  openAssistantSettings: openAssistantSettingsModal,
  closeAssistantSettings: closeAssistantSettingsModal,
  mountAssistantSettingsPanel,
};

function injectDiscoveryHint(serverUrl: string, knowledgeUrl?: string) {
  if (typeof document === "undefined" || document.querySelector('link[rel="llm"]')) return;
  const base = (serverUrl || "").replace(/\/$/, "");
  const link = document.createElement("link");
  link.rel = "llm";
  link.href = knowledgeUrl || `${base}/llm.txt`;
  document.head.appendChild(link);
  const meta = document.createElement("meta");
  meta.name = "llm-actions";
  meta.content = `${base}/.well-known/llm-actions.json`;
  document.head.appendChild(meta);
}

if (typeof window !== "undefined") (window as any).PageAssistant = PageAssistant;
