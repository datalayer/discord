import { MemoryWorkQueue } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  discordShape,
  sessionUidOf,
  threadIdOf,
  type ThreadKey,
} from "../../src/domain.js";
import { interactionsRoute, RESPONSE } from "../../src/interactions.js";
import { EPHEMERAL, START_OVER_LABEL } from "../../src/render.js";
import type { DiscordJob } from "../../src/resources.js";
import { WORDS } from "../../src/words.js";
import {
  ALICE,
  APPLICATION,
  BOB,
  CHANNEL,
  GUILD,
  id,
  quietLogger,
  serve,
  signingKey,
} from "../support/discord.js";
import { connected, harness, type Harness } from "../support/worker.js";

/**
 * Application selection and *Start over* through the interaction handler
 * (DC-207): the signed request on a real socket, the job it keeps, then the
 * worker. The menu and the button live in an ephemeral message, whose
 * payload says nothing of the thread: the thread key is in the component's
 * row. A press runs once and only for its own person; a switch or a start
 * over archives the thread's binding into a new generation, and the next
 * question opens a new session.
 */

const key = signingKey();
const THREAD = id(500);
const IN_THREAD: ThreadKey = {
  applicationId: APPLICATION,
  channelId: THREAD,
  guildId: GUILD,
  parentId: CHANNEL,
  thread: THREAD,
};

class Queue extends MemoryWorkQueue<DiscordJob> {
  readonly jobs: DiscordJob[] = [];
  override async enqueue(item: DiscordJob, idempotencyKey?: string) {
    const fresh = await super.enqueue(item, idempotencyKey);
    if (fresh) this.jobs.push(item);
    return fresh;
  }
}

