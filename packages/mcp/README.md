# @page-assistant/mcp

MCP (Model Context Protocol) stdio server that exposes a page-assistant backend to
Cursor, Claude Desktop, and other MCP clients. This is the artifact those users
install to let their agent talk to the assistant living on your app.

## Tools

- `ask_page_assistant` — send a message to the grounded assistant (POST `/v1/agent`).
- `health_check` — check the backend is reachable.

## Install (Claude Desktop / Cursor)

```json
{
  "mcpServers": {
    "page-assistant": {
      "command": "npx",
      "args": ["-y", "@page-assistant/mcp"],
      "env": {
        "PA_SERVER_URL": "http://localhost:8787",
        "PA_AUTH_TOKEN": "your-token-if-required"
      }
    }
  }
}
```

**`PA_SERVER_URL` must point at a server started with capabilities**, or
`ask_page_assistant` returns 404 — the default proxy does not mount `/v1/agent`. See
[`examples/full-server.mjs`](https://github.com/philipposk/page-assistant/blob/main/examples/full-server.mjs).

MIT
