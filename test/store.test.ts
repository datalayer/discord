import { execFileSync } from "node:child_process";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresQuotaStore,
  quotaEntries,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import { PostgresStore } from "../src/postgres-store.js";
import { TABLE_PREFIX } from "../src/resources.js";
import { MemoryStore, type DiscordStore } from "../src/store.js";
import { harness } from "./support/worker.js";
import {
  ALICE,
  APPLICATION,
  BOB,
  GUILD,
  id,
  installation,
  testCipher,
} from "./support/discord.js";

/**
 * The store's behavior, on memory and on a throwaway PostgreSQL
 * (`DATALAYER_DISCORD_TEST_DATABASE_URL`, never a cluster's): the insert-first turn
 * claim under concurrency, components answered once, the install state spent
 * once, a person forgotten, a removed server purged (DC-105, DC-106, DC-107).
 */
const DATABASE_URL = process.env.DATALAYER_DISCORD_TEST_DATABASE_URL;

function contract(name: string, make: () => Promise<DiscordStore>) {
  describe(name, () => {
    const now = new Date(Date.UTC(2026, 9, 16, 12));
    const later = (ms: number) => new Date(now.getTime() + ms);

    it("claims a thread's turn once among eight concurrent claims, and again after the lease", async () => {
      const store = await make();
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, n) =>
          store.claimTurn("t1", `job-${n}`, later(60_000), now),
        ),
      );
      expect(claims.filter((one) => one.ok)).toHaveLength(1);
      const holder = claims.findIndex((one) => one.ok);
      expect(
        await store.claimTurn("t1", `job-${holder}`, later(60_000), now),
      ).toEqual({ again: true, ok: true });
      expect(
        await store.claimTurn("t1", "late", later(120_000), later(61_000)),
      ).toEqual({ again: false, ok: true });
      await store.requestStop("t1");
      expect((await store.turn("t1"))?.stopRequested).toBe(true);
      await store.releaseTurn("t1", "late");
      expect(await store.turn("t1")).toBeUndefined();
    });

    it("answers a component once", async () => {
      const store = await make();
      await store.saveComponent({
        applicationId: APPLICATION,
        guildId: GUILD,
        kind: "answer",
        ownerId: ALICE,
        payload: { asking: "e1" },
        renderId: "render-0001",
      });
      const presses = await Promise.all([
        store.answerComponent("render-0001", ALICE),
        store.answerComponent("render-0001", BOB),
      ]);
      expect(presses.filter(Boolean)).toHaveLength(1);
      expect((await store.component("render-0001"))?.payload).toEqual({
        asking: "e1",
      });
    });

    it("finds an approval's rows in its server only, oldest first, and keeps a thread's unshown session until cleared (DC-301)", async () => {
      const store = await make();
      for (const [renderId, kind, guildId, approvalId] of [
        ["render-0101", "show", GUILD, "ap-1"],
        ["render-0102", "approve", GUILD, "ap-1"],
        ["render-0103", "show", GUILD, "ap-2"],
        ["render-0104", "show", id(4), "ap-1"],
      ] as const)
        await store.saveComponent({
          applicationId: APPLICATION,
          guildId,
          kind,
          ownerId: ALICE,
          payload: { approvalId, digest: "d" },
          renderId,
        });
      expect(
        (await store.approvalComponents(APPLICATION, GUILD, "ap-1")).map(
          (one) => [one.renderId, one.kind],
        ),
      ).toEqual([
        ["render-0101", "show"],
        ["render-0102", "approve"],
      ]);
      expect(
        await store.approvalComponents(APPLICATION, GUILD, "ap-9"),
      ).toEqual([]);
      const binding = {
        applicationId: APPLICATION,
        channelId: id(3),
        generation: 0,
        guildId: GUILD,
        sessionUid: "s-1",
        threadKey: "t-unshown",
      };
      await store.saveThread({ ...binding, unshownSessionUid: "s-1" });
      expect((await store.thread("t-unshown"))?.unshownSessionUid).toBe("s-1");
      await store.saveThread({ ...binding, unshownSessionUid: undefined });
      expect((await store.thread("t-unshown"))?.unshownSessionUid).toBe(
        undefined,
      );
    });

    it("spends an install state once, and never an expired one", async () => {
      const store = await make();
      const cipher = testCipher();
      const code = cipher.encrypt("bind-code", "install:n1");
      await store.saveState("n1", code, later(600_000));
      expect(await store.spendState("n1", now)).toEqual(code);
      expect(await store.spendState("n1", now)).toBeUndefined();
      await store.saveState("n2", code, later(1000));
      expect(await store.spendState("n2", later(2000))).toBeUndefined();
    });

    it("forgets a person in every server: their links and components deleted, the threads they opened and the presses they answered no longer naming them", async () => {
      const store = await make();
      const cipher = testCipher();
      const other = id(4);
      await store.saveInstallation(installation(cipher));
      await store.saveInstallation(
        installation(cipher, { guildId: other, hostUid: "host-other" }),
      );
      await store.setLinked(APPLICATION, GUILD, ALICE, true);
      await store.setLinked(APPLICATION, other, ALICE, false);
      await store.setLinked(APPLICATION, GUILD, BOB, true);
      expect((await store.linkedGuilds(APPLICATION, ALICE)).sort()).toEqual(
        [GUILD, other].sort(),
      );
      await store.saveComponent({
        applicationId: APPLICATION,
        guildId: other,
        kind: "app",
        ownerId: BOB,
        payload: {},
        renderId: "render-0003",
      });
      expect(await store.answerComponent("render-0003", ALICE)).toBe(true);
      await store.saveThread({
        applicationId: APPLICATION,
        channelId: id(3),
        generation: 0,
        guildId: GUILD,
        openedBy: ALICE,
        threadKey: "t2",
      });
      await store.saveComponent({
        applicationId: APPLICATION,
        guildId: GUILD,
        kind: "stop",
        ownerId: ALICE,
        payload: {},
        renderId: "render-0002",
      });
      // Bob's "Ask Datalayer" on Alice's message keeps her id and her text;
      // Bob's on his own message names nobody forgotten.
      await store.saveComponent({
        applicationId: APPLICATION,
        guildId: GUILD,
        kind: "ask-message",
        ownerId: BOB,
        payload: {
          authorId: ALICE,
          content: "Alice's words",
          messageId: id(5),
        },
        renderId: "render-0004",
      });
      await store.saveComponent({
        applicationId: APPLICATION,
        guildId: GUILD,
        kind: "ask-message",
        ownerId: BOB,
        payload: { authorId: BOB, content: "Bob's words", messageId: id(6) },
        renderId: "render-0005",
      });
      // Two links, one thread, one owned component, one message of hers
      // asked about, one answered press.
      expect(await store.forgetUser(APPLICATION, ALICE)).toBe(6);
      expect(await store.component("render-0004")).toBeUndefined();
      expect((await store.component("render-0005"))?.ownerId).toBe(BOB);
      expect(await store.linked(APPLICATION, GUILD, ALICE)).toBeUndefined();
      expect(await store.linked(APPLICATION, other, ALICE)).toBeUndefined();
      expect(await store.linkedGuilds(APPLICATION, ALICE)).toEqual([]);
      expect(await store.linked(APPLICATION, GUILD, BOB)).toBe(true);
      expect((await store.thread("t2"))?.openedBy).toBeUndefined();
      expect(await store.component("render-0002")).toBeUndefined();
      const answered = await store.component("render-0003");
      expect(answered?.ownerId).toBe(BOB);
      expect(answered?.answeredBy).not.toBe(ALICE);
      // Still answered: a later press is not taken as the first.
      expect(await store.answerComponent("render-0003", BOB)).toBe(false);
      // Nothing of the installation names a Discord person: its installer
      // is the Datalayer account the bind answered (`self().accountUid`).
      expect((await store.installation(APPLICATION, GUILD))?.installedBy).toBe(
        "account-1",
      );
    });

    it("keeps a server's quiet or noisy, quiet at install, never on a removed server (DC-307)", async () => {
      const store = await make();
      const cipher = testCipher();
      await store.saveInstallation(installation(cipher));
      expect(
        (await store.installation(APPLICATION, GUILD))?.notifications,
      ).toBe("quiet");
      expect(await store.setNotifications(APPLICATION, GUILD, "noisy")).toBe(
        true,
      );
      expect(
        (await store.installation(APPLICATION, GUILD))?.notifications,
      ).toBe("noisy");
      expect(await store.setNotifications(APPLICATION, id(9), "noisy")).toBe(
        false,
      );
      await store.setInstallationState(APPLICATION, GUILD, "removed", now);
      expect(await store.setNotifications(APPLICATION, GUILD, "quiet")).toBe(
        false,
      );
      expect(
        (await store.installation(APPLICATION, GUILD))?.notifications,
      ).toBe("noisy");
    });

    it("marks a server removed once, never back to active by a state change, and purges every row of it", async () => {
      const store = await make();
      const cipher = testCipher();
      await store.saveInstallation(installation(cipher));
      await store.setLinked(APPLICATION, GUILD, ALICE, true);
      await store.saveThread({
        applicationId: APPLICATION,
        channelId: id(3),
        generation: 0,
        guildId: GUILD,
        threadKey: "t3",
      });
      expect(
        await store.setInstallationState(APPLICATION, GUILD, "removed", now),
      ).toBe(true);
      expect(
        await store.setInstallationState(APPLICATION, GUILD, "removed", now),
      ).toBe(false);
      expect(
        await store.setInstallationState(APPLICATION, GUILD, "active", now),
      ).toBe(false);
      expect(
        (await store.installation(APPLICATION, GUILD))?.removedAt?.getTime(),
      ).toBe(now.getTime());
      await store.purgeInstallation(APPLICATION, GUILD);
      expect(await store.installation(APPLICATION, GUILD)).toBeUndefined();
      expect(await store.linked(APPLICATION, GUILD, ALICE)).toBeUndefined();
      expect(await store.thread("t3")).toBeUndefined();
    });
  });
}

