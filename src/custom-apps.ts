import {
  DELIVERY_PATH,
  HostRefusedError,
  type DatalayerHostClient,
  type EncryptedSecret,
  type Logger,
  type SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { parseCommands, type CommandDefinition } from "./commands.js";
import type {
  BotAuthorization,
  ChannelView,
  DiscordPort,
  MessageBody,
  SentMessage,
} from "./discord-port.js";
import { externalIdOf } from "./domain.js";
import {
  Gateway,
  gatewayBot,
  type GatewayBot,
  type GatewayDependencies,
  type LeaderLock,
  type MessageJob,
} from "./gateway.js";
import {
  interactionsFor,
  type InteractionDependencies,
} from "./interactions.js";
import { permissionsInteger } from "./permissions.js";
import type { Routes } from "./server.js";
import { customAppData, type DiscordStore } from "./store.js";
import { BodyTooLargeError, rawBodyOf } from "./verify.js";

/**
 * A Discord application the person brings (decided 28 October 2026).
 * Datalayer's own application (`oauth.ts`) is added to a server from a
 * person's Settings, through Discord's bot authorization with the code
 * grant; an application's Ship tab instead lets its owner bring their own
 * Discord application, created on Discord's developer portal: they add its
 * bot to their server themselves (the authorize URL the card shows, with
 * the permissions Datalayer's own asks), then paste its application id,
 * public key and bot token on the card. The card has made the pending
 * installation at Datalayer (`POST /apps/hosts`, provider `custom`) and
 * posts `{bind_code, application_id, public_key, bot_token, guild_id?}` to
 * `POST /discord/apps/install` (only the card's origin may post: CORS).
 *
 * The service checks the token with `GET /applications/@me` (the
 * application it is the bot of, and its `verify_key`: the public key typed
 * must be that one), finds the server among the bot's guilds (`GET
 * /users/@me/guilds`: the only one, or the one typed), registers the same
 * commands as Datalayer's own application on it (`PUT
 * /applications/{id}/commands`, the definitions of `commands/commands.json`
 * beside the bundle), binds the installation at Datalayer
 * (`application_id:guild_id`), registers where deliveries are pushed, and
 * keeps the installation beside the others (`discord_installation`) and
 * what only a custom application has (`discord_custom_app`: its public key,
 * its bot token encrypted). It answers the Interactions Endpoint URL the
 * person then puts in the application's General Information:
 * `/discord/interactions/<application_id>`, verified with that
 * application's own public key ({@link customInteractionsRoute}); Discord's
 * PING there is answered once the application is known.
 *
 * Posting as that bot: {@link ApplicationPorts} gives each application its
 * own port (Datalayer's own, or one over the custom bot token), and the
 * worker handles each job *within* its application, so the one port the
 * worker holds posts as the right bot ({@link ApplicationPorts.contextPort}).
 * Hearing that bot: the gateway role runs one gateway connection per custom
 * application beside Datalayer's own ({@link CustomGateways}), reconciled
 * from the store every minute — started for a new application, stopped
 * when its installation ended at Datalayer (the owner's Disconnect on the
 * Ship tab: the key is refused, the installation is marked removed and the
 * application's row dropped).
 */

/** Where the Ship card posts a custom application's credentials. */
export const CUSTOM_INSTALL_PATH = "/discord/apps/install";
/** Where Discord posts a custom application's interactions (the route's parameter is its id). */
export const CUSTOM_INTERACTIONS_ROUTE = "/discord/interactions/:applicationId";
/** The most an install request carries. */
export const INSTALL_BODY_LIMIT = 16 * 1024;
/** How often the custom applications are reconciled from the store, by default. */
export const RECONCILE_MS = 60 * 1000;

const SNOWFLAKE = /^\d{17,20}$/;

export const installRequestSchema = z
  .object({
    bind_code: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/),
    application_id: z.string().regex(SNOWFLAKE),
    /** The application's Public Key (General Information): 64 hex characters. */
    public_key: z.string().regex(/^[0-9a-f]{64}$/i),
    bot_token: z.string().regex(/^[A-Za-z0-9_.-]{50,120}$/),
    /** Which server, when the bot is in several. */
    guild_id: z.string().regex(SNOWFLAKE).optional(),
  })
  .strict();

