import { beforeEach, describe, expect, it } from "vitest";

import { DiscordError } from "../../src/discord-port.js";
import { sessionUidOf, threadIdOf } from "../../src/domain.js";
import type { InteractionJob } from "../../src/interactions.js";
import { EPHEMERAL, POST_LABEL } from "../../src/render.js";
import { WORDS } from "../../src/words.js";
import {
  ALICE,
  APPLICATION,
  BOB,
  CHANNEL,
  GUILD,
  id,
} from "../support/discord.js";
import { connected, harness, type Harness } from "../support/worker.js";

/**
 * *Ask Datalayer* on a message (DC-206): the modal's
 * submit becomes the person's own private turn — the instruction and the
 * message's text quoted, the message as the turn's provenance — answered
 * only to them, in a session of its own, once; and *Post in thread* on that
 * private answer, for the person who asked only, once, never for an answer
 * holding a secret, posting it in the message's thread and mapping the
 * session there.
 */

const ASKED_ABOUT = id(700);
const RENDER = "askmessage-0001";

async function opened(h: Harness, owner = ALICE): Promise<void> {
  await connected(h);
  h.hosts.links.set(BOB, "principal-bob");
  // What the ingress kept when the modal opened (interactions.test.ts).
  await h.store.saveComponent({
    applicationId: APPLICATION,
    guildId: GUILD,
    kind: "ask-message",
    ownerId: owner,
    payload: {
      authorId: BOB,
      content: "We ship on Tuesday.\nOr Wednesday, if QA needs it.",
      messageId: ASKED_ABOUT,
    },
    renderId: RENDER,
  });
}

function submitted(
  h: Harness,
  userId = ALICE,
  n = 950,
  question = "Summarize this in one line.",
  inThread = false,
): InteractionJob {
  const { command, ...job } = h.job({ n, userId });
  void command;
  return {
    ...job,
    ephemeral: true,
    fields: { question },
    ...(inThread
      ? {
          key: {
            ...job.key,
            channelId: id(500),
            parentId: CHANNEL,
            thread: id(500),
          },
          threadFromOriginal: false,
        }
      : {}),
    modal: `dc:ask-message:${RENDER}`,
    type: 5,
  };
}

