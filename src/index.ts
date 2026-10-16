import { Logger } from "@datalayer/agent-runtimes/lib/portable/hosts";

import { readConfig } from "./config.js";
import { LOG_SALT } from "./observability.js";
import { createResources } from "./resources.js";
import { createHttpServer } from "./server.js";

/**
 * @Datalayer for Discord (plans/DISCORD.md): one process per role. Every
 * role serves its health; the ingress will serve Discord's routes and the
 * worker will work the queue as Phase 1 lands (DC-102 on).
 */
const config = readConfig();
const logger = new Logger(undefined, undefined, LOG_SALT);
const resources = createResources(config);
const server = createHttpServer(resources.checks).listen(config.PORT, () =>
  logger.info("service.started", {
    port: config.PORT,
    role: config.DATALAYER_DISCORD_ROLE,
    store: config.DATABASE_URL ? "postgres" : "memory",
  }),
);

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  server.close();
  await resources.close();
  logger.info("service.stopped", { role: config.DATALAYER_DISCORD_ROLE });
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
