import { beforeEach, describe, expect, it } from "vitest";

import {
  deliverySecretData,
  type DeliveryQueueJob,
} from "../../src/deliveries.js";
import { DIRECT, targetOf, type ThreadKey } from "../../src/domain.js";
import type { MessageJob } from "../../src/gateway.js";
import { NO_MENTIONS } from "../../src/render.js";
import { WAITING } from "../../src/worker.js";
import { refusalWords, WORDS } from "../../src/words.js";
import {
  ALICE,
  APPLICATION,
  BOB,
  CHANNEL,
  GUILD,
  id,
  installation,
  presentation,
} from "../support/discord.js";
import { connected, harness, type Harness } from "../support/worker.js";

/**
 * Direct messages to the bot (DC-203): a DM names no server, so it goes to
 * the one server of the application where the person is linked, or the one
 * they chose among several from a select that holds their question. It is
 * the person's own session there, place `direct`: an application kept to
 * direct messages answers in the DM and is refused in a channel and a
 * thread. A person linked nowhere is told how to link. An approval of a
 * DM's turn is its card, in the DM.
 */

const DM = id(800);
const OTHER = id(4);

function dm(overrides: Partial<MessageJob> = {}, n = 900): MessageJob {
  return {
    applicationId: APPLICATION,
    authorId: ALICE,
    authorName: "alice",
    channelId: DM,
    content: "What is on my plate today?",
    id: id(n),
    kind: "message",
    mentioned: false,
    receivedAt: Date.UTC(2026, 9, 16, 12),
    ...overrides,
  };
}

