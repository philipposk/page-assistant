// Mount a web-standard handler on Node's http server or Express:
//
//   app.all("/api/pa/agent", toNodeHandler(createAgentHandler({ ... })));
//
// Works whether or not express.json() already read the body.

import type { IncomingMessage, ServerResponse } from "node:http";

type NodeRequest = IncomingMessage & { body?: unknown; originalUrl?: string };

export function toNodeHandler(handler: (req: Request) => Promise<Response>, opts: { maxBodyBytes?: number } = {}) {
  // Bounds what is buffered before the handler (and its sign-in check) even runs. The agent
  // route takes 256 KB; voice uploads up to 5 MB.
  const maxBody = opts.maxBodyBytes ?? 6 * 1024 * 1024;
  return async (req: NodeRequest, res: ServerResponse): Promise<void> => {
    try {
      if (Number(req.headers["content-length"] ?? "0") > maxBody) {
        res.statusCode = 413;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "The request is too large." }));
        req.resume();
        return;
      }
      const host = req.headers.host ?? "localhost";
      const url = `http://${host}${req.originalUrl ?? req.url ?? "/"}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
        else if (v !== undefined) headers.set(k, v);
      }
      let body: string | Uint8Array | undefined;
      if (req.method === "POST") {
        if (req.body !== undefined) {
          body = typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : JSON.stringify(req.body);
          headers.delete("content-length");
        } else {
          const read = await readAll(req, maxBody);
          if (read === null) {
            res.statusCode = 413;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "The request is too large." }));
            return;
          }
          body = read;
        }
      }
      // The request's signal follows the socket, so a closed tab stops the turn.
      const closed = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) closed.abort(new Error("connection closed"));
      });
      const response = await handler(new Request(url, { method: req.method, headers, body, signal: closed.signal }));
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (!response.body) {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      req.on("close", () => void reader.cancel().catch(() => undefined));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
      }
      res.end(JSON.stringify({ error: "The assistant failed." }));
    }
  };
}

/** The raw body (audio stays binary), or null once it passes `max` bytes (reading stops there). */
function readAll(req: IncomingMessage, max: number): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    req.on("error", reject);
  });
}
