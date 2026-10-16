import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createResources } from "../src/resources.js";
import { createHttpServer, routeOf, type Route } from "../src/server.js";
import { readConfig } from "../src/config.js";
import { ENVIRONMENT } from "./support/environment.js";

describe("health and readiness (DC-008)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function serve(ready: () => Promise<boolean>) {
    const server = createHttpServer({ store: ready });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    close = () => new Promise((resolve) => server.close(() => resolve()));
    const { port } = server.address() as AddressInfo;
    return (path: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${port}${path}`, init);
  }

  it("answers /healthz while the store is down, and /readyz only when it answers", async () => {
    let up = false;
    const get = await serve(async () => up);
    expect((await get("/healthz")).status).toBe(200);
    expect((await get("/readyz")).status).toBe(503);
    up = true;
    expect(await (await get("/readyz")).json()).toEqual({
      checks: { store: true },
      ready: true,
    });
  });

  it("answers 404 to a route no box has built yet", async () => {
    const get = await serve(async () => true);
    expect(
      (await get("/discord/interactions", { method: "POST" })).status,
    ).toBe(404);
  });

  it("runs in memory in development: the queue is ready and quotas are counted", async () => {
    const resources = createResources(readConfig(ENVIRONMENT));
    try {
      expect(await resources.checks.queue?.()).toBe(true);
      expect(
        await resources.quotas.takeQuota(
          [{ key: "user:x", limit: 1, scope: "user" }],
          "w",
        ),
      ).toEqual({ ok: true });
    } finally {
      await resources.close();
    }
  });
});

describe("routes with a parameter (DC-301)", () => {
  it("matches one non-empty, plain segment after the prefix, and nothing else", () => {
    const deliveries: Route = async () => {};
    const routes = {
      "GET /healthz-like": deliveries,
      "POST /datalayer/deliveries/:hostUid": deliveries,
    };
    expect(routeOf(routes, "POST", "/datalayer/deliveries/host-1")).toEqual({
      params: { hostUid: "host-1" },
      route: deliveries,
    });
    expect(routeOf(routes, "GET", "/datalayer/deliveries/host-1")).toBe(
      undefined,
    );
    expect(routeOf(routes, "POST", "/datalayer/deliveries/")).toBe(undefined);
    expect(routeOf(routes, "POST", "/datalayer/deliveries/a/b")).toBe(
      undefined,
    );
    expect(routeOf(routes, "POST", "/datalayer/deliveries/a%2Fb")).toBe(
      undefined,
    );
    expect(routeOf(routes, "GET", "/healthz-like")).toEqual({
      route: deliveries,
    });
  });
});
