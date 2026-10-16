import { HostRefusedError } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { beforeEach, describe, expect, it } from "vitest";

import { DiscordError, HttpDiscordPort } from "../../src/discord-port.js";
import { sessionUidOf } from "../../src/domain.js";
import { DiscordRateLimiter } from "../../src/rate-limit.js";
import { EPHEMERAL } from "../../src/render.js";
import { MemoryStore } from "../../src/store.js";
import { WORDS } from "../../src/words.js";
import {
  ALICE,
  APPLICATION,
  BOB,
  CHANNEL,
  FakeClock,
  GUILD,
  id,
  tokenGone,
  type Script,
} from "../support/discord.js";
import { connected, harness, type Harness } from "../support/worker.js";

/**
 * `/ask` end to end with a fake clock and a fake Discord port (plans/DISCORD.md
 * §3.2, §7.5, DC-105): edits counted, the thread started on the answer, the
 * final text never repeated, the 14-minute switch and a spent token, missing
 * permissions, an IAM refusal and a secret-bearing output after a public
 * deferral, Stop, and two copies of one job giving one turn.
 */

const words = (count: number, every: number): Script =>
  Array.from(
    { length: count },
    (): Script => [{ wait: every }, { kind: "text", text: "word " }],
  ).flat();

describe("/ask end to end (DC-105)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await connected(h);
  });

  it("edits at most 21 times for 600 tokens over 30 s, starts the thread on the answer, and never repeats the final text", async () => {
    h.agent.script = [
      ...words(600, 50),
      { kind: "completion", text: "word ".repeat(600) },
    ];
    await h.worker.handle(h.job());
    const edits = h.port.bodies("editOriginal");
    expect(edits.length).toBeLessThanOrEqual(21);
    expect(edits.length).toBeGreaterThan(10);
    expect(h.port.count("startThread")).toBe(1);
    expect(
      h.port.calls
        .find((call) => call.method === "startThread")
        ?.args.slice(0, 2),
    ).toEqual([CHANNEL, h.port.originalId]);
    const final = edits[edits.length - 1]!;
    expect(final.content?.match(/word/g)).toHaveLength(
      Math.min(600, Math.floor(2000 / 5)),
    );
    const all = [final, ...h.port.bodies("followUp")]
      .map((body) => body.content)
      .join("");
    expect(all.match(/word/g)).toHaveLength(600);
    expect(final.components).toEqual([]);
    expect(final.allowed_mentions).toEqual({ parse: [] });
    // The session uid is the thread's: the `@original` id the thread takes.
    expect(h.agent.started[0]).toMatchObject({
      applicationId: "deployment-1",
      externalEventId: `discord:${id(900)}`,
      externalUserId: ALICE,
      principalId: "principal-alice",
    });
    expect(h.agent.started[0]?.provenance.key.thread).toBe(h.port.originalId);
  });

  it("continues a thread's session in the thread, with the thread's application", async () => {
    await h.worker.handle(h.job());
    const thread = {
      applicationId: APPLICATION,
      channelId: h.port.originalId,
      guildId: GUILD,
      parentId: CHANNEL,
      thread: h.port.originalId,
    };
    await h.worker.handle(
      h.job({ key: thread, n: 901, threadFromOriginal: false }),
    );
    expect(h.agent.started).toHaveLength(2);
    expect(h.agent.started[1]?.sessionId).toBe(
      h.agent.started[0]?.sessionId ?? `discord-${"0".repeat(40)}`,
    );
    expect(sessionUidOf(thread)).toBe(
      sessionUidOf({ ...thread, channelId: CHANNEL, parentId: undefined }),
    );
    expect(h.port.count("startThread")).toBe(1);
  });

  it("switches to bot messages at 14 minutes in a 16-minute turn, never touching the token again", async () => {
    h.agent.script = [...words(16, 60_000), { kind: "completion" }];
    await h.worker.handle(h.job());
    const methods = h.port.calls.map((call) => call.method);
    const firstBot = methods.indexOf("createMessage");
    expect(firstBot).toBeGreaterThan(0);
    expect(methods.slice(firstBot)).not.toContain("editOriginal");
    expect(methods.slice(firstBot)).toContain("editMessage");
    // In the thread started from the answer.
    expect(h.port.calls[firstBot]?.args[0]).toBe(h.port.originalId);
  });

  it("switches at once after a 404 on the token and never uses it again", async () => {
    h.agent.script = [...words(5, 2000), { kind: "completion" }];
    let edits = 0;
    const edit = h.port.editOriginal.bind(h.port);
    h.port.editOriginal = async (token, body) => {
      edits += 1;
      if (edits === 2) {
        h.port.calls.push({ args: [token, body], method: "editOriginal" });
        throw tokenGone();
      }
      return edit(token, body);
    };
    await h.worker.handle(h.job());
    expect(edits).toBe(2);
    expect(h.port.count("createMessage")).toBe(1);
    expect(h.port.count("editMessage")).toBeGreaterThan(0);
  });

  it("without the thread permissions starts no thread, and at 14 minutes says the answer waits in Datalayer", async () => {
    h.agent.script = [...words(16, 60_000), { kind: "completion" }];
    await h.worker.handle(h.job({ appPermissions: String(1n << 10n) }));
    expect(h.port.count("startThread")).toBe(0);
    expect(h.port.count("createMessage")).toBe(0);
    const edits = h.port.bodies("editOriginal");
    expect(edits[edits.length - 1]?.content).toContain(WORDS.waitsInDatalayer);
  });

  it("answers an IAM refusal after a public deferral privately: no public text, one ephemeral follow-up", async () => {
    h.agent.refuse = new HostRefusedError(
      403,
      "not allowed",
      "Datalayer refused the host credential exchange",
    );
    await h.worker.handle(h.job());
    expect(h.port.count("editOriginal")).toBe(0);
    expect(h.port.count("deleteOriginal")).toBe(1);
    const follow = h.port.bodies("followUp");
    expect(follow).toHaveLength(1);
    expect(follow[0]).toMatchObject({
      content: WORDS.refusedByDatalayer,
      flags: EPHEMERAL,
    });
  });

  it("answers a secret-bearing output after a public deferral privately: no public text, one ephemeral follow-up", async () => {
    const secret = `dlhk_${"x".repeat(24)}`;
    h.agent.script = [
      { kind: "text", text: "Your key is " },
      { kind: "text", text: secret },
      { kind: "completion" },
    ];
    await h.worker.handle(h.job());
    for (const body of h.port.bodies("editOriginal"))
      expect(body.content).not.toContain(secret);
    expect(h.port.count("deleteOriginal")).toBe(1);
    const follow = h.port.bodies("followUp");
    expect(follow).toHaveLength(1);
    expect(follow[0]?.flags).toBe(EPHEMERAL);
    expect(follow[0]?.content).toContain(secret);
  });

  it("refuses privately an unlinked person and a busy thread; drops a removed server's job", async () => {
    h.hosts.links.clear();
    await h.worker.handle(h.job());
    expect(h.port.bodies("followUp")[0]?.content).toBe(WORDS.notLinked);
    expect(h.agent.started).toHaveLength(0);

    h.hosts.links.set(ALICE, "principal-alice");
    const thread = {
      applicationId: APPLICATION,
      channelId: id(701),
      guildId: GUILD,
      parentId: CHANNEL,
      thread: id(701),
    };
    await h.store.claimTurn(
      `${APPLICATION}:${GUILD}:${CHANNEL}:${id(701)}`,
      `${id(1)}:other`,
      new Date(h.clock.now() + 60_000),
      new Date(h.clock.now()),
    );
    await h.worker.handle(
      h.job({ key: thread, n: 902, threadFromOriginal: false }),
    );
    expect(h.port.bodies("followUp").at(-1)?.content).toBe(WORDS.busy);

    await h.store.setInstallationState(
      APPLICATION,
      GUILD,
      "removed",
      new Date(),
    );
    const before = h.port.calls.length;
    await h.worker.handle(h.job({ n: 903 }));
    expect(h.port.calls.length).toBe(before);
  });

  it("refuses a denied channel and a deployment not allowed, privately", async () => {
    h.hosts.self = {
      ...h.hosts.self,
      channels: [{ deployment: "", id: CHANNEL, state: "deny" }],
    };
    await h.worker.handle(h.job());
    expect(h.port.bodies("followUp")[0]?.content).toContain(
      "does not answer in this channel",
    );
    h.hosts.self = { ...h.hosts.self, channels: [] };
    await h.worker.handle(
      h.job({
        command: {
          name: "ask",
          options: { application: "deployment-9", question: "x" },
        },
        n: 904,
      }),
    );
    expect(h.port.bodies("followUp")[1]?.content).toContain(
      "not one this server allows",
    );
    expect(h.agent.started).toHaveLength(0);
  });

  it("stops a turn as the person who pressed Stop, and says Stopped when the stream just ends", async () => {
    let stopId = "";
    h.agent.script = [
      { kind: "text", text: "Working on it" },
      { wait: 2000 },
      { kind: "text", text: "." },
    ];
    const edit = h.port.editOriginal.bind(h.port);
    h.port.editOriginal = async (token, body) => {
      const button = (
        body.components?.[0] as
          | { components?: Array<{ custom_id: string }> }
          | undefined
      )?.components?.[0];
      if (button && !stopId) {
        stopId = button.custom_id;
        await h.worker.handle(
          h.job({
            command: undefined,
            component: { kind: "stop", renderId: stopId.split(":")[2]! },
            n: 950,
            type: 3,
            userId: BOB,
          }),
        );
      }
      return edit(token, body);
    };
    h.hosts.links.set(BOB, "principal-bob");
    await h.worker.handle(h.job());
    expect(stopId).toMatch(/^dc:stop:/);
    expect(h.agent.stopped).toHaveLength(1);
    expect(h.port.bodies("editOriginal").at(-1)?.content).toContain("Stopped");
  });
});

