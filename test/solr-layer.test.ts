import { describe, expect, it } from "vitest";

import { SolrDeadLetters } from "../src/solr/dead-letters.js";
import { SolrWorkQueue } from "../src/solr/queue.js";
import { SolrQuotaStore } from "../src/solr/quotas.js";
import { ulid } from "../src/solr/ulid.js";
import { solrTestUrl, testCollection } from "./support/solr.js";

describe("ulid", () => {
  it("is 26 Crockford characters, sorted as minted", () => {
    const minted = Array.from({ length: 50 }, () => ulid());
    for (const one of minted) expect(one).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect([...minted].sort()).toEqual(minted);
  });
});

describe.skipIf(!solrTestUrl)("the Solr layer, against a real Solr", () => {
  it("keeps a keyed record once, Solr making its id and our uid a ULID", async () => {
    const records = await testCollection("test_discord_layer_records");
    expect(await records.create("thing", "k1", { n: 1 })).toBe(true);
    expect(await records.create("thing", "k1", { n: 2 })).toBe(false);
    const stored = await records.getStored<{ n: number }>("thing", "k1");
    expect(stored?.record).toEqual({ n: 1 });
    expect(stored?.uid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(stored?.id).toMatch(/^[0-9a-f-]{36}$/);
    await records.put("thing", "k1", { n: 3 }, { status_s: "active" });
    const again = await records.getStored<{ n: number }>("thing", "k1");
    expect(again?.uid).toBe(stored?.uid);
    expect(again?.record).toEqual({ n: 3 });
    expect(await records.find("thing", { status_s: "active" })).toEqual([
      { n: 3 },
    ]);
    await records.remove("thing", "k1");
    expect(await records.get("thing", "k1")).toBeUndefined();
  }, 60_000);

  it("creates a key once among many racing writers", async () => {
    const records = await testCollection("test_discord_layer_race");
    const won = await Promise.all(
      Array.from({ length: 12 }, async (_, index) =>
        records.create("claim", "event-1", { by: index }),
      ),
    );
    expect(won.filter(Boolean)).toHaveLength(1);
    expect(await records.count("claim", { key_s: "event-1" })).toBe(1);
    // An increment under the lock loses no count.
    await Promise.all(
      Array.from({ length: 10 }, async () =>
        records.update<{ n: number }>("counter", "c", (before) => ({
          record: { n: (before?.n ?? 0) + 1 },
        })),
      ),
    );
    expect(await records.get("counter", "c")).toEqual({ n: 10 });
  }, 120_000);

  it("takes quotas all or none", async () => {
    const quotas = new SolrQuotaStore(
      await testCollection("test_discord_layer_quotas"),
    );
    const entries = [
      { key: "user:a", limit: 2, scope: "user" as const },
      { key: "application:x", limit: 5, scope: "application" as const },
    ];
    expect(await quotas.takeQuota(entries, "2026-11-13T10")).toEqual({
      ok: true,
    });
    expect(await quotas.takeQuota(entries, "2026-11-13T10")).toEqual({
      ok: true,
    });
    expect(await quotas.takeQuota(entries, "2026-11-13T10")).toMatchObject({
      ok: false,
    });
    expect(await quotas.quotaUsed("application:x", "2026-11-13T10")).toBe(2);
  }, 60_000);

  it("works a job once, retries, dead-letters and replays it", async () => {
    const records = await testCollection("test_discord_layer_queue");
    const queue = new SolrWorkQueue<{ prompt: string }>(records, 20, 1_000);
    expect(await queue.enqueue({ prompt: "a" }, "e1")).toBe(true);
    expect(await queue.enqueue({ prompt: "a" }, "e1")).toBe(false);
    const seen: string[] = [];
    queue.start(async (item) => {
      seen.push(item.prompt);
    });
    await expect.poll(() => seen, { timeout: 10_000 }).toEqual(["a"]);
    await queue.stop();
    expect(await records.count("job")).toBe(0);

    const failing = new SolrWorkQueue<{ prompt: string }>(records, 20, 1_000);
    await failing.enqueue({ prompt: "b" });
    let tries = 0;
    failing.start(async () => {
      tries += 1;
      throw new Error("boom xoxb-123456789012-secret");
    });
    // 2, 4, 8, 16 seconds of backoff are too long for a test: move the job on.
    for (let round = 0; round < 6 && tries < 5; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const ready = await records.client.search({
        fq: ["type_s:job", "state_s:ready"],
      });
      for (const doc of ready.docs)
        await records.client.add([
          {
            _version_: doc._version_,
            available_dt: { set: "2000-01-01T00:00:00Z" },
            id: doc.id,
          },
        ]);
    }
    await expect
      .poll(async () => (await failing.dead()).length, { timeout: 20_000 })
      .toBe(1);
    await failing.stop();
    const letters = new SolrDeadLetters(
      failing as SolrWorkQueue<unknown>,
      "discord",
    );
    const [dead] = await letters.list();
    expect(dead?.lastError).not.toContain("xoxb-123456789012");
    await expect(letters.payload(dead!.id, "op", "short")).rejects.toThrow();
    expect(
      await letters.payload(dead!.id, "op", "investigating a failure"),
    ).toEqual({ prompt: "b" });
    expect(await letters.replay(dead!.id, "op")).toBe(true);
    expect(await letters.replay(dead!.id, "op")).toBe(false);
    expect(await records.count("job_replay")).toBe(2);
    expect(await records.count("payload_access")).toBe(1);
  }, 120_000);
});
