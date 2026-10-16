import {
  DatalayerHostClient,
  DEFAULT_QUOTAS,
  HostKeyCredentials,
  HttpAgentClient,
  Logger,
  systemClock,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import { readConfig } from "./config.js";
import { HttpDiscordPort } from "./discord-port.js";
import { discordShape, externalIdOf, type DiscordTurn } from "./domain.js";
import { eventsRoute } from "./events.js";
import { interactionsRoute } from "./interactions.js";
import { CALLBACK_PATH, INSTALL_PATH, oauthRoutes } from "./oauth.js";
import { LOG_SALT } from "./observability.js";
import { DiscordRateLimiter } from "./rate-limit.js";
import { purgeRemoved, reconcile, removeInstallation } from "./removal.js";
import { createResources } from "./resources.js";
import { createHttpServer, type Routes } from "./server.js";
import { Worker } from "./worker.js";

/**
 * @Datalayer for Discord (plans/DISCORD.md): one process per role. Every
 * role serves its health; the ingress serves Discord's signed requests and
 * the install, persisting before it answers; the worker works the durable
 * queue and runs the removal reconciliation and purge (§7.4).
 */
const config = readConfig();
const logger = new Logger(undefined, undefined, LOG_SALT);
const resources = createResources(config);
const { store, cipher, queue } = resources;
const role = config.DATALAYER_DISCORD_ROLE;

const limiter = new DiscordRateLimiter(systemClock, (fields) =>
  logger.warn("discord.invalid_requests", fields),
);
const port = new HttpDiscordPort(
  {
    applicationId: config.DISCORD_APPLICATION_ID,
    botToken: config.DISCORD_BOT_TOKEN,
    clientSecret: config.DISCORD_CLIENT_SECRET,
  },
  limiter,
);
const hosts = new DatalayerHostClient(config.DATALAYER_API_URL);
const hostKeyFor = async (request: { provenance: DiscordTurn }) => {
  const { applicationId, guildId } = request.provenance.key;
  const installation = await store.installation(applicationId, guildId);
  if (!installation || installation.state === "removed") return undefined;
  return cipher.decrypt(
    installation.hostKey,
    externalIdOf(applicationId, guildId),
  );
};
const agent = new HttpAgentClient<DiscordTurn>(
  config.DATALAYER_API_URL,
  new HostKeyCredentials(config.DATALAYER_API_URL, hostKeyFor, discordShape),
  discordShape,
  fetch,
  hostKeyFor,
);
const removal = {
  applicationId: config.DISCORD_APPLICATION_ID,
  cipher,
  hosts,
  logger,
  store,
};

const routes: Routes =
  role === "worker"
    ? {}
    : (() => {
        const oauth = oauthRoutes({
          appUrl: config.DISCORD_APP_URL,
          applicationId: config.DISCORD_APPLICATION_ID,
          cipher,
          clientSecret: config.DISCORD_CLIENT_SECRET,
          development: config.NODE_ENV !== "production",
          hosts,
          logger,
          port,
          store,
          webUrl: config.DATALAYER_WEB_URL,
        });
        return {
          [`GET ${CALLBACK_PATH}`]: oauth.callback,
          "POST /discord/events": eventsRoute({
            applicationId: config.DISCORD_APPLICATION_ID,
            logger,
            publicKey: config.DISCORD_PUBLIC_KEY,
            queue,
          }),
          "POST /discord/interactions": interactionsRoute({
            applicationId: config.DISCORD_APPLICATION_ID,
            cipher,
            logger,
            publicKey: config.DISCORD_PUBLIC_KEY,
            queue,
            store,
          }),
          [`GET ${INSTALL_PATH}`]: oauth.install,
        };
      })();

const server = createHttpServer(resources.checks, routes, (error) =>
  logger.error("http.failed", { error }),
).listen(config.PORT, () =>
  logger.info("service.started", {
    port: config.PORT,
    role,
    store: config.DATABASE_URL ? "postgres" : "memory",
  }),
);

const timers: NodeJS.Timeout[] = [];
if (role !== "ingress") {
  const worker = new Worker({
    agent,
    applicationId: config.DISCORD_APPLICATION_ID,
    cipher,
    clock: systemClock,
    hosts,
    limits: DEFAULT_QUOTAS,
    logger,
    port,
    quotas: resources.quotas,
    removed: (guildId) => removeInstallation(removal, guildId, "unknown-guild"),
    store,
    webUrl: config.DATALAYER_WEB_URL,
  });
  queue.start((job) => worker.handle(job));
  const daily = async () => {
    try {
      const removed = await reconcile({ ...removal, port });
      const purged = await purgeRemoved(removal);
      logger.info("removal.reconciled", { purged, removed });
    } catch (error) {
      logger.error("removal.failed", { error });
    }
  };
  timers.push(setInterval(() => void daily(), 24 * 60 * 60 * 1000));
  timers.push(
    setInterval(
      () => void purgeRemoved(removal).catch(() => undefined),
      60 * 60 * 1000,
    ),
  );
}

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  timers.forEach(clearInterval);
  server.close();
  await resources.close();
  logger.info("service.stopped", { role });
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
