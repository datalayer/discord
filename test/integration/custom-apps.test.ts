import { HostRefusedError } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { afterEach, describe, expect, it } from "vitest";

import type { CommandDefinition } from "../../src/commands.js";
import {
  ApplicationPorts,
  CUSTOM_INSTALL_PATH,
  CUSTOM_INTERACTIONS_ROUTE,
  CUSTOM_WORDS,
  CustomGateways,
  customAuthorizeUrlOf,
  customInstallRoutes,
  customInteractionsRoute,
  installCustomApp,
  type DiscordAppPort,
  type RunningGateway,
} from "../../src/custom-apps.js";
import { permissionsInteger } from "../../src/permissions.js";
import { MemoryStore, customAppData } from "../../src/store.js";
import {
  APPLICATION,
  FakeHosts,
  FakePort,
  GUILD,
  id,
  quietLogger,
  serve,
  signingKey,
  testCipher,
} from "../support/discord.js";

/**
 * A Discord application the person brings (decided 28 October 2026):
 * installed from the Ship card with its id, public key and bot token, the
 * server found among the bot's guilds, the commands registered on it, bound
 * at Datalayer as a custom installation; its interactions verified with its
 * own key at /discord/interactions/<id>; posted as its own bot; its gateway
 * started and stopped as its installation lives and ends.
 */

const CUSTOM = id(7);
const OTHER_GUILD = id(8);
const KEY = signingKey();
const TOKEN = `${"M".repeat(24)}.${"G".repeat(6)}.${"x".repeat(27)}`;
const CODE = "dlhc_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const APP_URL = "https://discord.example.datalayer.run";
const WEB = "https://datalayer.ai";

/** Discord's answers of a bot token: alterable per case. */
class FakeAppPort implements DiscordAppPort {
  applicationId = CUSTOM;
  verifyKey = KEY.publicKey;
  guildList: Array<{ id: string; name: string }> = [{ id: GUILD, name: "Acme" }];
  refuseToken = false;
  refuseCommands = false;
  registered: Array<{ applicationId: string; commands: readonly CommandDefinition[] }> = [];
  async application(token: string) {
    if (this.refuseToken || token !== TOKEN) throw new Error("Discord answered 401");
    return { id: this.applicationId, name: "Acme Bot", verifyKey: this.verifyKey };
  }
  async guilds() {
    return this.guildList;
  }
  async registerCommands(_token: string, applicationId: string, commands: readonly CommandDefinition[]) {
    if (this.refuseCommands) throw new Error("Discord answered 403");
    this.registered.push({ applicationId, commands });
  }
}

const COMMANDS: CommandDefinition[] = [
  { description: "Ask", name: "ask", type: 1 } as CommandDefinition,
];

function dependencies(port = new FakeAppPort()) {
  const store = new MemoryStore();
  const hosts = new FakeHosts();
  const cipher = testCipher();
  return {
    appUrl: APP_URL,
    cipher,
    commands: async () => COMMANDS,
    hosts: hosts.client,
    hostsFake: hosts,
    logger: quietLogger(),
    now: () => Date.UTC(2026, 9, 28, 10),
    port,
    store,
    webUrl: WEB,
  };
}

const request = (over: Partial<Record<string, string>> = {}) => ({
  application_id: CUSTOM,
  bind_code: CODE,
  bot_token: TOKEN,
  public_key: KEY.publicKey,
  ...over,
});

