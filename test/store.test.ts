import { describe, expect, it } from "vitest";

import { quotaEntries } from "@datalayer/agent-runtimes/lib/portable/hosts";

import { SolrQuotaStore } from "../src/solr/quotas.js";
import { documentOf, type SolrRecords } from "../src/solr/records.js";
import { SolrDiscordStore } from "../src/solr-store.js";
import { MemoryStore, type DiscordStore } from "../src/store.js";
import { solrTestUrl, testCollection } from "./support/solr.js";
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
 * The store's behavior, on memory and, opt-in (`DATALAYER_SOLR_TEST_URL`,
 * `support/solr.ts`), on a throwaway Solr collection made from the
 * platform's configset: the turn claim under concurrency, components
 * answered once, the install state spent once, a person forgotten, a
 * removed server purged (DC-105, DC-106, DC-107).
 */

/** This file's one collection, made once, emptied of all but its locks before each test. */
let collection: Promise<SolrRecords> | undefined;
const solr = async (): Promise<SolrRecords> => {
  collection ??= testCollection("test_discord_store");
  const records = await collection;
  await records.client.deleteWhere("*:* -type_s:lock");
  return records;
};

function contract(name: string, make: () => Promise<DiscordStore>) {
  describe(name, { timeout: 60_000 }, () => {
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

    it("keeps a delivery secret with the key and version it was answered, and no key without a secret", async () => {
      const store = await make();
      const cipher = testCipher();
      const secret = cipher.encrypt("s".repeat(64), "delivery:a:g");
      await store.saveInstallation(
        installation(cipher, {
          deliveryKey: "ai-agents-host-deliveries-v1",
          deliverySecret: secret,
          deliveryVersion: 2,
        }),
      );
      expect(await store.installation(APPLICATION, GUILD)).toMatchObject({
        deliveryKey: "ai-agents-host-deliveries-v1",
        deliverySecret: secret,
        deliveryVersion: 2,
      });
      await store.saveInstallation(
        installation(cipher, { deliveryKey: "ai-agents-host-deliveries-v9" }),
      );
      const plain = await store.installation(APPLICATION, GUILD);
      expect(plain?.deliverySecret).toBeUndefined();
      expect(plain?.deliveryKey).toBeUndefined();
      expect(plain?.deliveryVersion).toBeUndefined();
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

    it("keeps a link code pending until linked or settled: not linked keeps it, linked ends it", async () => {
      const store = await make();
      const until = Date.UTC(2026, 9, 20, 6, 3, 21);
      await store.setLinked(APPLICATION, GUILD, ALICE, false);
      await store.setLinkPending(APPLICATION, GUILD, ALICE, until);
      expect(await store.link(APPLICATION, GUILD, ALICE)).toEqual({
        linked: false,
        pendingUntil: until,
      });
      await store.setLinked(APPLICATION, GUILD, ALICE, false);
      expect(await store.link(APPLICATION, GUILD, ALICE)).toEqual({
        linked: false,
        pendingUntil: until,
      });
      await store.setLinkPending(APPLICATION, GUILD, ALICE, undefined);
      expect(await store.link(APPLICATION, GUILD, ALICE)).toEqual({
        linked: false,
      });
      await store.setLinkPending(APPLICATION, GUILD, BOB, until);
      await store.setLinked(APPLICATION, GUILD, BOB, true);
      expect(await store.link(APPLICATION, GUILD, BOB)).toEqual({
        linked: true,
      });
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
      expect(await store.link(APPLICATION, GUILD, ALICE)).toBeUndefined();
      expect(await store.link(APPLICATION, other, ALICE)).toBeUndefined();
      expect(await store.linkedGuilds(APPLICATION, ALICE)).toEqual([]);
      expect((await store.link(APPLICATION, GUILD, BOB))?.linked).toBe(true);
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

    it("keeps whether a binding's thread exists, and answers an asking event once whichever of its buttons is pressed (DC-304)", async () => {
      const store = await make();
      await store.saveThread({
        applicationId: APPLICATION,
        channelId: id(3),
        generation: 0,
        guildId: GUILD,
        threadExists: true,
        threadKey: "t-asked",
      });
      expect((await store.thread("t-asked"))?.threadExists).toBe(true);
      await store.saveThread({
        applicationId: APPLICATION,
        channelId: id(3),
        generation: 1,
        guildId: GUILD,
        threadKey: "t-asked",
      });
      expect((await store.thread("t-asked"))?.threadExists).toBeUndefined();
      await store.saveComponent({
        applicationId: APPLICATION,
        guildId: GUILD,
        kind: "asking",
        ownerId: ALICE,
        payload: {},
        renderId: "asking-event-1",
      });
      const presses = await Promise.all(
        Array.from({ length: 4 }, () =>
          store.answerComponent("asking-event-1", ALICE),
        ),
      );
      expect(presses.filter(Boolean)).toHaveLength(1);
    });

    it("keeps the server a person's direct messages go to, forgets it with them and with the server (DC-203)", async () => {
      const store = await make();
      const cipher = testCipher();
      await store.saveInstallation(installation(cipher));
      expect(await store.directChoice(APPLICATION, ALICE)).toBeUndefined();
      await store.setDirectChoice(APPLICATION, ALICE, id(4));
      await store.setDirectChoice(APPLICATION, ALICE, GUILD);
      expect(await store.directChoice(APPLICATION, ALICE)).toBe(GUILD);
      await store.forgetUser(APPLICATION, ALICE);
      expect(await store.directChoice(APPLICATION, ALICE)).toBeUndefined();
      await store.setDirectChoice(APPLICATION, ALICE, GUILD);
      await store.purgeInstallation(APPLICATION, GUILD);
      expect(await store.directChoice(APPLICATION, ALICE)).toBeUndefined();
    });

    it("keeps the gateway session a stopping leader leaves, once, per application (DC-201)", async () => {
      const store = await make();
      expect(await store.gatewaySession(APPLICATION)).toBeUndefined();
      await store.saveGatewaySession(APPLICATION, {
        id: "session-1",
        resumeUrl: "wss://resume.discord.gg",
        seq: 41,
      });
      await store.saveGatewaySession(APPLICATION, {
        id: "session-2",
        resumeUrl: "wss://resume.discord.gg",
        seq: 42,
      });
      expect(await store.gatewaySession(APPLICATION)).toEqual({
        id: "session-2",
        resumeUrl: "wss://resume.discord.gg",
        seq: 42,
      });
      await store.saveGatewaySession(APPLICATION, undefined);
      expect(await store.gatewaySession(APPLICATION)).toBeUndefined();
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
      expect(await store.link(APPLICATION, GUILD, ALICE)).toBeUndefined();
      expect(await store.thread("t3")).toBeUndefined();
    });
  });
}

contract("the memory store", async () => new MemoryStore());

describe.skipIf(!solrTestUrl)("on Solr", { timeout: 120_000 }, () => {
  contract("the Solr store", async () => new SolrDiscordStore(await solr()));

  it("refuses a second installation under one host uid, as its unique index did", async () => {
    const store = new SolrDiscordStore(await solr());
    const cipher = testCipher();
    await store.saveInstallation(installation(cipher));
    await store.saveInstallation(installation(cipher));
    await expect(
      store.saveInstallation(
        installation(cipher, { guildId: id(4), hostUid: `host-${GUILD}` }),
      ),
    ).rejects.toThrow(/unique/);
    expect(await store.installationByHost(`host-${GUILD}`)).toMatchObject({
      guildId: GUILD,
    });
    expect(await store.installations()).toHaveLength(1);
  });

  it("keeps the secrets encrypted in the stored record, as PostgreSQL kept them", async () => {
    const records = await solr();
    const store = new SolrDiscordStore(records);
    const cipher = testCipher();
    const one = installation(cipher);
    await store.saveInstallation(one);
    const [doc] = (await records.client.search({ fq: ["type_s:installation"] }))
      .docs;
    const stored = String(doc?.record_stored);
    expect(stored).toContain(one.hostKey.ciphertext);
    expect(
      cipher.decrypt(
        (await store.installation(APPLICATION, GUILD))!.hostKey,
        `${APPLICATION}:${GUILD}`,
      ),
    ).toBe(cipher.decrypt(one.hostKey, `${APPLICATION}:${GUILD}`));
  });

  it("takes three of eight concurrent quota takes when three are allowed, all quotas or none (DC-402)", async () => {
    const quotas = new SolrQuotaStore(await solr());
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

  /** A queue job as the Solr queue writes it, in a given state. */
  const job = async (
    records: SolrRecords,
    payload: Record<string, unknown>,
    state = "ready",
  ) =>
    records.client.add([
      documentOf("job", null, {
        attempts_i: 0,
        available_dt: new Date(),
        kind_s: "other",
        payload_stored: JSON.stringify(payload),
        state_s: state,
      }),
    ]);
  const payloads = async (records: SolrRecords) =>
    (
      await records.client.search({
        fq: ["type_s:job"],
        sort: "uid asc",
      })
    ).docs.map((doc) => ({
      payload: JSON.parse(String(doc.payload_stored)) as Record<
        string,
        unknown
      >,
      state: String(doc.state_s),
    }));

  it("forgets a person's quota counts and queued or dead requests in every server, never another's or the running one (DC-106)", async () => {
    const records = await solr();
    const store = new SolrDiscordStore(records);
    const quotas = new SolrQuotaStore(records);
    const other = id(4);
    const usage = [
      `user:${APPLICATION}:${GUILD}:${ALICE}`,
      `user:${APPLICATION}:${other}:${ALICE}`,
      `user:${APPLICATION}:${GUILD}:${BOB}`,
      `installation:${APPLICATION}:${GUILD}`,
    ];
    for (const key of usage)
      await quotas.takeQuota(
        [{ key, limit: 10, scope: "user" }],
        "2026-10-16T12",
      );
    const request = (userId: string, guildId: string) => ({
      id: id(990),
      key: { applicationId: APPLICATION, channelId: id(3), guildId },
      kind: "interaction",
      userId,
      userName: "someone",
    });
    await job(records, request(ALICE, GUILD), "ready");
    await job(records, request(ALICE, other), "dead");
    await job(records, request(ALICE, GUILD), "processing");
    await job(records, request(BOB, GUILD), "dead");
    await job(records, {
      guildId: GUILD,
      kind: "event",
      type: "APPLICATION_AUTHORIZED",
    });
    // Two quota counts and two jobs.
    expect(await store.forgetUser(APPLICATION, ALICE)).toBe(4);
    for (const [index, key] of usage.entries())
      expect(await quotas.quotaUsed(key, "2026-10-16T12"), key).toBe(
        index < 2 ? 0 : 1,
      );
    expect(
      (await payloads(records)).map((one) => ({
        state: one.state,
        user: one.payload.userId ?? null,
      })),
    ).toEqual([
      { state: "processing", user: ALICE },
      { state: "dead", user: BOB },
      { state: "ready", user: null },
    ]);
    await expect(store.forgetUser(APPLICATION, "x' OR '1'='1")).rejects.toThrow(
      /Discord application and user id/,
    );
  });

  it("drops a spent interaction token from queued and dead jobs, keeping a live one's (DC-102)", async () => {
    const records = await solr();
    const store = new SolrDiscordStore(records);
    const now = Date.UTC(2026, 9, 16, 12);
    const interaction = (n: number, receivedAt: number) => ({
      id: id(n),
      kind: "interaction",
      receivedAt,
      token: { ciphertext: "x", iv: "y", version: 1 },
      userId: ALICE,
    });
    await job(records, interaction(980, now - 16 * 60 * 1000), "dead");
    await job(records, interaction(981, now - 20 * 60 * 1000));
    await job(records, interaction(982, now - 60 * 1000));
    await job(records, { kind: "event", type: "APPLICATION_AUTHORIZED" });
    expect(await store.dropSpentTokens(new Date(now - 15 * 60 * 1000))).toBe(2);
    expect(
      (await payloads(records))
        .filter((one) => one.payload.kind === "interaction")
        .map((one) => ({ id: one.payload.id, kept: "token" in one.payload })),
    ).toEqual([
      { id: id(980), kept: false },
      { id: id(981), kept: false },
      { id: id(982), kept: true },
    ]);
    expect(await store.dropSpentTokens(new Date(now - 15 * 60 * 1000))).toBe(0);
  });

  it("gives one turn for two concurrent copies of one /ask (DC-105)", async () => {
    const store = new SolrDiscordStore(await solr());
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
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    release();
    await both;
    expect(one.agent.started.length + two.agent.started.length).toBe(1);
    expect(one.port.count("followUp") + two.port.count("followUp")).toBe(0);
  });
});
