import {
  MemoryQuotaStore,
  MemoryWorkQueue,
  PostgresQuotaStore,
  PostgresWorkQueue,
  SecretCipher,
  type QuotaStore,
  type ReadinessChecks,
  type WorkQueue,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { Config } from "./config.js";
import { createDatabase } from "./database.js";

/** The service's table prefix: `discord_*` (plans/DISCORD.md §5). */
export const TABLE_PREFIX = "discord";

/** What the queue carries. Each kind of durable work joins it with its box (DC-102 on). */
export type DiscordJob = Readonly<{ kind: string; [field: string]: unknown }>;

export type Resources = Readonly<{
  cipher: SecretCipher;
  queue: WorkQueue<DiscordJob>;
  quotas: QuotaStore;
  /** What `/readyz` asks: the store and the queue, never Discord or Datalayer. */
  checks: ReadinessChecks;
  close(): Promise<void>;
}>;

/**
 * The store, queue and quotas: PostgreSQL when `DATABASE_URL` is set (always
 * in production, which `readConfig` enforces), in memory in development and
 * tests only. The queue and quotas are the shared host kit's under the
 * `discord` prefix.
 */
export function createResources(config: Config): Resources {
  const cipher = new SecretCipher(
    config.DISCORD_TOKEN_ENCRYPTION_KEY,
    config.DISCORD_TOKEN_ENCRYPTION_KEY_VERSION,
    "DISCORD_TOKEN_ENCRYPTION_KEY",
  );
  if (!config.DATABASE_URL) {
    const queue = new MemoryWorkQueue<DiscordJob>();
    return {
      checks: { queue: () => queue.ready() },
      cipher,
      close: () => queue.stop(),
      queue,
      quotas: new MemoryQuotaStore(),
    };
  }
  const database = createDatabase(config.DATABASE_URL);
  const queue = new PostgresWorkQueue<DiscordJob>(database, TABLE_PREFIX);
  return {
    checks: {
      database: async () => {
        await database.query("SELECT 1");
        return true;
      },
      queue: () => queue.ready(),
    },
    cipher,
    close: async () => {
      await queue.stop();
      await database.end();
    },
    queue,
    quotas: new PostgresQuotaStore(database, { tablePrefix: TABLE_PREFIX }),
  };
}