describe("installing a custom Discord application from the Ship card", () => {
  it("checks the token and key, finds the server, registers the commands, binds as application:guild, keeps it all, answers the Interactions Endpoint URL", async () => {
    const deps = dependencies();
    const done = await installCustomApp(deps, request());
    expect(done).toEqual({
      hostUid: "host-1",
      interactionsUrl: `${APP_URL}/discord/interactions/${CUSTOM}`,
      name: "Acme",
      ok: true,
    });
    expect(deps.hostsFake.bound).toEqual([{ code: CODE, externalId: `${CUSTOM}:${GUILD}`, name: "Acme" }]);
    expect(deps.port.registered).toEqual([{ applicationId: CUSTOM, commands: COMMANDS }]);
    expect(deps.hostsFake.webhooks).toEqual([{ hostKey: "dlhk_test_1", url: `${APP_URL}/datalayer/deliveries/host-1` }]);
    const installation = await deps.store.installation(CUSTOM, GUILD);
    expect(installation).toMatchObject({
      applicationId: CUSTOM,
      guildId: GUILD,
      hostUid: "host-1",
      installedBy: "account-1",
      notifications: "quiet",
      permissions: permissionsInteger(),
      state: "active",
    });
    expect(deps.cipher.decrypt(installation!.hostKey, `${CUSTOM}:${GUILD}`)).toBe("dlhk_test_1");
    const app = await deps.store.customApp(CUSTOM);
    expect(app?.publicKey).toBe(KEY.publicKey);
    expect(deps.cipher.decrypt(app!.botToken, customAppData(CUSTOM))).toBe(TOKEN);
    expect(JSON.stringify(app)).not.toContain(TOKEN);
    expect(customAuthorizeUrlOf(CUSTOM)).toBe(
      `https://discord.com/oauth2/authorize?client_id=${CUSTOM}&integration_type=0&permissions=${permissionsInteger()}&scope=bot+applications.commands`,
    );
  });

  it("refuses a token Discord refuses, another application's token, a key that is not the application's, keeping nothing", async () => {
    const refused = new FakeAppPort();
    refused.refuseToken = true;
    expect(await installCustomApp(dependencies(refused), request())).toEqual({ error: CUSTOM_WORDS.token, ok: false });
    const other = new FakeAppPort();
    other.applicationId = id(9);
    expect(await installCustomApp(dependencies(other), request())).toEqual({ error: CUSTOM_WORDS.notTheApplication, ok: false });
    const deps = dependencies();
    expect(await installCustomApp(deps, request({ public_key: "a".repeat(64) }))).toEqual({ error: CUSTOM_WORDS.publicKey, ok: false });
    expect(deps.hostsFake.bound).toEqual([]);
    expect(await deps.store.customApp(CUSTOM)).toBeUndefined();
  });

  it("needs the bot in one server, or the server named among those it is in", async () => {
    const none = new FakeAppPort();
    none.guildList = [];
    expect(await installCustomApp(dependencies(none), request())).toEqual({ error: CUSTOM_WORDS.noGuild, ok: false });
    const several = new FakeAppPort();
    several.guildList = [{ id: GUILD, name: "Acme" }, { id: OTHER_GUILD, name: "Beta" }];
    expect(await installCustomApp(dependencies(several), request())).toEqual({ error: CUSTOM_WORDS.whichGuild, ok: false });
    expect(await installCustomApp(dependencies(several), request({ guild_id: id(99) }))).toEqual({ error: CUSTOM_WORDS.notThatGuild, ok: false });
    const chosen = await installCustomApp(dependencies(several), request({ guild_id: OTHER_GUILD }));
    expect(chosen).toMatchObject({ name: "Beta", ok: true });
  });

  it("keeps nothing when the commands are refused or the bind code is spent; a reinstall ends the installation of before", async () => {
    const commands = new FakeAppPort();
    commands.refuseCommands = true;
    const refused = dependencies(commands);
    expect(await installCustomApp(refused, request())).toEqual({ error: CUSTOM_WORDS.commands, ok: false });
    expect(refused.hostsFake.bound).toEqual([]);
    const deps = dependencies();
    deps.hostsFake.spentCodes.add(CODE);
    expect(await installCustomApp(deps, request())).toEqual({ error: CUSTOM_WORDS.bind, ok: false });
    expect(await deps.store.installation(CUSTOM, GUILD)).toBeUndefined();
    const again = dependencies();
    expect((await installCustomApp(again, request())).ok).toBe(true);
    expect((await installCustomApp(again, request({ bind_code: `${CODE}2` }))).ok).toBe(true);
    expect(again.hostsFake.uninstalledKeys).toEqual(["dlhk_test_1"]);
    expect((await again.store.installation(CUSTOM, GUILD))?.hostUid).toBe("host-2");
  });
});

