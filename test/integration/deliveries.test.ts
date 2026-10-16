import {
  DELIVERY_ROUTE,
  deliveryRoute,
  deliverySignature,
  type HostDelivery,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deliverySecretData,
  deliverySinkOf,
  type DeliveryQueueJob,
} from "../../src/deliveries.js";
import { DiscordError } from "../../src/discord-port.js";
import { targetOf, threadIdOf, type ThreadKey } from "../../src/domain.js";
import { NO_MENTIONS, SUPPRESS_NOTIFICATIONS } from "../../src/render.js";
import { WORDS } from "../../src/words.js";
import {
  ALICE,
  APPLICATION,
  CHANNEL,
  GUILD,
  id,
  installation,
  serve,
} from "../support/discord.js";
import { connected, harness, type Harness } from "../support/worker.js";

/**
 * Datalayer's deliveries in Discord (DC-301): the
 * signed webhook (signature, window, unknown installation), each delivery
 * handled once then acknowledged, a removed installation's dropped, a thread
 * that is gone falling back to its channel, an approval as a line pinging
 * its owner alone, a decision taken elsewhere updating it, and a turn whose
 * answer the worker could not show — its token long spent — finished as a
 * bot message.
 */

const THREAD = id(500);
const HOST = `host-${GUILD}`;
const SECRET = "delivery-secret-for-tests";

/** The thread of a first `/ask` in the channel, started from `@original`. */
const KEY: ThreadKey = {
  applicationId: APPLICATION,
  channelId: CHANNEL,
  guildId: GUILD,
  thread: THREAD,
};

const target = (
  overrides: { threadExists?: boolean; private?: boolean } = {},
) =>
  targetOf({
    key: KEY,
    messageId: THREAD,
    private: overrides.private ?? false,
    threadExists: overrides.threadExists ?? true,
    userId: ALICE,
  });

let n = 0;
const requested = (
  approvalId = "ap-1",
  where: Record<string, unknown> = target(),
): HostDelivery => ({
  delivery: `dlv-${(n += 1)}`,
  event: "approval.requested",
  payload: {
    approval_id: approvalId,
    deployment_uid: "deployment-1",
    presentation: "v1",
    session_uid: "discord-session",
    target: where,
    tool_name: "send_email",
  },
});

const decided = (approvalId = "ap-1", status = "approved"): HostDelivery => ({
  delivery: `dlv-${(n += 1)}`,
  event: "approval.decided",
  payload: {
    approval_id: approvalId,
    decided_by: "principal-alice",
    deployment_uid: "deployment-1",
    session_uid: "discord-session",
    status,
    target: target(),
  },
});

const completed = (
  sessionUid = "discord-session",
  where: Record<string, unknown> = target(),
): HostDelivery => ({
  delivery: `dlv-${(n += 1)}`,
  event: "turn.completed",
  payload: {
    deployment_uid: "deployment-1",
    record_entry: "entry-1",
    session_uid: sessionUid,
    target: where,
  },
});

const job = (delivery: HostDelivery): DeliveryQueueJob => ({
  delivery,
  hostUid: HOST,
  kind: "delivery",
});

async function bound(h: Harness): Promise<void> {
  await connected(h);
  const one = installation(h.cipher);
  await h.store.saveInstallation({
    ...one,
    deliverySecret: h.cipher.encrypt(SECRET, deliverySecretData(one)),
  });
  await h.store.setAllowances(APPLICATION, GUILD, [
    {
      applicationId: "deployment-1",
      channelPolicy: "channels",
      enabled: true,
      name: "Launch Review",
    },
  ]);
}

describe("the delivery webhook (DC-301)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("queues a signed delivery once; refuses a forged one, one outside the window and an unknown installation", async () => {
    const h = harness();
    await bound(h);
    const queued: unknown[] = [];
    const now = Math.floor(h.clock.now() / 1000);
    const served = await serve({
      [`POST ${DELIVERY_ROUTE}`]: deliveryRoute(
        deliverySinkOf(h.store, h.cipher),
        async (one) => {
          queued.push(one);
        },
        () => now,
      ),
    });
    close = served.close;
    const delivery = requested();
    const body = JSON.stringify(delivery);
    const post = (
      host: string,
      timestamp: number,
      signature = deliverySignature(SECRET, timestamp, body),
    ) =>
      fetch(`${served.url}/datalayer/deliveries/${host}`, {
        body,
        headers: {
          "x-datalayer-delivery": delivery.delivery,
          "x-datalayer-signature": signature,
          "x-datalayer-timestamp": String(timestamp),
        },
        method: "POST",
      });
    expect((await post(HOST, now)).status).toBe(200);
    expect(queued).toEqual([{ delivery, hostUid: HOST }]);
    // Forged: signed with another secret.
    expect(
      (await post(HOST, now, deliverySignature("another", now, body))).status,
    ).toBe(401);
    // Outside the five-minute window, either way.
    expect((await post(HOST, now - 301)).status).toBe(401);
    expect((await post(HOST, now + 301)).status).toBe(401);
    expect((await post("host-unknown", now)).status).toBe(404);
    expect(queued).toHaveLength(1);
  });
});

