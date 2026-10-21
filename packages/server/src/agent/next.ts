// Next.js App Router helper. In `app/api/pa/agent/route.ts`:
//
//   import { createAgentRoute } from "@page-assistant/server/next";
//   export const runtime = "nodejs";
//   export const maxDuration = 60;
//   export const { GET, POST } = createAgentRoute({ getUser, tools, appName: "Recall" });
//
// The route is the whole server side: auth (`getUser`), the app's tools, and the model call.
// No Express, no separate server.

import { createAgentHandler, type AgentHandlerOptions } from "./handler.js";

export function createAgentRoute<C = unknown>(options: AgentHandlerOptions<C>) {
  const handler = createAgentHandler<C>(options);
  const route = (req: Request) => handler(req);
  return { GET: route, POST: route, OPTIONS: route, agent: handler.agent };
}

export type { AgentHandlerOptions } from "./handler.js";
export * from "./index.js";