describe("direct messages (DC-203)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await connected(h);
    // What a person's use of @Datalayer in the server left: linked there.
    await h.store.setLinked(APPLICATION, GUILD, ALICE, true);
    // Writer is kept to direct messages, and the server's default.
    h.hosts.self = {
      ...h.hosts.self,
      defaultDeployment: "deployment-2",
      directOnly: ["deployment-2"],
    };
  });

  /** Where the bot posted, by channel. */
  const posts = (one: Harness = h) =>
    one.port.calls
      .filter(
        (call) =>
          call.method === "createMessage" || call.method === "editMessage",
      )
      .map((call) => call.args[0]);

  it("answers a linked person in the DM as their own session, place direct, with the application kept to direct messages", async () => {
    await h.worker.handle(dm());
    const [turn] = h.agent.started;
    expect(turn?.applicationId).toBe("deployment-2");
    expect(turn?.externalUserId).toBe(ALICE);
    expect(turn?.prompt).toBe("What is on my plate today?");
    expect(turn?.provenance.key).toEqual({
      applicationId: APPLICATION,
      channelId: DM,
      guildId: DIRECT,
      thread: DM,
    });
    expect(h.agent.targets[0]?.target).toMatchObject({
      channelId: DM,
      guildId: DIRECT,
      threadId: DM,
    });
    expect(new Set(posts())).toEqual(new Set([DM]));
    for (const body of h.port.bodies("createMessage"))
      expect(body.allowed_mentions).toEqual(NO_MENTIONS);
    expect(JSON.stringify(h.port.bodies("editMessage"))).toContain("Hello.");
    expect(
      h.port.calls
        .filter((call) => call.method.endsWith("Reaction"))
        .map((call) => [call.method, call.args[2]]),
    ).toEqual([
      ["addReaction", WAITING],
      ["removeReaction", WAITING],
    ]);
    expect(h.port.count("startThread")).toBe(0);
  });

  it("tells a person linked nowhere how to link, once, and runs nothing", async () => {
    const bob = dm({ authorId: BOB, authorName: "bob" }, 901);
    await h.worker.handle(bob);
    await h.worker.handle(bob);
    expect(h.agent.started).toEqual([]);
    expect(h.port.bodies("createMessage").map((one) => one.content)).toEqual([
      WORDS.directNotLinked,
    ]);
  });

  it("refuses the application kept to direct messages in a channel and in a thread", async () => {
    // /ask in the channel, the default being Writer.
    await h.worker.handle(h.job({ n: 902 }));
    // A mention in a thread.
    h.port.channels.set(id(510), { id: id(510), parentId: CHANNEL, type: 11 });
    await h.worker.message({
      ...dm({}, 903),
      channelId: id(510),
      content: `<@${APPLICATION}> Same question`,
      guildId: GUILD,
      mentioned: true,
    });
    expect(h.agent.started).toEqual([]);
    expect(h.port.bodies("followUp").at(-1)?.content).toBe(
      refusalWords("direct-only"),
    );
    expect(h.port.bodies("createMessage").at(-1)?.content).toBe(
      refusalWords("direct-only"),
    );
  });

  it("asks a person linked in several servers which one, holds their question, and answers it once there, for them only", async () => {
    await h.store.saveInstallation(
      installation(h.cipher, { guildId: OTHER, hostUid: "host-other" }),
    );
    await h.store.setLinked(APPLICATION, OTHER, ALICE, true);
    await h.worker.handle(dm({}, 904));
    expect(h.agent.started).toEqual([]);
    const offer = h.port.bodies("createMessage").at(-1)!;
    const menu = (
      offer.components?.[0] as {
        components: Array<{
          custom_id: string;
          options: Array<{ value: string }>;
        }>;
      }
    ).components[0]!;
    expect(menu.options.map((one) => one.value).sort()).toEqual(
      [GUILD, OTHER].sort(),
    );
    const choose = (userId: string, n: number) => {
      const { command, ...job } = h.job({ n, userId });
      void command;
      return {
        ...job,
        component: {
          kind: "direct" as const,
          renderId: menu.custom_id.split(":")[2]!,
        },
        key: {
          applicationId: APPLICATION,
          channelId: DM,
          guildId: DIRECT,
          thread: DM,
        } satisfies ThreadKey,
        threadFromOriginal: false,
        type: 3,
        values: [OTHER],
      };
    };
    await h.worker.handle(choose(BOB, 905));
    expect(h.port.bodies("followUp").at(-1)?.content).toBe(WORDS.notYours);
    expect(h.agent.started).toEqual([]);

    await h.worker.handle(choose(ALICE, 906));
    expect(await h.store.directChoice(APPLICATION, ALICE)).toBe(OTHER);
    expect(h.port.bodies("editOriginal").at(-1)?.content).toContain(
      "Your direct messages go to",
    );
    // The held question, answered once, as the person, in the DM.
    expect(h.agent.started).toHaveLength(1);
    expect(h.agent.started[0]?.prompt).toBe("What is on my plate today?");
    expect(h.agent.started[0]?.externalUserId).toBe(ALICE);
    await h.worker.handle(choose(ALICE, 907));
    expect(h.port.bodies("followUp").at(-1)?.content).toBe(
      WORDS.alreadyAnswered,
    );
    expect(h.agent.started).toHaveLength(1);
    // Later DMs go there without asking.
    await h.worker.handle(dm({ content: "And tomorrow?" }, 908));
    expect(h.agent.started).toHaveLength(2);
    // Forgotten with the person.
    await h.store.forgetUser(APPLICATION, ALICE);
    expect(await h.store.directChoice(APPLICATION, ALICE)).toBeUndefined();
  });

  it("delivers a DM turn's approval as its card, in the DM", async () => {
    const one = installation(h.cipher);
    await h.store.saveInstallation({
      ...one,
      deliverySecret: h.cipher.encrypt("secret", deliverySecretData(one)),
    });
    await h.store.setAllowances(APPLICATION, GUILD, [
      {
        applicationId: "deployment-2",
        channelPolicy: "direct-only",
        enabled: true,
        name: "Writer",
      },
    ]);
    h.asPerson.approvals.set("ap-dm", {
      owner: ALICE,
      presentation: presentation(),
    });
    const delivered: DeliveryQueueJob = {
      delivery: {
        delivery: "dlv-dm",
        event: "approval.requested",
        payload: {
          approval_id: "ap-dm",
          deployment_uid: "deployment-2",
          presentation: "v1",
          session_uid: "discord-session",
          target: targetOf({
            key: {
              applicationId: APPLICATION,
              channelId: DM,
              guildId: DIRECT,
              thread: DM,
            },
            messageId: id(909),
            private: false,
            threadExists: true,
            userId: ALICE,
          }),
          tool_name: "send_email",
        },
      },
      hostUid: one.hostUid,
      kind: "delivery",
    };
    await h.worker.handle(delivered);
    const posted = h.port.calls.filter(
      (call) => call.method === "createMessage",
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]?.args[0]).toBe(DM);
    const card = JSON.stringify(posted[0]?.args[1]);
    expect(card).toContain("Approve");
    expect(card).toContain("Reject");
  });
});
