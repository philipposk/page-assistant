// Runnable full server: proxy + external agent endpoint + llm.txt + actions.json.
//
// The default proxy (packages/server bin, or `page-assistant serve` with no config)
// does NOT mount /v1/agent, /llm.txt, or /.well-known/llm-actions.json — those only
// appear when you pass `capabilities` (and `llmTxt`) to createServer. This example
// does exactly that with two sample capabilities, so the agent-to-agent journey works:
//
//   1. Build the packages first (dist is gitignored):  npm install && npm run build
//   2. (optional) put an LLM key in packages/server/.env  (OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY)
//   3. Run it:  node --env-file=packages/server/.env examples/full-server.mjs
//               (or plain `node examples/full-server.mjs` if keys are already in your env)
//
// Then drive it:
//   curl localhost:8787/llm.txt
//   PA_SERVER_URL=http://localhost:8787 node packages/cli/dist/index.js chat "simulate a cross of Blue Dream and OG Kush"
//   # MCP: set PA_SERVER_URL=http://localhost:8787 for @page-assistant/mcp so ask_page_assistant works
//
// You can also feed this file to the CLI's serve command:
//   node packages/cli/dist/index.js serve --config ./examples/full-server.mjs

import { pathToFileURL } from "node:url";
import { createServer, JsonFileTicketStore } from "@page-assistant/server";

const APP_URL = process.env.PA_APP_URL ?? "http://localhost:8787";

// Sample capabilities. In a real app each run() calls your real backend; render()
// produces the trusted, user-facing text the anti-hallucination validator locks in.
const capabilities = [
  {
    name: "simulate_cross",
    description: "Simulate a breeding cross between two strains and predict yield and height.",
    parameters: {
      type: "object",
      properties: {
        a: { type: "string", description: "first strain name" },
        b: { type: "string", description: "second strain name" },
      },
      required: ["a", "b"],
    },
    run: ({ a, b }) => ({ pair: `${a} × ${b}`, yieldScore: 72, heightLow: 95, heightHigh: 140 }),
    render: (r) => `Cross ${r.pair}: predicted yield ${r.yieldScore}/100, height ${r.heightLow}–${r.heightHigh} cm.`,
  },
  {
    name: "grow_advice",
    description: "Give grow advice for a strain and environment.",
    parameters: {
      type: "object",
      properties: {
        strain: { type: "string", description: "strain name" },
        indoor: { type: "boolean", description: "true for indoor grow" },
      },
      required: ["strain"],
    },
    run: ({ strain, indoor }) => ({ strain, setting: indoor ? "indoor" : "outdoor", weeks: 9 }),
    render: (r) => `${r.strain} (${r.setting}): ~${r.weeks} weeks flowering. Keep humidity below 50% in late flower.`,
  },
];

// Metadata for the generated llm.txt / actions.json. agentEndpoint is where other
// agents POST { message, page } to drive this assistant.
const llmTxt = {
  appName: "Acme Strains",
  appUrl: APP_URL,
  description: "Simulate breeding crosses and get grounded grow advice.",
  agentEndpoint: `${APP_URL}/v1/agent`,
};

// The config object. Exported as the default so `page-assistant serve --config
// ./examples/full-server.mjs` can import it and mount /v1/agent + /llm.txt on the
// CLI's server WITHOUT this file starting a second server on the same port.
const config = {
  corsOrigin: process.env.PA_CORS_ORIGIN ?? "*",
  ticketStore: new JsonFileTicketStore(process.env.PA_TICKETS_FILE ?? "./data/tickets.json"),
  appName: "Acme Strains",
  capabilities,
  llmTxt,
};

export default config;
export { capabilities, llmTxt };

// Only boot a standalone server when this file is run DIRECTLY (`node
// examples/full-server.mjs`) — never on import (that would race the CLI onto the same
// port and crash with EADDRINUSE).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 8787);
  createServer(config).listen(port, () => {
    console.log(`[full-server] listening on http://localhost:${port}`);
    console.log("  POST /v1/agent  GET /llm.txt  GET /.well-known/llm-actions.json  (mounted — capabilities present)");
    console.log("  POST /v1/llm/complete  POST /v1/voice/tts  POST /v1/voice/stt  POST /v1/feedback");
    if (!process.env.PA_AUTH_TOKEN) {
      console.log("  WARNING: PA_AUTH_TOKEN not set — spend + agent endpoints are open (rate-limited only).");
    }
  });
}