export type InstallRequest = z.infer<typeof installRequestSchema>;

/** The Interactions Endpoint URL of one custom application, as the card shows it. */
export const customInteractionsUrlOf = (
  appUrl: string,
  applicationId: string,
): string =>
  `${appUrl.replace(/\/+$/, "")}/discord/interactions/${encodeURIComponent(applicationId)}`;

/** Where the person adds their own bot to their server: Discord's authorization, without a code grant. */
export const customAuthorizeUrlOf = (applicationId: string): string => {
  const query = new URLSearchParams({
    client_id: applicationId,
    integration_type: "0",
    permissions: permissionsInteger(),
    scope: "bot applications.commands",
  });
  return `https://discord.com/oauth2/authorize?${query.toString()}`;
};

/** What the card is answered: connected, or why not in one sentence. */
export const CUSTOM_WORDS = {
  invalid: "The install request is not one this service takes.",
  token:
    "Discord did not accept that bot token: copy it again from the application's Bot page (Reset Token gives a new one).",
  notTheApplication:
    "That bot token belongs to another application: paste the token of the application whose id you entered (General Information, Application ID).",
  publicKey:
    "That public key is not the application's: copy it again from General Information, Public Key.",
  noGuild:
    "The bot is in no server yet: add it to your server with the link on the card, then connect again.",
  whichGuild:
    "The bot is in several servers: enter the id of the one to connect (Server Settings, Widget, or Copy Server ID with Developer Mode on).",
  notThatGuild:
    "The bot is not in the server of that id: add it there with the link on the card, or enter the id of a server it is in.",
  commands:
    "Discord refused to register the commands on the application: check that the bot was added with the applications.commands scope, then connect again.",
  bind: "The install's code from Datalayer was used or expired: nothing was kept. Connect the application again from the Ship tab.",
  unknownApplication:
    "No custom Discord application of that id is connected to Datalayer.",
} as const;

/** What the service asks Discord of a pasted bot token, as that bot. */
export interface DiscordAppPort {
  /** The application the token is the bot of: its id, name and verify key. */
  application(
    botToken: string,
  ): Promise<{ id: string; name: string; verifyKey: string }>;
  /** The servers the bot is in. */
  guilds(botToken: string): Promise<Array<{ id: string; name: string }>>;
  /** Register the commands on the application, replacing what it had. */
  registerCommands(
    botToken: string,
    applicationId: string,
    commands: readonly CommandDefinition[],
  ): Promise<void>;
}

const API = "https://discord.com/api/v10";

/** Discord's REST as the port, over `fetch`: three calls at install, no bucket to keep. */
export function httpDiscordAppPort(
  fetchImplementation: typeof fetch = fetch,
): DiscordAppPort {
  const call = async <T>(
    method: string,
    path: string,
    botToken: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await fetchImplementation(`${API}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        authorization: `Bot ${botToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      method,
    });
    if (!response.ok)
      throw new Error(`Discord answered ${response.status} to ${path}`);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  };
  const str = (value: unknown): string =>
    typeof value === "string" ? value : "";
  return {
    async application(botToken) {
      const answer = await call<Record<string, unknown>>(
        "GET",
        "/applications/@me",
        botToken,
      );
      return {
        id: str(answer.id),
        name: str(answer.name),
        verifyKey: str(answer.verify_key),
      };
    },
    async guilds(botToken) {
      const answer = await call<Array<Record<string, unknown>>>(
        "GET",
        "/users/@me/guilds?limit=200",
        botToken,
      );
      return answer.map((one) => ({ id: str(one.id), name: str(one.name) }));
    },
    async registerCommands(botToken, applicationId, commands) {
      await call(
        "PUT",
        `/applications/${applicationId}/commands`,
        botToken,
        commands,
      );
    },
  };
}

