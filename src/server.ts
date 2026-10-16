import {
  answerHealth,
  type ReadinessChecks,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

/** A route's handler: it answers the request itself. */
export type Route = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

/** Routes by `"<METHOD> <path>"`, the path without its query. */
export type Routes = Readonly<Record<string, Route>>;

/**
 * The service's HTTP server (plans/DISCORD.md §4): `/healthz` and `/readyz`
 * on every role; the ingress adds Discord's routes (`POST
 * /discord/interactions`, DC-102; `GET /discord/install`, `GET
 * /discord/oauth/callback`, `POST /discord/events`, DC-103). Anything else
 * is 404; a route that throws answers 500 and says nothing more.
 */
export function createHttpServer(
  checks: ReadinessChecks,
  routes: Routes = {},
  onError: (error: unknown) => void = () => {},
): Server {
  return createServer((request, response) => {
    if (answerHealth(checks, request, response)) return;
    const path = (request.url ?? "/").split("?")[0];
    const route = routes[`${request.method} ${path}`];
    if (!route) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    route(request, response).catch((error: unknown) => {
      onError(error);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "internal error" }));
      } else response.end();
    });
  });
}
