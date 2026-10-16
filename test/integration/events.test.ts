import { MemoryWorkQueue } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { afterEach, describe, expect, it } from "vitest";

import { eventsRoute, handleEvent, type EventJob } from "../../src/events.js";
import type { DiscordJob } from "../../src/resources.js";
import { MemoryStore } from "../../src/store.js";
import {
  APPLICATION,
  GUILD,
  id,
  installation,
  quietLogger,
  serve,
  signingKey,
  testCipher,
} from "../support/discord.js";

/**
 * Webhook events (DC-103): signed like interactions,
 * PING answered 204, each event persisted once and answered 204, whatever
 * its handling later does; handled in any order.
 */

const key = signingKey();
const NOW = Date.UTC(2026, 9, 16, 12);

function authorized(guildId: string, timestamp = "2026-10-16T12:00:00Z") {
  return JSON.stringify({
    application_id: APPLICATION,
    event: {
      data: {
        guild: { id: guildId },
        integration_type: 0,
        scopes: ["bot"],
        user: { id: id(11) },
      },
      timestamp,
      type: "APPLICATION_AUTHORIZED",
    },
    type: 1,
    version: 1,
  });
}

describe("POST /discord/events (DC-103)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function endpoint(queue = new MemoryWorkQueue<DiscordJob>()) {
    const served = await serve({
      "POST /discord/events": eventsRoute({
        applicationId: APPLICATION,
        logger: quietLogger(),
        now: () => NOW,
        publicKey: key.publicKey,
        queue,
      }),
    });
    close = served.close;
    return (body: string, signed = true) => {
      const at = String(Math.floor(NOW / 1000));
      return fetch(`${served.url}/discord/events`, {
        body,
        headers: signed
          ? {
              "x-signature-ed25519": key.sign(at, body),
              "x-signature-timestamp": at,
            }
          : {
              "x-signature-ed25519": "0".repeat(128),
              "x-signature-timestamp": at,
            },
        method: "POST",
      });
    };
  }

  it("answers PING 204, refuses a bad signature 401, persists an event once and answers 204", async () => {
    const jobs: DiscordJob[] = [];
    const queue = new MemoryWorkQueue<DiscordJob>();
    const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = async (item, idempotencyKey) => {
      const fresh = await enqueue(item, idempotencyKey);
      if (fresh) jobs.push(item);
      return fresh;
    };
    const post = await endpoint(queue);
    expect(
      (
        await post(
          JSON.stringify({ application_id: APPLICATION, type: 0, version: 1 }),
        )
      ).status,
    ).toBe(204);
    expect((await post(authorized(GUILD), false)).status).toBe(401);
    expect((await post(authorized(GUILD))).status).toBe(204);
    // Discord retries an event it thinks unanswered: claimed once.
    expect((await post(authorized(GUILD))).status).toBe(204);
    expect(jobs).toEqual([
      {
        at: "2026-10-16T12:00:00Z",
        guildId: GUILD,
        integrationType: 0,
        kind: "event",
        type: "APPLICATION_AUTHORIZED",
      },
    ]);
  });

  it("answers 500 only when the event could not be persisted (Discord tries again)", async () => {
    const queue = new MemoryWorkQueue<DiscordJob>();
    queue.enqueue = async () => {
      throw new Error("the database is down");
    };
    const post = await endpoint(queue);
    expect((await post(authorized(GUILD))).status).toBe(500);
  });

  it("answers 204 before any handling runs: a handling that fails stays in the queue, never a non-2xx", async () => {
    const queue = new MemoryWorkQueue<DiscordJob>();
    const post = await endpoint(queue);
    // No worker takes the job yet: the answer did not wait for one.
    expect((await post(authorized(GUILD))).status).toBe(204);
  });
});

describe("handling an event, in any order (DC-103)", () => {
  const job: EventJob = {
    guildId: GUILD,
    kind: "event",
    type: "APPLICATION_AUTHORIZED",
  };

  it("ignores an authorization for a server already removed, or never bound", async () => {
    const store = new MemoryStore();
    const dependencies = {
      applicationId: APPLICATION,
      logger: quietLogger(),
      store,
    };
    expect(await handleEvent(job, dependencies)).toBe("ignored");
    await store.saveInstallation(installation(testCipher()));
    expect(await handleEvent(job, dependencies)).toBe("seen");
    await store.setInstallationState(APPLICATION, GUILD, "removed", new Date());
    expect(await handleEvent(job, dependencies)).toBe("ignored");
    expect((await store.installation(APPLICATION, GUILD))?.state).toBe(
      "removed",
    );
  });

  it("never maps a deauthorization to a server", async () => {
    const store = new MemoryStore();
    await store.saveInstallation(installation(testCipher()));
    expect(
      await handleEvent(
        { kind: "event", type: "APPLICATION_DEAUTHORIZED" },
        { applicationId: APPLICATION, logger: quietLogger(), store },
      ),
    ).toBe("ignored");
    expect((await store.installation(APPLICATION, GUILD))?.state).toBe(
      "active",
    );
  });
});