/** The command definitions beside the bundle (`commands/commands.json`), as Datalayer's own application registers them. */
export async function commandDefinitions(): Promise<CommandDefinition[]> {
  return parseCommands(
    JSON.parse(
      await readFile(
        new URL("../commands/commands.json", import.meta.url),
        "utf8",
      ),
    ),
  );
}

export type CustomInstallDependencies = Readonly<{
  /** The service's public address: where Discord posts the application's interactions. */
  appUrl: string;
  /** Datalayer's web origin: the only one whose card may post. */
  webUrl: string;
  store: DiscordStore;
  cipher: SecretCipher;
  port: DiscordAppPort;
  /** The commands to register on the application: {@link commandDefinitions} in production. */
  commands: () => Promise<readonly CommandDefinition[]>;
  hosts: Pick<
    DatalayerHostClient,
    "bind" | "self" | "setWebhook" | "uninstalled"
  >;
  logger: Logger;
  now?: () => number;
}>;

export type InstallOutcome =
  | Readonly<{
      ok: true;
      name: string;
      hostUid: string;
      /** What the person puts in General Information, Interactions Endpoint URL. */
      interactionsUrl: string;
    }>
  | Readonly<{ ok: false; error: string }>;

/** The install, once the request is read: the token checked, the server found, the commands registered, bound at Datalayer, kept. */
export async function installCustomApp(
  dependencies: CustomInstallDependencies,
  request: InstallRequest,
): Promise<InstallOutcome> {
  const { port, store, cipher, hosts, logger } = dependencies;
  const token = request.bot_token;
  let application;
  try {
    application = await port.application(token);
  } catch (error) {
    logger.warn("custom_install.token_refused", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: CUSTOM_WORDS.token, ok: false };
  }
  if (application.id !== request.application_id)
    return { error: CUSTOM_WORDS.notTheApplication, ok: false };
  if (application.verifyKey.toLowerCase() !== request.public_key.toLowerCase())
    return { error: CUSTOM_WORDS.publicKey, ok: false };
  let guilds;
  try {
    guilds = await port.guilds(token);
  } catch (error) {
    logger.warn("custom_install.guilds_refused", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: CUSTOM_WORDS.token, ok: false };
  }
  if (!guilds.length) return { error: CUSTOM_WORDS.noGuild, ok: false };
  const guild = request.guild_id
    ? guilds.find((one) => one.id === request.guild_id)
    : guilds.length === 1
      ? guilds[0]
      : undefined;
  if (!guild)
    return {
      error: request.guild_id ? CUSTOM_WORDS.notThatGuild : CUSTOM_WORDS.whichGuild,
      ok: false,
    };
  try {
    await port.registerCommands(
      token,
      application.id,
      await dependencies.commands(),
    );
  } catch (error) {
    logger.warn("custom_install.commands_refused", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: CUSTOM_WORDS.commands, ok: false };
  }
  const externalId = externalIdOf(application.id, guild.id);
  let bound;
  try {
    bound = await hosts.bind({
      code: request.bind_code,
      externalId,
      name: guild.name,
    });
  } catch (error) {
    if (!(error instanceof HostRefusedError)) throw error;
    logger.warn("custom_install.bind_refused", { status: error.status });
    return { error: CUSTOM_WORDS.bind, ok: false };
  }
  const self = await hosts.self(bound.hostKey);
  let deliverySecret: EncryptedSecret | undefined;
  try {
    const { signingSecret } = await hosts.setWebhook(
      bound.hostKey,
      `${dependencies.appUrl.replace(/\/+$/, "")}${DELIVERY_PATH}/${encodeURIComponent(bound.hostUid)}`,
    );
    deliverySecret = cipher.encrypt(signingSecret, `delivery:${externalId}`);
  } catch (error) {
    logger.warn("custom_install.delivery_not_registered", { error });
  }
  // A reinstall: the installation of before ends at Datalayer.
  const before = await store.installation(application.id, guild.id);
  if (before && before.state !== "removed" && before.hostUid !== bound.hostUid)
    await hosts
      .uninstalled(cipher.decrypt(before.hostKey, externalId))
      .catch((error: unknown) =>
        logger.warn("custom_install.previous_not_ended", { error }),
      );
  await store.saveInstallation({
    applicationId: application.id,
    guildId: guild.id,
    hostKey: cipher.encrypt(bound.hostKey, externalId),
    hostUid: bound.hostUid,
    installedBy: self.accountUid,
    notifications:
      before && before.state !== "removed" ? before.notifications : "quiet",
    organizationUid: self.accountUid,
    permissions: permissionsInteger(),
    state: "active",
    ...(deliverySecret ? { deliverySecret } : {}),
  });
  await store.saveCustomApp({
    applicationId: application.id,
    botToken: cipher.encrypt(token, customAppData(application.id)),
    createdAt: new Date((dependencies.now ?? Date.now)()),
    publicKey: request.public_key.toLowerCase(),
  });
  logger.info("custom_install.bound", { installation: externalId });
  return {
    hostUid: bound.hostUid,
    interactionsUrl: customInteractionsUrlOf(dependencies.appUrl, application.id),
    name: guild.name,
    ok: true,
  };
}

