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

/**
 * Routes by `"<METHOD> <path>"`, the path without its query. A path's last
 * segment may be a parameter (`/datalayer/deliveries/:hostUid`): it matches
 * one non-empty segment, handed to the route as `request.params`.
 */
export type Routes = Readonly<Record<string, Route>>;

/** The route for a request, and its parameter when the route names one. */
export function routeOf(
  routes: Routes,
  method: string | undefined,
  path: string,
): { route: Route; params?: Record<string, string> } | undefined {
  const exact = routes[`${method} ${path}`];
  if (exact) return { route: exact };
  const cut = path.lastIndexOf("/");
  const segment = path.slice(cut + 1);
  if (cut <= 0 || !/^[A-Za-z0-9_-]{1,128}$/.test(segment)) return undefined;
  const prefix = `${method} ${path.slice(0, cut)}/:`;
  for (const [key, route] of Object.entries(routes))
    if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
      return { params: { [key.slice(prefix.length)]: segment }, route };
  return undefined;
}

/**
 * The service's HTTP server: `/healthz` and `/readyz`
 * on every role; the ingress adds Discord's routes (`POST
 * /discord/interactions`, DC-102; `GET /discord/install`, `GET
 * /discord/oauth/callback`, `POST /discord/events`, DC-103; `POST
 * /datalayer/deliveries/:hostUid`, DC-301). Anything else
 * is 404; a route that throws answers 500 and says nothing more.
 */
export function createHttpServer(
  checks: ReadinessChecks,
  routes: Routes = {},
  onError: (error: unknown) => void = () => {},
): Server {
  return createServer((request, response) => {
    if (answerHealth(checks, request, response)) return;
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const found = routeOf(routes, request.method, path);
    if (!found) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (found.params)
      (
        request as IncomingMessage & { params?: Record<string, string> }
      ).params = found.params;
    found.route(request, response).catch((error: unknown) => {
      onError(error);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "internal error" }));
      } else response.end();
    });
  });
}
