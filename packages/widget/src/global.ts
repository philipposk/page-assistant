// Entry of the script-tag build (dist/page-assistant.global.js). Apps that load it have only
// `window.PageAssistant`, so it carries every export of the module, not a hand-kept subset:
// 0.6.0's subset lacked `supabaseChatHistoryAdapter`, and without an adapter the widget quietly
// keeps chats on the device. On a name clash the controller's own methods win.
//
// This lives in its own entry, not at the end of index.ts: there it needed index.ts to import
// itself, and Turbopack runs such a module's code before its re-exports are defined, so importing
// @page-assistant/widget in a Next.js app threw "Cannot read properties of undefined".
import * as widgetExports from "./index.js";

export * from "./index.js";

if (typeof window !== "undefined") {
  (window as any).PageAssistant = { ...widgetExports, ...widgetExports.PageAssistant };
}
