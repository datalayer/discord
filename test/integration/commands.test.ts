import { beforeEach, describe, expect, it } from "vitest";

import { threadIdOf } from "../../src/domain.js";
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
  installation,
} from "../support/discord.js";
import { connected, harness, type Harness } from "../support/worker.js";

/**
 * `/datalayer` and `/datalayer-admin` (DC-104, DC-106):
 * every answer ephemeral, each subcommand and its refusals, `forget`
 * deleting the person's rows, and administration only for the member linked
 * to the connection's owner.
 */

const THREAD = {
  applicationId: APPLICATION,
  channelId: id(700),
  guildId: GUILD,
  parentId: CHANNEL,
  thread: id(700),
};

function command(
  h: Harness,
  name: string,
  subcommand: string,
  overrides: Partial<InteractionJob> = {},
  options = {},
) {
  return h.job({
    command: { name, options, subcommand },
    ephemeral: true,
    ...overrides,
  });
}

/** What the person was told: the last ephemeral edit of `@original`. */
const told = (h: Harness) => {
  const body = h.port.bodies("editOriginal").at(-1);
  expect(body?.flags).toBe(EPHEMERAL);
  return body?.content ?? "";
};

describe("/datalayer (DC-104, DC-106)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await connected(h);
  });

  it("link answers a one-use link to /hosts/link, or says the account is linked already", async () => {
    h.hosts.links.delete(ALICE);
    await h.worker.handle(command(h, "datalayer", "link"));
    expect(told(h)).toContain(
      `https://datalayer.ai/hosts/link?code=dlhc_test_${ALICE}`,
    );
    h.hosts.links.set(ALICE, "principal-alice");
    await h.worker.handle(command(h, "datalayer", "link", { id: id(901) }));
    expect(told(h)).toContain("linked here already");
  });

  it("unlink ends the link at Datalayer and here", async () => {
    await h.worker.handle(command(h, "datalayer", "unlink"));
    expect(told(h)).toContain("unlinked");
    expect(h.hosts.unlinked).toEqual([ALICE]);
    expect(await h.store.linked(APPLICATION, GUILD, ALICE)).toBe(false);
    await h.worker.handle(command(h, "datalayer", "unlink", { id: id(902) }));
    expect(told(h)).toContain("was not linked");
  });

  it("status says the connection, the link, the thread's application and the person's usage", async () => {
    await h.worker.handle(h.job());
    await h.worker.handle(
      command(h, "datalayer", "status", {
        id: id(903),
        key: THREAD,
        threadFromOriginal: false,
      }),
    );
    const words = told(h);
    expect(words).toContain("connected to Datalayer");
    expect(words).toContain("Your Datalayer account is linked.");
    expect(words).toContain("You asked 1 question this hour");
    expect(words).toContain("https://datalayer.ai/docs/discord");
  });

  it("start-over opens a new session generation in a thread, and is refused in a channel", async () => {
    await h.worker.handle(command(h, "datalayer", "start-over"));
    expect(told(h)).toContain("inside a thread");
    await h.store.saveThread({
      applicationId: APPLICATION,
      channelId: CHANNEL,
      deploymentUid: "deployment-1",
      generation: 0,
      guildId: GUILD,
      sessionUid: "discord-old",
      threadKey: threadIdOf(THREAD),
    });
    await h.worker.handle(
      command(h, "datalayer", "start-over", {
        id: id(904),
        key: THREAD,
        threadFromOriginal: false,
      }),
    );
    expect(told(h)).toContain("new session");
    // Held on its own person's button, applied by the press.
    expect(await h.store.thread(threadIdOf(THREAD))).toMatchObject({
      generation: 0,
    });
    const button = (
      h.port.bodies("editOriginal").at(-1)?.components?.[0] as {
        components: Array<{ custom_id: string }>;
      }
    ).components[0]!.custom_id;
    await h.worker.handle(
      h.job({
        command: undefined,
        component: { kind: "start-over", renderId: button.split(":")[2]! },
        id: id(907),
        key: THREAD,
        threadFromOriginal: false,
        type: 3,
      }),
    );
    expect(h.port.bodies("editOriginal").at(-1)?.content).toContain(
      "starts a new session",
    );
    expect(await h.store.thread(threadIdOf(THREAD))).toMatchObject({
      generation: 1,
    });
    expect(
      (await h.store.thread(threadIdOf(THREAD)))?.sessionUid,
    ).toBeUndefined();
  });

  it("app offers the allowed applications, and a press by its owner switches the thread to a new session", async () => {
    await h.worker.handle(
      command(h, "datalayer", "app", {
        key: THREAD,
        threadFromOriginal: false,
      }),
    );
    const offer = h.port.bodies("editOriginal").at(-1)!;
    const menu = (
      offer.components?.[0] as {
        components: Array<{
          custom_id: string;
          options: Array<{ value: string }>;
        }>;
      }
    ).components[0]!;
    expect(menu.options.map((one) => one.value)).toEqual([
      "deployment-1",
      "deployment-2",
    ]);
    const renderId = menu.custom_id.split(":")[2]!;
    // Someone else's press does nothing but say so.
    await h.worker.handle(
      h.job({
        command: undefined,
        component: { kind: "app", renderId },
        id: id(905),
        key: THREAD,
        threadFromOriginal: false,
        type: 3,
        userId: BOB,
        values: ["deployment-2"],
      }),
    );
    expect(h.port.bodies("followUp").at(-1)?.content).toBe(WORDS.notYours);
    await h.worker.handle(
      h.job({
        command: undefined,
        component: { kind: "app", renderId },
        id: id(906),
        key: THREAD,
        threadFromOriginal: false,
        type: 3,
        values: ["deployment-2"],
      }),
    );
    expect(await h.store.thread(threadIdOf(THREAD))).toMatchObject({
      generation: 1,
      nextDeploymentUid: "deployment-2",
    });
    // The next question in the thread runs it, in a new session.
    await h.worker.handle(
      h.job({ id: id(907), key: THREAD, threadFromOriginal: false }),
    );
    expect(h.agent.started.at(-1)).toMatchObject({
      applicationId: "deployment-2",
      sessionGeneration: 1,
    });
    expect(h.agent.started.at(-1)?.sessionId).toBeUndefined();
  });

  it("forget unlinks the person and deletes every row naming them, keeping others'", async () => {
    h.hosts.links.set(BOB, "principal-bob");
    await h.store.setLinked(APPLICATION, GUILD, BOB, true);
    await h.worker.handle(h.job());
    await h.worker.handle(command(h, "datalayer", "forget", { id: id(908) }));
    expect(told(h)).toMatch(
      /Discord records? naming you at Datalayer (is|are) deleted/,
    );
    expect(h.hosts.unlinked).toContain(ALICE);
    expect(await h.store.linked(APPLICATION, GUILD, ALICE)).toBeUndefined();
    expect(await h.store.linked(APPLICATION, GUILD, BOB)).toBe(true);
  });

  it("forget unlinks the person at Datalayer in every server where a link was known, and forgets them in each, never in a removed one", async () => {
    const other = id(4);
    const removed = id(5);
    await h.store.saveInstallation(
      installation(h.cipher, { guildId: other, hostUid: "host-other" }),
    );
    await h.store.saveInstallation(
      installation(h.cipher, {
        guildId: removed,
        hostUid: "host-removed",
        state: "removed",
      }),
    );
    await h.store.setLinked(APPLICATION, other, ALICE, true);
    await h.store.setLinked(APPLICATION, removed, ALICE, true);
    await h.store.setLinked(APPLICATION, other, BOB, true);
    await h.worker.handle(command(h, "datalayer", "forget"));
    // This server's and the other's, each with its own host key.
    expect(h.hosts.unlinked).toEqual([ALICE, ALICE]);
    expect(h.hosts.unlinkedKeys).toHaveLength(2);
    expect(await h.store.linkedGuilds(APPLICATION, ALICE)).toEqual([]);
    expect(await h.store.linked(APPLICATION, other, BOB)).toBe(true);
  });

  it("start-over and app are refused to an unlinked person and to anyone but the thread's opener", async () => {
    await h.store.saveThread({
      applicationId: APPLICATION,
      channelId: CHANNEL,
      deploymentUid: "deployment-1",
      generation: 0,
      guildId: GUILD,
      openedBy: ALICE,
      sessionUid: "discord-old",
      threadKey: threadIdOf(THREAD),
    });
    const inThread = { key: THREAD, threadFromOriginal: false };
    h.hosts.links.delete(BOB);
    await h.worker.handle(
      command(h, "datalayer", "start-over", { ...inThread, userId: BOB }),
    );
    expect(told(h)).toBe(WORDS.notLinked);
    h.hosts.links.set(BOB, "principal-bob");
    for (const [n, sub] of [
      [920, "start-over"],
      [921, "app"],
    ] as const) {
      await h.worker.handle(
        command(h, "datalayer", sub, { ...inThread, id: id(n), userId: BOB }),
      );
      expect(told(h)).toBe(WORDS.notOpener);
    }
    expect(await h.store.thread(threadIdOf(THREAD))).toMatchObject({
      generation: 0,
      sessionUid: "discord-old",
    });
    // The opener may.
    await h.worker.handle(
      command(h, "datalayer", "start-over", { ...inThread, id: id(922) }),
    );
    expect(told(h)).toContain("new session");
  });
});

