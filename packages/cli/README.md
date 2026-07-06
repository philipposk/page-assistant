# @page-assistant/cli

Command-line companion for a page-assistant backend.

```bash
npx @page-assistant/cli health                 # backend health
npx @page-assistant/cli models                 # list LLM models
npx @page-assistant/cli chat "your message"    # POST /v1/agent
npx @page-assistant/cli serve [port]           # start a standalone proxy
```

## serve

```bash
page-assistant serve 8787 --config ./examples/full-server.mjs
```

- Loads a local `.env` automatically.
- Persists feedback tickets to disk (`JsonFileTicketStore`).
- `--config <path>` loads a JS/MJS module (default export) or JSON file with
  `{ capabilities, llmTxt, ... }`. **Without it, `/v1/agent` and `/llm.txt` are not
  mounted**, so `chat` (and the MCP `ask_page_assistant` tool) will 404.

Env: `PA_SERVER_URL`, `PA_AUTH_TOKEN`, `PORT`, `PA_CORS_ORIGIN`, `PA_TICKETS_FILE`.

MIT