describe("Discord's rate limits through the REST port (DC-105, §7.5)", () => {
  it("honours a 429's retry_after once, counts it, and succeeds", async () => {
    const clock = new FakeClock();
    const limiter = new DiscordRateLimiter(clock);
    const answers = [
      new Response(
        JSON.stringify({
          global: false,
          message: "You are being rate limited.",
          retry_after: 1.5,
        }),
        {
          headers: { "x-ratelimit-scope": "user" },
          status: 429,
        },
      ),
      new Response(JSON.stringify({ channel_id: CHANNEL, id: id(42) }), {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset-after": "2",
        },
        status: 200,
      }),
      new Response(JSON.stringify({ channel_id: CHANNEL, id: id(43) }), {
        status: 200,
      }),
    ];
    const port = new HttpDiscordPort(
      {
        applicationId: APPLICATION,
        botToken: "test-only",
        clientSecret: "test-only",
      },
      limiter,
      async () => answers.shift()!,
    );
    const start = clock.now();
    expect(
      (
        await port.createMessage(CHANNEL, {
          allowed_mentions: { parse: [] },
          content: "x",
        })
      ).id,
    ).toBe(id(42));
    expect(clock.now() - start).toBe(1500);
    expect(limiter.limited.user).toBe(1);
    expect(limiter.invalidRequests()).toBe(1);
    // The bucket said it was spent: the next call on the route waits for it.
    await port.createMessage(CHANNEL, {
      allowed_mentions: { parse: [] },
      content: "y",
    });
    expect(clock.now() - start).toBe(3500);
  });

  it("fails after the bounded retries, with Discord's status", async () => {
    const limiter = new DiscordRateLimiter(new FakeClock());
    const port = new HttpDiscordPort(
      {
        applicationId: APPLICATION,
        botToken: "test-only",
        clientSecret: "test-only",
      },
      limiter,
      async () =>
        new Response(JSON.stringify({ retry_after: 0.1 }), {
          headers: { "x-ratelimit-scope": "shared" },
          status: 429,
        }),
    );
    await expect(
      port.createMessage(CHANNEL, { allowed_mentions: { parse: [] } }),
    ).rejects.toBeInstanceOf(DiscordError);
    expect(limiter.limited.shared).toBe(3);
    // A shared-scope 429 is not an invalid request (Discord does not count it).
    expect(limiter.invalidRequests()).toBe(0);
  });
});

describe("two copies of one job (DC-105)", () => {
  it("run one turn on the memory store", async () => {
    const store = new MemoryStore();
    const one = harness(store, "one");
    await connected(one);
    const two = harness(store, "two", one.cipher);
    two.hosts.links.set(ALICE, "principal-alice");
    // The same job, as two workers took it: same id, same token.
    const job = one.job();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    one.agent.onStart = () => gate;
    const first = one.worker.handle(job);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await two.worker.handle(job);
    release();
    await first;
    expect(one.agent.started.length + two.agent.started.length).toBe(1);
    expect(two.port.count("followUp")).toBe(0);
  });
});