contract("the memory store", async () => new MemoryStore());

describe.runIf(Boolean(DATABASE_URL))("on PostgreSQL", () => {
  let database: pg.Pool;
  beforeAll(async () => {
    database = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
    await database.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    execFileSync("node", ["--import", "tsx", "scripts/migrate.ts"], {
      env: { ...process.env, DATABASE_URL },
    });
  }, 60_000);
  afterAll(async () => {
    await database?.end();
  });
  const truncate = async () =>
    database.query(
      "TRUNCATE discord_turn, discord_component, discord_oauth_state, discord_user_link, discord_thread_binding, discord_installation, discord_allowance",
    );

  contract("the PostgreSQL store", async () => {
    await truncate();
    return new PostgresStore(database);
  });

  it("takes three of eight concurrent quota takes when three are allowed, all quotas or none (DC-402)", async () => {
    await database.query("TRUNCATE discord_usage");
    const quotas = new PostgresQuotaStore(database, {
      tablePrefix: TABLE_PREFIX,
    });
    const entries = quotaEntries(
      { application: 100, installation: 100, organization: 3, user: 100 },
      {
        applicationId: "deployment-1",
        externalUserId: ALICE,
        installation: `${APPLICATION}:${GUILD}`,
        organizationId: "account-1",
      },
    );
    const takes = await Promise.all(
      Array.from({ length: 8 }, () =>
        quotas.takeQuota(entries, "2026-10-16T12"),
      ),
    );
    expect(takes.filter((one) => one.ok)).toHaveLength(3);
    expect(
      takes
        .filter((one) => !one.ok)
        .map((one) => (one.ok ? "" : one.entry.scope)),
    ).toEqual(Array(5).fill("organization"));
    expect(
      await quotas.quotaUsed("organization:account-1", "2026-10-16T12"),
    ).toBe(3);
    // None of the refused takes counted against the others.
    expect(
      await quotas.quotaUsed(
        `installation:${APPLICATION}:${GUILD}`,
        "2026-10-16T12",
      ),
    ).toBe(3);
  });

  it("forgets a person's quota counts and queued or dead requests in every server, never another's or the running one (DC-106)", async () => {
    await truncate();
    await database.query("TRUNCATE discord_usage, discord_jobs");
    const store = new PostgresStore(database);
    const other = id(4);
    const usage = [
      `user:${APPLICATION}:${GUILD}:${ALICE}`,
      `user:${APPLICATION}:${other}:${ALICE}`,
      `user:${APPLICATION}:${GUILD}:${BOB}`,
      `installation:${APPLICATION}:${GUILD}`,
    ];
    for (const key of usage)
      await database.query(
        "INSERT INTO discord_usage (usage_key, usage_window, used) VALUES ($1, '2026-10-16T12', 1)",
        [key],
      );
    const job = (userId: string, guildId: string, state: string) =>
      database.query(
        "INSERT INTO discord_jobs (payload, state) VALUES ($1, $2)",
        [
          {
            id: id(990),
            key: { applicationId: APPLICATION, channelId: id(3), guildId },
            kind: "interaction",
            userId,
            userName: "someone",
          },
          state,
        ],
      );
    await job(ALICE, GUILD, "ready");
    await job(ALICE, other, "dead");
    await job(ALICE, GUILD, "processing");
    await job(BOB, GUILD, "dead");
    await database.query("INSERT INTO discord_jobs (payload) VALUES ($1)", [
      { guildId: GUILD, kind: "event", type: "APPLICATION_AUTHORIZED" },
    ]);
    // Two quota counts and two jobs.
    expect(await store.forgetUser(APPLICATION, ALICE)).toBe(4);
    const { rows: keys } = await database.query<{ usage_key: string }>(
      "SELECT usage_key FROM discord_usage ORDER BY usage_key",
    );
    expect(keys.map((row) => row.usage_key)).toEqual(
      [usage[3], usage[2]].sort(),
    );
    const { rows: jobs } = await database.query<{
      state: string;
      user: string | null;
    }>(
      "SELECT state, payload->>'userId' AS user FROM discord_jobs ORDER BY id",
    );
    expect(jobs).toEqual([
      { state: "processing", user: ALICE },
      { state: "dead", user: BOB },
      { state: "ready", user: null },
    ]);
    await expect(store.forgetUser(APPLICATION, "x' OR '1'='1")).rejects.toThrow(
      /Discord application and user id/,
    );
  });

  it("drops a spent interaction token from queued and dead jobs, keeping a live one's (DC-102)", async () => {
    await database.query("TRUNCATE discord_jobs");
    const store = new PostgresStore(database);
    const now = Date.UTC(2026, 9, 16, 12);
    const job = (n: number, receivedAt: number, state: string) =>
      database.query(
        "INSERT INTO discord_jobs (payload, state) VALUES ($1, $2)",
        [
          {
            id: id(n),
            kind: "interaction",
            receivedAt,
            token: { ciphertext: "x", iv: "y", version: 1 },
            userId: ALICE,
          },
          state,
        ],
      );
    await job(980, now - 16 * 60 * 1000, "dead");
    await job(981, now - 20 * 60 * 1000, "ready");
    await job(982, now - 60 * 1000, "ready");
    await database.query("INSERT INTO discord_jobs (payload) VALUES ($1)", [
      { kind: "event", type: "APPLICATION_AUTHORIZED" },
    ]);
    expect(await store.dropSpentTokens(new Date(now - 15 * 60 * 1000))).toBe(2);
    const { rows } = await database.query<{ id: string; kept: boolean }>(
      "SELECT payload->>'id' AS id, payload ? 'token' AS kept FROM discord_jobs WHERE payload->>'kind' = 'interaction' ORDER BY id",
    );
    expect(rows).toEqual([
      { id: id(980), kept: false },
      { id: id(981), kept: false },
      { id: id(982), kept: true },
    ]);
    expect(await store.dropSpentTokens(new Date(now - 15 * 60 * 1000))).toBe(0);
  });

  it("gives one turn for two concurrent copies of one /ask (DC-105)", async () => {
    await truncate();
    const store = new PostgresStore(database);
    const one = harness(store, "one");
    await store.saveInstallation(installation(one.cipher));
    one.hosts.links.set(ALICE, "principal-alice");
    const two = harness(store, "two", one.cipher);
    two.hosts.links.set(ALICE, "principal-alice");
    const job = one.job();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    one.agent.onStart = () => gate;
    two.agent.onStart = () => gate;
    const both = Promise.all([one.worker.handle(job), two.worker.handle(job)]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await both;
    expect(one.agent.started.length + two.agent.started.length).toBe(1);
    expect(one.port.count("followUp") + two.port.count("followUp")).toBe(0);
  });
});
