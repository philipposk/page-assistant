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

export interface PageAssistantConfig {
  /** Backend base URL (the @page-assistant/server deployment). */
  serverUrl: string;
  appName?: string;
  /**
   * The mark on the launcher button. One of the names in LAUNCHER_ICONS —
   * "chat" (default), "sparkle", "mic", "book", "help", "phone" — or your own
   * SVG string, or a single character such as an emoji.
   *
   * It used to be a telephone with no way to change it, which reads as "call
   * support" rather than "ask something and get an answer now".
   */
  launcherIcon?: string;
  persona?: string;
  /** Real host actions the assistant may perform. The grounding boundary. */
  capabilities: Capability[];
  /** Return current app state each turn (selected items, current view…). */
  getPageState?: () => Record<string, unknown>;
  /** Voice: true for browser defaults, or detailed options (server TTS, voice id…). */
  voice?: boolean | VoiceOptions;
  /** Run a full same-origin scan on first open. Default true. */
  autoScan?: boolean;
  /** Greet the user when first opened. */
  greeting?: string;
  /** Background knowledge (README/docs/"what this app is") so the assistant understands the product. */
  knowledge?: string;
  /** URL to fetch extra knowledge from on first open (e.g. "/llm.txt" or "/README.md"). */
  knowledgeUrl?: string;
  /** Suggested prompts shown as clickable chips and offered proactively. */
  suggestions?: string[];
  /** When true, assistant reads replies aloud. Default false (text only). */
  autoSpeak?: boolean;
  /** Open assistant / voice settings (gear). Omit to use the built-in voice settings modal. */
  onSettings?: () => void;
  /** Link shown in the built-in settings modal footer (e.g. "/settings#assistant"). */
  settingsPageUrl?: string;
  /** localStorage key for voice prefs. Default `page_assistant_voice_settings`. */
  settingsStorageKey?: string;
  /** Load TTS/STT voice options from stored settings on init + when settings change. Default true. */
  useVoiceSettings?: boolean;
  /** Bearer token for standalone server when PA_AUTH_TOKEN is set. Prefer host session auth in production. */
  authToken?: string;
  /** "persistent" (default, localStorage — remembers across visits) or "session" (forgets on reload). */
  memory?: "persistent" | "session";
}

export { capability } from "./capability.js";
export type { Capability } from "@page-assistant/core";
export { scanPage, fullScan } from "./scanner.js";
export { LocalMemoryStore } from "./localMemory.js";
export { pageActionCapabilities } from "./pageActions.js";
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

class PageAssistantController {
  private assistant: Assistant;
  private ui: WidgetUI;
  private voice?: Voice;
  private history: ChatMessage[] = [];
  private scanned = false;
  private listening = false;
  private ttsEnabled: boolean;
  private pending?: { name: string; args: Record<string, unknown> };
  private map?: PageContext["map"];
  private settingsKey: string;
  private onSettingsChange: () => void;

  constructor(private cfg: PageAssistantConfig) {
    this.settingsKey = cfg.settingsStorageKey ?? VOICE_SETTINGS_STORAGE_KEY;
    const stored = getVoiceSettings(this.settingsKey);
    const useStored = cfg.useVoiceSettings !== false;
    this.ttsEnabled = cfg.autoSpeak ?? (useStored ? stored.autoSpeak : false);
    // Persistent memory by default (localStorage); opt out with memory: "session".
    const memory = cfg.memory === "session" ? new InMemoryStore() : new LocalMemoryStore();
    // Built-ins: remember facts + act on any scanned page. Host capabilities win on name clash.
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
      llm: proxyProvider(cfg.serverUrl, cfg.authToken),
      memory,
      appName: cfg.appName,
      persona: cfg.persona,
      knowledge: cfg.knowledge,
      suggestions: cfg.suggestions,
    });
    if (cfg.voice !== false) {
      let vo: VoiceOptions;
      if (cfg.voice === true || cfg.voice === undefined) {
        vo = useStored
          ? voiceOptionsFromSettings(cfg.serverUrl, stored)
          : { serverUrl: cfg.serverUrl };
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
    };
    this.ui = new WidgetUI(cfg.appName ?? "Assistant", {
      onSend: (t) => this.handleUser(t),
      onMic: () => this.toggleMic(),
      onConfirm: (ok) => this.handleConfirm(ok),
      onToggle: (open) => this.handleToggle(open),
      onSettings: () =>
        cfg.onSettings?.() ?? openVoiceSettingsModal(settingsUiOpts),
      onTtsToggle: (on) => {
        this.ttsEnabled = on;
      },
    }, cfg.launcherIcon);
    this.ui.setTtsEnabled(this.ttsEnabled);
    this.onSettingsChange = () => {
      if (cfg.useVoiceSettings === false || cfg.voice === false) return;
      const s = getVoiceSettings(this.settingsKey);
      this.updateConfig({
        autoSpeak: cfg.autoSpeak ?? s.autoSpeak,
        voice: voiceOptionsFromSettings(cfg.serverUrl, s),
      });
    };
    window.addEventListener(VOICE_SETTINGS_CHANGE_EVENT, this.onSettingsChange);
    injectDiscoveryHint(cfg.serverUrl, cfg.knowledgeUrl);
  }

  dispose() {
    window.removeEventListener(VOICE_SETTINGS_CHANGE_EVENT, this.onSettingsChange);
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

  private async handleToggle(open: boolean) {
    if (!open) {
      this.voice?.stop(); // closing the panel shuts the assistant up
      return;
    }
    if (this.scanned) return;
    this.scanned = true;
    if (this.cfg.greeting) this.ui.addMessage("assistant", this.cfg.greeting);
    if (this.cfg.suggestions?.length) this.ui.addSuggestions(this.cfg.suggestions, (t) => this.handleUser(t));
    // Auto-onboard: pull in README/llm.txt so the assistant understands the app.
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

  private async handleUser(text: string) {
    // Typing a new message abandons any staged confirmation — it must not fire later.
    if (this.pending) {
      this.pending = undefined;
      this.ui.addMessage("system", "Previous pending action cancelled.");
    }
    this.ui.addMessage("user", text);
    this.ui.setState("thinking");
    try {
      const res = await this.assistant.chat({ message: text, page: this.pageContext(), history: this.history });
      this.history.push({ role: "user", content: text }, { role: "assistant", content: res.message });
      if (this.history.length > 20) this.history = this.history.slice(-20);

      if (res.pendingConfirmation) {
        this.pending = { name: res.pendingConfirmation.name, args: res.pendingConfirmation.args };
        this.ui.addConfirm(res.message);
        this.ui.setState("idle");
        return;
      }
      this.ui.addMessage("assistant", res.message);
      await this.say(res.message);
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
      /* a TTS failure must not freeze the mascot in "talking" */
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
  /** Mount the assistant on the current page. Call once after the app has loaded. */
  init(cfg: PageAssistantConfig) {
    if (instance) return instance;
    instance = new PageAssistantController(cfg);
    return instance;
  },
  /** Update voice / read-aloud after init (e.g. when user changes settings). */
  configure(patch: Partial<Pick<PageAssistantConfig, "autoSpeak" | "voice">>) {
    instance?.updateConfig(patch);
  },
  openVoiceSettings: openVoiceSettingsModal,
  closeVoiceSettings: closeVoiceSettingsModal,
  mountVoiceSettingsPanel,
};

/** Add <link rel="llm"> + meta so agents scanning the page HTML discover the manifest. */
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

// UMD-ish global for <script> embedding.
if (typeof window !== "undefined") (window as any).PageAssistant = PageAssistant;
