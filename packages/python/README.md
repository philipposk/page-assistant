# page-assistant (Python client)

A thin, dependency-free Python client for the page-assistant REST API. Not published
to PyPI yet — install from source.

```bash
pip install -e packages/python
```

```python
from page_assistant import PageAssistantClient

client = PageAssistantClient(base_url="http://localhost:8787")
print(client.health())
print(client.chat("simulate a cross of Blue Dream and OG Kush"))
```

`chat()` calls `POST /v1/agent`, which only exists when the server was started with
capabilities (see `examples/full-server.mjs` in the repo). Env: `PA_SERVER_URL`,
`PA_AUTH_TOKEN`.

CLI:

```bash
python -m page_assistant.cli health
python -m page_assistant.cli chat "your message"
```

MIT