describe("Ask Datalayer on a message (DC-206)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("runs the person's own private turn on the instruction and the quoted message, with the message as its provenance", async () => {
    await opened(h);
    await h.worker.handle(submitted(h));
    const [turn] = h.agent.started;
    expect(turn?.externalUserId).toBe(ALICE);
    expect(turn?.prompt).toBe(
      "Summarize this in one line.\n\nThe message, as written in Discord:\n> We ship on Tuesday.\n> Or Wednesday, if QA needs it.",
    );
    expect(turn?.provenance).toMatchObject({
      messageId: ASKED_ABOUT,
      private: true,
      threadExists: false,
      userId: ALICE,
    });
    // Mapped private: nothing of it is delivered where others read.
    expect(h.agent.targets[0]?.target).toMatchObject({
      messageId: ASKED_ABOUT,
      private: true,
    });
    expect(h.agent.targets[0]?.target).not.toHaveProperty("threadId");
    // Answered only to them: every edit ephemeral, nothing posted, no thread.
    const edits = h.port.bodies("editOriginal");
    expect(edits.length).toBeGreaterThan(0);
    for (const body of edits) expect(body.flags).toBe(EPHEMERAL);
    expect(edits.at(-1)?.content).toContain("Hello.");
    expect(h.port.count("createMessage")).toBe(0);
    expect(h.port.count("startThread")).toBe(0);
    expect(h.port.count("deleteOriginal")).toBe(0);
  });

  it("answers a submit once, and refuses another person's", async () => {
    await opened(h);
    await h.worker.handle(submitted(h, BOB, 951));
    expect(h.agent.started).toEqual([]);
    expect(h.port.bodies("editOriginal")[0]?.content).toBe(WORDS.notYours);
    await h.worker.handle(submitted(h, ALICE, 952));
    await h.worker.handle(submitted(h, ALICE, 953));
    expect(h.agent.started).toHaveLength(1);
    expect(h.port.bodies("editOriginal").at(-1)?.content).toBe(
      WORDS.alreadyAnswered,
    );
  });

  it("keeps a submit in a thread out of the thread's session: a session of its own, the channel's policy", async () => {
    await opened(h);
    // The private answer's own message in the thread.
    h.port.originalId = id(777);
    await h.worker.handle(submitted(h, ALICE, 954, "Check it.", true));
    const [turn] = h.agent.started;
    const threadSession = sessionUidOf({
      applicationId: APPLICATION,
      channelId: id(500),
      guildId: GUILD,
      parentId: CHANNEL,
      thread: id(500),
    });
    expect(h.agent.targets[0]?.sessionId).not.toBe(threadSession);
    expect(
      await h.store.thread(
        threadIdOf({
          applicationId: APPLICATION,
          channelId: id(500),
          guildId: GUILD,
          parentId: CHANNEL,
          thread: id(500),
        }),
      ),
    ).toBeUndefined();
    expect(turn?.provenance.key.parentId).toBe(CHANNEL);
    expect(turn?.provenance.threadExists).toBe(false);
  });

  it("refuses an empty instruction and a person not linked", async () => {
    await opened(h);
    await h.worker.handle(submitted(h, ALICE, 955, "   "));
    expect(h.port.bodies("editOriginal")[0]?.content).toBe(
      "Say what Datalayer should do.",
    );
    h.hosts.links.delete(ALICE);
    await h.worker.handle(submitted(h, ALICE, 956));
    expect(h.agent.started).toEqual([]);
    expect(h.port.bodies("editOriginal").at(-1)?.content).toBe(WORDS.notLinked);
  });

  /** The *Post in thread* button on the private answer, if any. */
  function postButton(h: Harness): string | undefined {
    for (const body of h.port.bodies("editOriginal"))
      for (const row of (body.components ?? []) as Array<{
        components: Array<{ custom_id: string; label: string }>;
      }>)
        for (const button of row.components)
          if (button.label === POST_LABEL) return button.custom_id;
    return undefined;
  }

  /** A press on the private answer: an update deferred in the channel. */
  function pressed(
    h: Harness,
    customId: string,
    userId = ALICE,
    n = 960,
  ): InteractionJob {
    const { command, ...job } = h.job({ n, userId });
    void command;
    return {
      ...job,
      component: { kind: "post", renderId: customId.split(":")[2] ?? "" },
      ephemeral: false,
      threadFromOriginal: false,
      type: 3,
    };
  }

  it("posts the private answer in a thread started on the message, for the asker, once, and maps the session there", async () => {
    await opened(h);
    await h.worker.handle(submitted(h));
    const post = postButton(h);
    expect(post).toMatch(/^dc:post:/);
    const sessionId = h.agent.targets[0]!.sessionId;

    // Another person's press posts nothing.
    await h.worker.handle(pressed(h, post!, BOB, 961));
    expect(h.port.bodies("followUp").at(-1)?.content).toBe(WORDS.notYours);
    expect(h.port.count("createMessage")).toBe(0);

    await h.worker.handle(pressed(h, post!, ALICE, 962));
    expect(
      h.port.calls.filter((call) => call.method === "startThread")[0]?.args,
    ).toEqual([CHANNEL, ASKED_ABOUT, "Datalayer"]);
    const posted = h.port.calls.filter(
      (call) => call.method === "createMessage",
    );
    expect(posted).toHaveLength(1);
    // As the bot, in the thread whose id is the message's, no ping.
    expect(posted[0]?.args[0]).toBe(ASKED_ABOUT);
    const body = h.port.bodies("createMessage")[0]!;
    expect(body.content).toContain(`<@${ALICE}> asked Datalayer`);
    expect(body.content).toContain("Hello.");
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.flags).toBeUndefined();
    // The session's target is the thread now, no longer private.
    expect(h.agent.targets.at(-1)).toEqual({
      sessionId,
      target: {
        applicationId: APPLICATION,
        channelId: CHANNEL,
        guildId: GUILD,
        messageId: ASKED_ABOUT,
        threadId: ASKED_ABOUT,
        userId: ALICE,
      },
    });
    // The thread it started continues that session.
    const key = {
      applicationId: APPLICATION,
      channelId: ASKED_ABOUT,
      guildId: GUILD,
      parentId: CHANNEL,
      thread: ASKED_ABOUT,
    };
    expect(await h.store.thread(threadIdOf(key))).toMatchObject({
      openedBy: ALICE,
      sessionUid: sessionId,
    });
    // The private answer loses the button and keeps Open in Datalayer.
    const edited = h.port.bodies("editOriginal").at(-1)!;
    expect(JSON.stringify(edited.components)).not.toContain(POST_LABEL);
    expect(JSON.stringify(edited.components)).toContain("dc:open:");
    expect(h.port.bodies("followUp").at(-1)?.content).toBe(
      `Posted in <#${ASKED_ABOUT}>.`,
    );

    // Once.
    await h.worker.handle(pressed(h, post!, ALICE, 963));
    expect(h.port.count("createMessage")).toBe(1);
    expect(h.port.bodies("followUp").at(-1)?.content).toBe(
      WORDS.alreadyAnswered,
    );
  });

  it("posts in the thread the message is in, or the one already started on it, without re-binding that thread", async () => {
    await opened(h);
    h.port.originalId = id(777);
    await h.worker.handle(submitted(h, ALICE, 964, "Check it.", true));
    await h.worker.handle(pressed(h, postButton(h)!, ALICE, 965));
    expect(h.port.count("startThread")).toBe(0);
    expect(
      h.port.calls.find((call) => call.method === "createMessage")?.args[0],
    ).toBe(id(500));
    expect(h.agent.targets.at(-1)?.target).toMatchObject({
      channelId: CHANNEL,
      threadId: id(500),
    });

    // A message in a channel that already has its thread: Discord's 160004.
    const g = harness();
    await opened(g);
    await g.worker.handle(submitted(g, ALICE, 966));
    g.port.failures.set("startThread", [
      new DiscordError(400, 160004, "channel:threads"),
    ]);
    await g.worker.handle(pressed(g, postButton(g)!, ALICE, 967));
    expect(
      g.port.calls.find((call) => call.method === "createMessage")?.args[0],
    ).toBe(ASKED_ABOUT);
    expect(
      await g.store.thread(
        threadIdOf({
          applicationId: APPLICATION,
          channelId: ASKED_ABOUT,
          guildId: GUILD,
          parentId: CHANNEL,
          thread: ASKED_ABOUT,
        }),
      ),
    ).toBeUndefined();
  });

  it("never offers or posts a secret-bearing answer", async () => {
    await opened(h);
    const secret = `dlhk_${"q3".repeat(12)}`;
    h.agent.script = [
      { kind: "text", text: `The key is ${secret}` },
      { kind: "completion" },
    ];
    await h.worker.handle(submitted(h));
    expect(h.port.bodies("editOriginal").at(-1)?.content).toContain(secret);
    expect(postButton(h)).toBeUndefined();

    // A row whose answer holds one (as if written before a check) is refused.
    await h.store.saveComponent({
      applicationId: APPLICATION,
      guildId: GUILD,
      kind: "post",
      ownerId: ALICE,
      payload: {
        applicationId: "deployment-1",
        channelId: CHANNEL,
        messageId: ASKED_ABOUT,
        openId: "openopenopen",
        parentId: "",
        sessionUid: "session-1",
        texts: [`The key is ${secret}`],
      },
      renderId: "postpostpost",
    });
    await h.worker.handle(pressed(h, "dc:post:postpostpost", ALICE, 968));
    expect(h.port.bodies("followUp").at(-1)?.content).toBe(WORDS.private);
    expect(h.port.count("createMessage")).toBe(0);
    expect(h.port.count("startThread")).toBe(0);
  });
});
