# @page-assistant/react

The **Agent mode** dock for React 19 and Next.js: a chat panel that talks to
`@page-assistant/server`'s agent route and can show the product, not just describe it.

- Confirm cards for actions that can't be undone (the button confirms; typing never does).
- View-only UI actions from the server: `navigate`, `highlight` an element marked with
  `data-pa-anchor`, `narrate`, `wait`, and your own types; **guided walkthroughs** play them one
  by one with a pointer ring and narration.
- An event bus with replay (`usePaAction`), so an action that arrives right after a navigation
  still reaches the page that mounts.
- Progress over Server-Sent Events, Stop, Retry with `Retry-After`, a safe markdown renderer
  (no HTML is ever injected), saved chats (the widget's `ChatHistoryAdapter`, Supabase or
  device), voice (server Whisper / TTS, else the browser's).
- No Tailwind, shadcn, react-query or auth library: style it with CSS variables
  (`--pa-accent`, `--pa-bg`, …) and pass your router and auth.

```tsx
"use client";
import { AgentDock, paAnchor, usePaAction } from "@page-assistant/react";
import { useRouter } from "next/navigation";

export function Assistant() {
  const router = useRouter();
  return <AgentDock endpoint="/api/pa/agent" navigate={(p) => router.push(p)} voice />;
}
```

Server side, setup and every option: [INTEGRATION.md §9](https://github.com/philipposk/page-assistant/blob/main/INTEGRATION.md#9-agent-mode-server-side-tool-loop--react-dock).
Runnable example: [`examples/next-agent`](https://github.com/philipposk/page-assistant/tree/main/examples/next-agent).

Headless: `useAgentChat`, `useActionRunner`, `createActionRunner`, `HighlightOverlay`,
`PendingActionCard`, `Markdown`, `postTurn` are exported for a host that wants its own UI.

MIT
