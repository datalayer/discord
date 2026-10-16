import {
  DatalayerHostClient,
  DEFAULT_QUOTAS,
  DELIVERY_ROUTE,
  DeliveryPoller,
  deliveryRoute,
  HostKeyCredentials,
  HttpAgentClient,
  Logger,
  systemClock,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import { httpAsPerson } from "./as-person.js";
import { readConfig } from "./config.js";
import { deliverySinkOf, type DeliveryQueueJob } from "./deliveries.js";
import { HttpDiscordPort } from "./discord-port.js";
import {
  discordShape,
  externalIdOf,
  type DiscordTurn,
  type DiscordTurnRequest,
} from "./domain.js";
import { eventsRoute } from "./events.js";
import { interactionsRoute } from "./interactions.js";
import { CALLBACK_PATH, INSTALL_PATH, oauthRoutes } from "./oauth.js";
import { LOG_SALT } from "./observability.js";
import { DiscordRateLimiter } from "./rate-limit.js";
import { purgeRemoved, reconcile, removeInstallation } from "./removal.js";
import { createResources } from "./resources.js";
import { createHttpServer, type Routes } from "./server.js";
import { TOKEN_LIFETIME_MS, Worker } from "./worker.js";

/**
 * @Datalayer for Discord: one process per role. Every
 * role serves its health; the ingress serves Discord's signed requests and
 * the install, persisting before it answers; the worker works the durable
 * queue and runs the removal reconciliation and purge.
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
const credentials = new HostKeyCredentials(
  config.DATALAYER_API_URL,
  hostKeyFor,
  discordShape,
);
const agent = new HttpAgentClient<DiscordTurn>(
  config.DATALAYER_API_URL,
  credentials,
  discordShape,
  fetch,
  hostKeyFor,
);
// *Open in Datalayer*: the presser's own host token makes the handoff.
const openLink = async (
  request: DiscordTurnRequest,
  kind: "session" | "approval",
  target: string,
): Promise<string> => {
  const host = await credentials.forTurn(request);
  return (await hosts.handoff(host.accessToken, kind, target)).path;
};
// Datalayer as one member: approvals, decisions, a session's answer.
const asPerson = httpAsPerson(credentials, hosts);
// Each delivery queued once by its uid; handled from the queue (DC-301).
const enqueueDelivery = async (job: {
  delivery: DeliveryQueueJob["delivery"];
  hostUid: string;
}): Promise<void> => {
  await queue.enqueue(
    { ...job, kind: "delivery" },
    `delivery:${job.hostUid}:${job.delivery.delivery}`,
  );
};
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
          [`POST ${DELIVERY_ROUTE}`]: deliveryRoute(
            deliverySinkOf(store, cipher),
            enqueueDelivery,
          ),
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
let stopPoller = (): void => {};
if (role !== "ingress") {
  const worker = new Worker({
    agent,
    applicationId: config.DISCORD_APPLICATION_ID,
    asPerson,
    cipher,
    clock: systemClock,
    hosts,
    limits: DEFAULT_QUOTAS,
    logger,
    openLink,
    port,
    quotas: resources.quotas,
    removed: (guildId) => removeInstallation(removal, guildId, "unknown-guild"),
    store,
    webUrl: config.DATALAYER_WEB_URL,
  });
  queue.start((job) => worker.handle(job));
  // The outbox: what a push missed, or every delivery when none is registered.
  const poller = new DeliveryPoller(
    deliverySinkOf(store, cipher),
    hosts,
    enqueueDelivery,
    {
      warn: (message: string) =>
        logger.warn("delivery.outbox_unread", { message }),
    },
  );
  poller.start(config.DATALAYER_DELIVERY_POLL_SECONDS);
  stopPoller = () => poller.stop();
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
  // An interaction token outlives its 15 minutes nowhere.
  timers.push(
    setInterval(
      () =>
        void store
          .dropSpentTokens(new Date(Date.now() - TOKEN_LIFETIME_MS))
          .then((dropped) =>
            dropped ? logger.info("tokens.dropped", { dropped }) : undefined,
          )
          .catch((error: unknown) =>
            logger.error("tokens.not_dropped", { error }),
          ),
      60 * 1000,
    ),
  );
}

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  timers.forEach(clearInterval);
  stopPoller();
  server.close();
  await resources.close();
  logger.info("service.stopped", { role });
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