describe("/datalayer-admin (DC-106)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await connected(h);
    h.hosts.links.set(BOB, "principal-bob");
  });

  it("pauses and resumes for the member linked to the connection's owner, and refuses anyone else", async () => {
    await h.worker.handle(
      command(h, "datalayer-admin", "pause", { userId: BOB }),
    );
    expect(told(h)).toBe(WORDS.notOwner);
    expect((await h.store.installation(APPLICATION, GUILD))?.state).toBe(
      "active",
    );

    await h.worker.handle(
      command(h, "datalayer-admin", "pause", { id: id(910) }),
    );
    expect(told(h)).toContain("paused");
    expect((await h.store.installation(APPLICATION, GUILD))?.state).toBe(
      "paused",
    );
    // Paused: /ask is refused, privately.
    await h.worker.handle(h.job({ id: id(911) }));
    expect(h.port.bodies("followUp").at(-1)?.content).toBe(WORDS.paused);
    expect(h.agent.started).toHaveLength(0);

    await h.worker.handle(
      command(h, "datalayer-admin", "resume", { id: id(912) }),
    );
    expect((await h.store.installation(APPLICATION, GUILD))?.state).toBe(
      "active",
    );
    await h.worker.handle(h.job({ id: id(913) }));
    expect(h.agent.started).toHaveLength(1);
  });

  it("refuses resume to anyone but the owner's linked member, the server staying paused", async () => {
    await h.worker.handle(command(h, "datalayer-admin", "pause"));
    expect((await h.store.installation(APPLICATION, GUILD))?.state).toBe(
      "paused",
    );
    await h.worker.handle(
      command(h, "datalayer-admin", "resume", { id: id(916), userId: BOB }),
    );
    expect(told(h)).toBe(WORDS.notOwner);
    expect((await h.store.installation(APPLICATION, GUILD))?.state).toBe(
      "paused",
    );
    expect(h.hosts.changes).toEqual([{ paused: true }]);
  });

  it("denies a channel for its threads too (a thread is sent as its parent), for the owner only", async () => {
    await h.worker.handle(
      command(
        h,
        "datalayer-admin",
        "channel",
        { key: THREAD, threadFromOriginal: false, userId: BOB },
        { state: "deny" },
      ),
    );
    expect(told(h)).toBe(WORDS.notOwner);
    await h.worker.handle(
      command(
        h,
        "datalayer-admin",
        "channel",
        { id: id(914), key: THREAD, threadFromOriginal: false },
        { state: "deny" },
      ),
    );
    expect(h.hosts.changes.at(-1)).toEqual({
      channel: { id: CHANNEL, state: "deny" },
    });
    await h.worker.handle(h.job({ id: id(915) }));
    expect(h.port.bodies("followUp").at(-1)?.content).toContain(
      "does not answer in this channel",
    );
  });
});