describe("deliveries in Discord (DC-301)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await bound(h);
  });

  it("shows an approval as a line in its thread that pings its owner alone, with Show the request, once", async () => {
    const delivery = requested();
    await h.worker.handle(job(delivery));
    // Delivered twice (a push and the outbox): handled once, acknowledged twice.
    await h.worker.handle(job(delivery));
    expect(h.port.count("createMessage")).toBe(1);
    const [where, body] = h.port.calls.find(
      (call) => call.method === "createMessage",
    )!.args as [string, Record<string, unknown>];
    expect(where).toBe(THREAD);
    expect(body.allowed_mentions).toEqual({ parse: [], users: [ALICE] });
    expect(body.content).toBe(
      `<@${ALICE}> Launch Review is waiting for your decision: send\\_email.`,
    );
    expect(JSON.stringify(body.components)).toContain("Show the request");
    expect(h.hosts.acknowledged).toEqual([
      delivery.delivery,
      delivery.delivery,
    ]);
    const rows = await h.store.approvalComponents(APPLICATION, GUILD, "ap-1");
    expect(rows.map((one) => [one.kind, one.ownerId])).toEqual([
      ["show", ALICE],
    ]);
    // The same approval delivered again under another uid: no second line.
    await h.worker.handle(job({ ...delivery, delivery: "dlv-again" }));
    expect(h.port.count("createMessage")).toBe(1);
  });

  it("drops a removed installation's delivery, unacknowledged and unshown", async () => {
    await h.store.setInstallationState(
      APPLICATION,
      GUILD,
      "removed",
      new Date(h.clock.now()),
    );
    await h.worker.handle(job(requested()));
    expect(h.port.calls).toEqual([]);
    expect(h.hosts.acknowledged).toEqual([]);
  });

  it("shows nothing for a target it did not give, or another server's", async () => {
    await h.worker.handle(
      job(requested("ap-1", { ...target(), guildId: id(9) })),
    );
    await h.worker.handle(job(requested("ap-2", { channel: "C1" })));
    expect(h.port.calls).toEqual([]);
    expect(h.hosts.acknowledged).toHaveLength(2);
  });

  it("posts in the parent channel when the thread was deleted, or archived and locked", async () => {
    h.port.failures.set("createMessage", [
      new DiscordError(404, 10003, "channel:messages"),
    ]);
    await h.worker.handle(job(requested("ap-1")));
    h.port.failures.set("createMessage", [
      new DiscordError(400, 50083, "channel:messages"),
    ]);
    await h.worker.handle(job(requested("ap-2")));
    const places = h.port.calls
      .filter((call) => call.method === "createMessage")
      .map((call) => call.args[0]);
    expect(places).toEqual([THREAD, CHANNEL, THREAD, CHANNEL]);
    const shown = await h.store.approvalComponents(APPLICATION, GUILD, "ap-2");
    expect(shown[0]?.payload.channelId).toBe(CHANNEL);
  });

  it("says nothing of a private turn's approval where others read", async () => {
    await h.worker.handle(job(requested("ap-1", target({ private: true }))));
    expect(h.port.calls).toEqual([]);
    expect(h.hosts.acknowledged).toHaveLength(1);
  });

  it("updates the thread's line when the approval is decided in Datalayer: its outcome, no buttons", async () => {
    await h.worker.handle(job(requested()));
    await h.worker.handle(job(decided("ap-1", "rejected")));
    const [where, message, body] = h.port.calls.find(
      (call) => call.method === "editMessage",
    )!.args as [string, string, Record<string, unknown>];
    expect(where).toBe(THREAD);
    expect(message).toBe(id(601));
    expect(body).toMatchObject({
      allowed_mentions: NO_MENTIONS,
      components: [],
      content: "Rejected: send\\_email.",
    });
  });

  it("finishes a turn whose answer was not shown — its token long spent — as a quiet bot message in the thread, once", async () => {
    await h.store.saveThread({
      applicationId: APPLICATION,
      channelId: CHANNEL,
      deploymentUid: "deployment-1",
      generation: 0,
      guildId: GUILD,
      openedBy: ALICE,
      sessionUid: "discord-session",
      threadKey: threadIdOf(KEY),
      unshownSessionUid: "discord-session",
    });
    h.asPerson.answers.set("discord-session", "The launch is on Tuesday.");
    // Long after the interaction's 15 minutes: only the bot token is used.
    h.clock.advance(60 * 60 * 1000);
    await h.worker.handle(job(completed()));
    expect(h.port.count("editOriginal")).toBe(0);
    expect(h.port.count("followUp")).toBe(0);
    const [where, body] = h.port.calls.find(
      (call) => call.method === "createMessage",
    )!.args as [string, Record<string, unknown>];
    expect(where).toBe(THREAD);
    expect(body).toMatchObject({
      allowed_mentions: NO_MENTIONS,
      content: "The launch is on Tuesday.",
      flags: SUPPRESS_NOTIFICATIONS,
    });
    expect(JSON.stringify(body.components)).toContain("Open in Datalayer");
    expect((await h.store.thread(threadIdOf(KEY)))?.unshownSessionUid).toBe(
      undefined,
    );
    // Delivered again (another uid): shown already, nothing more.
    await h.worker.handle(job(completed()));
    expect(h.port.count("createMessage")).toBe(1);
  });

  it("posts a later answer as the server chose: silently when quiet, as any message when noisy, never parsing a mention; only the approval line names its owner", async () => {
    const unshown = async (session: string) =>
      h.store.saveThread({
        applicationId: APPLICATION,
        channelId: CHANNEL,
        deploymentUid: "deployment-1",
        generation: 0,
        guildId: GUILD,
        openedBy: ALICE,
        sessionUid: session,
        threadKey: threadIdOf(KEY),
        unshownSessionUid: session,
      });
    h.asPerson.answers.set("s-quiet", "Quiet @everyone answer.");
    h.asPerson.answers.set("s-noisy", "Noisy answer.");
    await unshown("s-quiet");
    await h.worker.handle(job(completed("s-quiet")));
    expect(await h.store.setNotifications(APPLICATION, GUILD, "noisy")).toBe(
      true,
    );
    await unshown("s-noisy");
    await h.worker.handle(job(completed("s-noisy")));
    await h.worker.handle(job(requested("ap-9")));
    const bodies = h.port.bodies("createMessage");
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({ flags: SUPPRESS_NOTIFICATIONS });
    expect(bodies[0]?.content).not.toContain("@everyone");
    expect(bodies[1]?.content).toBe("Noisy answer.");
    expect(bodies[1]?.flags).toBeUndefined();
    // The decision notice: its owner alone, in `users`, nothing parsed.
    expect(bodies[2]?.allowed_mentions).toEqual({ parse: [], users: [ALICE] });
    for (const body of bodies.slice(0, 2))
      expect(body.allowed_mentions).toEqual(NO_MENTIONS);
  });

  it("never shows a finished answer holding a credential, nor a turn shown as it streamed", async () => {
    // Shown as it streamed: no mark, nothing delivered.
    await h.worker.handle(job(completed()));
    expect(h.port.count("createMessage")).toBe(0);
    await h.store.saveThread({
      applicationId: APPLICATION,
      channelId: CHANNEL,
      generation: 0,
      guildId: GUILD,
      sessionUid: "discord-session",
      threadKey: threadIdOf(KEY),
      unshownSessionUid: "discord-session",
    });
    // Built here, so no scanner takes the test value for a credential.
    const credential = ["dlhk", "test".repeat(3)].join("_");
    h.asPerson.answers.set("discord-session", `It is ${credential} now.`);
    await h.worker.handle(job(completed()));
    const body = h.port.bodies("createMessage")[0]!;
    expect(body.content).toBe(WORDS.finishedInDatalayer);
    expect(JSON.stringify(h.port.calls)).not.toContain("dlhk_");
  });

  it("runs a turn whose answer could not be shown and leaves it for turn.completed, then clears it once shown", async () => {
    // No bot permission to post and the token switched at 14 minutes: the
    // answer waits; the delivery then finds the mark.
    h.agent.script = [
      { kind: "text", text: "Part one." },
      { wait: 15 * 60 * 1000 },
      { kind: "text", text: " Part two." },
      { kind: "completion" },
    ];
    await h.worker.handle(h.job({ appPermissions: "0" }));
    const threadKey = threadIdOf({ ...KEY, thread: h.port.originalId });
    const binding = await h.store.thread(threadKey);
    expect(binding?.unshownSessionUid).toBe(binding?.sessionUid);
    // A turn that showed its answer leaves no mark.
    const shown = harness();
    await connected(shown);
    await shown.worker.handle(shown.job());
    const after = await shown.store.thread(
      threadIdOf({ ...KEY, thread: shown.port.originalId }),
    );
    expect(after?.sessionUid).toBeTruthy();
    expect(after?.unshownSessionUid).toBe(undefined);
  });
});