describe("components through the interaction handler (DC-207)", () => {
  let h: Harness;
  let close: (() => Promise<void>) | undefined;
  let send: (body: unknown) => Promise<unknown>;
  let queue: Queue;
  let n = 0;

  beforeEach(async () => {
    h = harness();
    await connected(h);
    h.hosts.links.set(BOB, "principal-bob");
    await h.store.saveThread({
      applicationId: APPLICATION,
      channelId: CHANNEL,
      deploymentUid: "deployment-1",
      generation: 0,
      guildId: GUILD,
      openedBy: ALICE,
      sessionUid: sessionUidOf(IN_THREAD, 0),
      threadKey: threadIdOf(IN_THREAD),
    });
    queue = new Queue();
    const served = await serve({
      "POST /discord/interactions": interactionsRoute({
        applicationId: APPLICATION,
        cipher: h.cipher,
        hosts: h.hosts.client,
        logger: quietLogger(),
        now: () => h.clock.now(),
        publicKey: key.publicKey,
        queue,
        store: h.store,
      }),
    });
    close = served.close;
    send = async (body: unknown) => {
      const text = JSON.stringify(body);
      const at = String(Math.floor(h.clock.now() / 1000));
      const response = await fetch(`${served.url}/discord/interactions`, {
        body: text,
        headers: {
          "content-type": "application/json",
          "x-signature-ed25519": key.sign(at, text),
          "x-signature-timestamp": at,
        },
        method: "POST",
      });
      expect(response.status).toBe(200);
      return response.json();
    };
  });

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  /** One interaction in the thread, by a person; its kept job run by the worker. */
  async function interact(
    userId: string,
    data: Record<string, unknown>,
    type: 2 | 3,
    message?: Record<string, unknown>,
  ): Promise<unknown> {
    const before = queue.jobs.length;
    const answer = await send({
      app_permissions: "309237763136",
      application_id: APPLICATION,
      channel: { id: THREAD, parent_id: CHANNEL, type: 11 },
      data,
      guild_id: GUILD,
      id: id(1000 + (n += 1)),
      member: { user: { id: userId, username: userId } },
      token: "interaction-token-for-tests",
      type,
      version: 1,
      ...(message ? { message } : {}),
    });
    expect(queue.jobs).toHaveLength(before + 1);
    await h.worker.handle(queue.jobs.at(-1)!);
    return answer;
  }

  const datalayer = (userId: string, subcommand: string) =>
    interact(
      userId,
      { name: "datalayer", options: [{ name: subcommand, type: 1 }], type: 1 },
      2,
    );

  /** The ephemeral message the person was shown, as Discord gives it back on a press. */
  function shown(): {
    message: Record<string, unknown>;
    customId: string;
  } {
    const body = h.port.bodies("editOriginal").at(-1)!;
    expect(body.flags).toBe(EPHEMERAL);
    const component = (
      body.components?.[0] as {
        components: Array<{ custom_id: string }>;
      }
    ).components[0]!;
    return {
      customId: component.custom_id,
      message: {
        components: body.components,
        content: body.content,
        flags: EPHEMERAL,
        id: id(800),
      },
    };
  }

  const told = () => h.port.bodies("followUp").at(-1)?.content;

  it("switches the thread's application once, for the person it was offered to, from a menu in an ephemeral message", async () => {
    expect(await datalayer(ALICE, "app")).toEqual({
      data: { flags: EPHEMERAL },
      type: RESPONSE.deferredMessage,
    });
    const { customId, message } = shown();
    expect(customId).toMatch(/^dc:app:/);
    // The ephemeral payload names no thread: its row does.
    expect(JSON.stringify(message)).not.toContain(THREAD);
    const choose = (userId: string, value: string) =>
      interact(
        userId,
        { component_type: 3, custom_id: customId, values: [value] },
        3,
        message,
      );

    // Another person's choice: deferred as an update, then refused privately.
    expect(await choose(BOB, "deployment-2")).toEqual({
      type: RESPONSE.deferredUpdate,
    });
    expect(told()).toBe(WORDS.notYours);
    expect(await h.store.thread(threadIdOf(IN_THREAD))).toMatchObject({
      generation: 0,
      sessionUid: sessionUidOf(IN_THREAD, 0),
    });

    await choose(ALICE, "deployment-2");
    expect(h.port.bodies("editOriginal").at(-1)?.content).toBe(
      "Writer answers the next question here, in a new session.",
    );
    const switched = await h.store.thread(threadIdOf(IN_THREAD));
    expect(switched).toMatchObject({
      generation: 1,
      nextDeploymentUid: "deployment-2",
    });
    expect(switched?.sessionUid).toBeUndefined();

    // Once: a second choice from the same menu changes nothing.
    await choose(ALICE, "deployment-1");
    expect(told()).toBe(WORDS.alreadyAnswered);
    expect(await h.store.thread(threadIdOf(IN_THREAD))).toMatchObject({
      generation: 1,
      nextDeploymentUid: "deployment-2",
    });

    // The next question opens a new session, on the chosen application.
    await interact(
      ALICE,
      {
        name: "ask",
        options: [{ name: "question", type: 3, value: "Again?" }],
        type: 1,
      },
      2,
    );
    const [turn] = h.agent.started;
    expect(turn?.applicationId).toBe("deployment-2");
    expect(turn?.sessionGeneration).toBe(1);
    expect(turn?.sessionId).toBeUndefined();
    expect(sessionUidOf(IN_THREAD, 1)).not.toBe(sessionUidOf(IN_THREAD, 0));
  });

  it("starts over once, for its own person, from a button in an ephemeral message", async () => {
    // Someone not the thread's opener is refused before any button.
    await datalayer(BOB, "start-over");
    expect(h.port.bodies("editOriginal").at(-1)?.content).toBe(WORDS.notOpener);

    await datalayer(ALICE, "start-over");
    const { customId, message } = shown();
    expect(customId).toMatch(/^dc:start-over:/);
    expect(JSON.stringify(message.components)).toContain(START_OVER_LABEL);
    expect(await h.store.thread(threadIdOf(IN_THREAD))).toMatchObject({
      generation: 0,
    });
    const press = (userId: string) =>
      interact(userId, { component_type: 2, custom_id: customId }, 3, message);

    expect(await press(BOB)).toEqual({ type: RESPONSE.deferredUpdate });
    expect(told()).toBe(WORDS.notYours);
    expect(await h.store.thread(threadIdOf(IN_THREAD))).toMatchObject({
      generation: 0,
    });

    await press(ALICE);
    const after = h.port.bodies("editOriginal").at(-1)!;
    expect(after.content).toContain("starts a new session");
    expect(after.components).toEqual([]);
    const archived = await h.store.thread(threadIdOf(IN_THREAD));
    expect(archived).toMatchObject({ generation: 1, openedBy: ALICE });
    expect(archived?.sessionUid).toBeUndefined();

    await press(ALICE);
    expect(told()).toBe(WORDS.alreadyAnswered);
    expect((await h.store.thread(threadIdOf(IN_THREAD)))?.generation).toBe(1);

    // The next question opens a new session: generation 1, no session kept.
    await interact(
      ALICE,
      {
        name: "ask",
        options: [{ name: "question", type: 3, value: "Fresh?" }],
        type: 1,
      },
      2,
    );
    const [turn] = h.agent.started;
    expect(turn?.sessionGeneration).toBe(1);
    expect(turn?.sessionId).toBeUndefined();
    expect(h.agent.targets[0]?.sessionId).not.toBe(sessionUidOf(IN_THREAD, 0));
  });

  it("opens a new session uid on the next mention after the Start over press (DC-202)", async () => {
    h.port.channels.set(THREAD, { id: THREAD, parentId: CHANNEL, type: 11 });
    await datalayer(ALICE, "start-over");
    const { customId, message } = shown();
    await interact(
      ALICE,
      { component_type: 2, custom_id: customId },
      3,
      message,
    );
    // The next mention in the thread, over the gateway.
    await h.worker.message({
      applicationId: APPLICATION,
      authorId: ALICE,
      authorName: "alice",
      channelId: THREAD,
      content: `<@${APPLICATION}> Start fresh`,
      guildId: GUILD,
      id: id(1500),
      kind: "message",
      mentioned: true,
      receivedAt: h.clock.now(),
    });
    const [turn] = h.agent.started;
    expect(turn?.prompt).toBe("Start fresh");
    expect(turn?.sessionGeneration).toBe(1);
    // No session kept: the agent client opens the uid the shape derives
    // for generation 1, a new one.
    expect(turn?.sessionId).toBeUndefined();
    expect(discordShape.sessionUidOf(turn!)).toBe(sessionUidOf(IN_THREAD, 1));
    expect(discordShape.sessionUidOf(turn!)).not.toBe(
      sessionUidOf(IN_THREAD, 0),
    );
    expect((await h.store.thread(threadIdOf(IN_THREAD)))?.generation).toBe(1);
  });
});
