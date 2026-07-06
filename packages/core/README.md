# @page-assistant/core

The grounding brain shared by the widget and server. Framework-agnostic, no DOM or
Node dependencies — runs in the browser or Node.

- **Capability registry** — the only actions the assistant may perform.
- **Anti-hallucination tool loop** — the model narrates around facts; a validator
  rejects any number no executed capability actually returned.
- **`llm.txt` generator** — machine-readable manifest so other agents can discover
  and drive your assistant.

```ts
import { Assistant, generateLlmTxt } from "@page-assistant/core";
```

Usually consumed via `@page-assistant/widget` (browser) or `@page-assistant/server`
(Node), not directly. See the [repo README](https://github.com/philipposk/page-assistant)
for the architecture and anti-hallucination model.

MIT
