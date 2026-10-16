import { afterEach, describe, expect, it } from "vitest";

import {
  authorizeUrl,
  nonceOf,
  oauthRoutes,
  signState,
} from "../../src/oauth.js";
import { MemoryStore } from "../../src/store.js";
import {
  APPLICATION,
  FakeHosts,
  FakePort,
  GUILD,
  id,
  quietLogger,
  serve,
  testCipher,
} from "../support/discord.js";

/**
 * Install and bind (plans/DISCORD.md §3.1, DC-103): the signed one-use state
 * keeping Datalayer's bind code server side, the guild read from Discord's
 * token response and refused when the hint differs, a spent or expired bind
 * code storing nothing, a reinstall, and a replayed state.
 */

const SECRET = "test-only-client-secret";

describe("/discord/install and /discord/oauth/callback (DC-103)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function service(now = () => Date.UTC(2026, 9, 16, 12)) {
    const store = new MemoryStore();
    const port = new FakePort();
    const hosts = new FakeHosts();
    const cipher = testCipher();
    const routes = oauthRoutes({
      appUrl: "https://discord.example.datalayer.run",
      applicationId: APPLICATION,
      cipher,
      clientSecret: SECRET,
      development: false,
      hosts: hosts.client,
      logger: quietLogger(),
      now,
      port,
      store,
      webUrl: "https://datalayer.ai",
    });
    const served = await serve({
      "GET /discord/install": routes.install,
      "GET /discord/oauth/callback": routes.callback,
    });
    close = served.close;
    const get = (path: string) =>
      fetch(`${served.url}${path}`, { redirect: "manual" });
    /** Start an install from the Ship card: the state Discord would hand back. */
    const start = async (bind = "dlhb_bind_code_1") => {
      const response = await get(`/discord/install?datalayer_bind=${bind}`);
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(
        "https://discord.com/oauth2/authorize",
      );
      expect(location.searchParams.get("integration_type")).toBe("0");
      expect(location.searchParams.get("scope")).toBe(
        "bot applications.commands",
      );
      expect(location.searchParams.get("permissions")).toBe("309237763136");
      expect(location.toString()).not.toContain(bind);
      return location.searchParams.get("state")!;
    };
    return { cipher, get, hosts, port, start, store };
  }

  it("binds the guild from Discord's token response with the kept bind code, the host key encrypted", async () => {
    const { get, start, store, hosts, cipher } = await service();
    const state = await start();
    const done = await get(
      `/discord/oauth/callback?code=discord-code&state=${state}&guild_id=${GUILD}&permissions=309237763136`,
    );
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("@Datalayer is added");
    expect(hosts.bound).toEqual([
      {
        code: "dlhb_bind_code_1",
        externalId: `${APPLICATION}:${GUILD}`,
        name: "Test",
      },
    ]);
    const kept = await store.installation(APPLICATION, GUILD);
    expect(kept).toMatchObject({
      hostUid: "host-1",
      organizationUid: "account-1",
      state: "active",
    });
    expect(JSON.stringify(kept)).not.toContain("dlhk_test_1");
    expect(cipher.decrypt(kept!.hostKey, `${APPLICATION}:${GUILD}`)).toBe(
      "dlhk_test_1",
    );
  });

  it("refuses a replayed state, a forged state and a missing bind code, storing nothing", async () => {
    const { get, start, store, hosts } = await service();
    const state = await start();
    expect(
      (await get(`/discord/oauth/callback?code=c&state=${state}`)).status,
    ).toBe(200);
    expect(
      (await get(`/discord/oauth/callback?code=c&state=${state}`)).status,
    ).toBe(400);
    expect(
      (
        await get(
          `/discord/oauth/callback?code=c&state=${signState("made-up", "another secret")}`,
        )
      ).status,
    ).toBe(400);
    expect((await get("/discord/install")).status).toBe(400);
    expect(hosts.bound).toHaveLength(1);
    expect(await store.installations()).toHaveLength(1);
  });

  it("refuses a guild hint that differs from the token response's guild (guild substitution)", async () => {
    const { get, start, store, hosts } = await service();
    const state = await start();
    const response = await get(
      `/discord/oauth/callback?code=c&state=${state}&guild_id=${id(77)}`,
    );
    expect(response.status).toBe(400);
    expect(hosts.bound).toHaveLength(0);
    expect(await store.installations()).toHaveLength(0);
  });

  it("refuses an install without a code outside development", async () => {
    const { get, start, hosts } = await service();
    const state = await start();
    expect(
      (await get(`/discord/oauth/callback?state=${state}&error=access_denied`))
        .status,
    ).toBe(400);
    expect(hosts.bound).toHaveLength(0);
  });

  it("stores nothing when Datalayer refuses a spent or expired bind code", async () => {
    const { get, start, store, hosts } = await service();
    hosts.spentCodes.add("dlhb_bind_code_1");
    const state = await start();
    const response = await get(`/discord/oauth/callback?code=c&state=${state}`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("was used or expired");
    expect(await store.installations()).toHaveLength(0);
  });

  it("refuses a state older than ten minutes", async () => {
    let at = Date.UTC(2026, 9, 16, 12);
    const { get, start, hosts } = await service(() => at);
    const state = await start();
    at += 10 * 60 * 1000 + 1;
    expect(
      (await get(`/discord/oauth/callback?code=c&state=${state}`)).status,
    ).toBe(400);
    expect(hosts.bound).toHaveLength(0);
  });

  it("makes a reinstall active again under its new host", async () => {
    const { get, start, store } = await service();
    await get(
      `/discord/oauth/callback?code=c&state=${await start("dlhb_bind_code_1")}`,
    );
    await store.setInstallationState(APPLICATION, GUILD, "removed", new Date());
    await get(
      `/discord/oauth/callback?code=c&state=${await start("dlhb_bind_code_2")}`,
    );
    expect(await store.installation(APPLICATION, GUILD)).toMatchObject({
      hostUid: "host-2",
      state: "active",
    });
  });

  it("signs states so only this service's verify", () => {
    const state = signState("n0nce", SECRET);
    expect(nonceOf(state, SECRET)).toBe("n0nce");
    expect(nonceOf(state, "other")).toBeUndefined();
    expect(nonceOf(`${state}x`, SECRET)).toBeUndefined();
    expect(
      authorizeUrl(
        { appUrl: "https://x.datalayer.run/", applicationId: APPLICATION },
        state,
      ),
    ).toContain(
      encodeURIComponent("https://x.datalayer.run/discord/oauth/callback"),
    );
  });
});
