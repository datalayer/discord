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
 * (`DISCORD_TEST_DATABASE_URL`, never a cluster's): the insert-first turn
 * claim under concurrency, components answered once, the install state spent
 * once, a person forgotten, a removed server purged (plans/DISCORD.md §5,
 * §7.5, DC-105, DC-106, DC-107).
 */
const DATABASE_URL = process.env.DISCORD_TEST_DATABASE_URL;

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

    it("forgets a person: their link and components deleted, the threads they opened no longer naming them", async () => {
      const store = await make();
      const cipher = testCipher();
      await store.saveInstallation(installation(cipher));
      await store.setLinked(APPLICATION, GUILD, ALICE, true);
      await store.setLinked(APPLICATION, GUILD, BOB, true);
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
      expect(await store.forgetUser(APPLICATION, ALICE)).toBe(3);
      expect(await store.linked(APPLICATION, GUILD, ALICE)).toBeUndefined();
      expect(await store.linked(APPLICATION, GUILD, BOB)).toBe(true);
      expect((await store.thread("t2"))?.openedBy).toBeUndefined();
      expect(await store.component("render-0002")).toBeUndefined();
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
