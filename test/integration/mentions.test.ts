import { beforeEach, describe, expect, it } from "vitest";

import { answers, type MessageJob } from "../../src/gateway.js";
import { sessionUidOf, threadIdOf, type ThreadKey } from "../../src/domain.js";
import { NO_MENTIONS } from "../../src/render.js";
import { WAITING } from "../../src/worker.js";
import { WORDS } from "../../src/words.js";
import { ALICE, APPLICATION, CHANNEL, GUILD, id } from "../support/discord.js";
import { connected, harness, type Harness } from "../support/worker.js";

/**
 * Mentions over the gateway (DC-202): a mention in a text or announcement
 * channel starts a thread on it, keyed by the thread's id, and the
 * person's turn runs there as the bot, under ⏳ while it runs; in an
 * existing thread or a forum post, and in a ping-on reply to a bot message
 * whose thread exists, the session continues. A message without a question
 * — a reply to the interaction response, which carries no text, or a reply
 * with the ping off — is told once that a mention reaches @Datalayer, and
 * is never a turn. A plain message in a thread never reaches the worker.
 */

const BOT = APPLICATION;
const THREAD = id(510);
const FORUM = id(520);
const POST = id(521);

function mention(overrides: Partial<MessageJob> = {}, n = 700): MessageJob {
  return {
    applicationId: APPLICATION,
    authorId: ALICE,
    authorName: "alice",
    channelId: CHANNEL,
    content: `<@${BOT}> What changed this week?`,
    guildId: GUILD,
    id: id(n),
    kind: "message",
    mentioned: true,
    receivedAt: Date.UTC(2026, 9, 16, 12),
    ...overrides,
  };
}

