"""Thin Python client for page-assistant REST API."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any


class PageAssistantClient:
    def __init__(self, base_url: str | None = None, auth_token: str | None = None):
        self.base_url = (base_url or os.environ.get("PA_SERVER_URL", "http://localhost:8787")).rstrip("/")
        self.auth_token = auth_token or os.environ.get("PA_AUTH_TOKEN")

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.auth_token:
            h["Authorization"] = f"Bearer {self.auth_token}"
        return h

    def _request(self, method: str, path: str, body: dict | None = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=self._headers(), method=method)
        try:
            with urllib.request.urlopen(req) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError as e:
            raise RuntimeError(e.read().decode()) from e

    def health(self) -> dict:
        return self._request("GET", "/v1/health")

    def models(self) -> dict:
        return self._request("GET", "/v1/models")

    def chat(self, message: str, page: dict | None = None) -> dict:
        return self._request("POST", "/v1/agent", {"message": message, "page": page or {"url": self.base_url, "path": "/"}})