/** The install route and its CORS preflight, for the ingress. */
export function customInstallRoutes(
  dependencies: CustomInstallDependencies,
): Routes {
  const origin = new URL(dependencies.webUrl).origin;
  const cors = (request: IncomingMessage): Record<string, string> =>
    request.headers.origin === origin
      ? {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "POST",
          "access-control-allow-origin": origin,
          "access-control-max-age": "600",
          vary: "origin",
        }
      : { vary: "origin" };
  const answer = (
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    body: Record<string, unknown>,
  ) => {
    response.writeHead(status, {
      ...cors(request),
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    response.end(JSON.stringify(body));
  };
  return {
    [`OPTIONS ${CUSTOM_INSTALL_PATH}`]: async (request, response) => {
      response.writeHead(request.headers.origin === origin ? 204 : 403, {
        ...cors(request),
      });
      response.end();
    },
    [`POST ${CUSTOM_INSTALL_PATH}`]: async (request, response) => {
      if (
        request.headers.origin !== undefined &&
        request.headers.origin !== origin
      )
        return answer(request, response, 403, { error: CUSTOM_WORDS.invalid });
      let raw: Buffer;
      try {
        raw = await rawBodyOf(request);
      } catch (error) {
        if (!(error instanceof BodyTooLargeError)) throw error;
        request.resume();
        return answer(request, response, 413, { error: CUSTOM_WORDS.invalid });
      }
      if (raw.length > INSTALL_BODY_LIMIT)
        return answer(request, response, 413, { error: CUSTOM_WORDS.invalid });
      let parsed: InstallRequest;
      try {
        parsed = installRequestSchema.parse(JSON.parse(raw.toString("utf8")));
      } catch {
        return answer(request, response, 400, { error: CUSTOM_WORDS.invalid });
      }
      const done = await installCustomApp(dependencies, parsed);
      answer(
        request,
        response,
        done.ok ? 200 : 400,
        done.ok
          ? {
              connected: true,
              interactions_url: done.interactionsUrl,
              name: done.name,
            }
          : { error: done.error },
      );
    },
  };
}

/**
 * The interactions endpoint of every custom application: the application
 * named in the path, verified with its own public key, answered as the
 * common endpoint answers Datalayer's own.
 */
export function customInteractionsRoute(
  dependencies: Omit<InteractionDependencies, "applicationId" | "publicKey">,
) {
  return interactionsFor(dependencies, async (request) => {
    const applicationId = request.params?.applicationId ?? "";
    if (!SNOWFLAKE.test(applicationId)) return undefined;
    const app = await dependencies.store.customApp(applicationId);
    return app ? { applicationId, publicKey: app.publicKey } : undefined;
  });
}

// --- posting as the right bot ----------------------------------------------------

export type PortSettings = Readonly<{ applicationId: string; botToken: string }>;

/**
 * One Discord port per application: Datalayer's own, and one over each
 * custom application's bot token (made once, from the store). The worker
 * holds {@link contextPort}: a port that posts as whichever application the
 * job in hand is handled within ({@link within}), Datalayer's own outside
 * any job.
 */
export class ApplicationPorts {
  readonly #custom = new Map<string, DiscordPort>();
  readonly #context = new AsyncLocalStorage<string>();

  constructor(
    readonly own: Readonly<{ applicationId: string; port: DiscordPort }>,
    readonly store: Pick<DiscordStore, "customApp">,
    readonly cipher: Pick<SecretCipher, "decrypt">,
    readonly make: (settings: PortSettings) => DiscordPort,
  ) {}

  /** The port of one application; a custom application nobody connected is refused. */
  async for(applicationId: string): Promise<DiscordPort> {
    if (applicationId === this.own.applicationId) return this.own.port;
    const cached = this.#custom.get(applicationId);
    if (cached) return cached;
    const app = await this.store.customApp(applicationId);
    if (!app)
      throw new Error(
        `No custom Discord application ${applicationId} is connected.`,
      );
    const port = this.make({
      applicationId,
      botToken: this.cipher.decrypt(app.botToken, customAppData(applicationId)),
    });
    this.#custom.set(applicationId, port);
    return port;
  }

  /** Forget a custom application's port (its token changed, or it ended). */
  forget(applicationId: string): void {
    this.#custom.delete(applicationId);
  }

  /** Run `work` as one application: the context port posts as it. */
  within<T>(applicationId: string, work: () => Promise<T>): Promise<T> {
    return this.#context.run(applicationId, work);
  }

  /** The application in hand, or Datalayer's own. */
  get current(): string {
    return this.#context.getStore() ?? this.own.applicationId;
  }

  /** A port that posts as the application in hand. */
  contextPort(): DiscordPort {
    const port = () => this.for(this.current);
    return {
      addReaction: async (channelId, messageId, emoji) =>
        (await port()).addReaction(channelId, messageId, emoji),
      authorize: async (code, redirectUri): Promise<BotAuthorization> =>
        (await port()).authorize(code, redirectUri),
      botGuilds: async (after) => (await port()).botGuilds(after),
      channel: async (channelId): Promise<ChannelView> =>
        (await port()).channel(channelId),
      createMessage: async (channelId, body: MessageBody): Promise<SentMessage> =>
        (await port()).createMessage(channelId, body),
      deleteOriginal: async (token) => (await port()).deleteOriginal(token),
      editMessage: async (channelId, messageId, body) =>
        (await port()).editMessage(channelId, messageId, body),
      editOriginal: async (token, body) => (await port()).editOriginal(token, body),
      followUp: async (token, body) => (await port()).followUp(token, body),
      guildName: async (guildId) => (await port()).guildName(guildId),
      original: async (token) => (await port()).original(token),
      removeReaction: async (channelId, messageId, emoji) =>
        (await port()).removeReaction(channelId, messageId, emoji),
      startThread: async (channelId, messageId, name) =>
        (await port()).startThread(channelId, messageId, name),
    };
  }
}

// --- hearing each bot: one gateway per custom application -------------------------

/** A gateway as the reconciler runs one: started once, stopped once. */
export type RunningGateway = Readonly<{ start(): void; stop(): Promise<void> }>;

export type CustomGatewayDependencies = Readonly<{
  store: DiscordStore;
  cipher: Pick<SecretCipher, "decrypt">;
  logger: Logger;
  /** The installation's record at Datalayer: a refused key ends it here. */
  hosts: Pick<DatalayerHostClient, "self">;
  enqueue: GatewayDependencies["enqueue"];
  /** The leader lock of one application's connection. */
  lockOf: (applicationId: string) => LeaderLock;
  socket: GatewayDependencies["socket"];
  timers: GatewayDependencies["timers"];
  /** A gateway from its dependencies: {@link Gateway} in production, a fake in tests. */
  gatewayOf?: (deps: GatewayDependencies) => RunningGateway;
  /** How a bot's gateway is asked: `gatewayBot` in production. */
  botOf?: (token: string) => () => Promise<GatewayBot>;
  /** Forget a custom application's port once it ended ({@link ApplicationPorts.forget}). */
  forget?: (applicationId: string) => void;
}>;

/**
 * The gateway connections of the custom applications, reconciled from the
 * store: one started per custom application with an active installation,
 * stopped — and the application's row dropped — once its installation
 * ended at Datalayer (its key refused) or was removed here.
 */
export class CustomGateways {
  readonly #running = new Map<string, RunningGateway>();
  #timer: NodeJS.Timeout | undefined;

  constructor(readonly deps: CustomGatewayDependencies) {}

  /** The applications whose gateway runs. */
  get running(): string[] {
    return [...this.#running.keys()];
  }

  /** Reconcile now, then every `everyMs`. */
  start(everyMs = RECONCILE_MS): void {
    const tick = () =>
      void this.reconcile().catch((error: unknown) =>
        this.deps.logger.error("custom_gateways.failed", { error }),
      );
    tick();
    this.#timer = setInterval(tick, everyMs);
    this.#timer.unref();
  }

  async reconcile(): Promise<void> {
    const { store, cipher, hosts, logger } = this.deps;
    const apps = await store.customApps();
    const active = await store.installations("active");
    for (const app of apps) {
      const installations = active.filter(
        (one) => one.applicationId === app.applicationId,
      );
      let live = 0;
      let unknown = 0;
      for (const installation of installations) {
        const externalId = externalIdOf(
          installation.applicationId,
          installation.guildId,
        );
        try {
          await hosts.self(cipher.decrypt(installation.hostKey, externalId));
          live += 1;
        } catch (error) {
          if (!(error instanceof HostRefusedError) || error.status !== 401) {
            // Datalayer unreachable, or a passing refusal: not a revocation.
            unknown += 1;
            continue;
          }
          // The owner disconnected it at Datalayer: it ends here.
          await store.setInstallationState(
            installation.applicationId,
            installation.guildId,
            "removed",
            new Date(),
          );
          logger.info("custom_app.installation_ended", {
            installation: externalId,
          });
        }
      }
      if (live > 0 || unknown > 0) {
        if (!this.#running.has(app.applicationId))
          this.#start(app.applicationId, app.botToken);
        continue;
      }
      // Every installation of the application ended, or none was active: the
      // application is dropped; a new install from the Ship tab brings it back.
      await this.#stop(app.applicationId);
      await store.deleteCustomApp(app.applicationId);
      this.deps.forget?.(app.applicationId);
      logger.info("custom_app.dropped", { application: app.applicationId });
    }
    // An application gone from the store: its gateway stops.
    const known = new Set(apps.map((one) => one.applicationId));
    for (const applicationId of this.#running.keys())
      if (!known.has(applicationId)) await this.#stop(applicationId);
  }

  #start(applicationId: string, botToken: EncryptedSecret): void {
    const { deps } = this;
    const token = deps.cipher.decrypt(botToken, customAppData(applicationId));
    const gateway = (deps.gatewayOf ?? ((made) => new Gateway(made)))({
      applicationId,
      bot: (deps.botOf ?? gatewayBot)(token),
      enqueue: (job: MessageJob, key: string) => deps.enqueue(job, key),
      lock: deps.lockOf(applicationId),
      logger: deps.logger,
      sessions: {
        load: () => deps.store.gatewaySession(applicationId),
        save: (session) => deps.store.saveGatewaySession(applicationId, session),
      },
      socket: deps.socket,
      timers: deps.timers,
      token,
    });
    this.#running.set(applicationId, gateway);
    gateway.start();
    deps.logger.info("custom_gateway.started", { application: applicationId });
  }

  async #stop(applicationId: string): Promise<void> {
    const gateway = this.#running.get(applicationId);
    if (!gateway) return;
    this.#running.delete(applicationId);
    await gateway.stop();
    this.deps.logger.info("custom_gateway.stopped", {
      application: applicationId,
    });
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    for (const applicationId of [...this.#running.keys()])
      await this.#stop(applicationId);
  }
}