describe("mentions over the gateway (DC-202)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await connected(h);
    h.port.channels.set(THREAD, { id: THREAD, parentId: CHANNEL, type: 11 });
    h.port.channels.set(id(530), { id: id(530), type: 5 });
    h.port.channels.set(POST, { id: POST, parentId: FORUM, type: 11 });
  });

  /** Where the bot posted: channel ids of its messages and edits. */
  const posts = () =>
    h.port.calls
      .filter(
        (call) =>
          call.method === "createMessage" || call.method === "editMessage",
      )
      .map((call) => call.args[0]);

  it("starts a thread on a mention in a text channel, keyed by its id, and answers there as the bot under ⏳", async () => {
    await h.worker.handle(mention());
    const message = id(700);
    expect(
      h.port.calls.find((call) => call.method === "startThread")?.args,
    ).toEqual([CHANNEL, message, "What changed this week?"]);
    // The explanation, then the answer, all in the thread.
    expect(h.port.bodies("createMessage")[0]?.content).toBe(
      `-# ${WORDS.mentionReliable}`,
    );
    expect(new Set(posts())).toEqual(new Set([message]));
    const bodies = [
      ...h.port.bodies("createMessage"),
      ...h.port.bodies("editMessage"),
    ];
    for (const body of bodies)
      expect(body.allowed_mentions).toEqual(NO_MENTIONS);
    expect(JSON.stringify(bodies)).toContain("Hello.");
    // The turn: the person's, the mention stripped, in the thread.
    const [turn] = h.agent.started;
    expect(turn?.prompt).toBe("What changed this week?");
    expect(turn?.externalUserId).toBe(ALICE);
    expect(turn?.provenance).toMatchObject({
      messageId: message,
      private: false,
      threadExists: true,
    });
    const key: ThreadKey = {
      applicationId: APPLICATION,
      channelId: message,
      guildId: GUILD,
      parentId: CHANNEL,
      thread: message,
    };
    expect(await h.store.thread(threadIdOf(key))).toMatchObject({
      openedBy: ALICE,
      threadExists: true,
    });
    // ⏳ added on the mention, then removed.
    const reactions = h.port.calls
      .filter(
        (call) =>
          call.method === "addReaction" || call.method === "removeReaction",
      )
      .map((call) => [call.method, ...call.args]);
    expect(reactions).toEqual([
      ["addReaction", CHANNEL, message, WAITING],
      ["removeReaction", CHANNEL, message, WAITING],
    ]);
    // Never the interaction token.
    expect(h.port.count("editOriginal")).toBe(0);
    expect(h.port.count("followUp")).toBe(0);
  });

  it("starts a thread on a mention in an announcement channel", async () => {
    await h.worker.handle(mention({ channelId: id(530) }, 701));
    expect(
      h.port.calls.find((call) => call.method === "startThread")?.args,
    ).toEqual([id(530), id(701), "What changed this week?"]);
    expect(new Set(posts())).toEqual(new Set([id(701)]));
    expect(h.agent.started).toHaveLength(1);
  });

  it("continues the session in an existing thread and in a forum post, without a new thread", async () => {
    await h.worker.handle(mention({ channelId: THREAD }, 702));
    await h.worker.handle(
      mention({ channelId: THREAD, content: `<@${BOT}> And then?` }, 703),
    );
    expect(h.port.count("startThread")).toBe(0);
    expect(new Set(posts())).toEqual(new Set([THREAD]));
    const [first, second] = h.agent.started;
    expect(second?.prompt).toBe("And then?");
    expect(second?.sessionId).toBe(h.agent.targets[0]?.sessionId);
    expect(first?.provenance.key.thread).toBe(THREAD);

    await h.worker.handle(mention({ channelId: POST }, 704));
    expect(h.port.count("startThread")).toBe(0);
    expect(h.agent.started[2]?.provenance.key).toMatchObject({
      channelId: POST,
      parentId: FORUM,
      thread: POST,
    });
  });

  it("continues in the thread of a regular bot message a ping-on reply answers", async () => {
    // A first /ask's answer in the channel, its thread started on it.
    const answered = id(540);
    await h.store.saveThread({
      applicationId: APPLICATION,
      channelId: CHANNEL,
      deploymentUid: "deployment-1",
      generation: 0,
      guildId: GUILD,
      openedBy: ALICE,
      sessionUid: "discord-session-of-the-answer",
      threadExists: true,
      threadKey: threadIdOf({
        applicationId: APPLICATION,
        channelId: CHANNEL,
        guildId: GUILD,
        thread: answered,
      }),
    });
    await h.worker.handle(
      mention(
        {
          content: `<@${BOT}> Say more`,
          reference: { authorId: BOT, messageId: answered },
        },
        705,
      ),
    );
    expect(h.port.count("startThread")).toBe(0);
    expect(new Set(posts())).toEqual(new Set([answered]));
    expect(h.agent.started[0]?.sessionId).toBe("discord-session-of-the-answer");
  });

  it("tells a reply to the interaction response and a reply with the ping off, once each, that a mention reaches it — never a turn", async () => {
    // A reply to the /ask interaction response arrives without its text.
    const toResponse = mention(
      { content: "", reference: { authorId: BOT, messageId: id(541) } },
      706,
    );
    await h.worker.handle(toResponse);
    await h.worker.handle(toResponse);
    // A reply with the ping off: not a mention.
    const pingOff = mention(
      {
        content: "",
        mentioned: false,
        reference: { authorId: BOT, messageId: id(541) },
      },
      707,
    );
    await h.worker.handle(pingOff);
    await h.worker.handle(pingOff);
    expect(h.agent.started).toEqual([]);
    expect(h.port.count("startThread")).toBe(0);
    const said = h.port.calls.filter((call) => call.method === "createMessage");
    expect(said.map((call) => call.args[0])).toEqual([CHANNEL, CHANNEL]);
    expect(h.port.bodies("createMessage").map((one) => one.content)).toEqual([
      WORDS.mentionToContinue,
      WORDS.mentionToContinue,
    ]);
    expect(h.port.bodies("createMessage")[0]?.message_reference).toEqual({
      fail_if_not_exists: false,
      message_id: id(706),
    });
    expect(h.port.count("addReaction")).toBe(0);
  });

  it("never lets a plain message in a thread reach the worker", () => {
    expect(
      answers(
        {
          author: { id: ALICE },
          channel_id: THREAD,
          content: "",
          guild_id: GUILD,
          id: id(708),
          mentions: [],
          type: 0,
        },
        BOT,
      ),
    ).toBe(false);
  });

  it("refuses a person not linked with a reply, before any thread", async () => {
    h.hosts.links.delete(ALICE);
    await h.worker.handle(mention({}, 709));
    expect(h.agent.started).toEqual([]);
    expect(h.port.count("startThread")).toBe(0);
    expect(h.port.bodies("createMessage").at(-1)?.content).toBe(
      WORDS.notLinked,
    );
  });

  it("opens a new session on the next mention after Start over (DC-207)", async () => {
    await h.worker.handle(mention({ channelId: THREAD }, 710));
    const key: ThreadKey = {
      applicationId: APPLICATION,
      channelId: THREAD,
      guildId: GUILD,
      parentId: CHANNEL,
      thread: THREAD,
    };
    const before = await h.store.thread(threadIdOf(key));
    expect(before?.sessionUid).toBeDefined();
    // What the Start over press does (components.test.ts): a new generation.
    await h.store.saveThread({
      ...before!,
      generation: 1,
      sessionUid: undefined,
    });
    await h.worker.handle(mention({ channelId: THREAD }, 711));
    const next = h.agent.started[1]!;
    expect(next.sessionGeneration).toBe(1);
    expect(next.sessionId).toBeUndefined();
    // The session uid the agent client derives is a new one.
    expect(sessionUidOf(key, 1)).not.toBe(sessionUidOf(key, 0));
  });
});
