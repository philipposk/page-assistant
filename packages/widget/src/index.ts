import {
  Assistant,
  InMemoryStore,
  type Capability,
  type ChatMessage,
  type PageContext,
} from "@page-assistant/core";
import { proxyProvider } from "./llmProxy.js";
import { Voice, type VoiceOptions } from "./voice.js";
import { WidgetUI } from "./ui.js";
import { fullScan, scanPage } from "./scanner.js";

export interface PageAssistantConfig {
  /** Backend base URL (the @page-assistant/server deployment). */
  serverUrl: string;
  appName?: string;
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
}

export { capability } from "./capability.js";
export type { Capability } from "@page-assistant/core";
export { scanPage, fullScan } from "./scanner.js";

class PageAssistantController {
  private assistant: Assistant;
  private ui: WidgetUI;
  private voice?: Voice;
  private history: ChatMessage[] = [];
  private scanned = false;
  private listening = false;
  private pending?: { name: string; args: Record<string, unknown> };
  private map?: PageContext["map"];

  constructor(private cfg: PageAssistantConfig) {
    this.assistant = new Assistant({
      capabilities: cfg.capabilities,
      llm: proxyProvider(cfg.serverUrl),
      memory: new InMemoryStore(),
      appName: cfg.appName,
      persona: cfg.persona,
      knowledge: cfg.knowledge,
      suggestions: cfg.suggestions,
    });
    if (cfg.voice) {
      const vo: VoiceOptions = cfg.voice === true ? { serverUrl: cfg.serverUrl } : { serverUrl: cfg.serverUrl, ...cfg.voice };
      this.voice = new Voice(vo);
    }
    this.ui = new WidgetUI(cfg.appName ?? "Assistant", {
      onSend: (t) => this.handleUser(t),
      onMic: () => this.toggleMic(),
      onConfirm: (ok) => this.handleConfirm(ok),
    });
    injectDiscoveryHint(cfg.serverUrl, cfg.knowledgeUrl);
    this.firstOpenHook();
  }

  private firstOpenHook() {
    // Lazily scan + greet the first time the panel opens.
    const launcher = (this.ui as any).launcher as HTMLElement;
    launcher.addEventListener(
      "click",
      async () => {
        if (this.scanned) return;
        this.scanned = true;
        if (this.cfg.greeting) this.ui.addMessage("assistant", this.cfg.greeting);
        if (this.cfg.suggestions?.length) this.ui.addSuggestions(this.cfg.suggestions, (t) => this.handleUser(t));
        // Auto-onboard: pull in README/llm.txt so the assistant understands the app.
        if (this.cfg.knowledgeUrl) {
          try {
            const res = await fetch(this.cfg.knowledgeUrl);
            if (res.ok) this.assistant.setKnowledge((await res.text()).slice(0, 6000));
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
      },
      { once: true }
    );
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
    const res = await this.assistant.confirmAndRun(this.pending.name, this.pending.args, this.pageContext());
    this.pending = undefined;
    this.ui.addMessage("assistant", res.message);
    await this.say(res.message);
  }

  private async say(text: string) {
    if (!this.voice) {
      this.ui.setState("idle");
      return;
    }
    this.ui.setState("talking");
    await this.voice.speak(text);
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
    const text = await this.voice.listenOnce();
    this.listening = false;
    this.ui.setMic(false);
    this.ui.setState("idle");
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
