import { beforeEach, describe, expect, it } from "vitest";

import { sessionUidOf, threadIdOf } from "../../src/domain.js";
import type { InteractionJob } from "../../src/interactions.js";
import { EPHEMERAL } from "../../src/render.js";
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
 * only to them, in a session of its own, once.
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
});