describe("the custom application routes", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("installs from the card's origin only, with a CORS preflight, and refuses another shape", async () => {
    const deps = dependencies();
    const served = await serve(customInstallRoutes(deps));
    close = served.close;
    const preflight = await fetch(`${served.url}${CUSTOM_INSTALL_PATH}`, { headers: { origin: WEB }, method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(WEB);
    expect((await fetch(`${served.url}${CUSTOM_INSTALL_PATH}`, { headers: { origin: "https://evil.example" }, method: "OPTIONS" })).status).toBe(403);
    const post = (body: unknown, origin = WEB) =>
      fetch(`${served.url}${CUSTOM_INSTALL_PATH}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", origin },
        method: "POST",
      });
    expect((await post(request(), "https://evil.example")).status).toBe(403);
    const odd = await post({ ...request(), client_secret: "x" });
    expect(odd.status).toBe(400);
    expect(await odd.json()).toEqual({ error: CUSTOM_WORDS.invalid });
    const done = await post(request());
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({
      connected: true,
      interactions_url: `${APP_URL}/discord/interactions/${CUSTOM}`,
      name: "Acme",
    });
  });

  it("answers Discord's PING at the application's own endpoint, verified with its own key; 404 for an application nobody connected", async () => {
    const deps = dependencies();
    await installCustomApp(deps, request());
    const route = customInteractionsRoute({
      cipher: deps.cipher,
      hosts: deps.hosts,
      logger: deps.logger,
      now: deps.now,
      queue: { enqueue: async () => true } as never,
      store: deps.store,
    });
    const served = await serve({ [`POST ${CUSTOM_INTERACTIONS_ROUTE}`]: route });
    close = served.close;
    const at = String(Math.floor(deps.now() / 1000));
    const body = JSON.stringify({ application_id: CUSTOM, id: id(900), token: "t", type: 1, version: 1 });
    const post = (applicationId: string, signature: string) =>
      fetch(`${served.url}/discord/interactions/${applicationId}`, {
        body,
        headers: {
          "content-type": "application/json",
          "x-signature-ed25519": signature,
          "x-signature-timestamp": at,
        },
        method: "POST",
      });
    const pong = await post(CUSTOM, KEY.sign(at, body));
    expect(pong.status).toBe(200);
    expect(await pong.json()).toEqual({ type: 1 });
    expect((await post(CUSTOM, signingKey().sign(at, body))).status).toBe(401);
    expect((await post(id(42), KEY.sign(at, body))).status).toBe(404);
    expect((await post("not-an-id", KEY.sign(at, body))).status).toBe(404);
  });
});

describe("posting as the right bot", () => {
  it("gives each application its port, and the context port posts as the application in hand", async () => {
    const deps = dependencies();
    await installCustomApp(deps, request());
    const own = new FakePort();
    const made: Array<{ applicationId: string; botToken: string; port: FakePort }> = [];
    const ports = new ApplicationPorts({ applicationId: APPLICATION, port: own }, deps.store, deps.cipher, (settings) => {
      const port = new FakePort();
      made.push({ ...settings, port });
      return port;
    });
    const port = ports.contextPort();
    await port.guildName(GUILD);
    expect(own.calls.map((call) => call.method)).toEqual(["guildName"]);
    await ports.within(CUSTOM, async () => {
      await port.createMessage("C1", { allowed_mentions: { parse: [] }, content: "hi" });
      expect(ports.current).toBe(CUSTOM);
    });
    expect(ports.current).toBe(APPLICATION);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ applicationId: CUSTOM, botToken: TOKEN });
    expect(made[0]!.port.calls.map((call) => call.method)).toEqual(["createMessage"]);
    expect(await ports.for(CUSTOM)).toBe(made[0]!.port);
    await expect(ports.for(id(42))).rejects.toThrow(/is connected/);
    ports.forget(CUSTOM);
    expect(await ports.for(CUSTOM)).not.toBe(made[0]!.port);
  });
});

describe("hearing each bot: one gateway per custom application", () => {
  function gateways(deps: ReturnType<typeof dependencies>, selfAnswers: () => Promise<unknown>) {
    const started: string[] = [];
    const stopped: string[] = [];
    const forgotten: string[] = [];
    const custom = new CustomGateways({
      botOf: () => async () => ({ session_start_limit: { max_concurrency: 1, remaining: 1, reset_after: 0, total: 1 }, shards: 1, url: "wss://gateway" }),
      cipher: deps.cipher,
      enqueue: async () => true,
      forget: (applicationId) => void forgotten.push(applicationId),
      gatewayOf: (made): RunningGateway => ({
        start: () => void started.push(made.applicationId),
        stop: async () => void stopped.push(made.applicationId),
      }),
      hosts: { self: async () => (await selfAnswers()) as never },
      lockOf: () => ({ acquire: async () => true, held: async () => true, release: async () => undefined }),
      logger: deps.logger,
      socket: () => ({ close: () => undefined, send: () => undefined }),
      store: deps.store,
      timers: { clearInterval: () => undefined, clearTimeout: () => undefined, setInterval: () => undefined, setTimeout: () => undefined } as never,
    });
    return { custom, forgotten, started, stopped };
  }

  it("starts a gateway for a connected application, keeps it while Datalayer is unreachable, and ends it all once its installation was disconnected", async () => {
    const deps = dependencies();
    await installCustomApp(deps, request());
    let answer: () => Promise<unknown> = async () => deps.hostsFake.self;
    const { custom, forgotten, started, stopped } = gateways(deps, () => answer());
    await custom.reconcile();
    expect(started).toEqual([CUSTOM]);
    await custom.reconcile();
    expect(started).toEqual([CUSTOM]);
    // Datalayer down: nothing changes.
    answer = async () => {
      throw new Error("ECONNREFUSED");
    };
    await custom.reconcile();
    expect(stopped).toEqual([]);
    expect(await deps.store.customApp(CUSTOM)).toBeDefined();
    // The owner disconnected it on the Ship tab: its key opens nothing.
    answer = async () => {
      throw new HostRefusedError(401, "ended", "Datalayer did not answer the installation");
    };
    await custom.reconcile();
    expect(stopped).toEqual([CUSTOM]);
    expect(forgotten).toEqual([CUSTOM]);
    expect((await deps.store.installation(CUSTOM, GUILD))?.state).toBe("removed");
    expect(await deps.store.customApp(CUSTOM)).toBeUndefined();
    expect(custom.running).toEqual([]);
    await custom.stop();
  });
});
