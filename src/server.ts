import {
  answerHealth,
  type ReadinessChecks,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { createServer, type Server } from "node:http";

/**
 * The service's HTTP server (plans/DISCORD.md §4): `/healthz` and `/readyz`
 * on every role; the ingress adds Discord's routes as their boxes land
 * (`/discord/interactions`, DC-102; `/discord/install`, `/discord/oauth/
 * callback`, `/discord/events`, DC-103; `/datalayer/deliveries/{host}`,
 * DC-301). Anything else is 404.
 */
export function createHttpServer(checks: ReadinessChecks): Server {
  return createServer((request, response) => {
    if (answerHealth(checks, request, response)) return;
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
}
