# @page-assistant/widget

The embeddable browser widget: floating voice assistant, page scanner, and grounded
actions. The grounding loop runs **in the page**, so your real functions execute
locally and results never round-trip through the model.

## Script tag

```html
<script src="https://unpkg.com/@page-assistant/widget/dist/page-assistant.global.js"></script>
<script>
  PageAssistant.init({
    serverUrl: "http://localhost:8787",
    appName: "Acme Assistant",
    voice: true,
    capabilities: [ /* your real actions */ ],
  });
</script>
```

## Bundler (React/Next/Vue)

```ts
import { PageAssistant, capability } from "@page-assistant/widget";
```

## Capabilities register in two places

Capabilities passed to `PageAssistant.init()` run in the **browser**. They do **not**
carry over to the server's `/v1/agent` + `llm.txt` — that path uses a separate
`ServerConfig.capabilities` list in `@page-assistant/server`. Register in both if you
want both the on-page assistant and the agent-to-agent endpoint.

See [INTEGRATION.md](https://github.com/philipposk/page-assistant/blob/main/INTEGRATION.md).

MIT
