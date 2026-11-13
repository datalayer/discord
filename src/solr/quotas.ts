import type {
  QuotaEntry,
  QuotaStore,
  QuotaTake,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import { documentOf, lockKey, type SolrRecords } from "./records.js";

/**
 * Quota counts (`type_s:usage`, one per key and hour), taken all or none:
 * under the locks of every count a turn takes, read, checked and written
 * back in one request. What a Postgres transaction with its rows locked in
 * a stable order was; the locks are taken in a stable order too.
 */
const USAGE = "usage";

type Usage = Readonly<{ key: string; period: string; used: number }>;

const usageKey = (key: string, period: string): string =>
  `${period}\u0000${key}`;

export class SolrQuotaStore implements QuotaStore {
  constructor(readonly records: SolrRecords) {}

  async takeQuota(
    entries: readonly QuotaEntry[],
    period: string,
  ): Promise<QuotaTake> {
    const keys = entries.map((entry) => usageKey(entry.key, period));
    return this.records.locked(
      keys.map((key) => lockKey(USAGE, key)),
      async () => {
        const kept = await Promise.all(
          keys.map(async (key) => this.records.getStored<Usage>(USAGE, key)),
        );
        const spent = entries.find(
          (entry, index) => (kept[index]?.record.used ?? 0) >= entry.limit,
        );
        if (spent) return { entry: spent, ok: false };
        await this.records.client.add(
          entries.map((entry, index) => {
            const used = (kept[index]?.record.used ?? 0) + 1;
            return documentOf(
              USAGE,
              { key: entry.key, period, used } satisfies Usage,
              {
                key_s: usageKey(entry.key, period),
                usage_key_s: entry.key,
                usage_window_s: period,
                used_i: used,
              },
              kept[index],
            );
          }),
        );
        return { ok: true };
      },
    );
  }

  async quotaUsed(key: string, period: string): Promise<number> {
    return (
      (await this.records.get<Usage>(USAGE, usageKey(key, period)))?.used ?? 0
    );
  }
}