describe("/datalayer-admin notifications (DC-307)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await connected(h);
    h.hosts.links.set(BOB, "principal-bob");
  });

  it("sets quiet or noisy for the server, for the member linked as the connection's owner only", async () => {
    expect(
      (await h.store.installation(APPLICATION, GUILD))?.notifications,
    ).toBe("quiet");
    // Linked, but not as the installation's account: refused.
    await h.worker.handle(
      command(
        h,
        "datalayer-admin",
        "notifications",
        { userId: BOB },
        {
          mode: "noisy",
        },
      ),
    );
    expect(told(h)).toBe(WORDS.notOwner);
    await h.worker.handle(
      command(
        h,
        "datalayer-admin",
        "notifications",
        { id: id(920) },
        {
          mode: "noisy",
        },
      ),
    );
    expect(told(h)).toBe(WORDS.notOwner);
    expect(
      (await h.store.installation(APPLICATION, GUILD))?.notifications,
    ).toBe("quiet");

    // Alice linked as the account the server is bound to: its owner.
    h.hosts.links.set(ALICE, h.hosts.self.accountUid);
    await h.worker.handle(
      command(
        h,
        "datalayer-admin",
        "notifications",
        { id: id(921) },
        {
          mode: "noisy",
        },
      ),
    );
    expect(told(h)).toContain("notify as any message does");
    expect(
      (await h.store.installation(APPLICATION, GUILD))?.notifications,
    ).toBe("noisy");
    await h.worker.handle(
      command(
        h,
        "datalayer-admin",
        "notifications",
        { id: id(922) },
        {
          mode: "quiet",
        },
      ),
    );
    expect(told(h)).toContain("notify no one");
    expect(
      (await h.store.installation(APPLICATION, GUILD))?.notifications,
    ).toBe("quiet");
    // Nothing of it goes to Datalayer's admin route.
    expect(h.hosts.changes).toEqual([]);
  });
});
