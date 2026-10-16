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
} from "../support/discord.js";
import { connected, harness, type Harness } from "../support/worker.js";

/**
 * `/datalayer` and `/datalayer-admin` (plans/DISCORD.md §6.1, DC-104, DC-106):
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
