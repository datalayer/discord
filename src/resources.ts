import {
  MemoryQuotaStore,
  MemoryWorkQueue,
  SecretCipher,
  type QuotaStore,
  type ReadinessChecks,
  type WorkQueue,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { Config } from "./config.js";
import type { LeaderLock } from "./gateway.js";
import { SolrClient } from "./solr/client.js";
import { SolrWorkQueue } from "./solr/queue.js";
import { SolrQuotaStore } from "./solr/quotas.js";
import { SolrRecords } from "./solr/records.js";
import { SolrDiscordStore, SolrLeaderLock } from "./solr-store.js";
import { MemoryStore, type DiscordStore } from "./store.js";

/** What the queue carries. Each kind of durable work joins it with its box (DC-102 on). */
export type DiscordJob = Readonly<{ kind: string; [field: string]: unknown }>;

export type Resources = Readonly<{
  cipher: SecretCipher;
  queue: WorkQueue<DiscordJob>;
  quotas: QuotaStore;
  store: DiscordStore;
  /** The leader of one gateway connection, by its key (DC-201). */
  leaderLock(key: string): LeaderLock;
  /** What `/readyz` asks: the store and the queue, never Discord or Datalayer. */
  checks: ReadinessChecks;
  close(): Promise<void>;
}>;

/** The Solr settings of a configuration that has them. */
export function solrSettingsOf(config: Config) {
  const url = config.DATALAYER_SOLR_URL;
  const username = config.DATALAYER_SOLR_USERNAME;
  const password = config.DATALAYER_SOLR_PASSWORD;
  if (!url || !username || !password)
    throw new Error(
      "DATALAYER_SOLR_URL, DATALAYER_SOLR_USERNAME and DATALAYER_SOLR_PASSWORD are required.",
    );
  return {
    collection: config.DATALAYER_DISCORD_SOLR_COLLECTION,
    password,
    url,
    username,
  };
}

/**
 * The store, queue, quotas and leader locks: the service's Solr collection
 * when `DATALAYER_SOLR_URL` is set (always in production, which
 * `readConfig` enforces), in memory in development and tests only. The
 * lock documents are made at start, once.
 */
export async function createResources(config: Config): Promise<Resources> {
  const cipher = new SecretCipher(
    config.DATALAYER_DISCORD_TOKEN_ENCRYPTION_KEY,
    config.DATALAYER_DISCORD_TOKEN_ENCRYPTION_KEY_VERSION,
    "DATALAYER_DISCORD_TOKEN_ENCRYPTION_KEY",
  );
  if (!config.DATALAYER_SOLR_URL) {
    const queue = new MemoryWorkQueue<DiscordJob>();
    return {
      checks: { queue: () => queue.ready() },
      cipher,
      close: () => queue.stop(),
      // One process without a collection (development): it alone leads.
      leaderLock: () => ({
        acquire: async () => true,
        held: async () => true,
        release: async () => undefined,
      }),
      queue,
      quotas: new MemoryQuotaStore(),
      store: new MemoryStore(),
    };
  }
  const client = new SolrClient(solrSettingsOf(config));
  const records = new SolrRecords(client);
  await records.init();
  const queue = new SolrWorkQueue<DiscordJob>(records);
  return {
    checks: { solr: () => client.ready() },
    cipher,
    close: () => queue.stop(),
    leaderLock: (key) => new SolrLeaderLock(records, key),
    queue,
    quotas: new SolrQuotaStore(records),
    store: new SolrDiscordStore(records),
  };
}
