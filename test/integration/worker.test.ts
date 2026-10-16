import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  DEFAULT_QUOTAS,
  HostKeyCredentials,
  HostRefusedError,
  HttpAgentClient,
  MemoryQuotaStore,
  quotaEntries,
  windowOf,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { beforeEach, describe, expect, it } from "vitest";

import { DiscordError, HttpDiscordPort } from "../../src/discord-port.js";
import {
  discordShape,
  sessionUidOf,
  type DiscordTurn,
} from "../../src/domain.js";
import { DiscordRateLimiter } from "../../src/rate-limit.js";
import { EPHEMERAL } from "../../src/render.js";
import { MemoryStore } from "../../src/store.js";
import { Worker } from "../../src/worker.js";
import { WORDS } from "../../src/words.js";
import {
  ALICE,
  APPLICATION,
  BOB,
  CHANNEL,
  FakeAsPerson,
  FakeClock,
  FakeHosts,
  GUILD,
  id,
  installation,
  quietLogger,
  testCipher,
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
    // Beside @original in its channel: no thread before the output is whole
    // and checked, then one on @original, after the last edit.
    expect(h.port.calls[firstBot]?.args[0]).toBe(CHANNEL);
    expect(h.port.count("startThread")).toBe(1);
    expect(methods.indexOf("startThread")).toBeGreaterThan(
      methods.lastIndexOf("editMessage"),
    );
    expect(h.agent.targets.at(-1)?.target).toMatchObject({
      threadId: h.port.originalId,
    });
  });

  it("starts no thread for a 16-minute turn whose answer turns out secret-bearing, and shows none of it", async () => {
    const secret = `dlhk_${"k9".repeat(12)}`;
    h.agent.script = [
      ...words(15, 60_000),
      { kind: "text", text: `the key is ${secret}` },
      { wait: 60_000 },
      { kind: "completion" },
    ];
    await h.worker.handle(h.job());
    expect(h.port.count("createMessage")).toBe(1);
    expect(h.port.count("startThread")).toBe(0);
    for (const call of h.port.calls)
      expect([call.method, JSON.stringify(call.args).includes("k9k9")]).toEqual(
        [call.method, false],
      );
    const bot = h.port.bodies("editMessage");
    expect(bot.at(-1)?.content).toContain(WORDS.privateAfterExpiry);
    expect(h.agent.targets).toHaveLength(1);
    expect(h.agent.targets[0]?.target).not.toHaveProperty("threadId");
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

  it("answers a secret-bearing output after a public deferral privately: no public text, no thread, one ephemeral follow-up", async () => {
    const secret = `dlhk_${"x7".repeat(12)}`;
    // Streamed in pieces, with time for an edit between each: the shape of
    // the review's probe ("Your key is", then "Your key is dlhk_abc").
    h.agent.script = [
      { kind: "text", text: "Your key is " },
      { wait: 2000 },
      { kind: "text", text: secret.slice(0, 8) },
      { wait: 2000 },
      { kind: "text", text: secret.slice(8, 12) },
      { wait: 2000 },
      { kind: "text", text: `${secret.slice(12)} and it works.` },
      { wait: 2000 },
      { kind: "completion" },
    ];
    await h.worker.handle(h.job());
    const publicCalls = h.port.calls.filter(
      (call) => call.method !== "followUp",
    );
    // Edits came (the status as the stream advanced), with no answer text.
    expect(h.port.count("editOriginal")).toBeGreaterThan(1);
    for (const call of publicCalls) {
      const sent = JSON.stringify(call.args);
      for (const words of ["Your", "key", "works", "dlhk", "x7x7"])
        expect([call.method, sent.includes(words)]).toEqual([
          call.method,
          false,
        ]);
    }
    expect(h.port.count("startThread")).toBe(0);
    expect(h.port.count("createMessage")).toBe(0);
    expect(h.port.count("deleteOriginal")).toBe(1);
    const follow = h.port.bodies("followUp");
    expect(follow).toHaveLength(1);
    expect(follow[0]?.flags).toBe(EPHEMERAL);
    expect(follow[0]?.content).toContain(secret);
    // The session stays mapped to the channel's message, never to a thread.
    expect(h.agent.targets).toHaveLength(1);
    expect(h.agent.targets[0]?.target).not.toHaveProperty("threadId");
  });

  // Not only the answer's words: the question a turn ends on, the run's
  // error, a file's link and the status line are output too (§2, 5).
  const OTHER = `dlhk_${"z3".repeat(12)}`;
  for (const [what, script] of [
    [
      "the question it ends on",
      [
        { wait: 2000 },
        { kind: "ask", question: { kind: "text", prompt: `Use ${OTHER}?` } },
      ],
    ],
    [
      "the run's error",
      [{ wait: 2000 }, { kind: "error", message: `bad key ${OTHER}` }],
    ],
    [
      "a file's link",
      [
        { kind: "file", name: "out.csv", url: `https://x.test/f?t=${OTHER}` },
        { wait: 2000 },
        { kind: "completion", text: "Here it is." },
      ],
    ],
    [
      "the status line",
      [
        { kind: "progress", label: `Trying ${OTHER}` },
        { wait: 2000 },
        { kind: "text", text: "Done." },
        { wait: 2000 },
        { kind: "completion" },
      ],
    ],
  ] as const satisfies readonly (readonly [string, Script])[])
    it(`answers a credential in ${what} after a public deferral privately: no public text, no thread, one ephemeral follow-up`, async () => {
      h.agent.script = [...script];
      await h.worker.handle(h.job());
      for (const call of h.port.calls.filter(
        (one) => one.method !== "followUp",
      ))
        expect([
          call.method,
          JSON.stringify(call.args).includes("z3z3"),
        ]).toEqual([call.method, false]);
      expect(h.port.count("startThread")).toBe(0);
      expect(h.port.count("deleteOriginal")).toBe(1);
      const follow = h.port.bodies("followUp");
      expect(follow).toHaveLength(1);
      expect(follow[0]?.flags).toBe(EPHEMERAL);
      expect(h.agent.targets).toHaveLength(1);
    });

  it("shows a public answer only whole: while it runs, its status and length; a private one as it is written", async () => {
    h.agent.script = [
      { kind: "text", text: "Option B is saf" },
      { wait: 2000 },
      { kind: "text", text: "er than A" },
      { wait: 2000 },
      { kind: "completion" },
    ];
    await h.worker.handle(h.job());
    const edits = h.port.bodies("editOriginal").map((body) => body.content);
    expect(edits.slice(0, -1)).toEqual([
      "-# Working… · 4 words so far",
      "-# Working… · 6 words so far",
    ]);
    expect(edits.at(-1)).toBe("Option B is safer than A");
  });

  it("knows every kind of semantic event, none of which marks an output private: tools and approvals reach a message by name only (§2, 5)", async () => {
    const events = JSON.parse(
      readFileSync(
        createRequire(import.meta.url).resolve(
          "@datalayer/agent-runtimes/lib/portable/semantic-events.json",
        ),
        "utf8",
      ),
    ) as { kinds: string[]; cases: unknown };
    // A new kind (a private output among them) fails here first, so the
    // worker decides how it is shown before it is ever streamed.
    expect([...events.kinds].sort()).toEqual(
      [
        "approval",
        "ask",
        "citation",
        "completion",
        "error",
        "file",
        "progress",
        "stop",
        "table",
        "text",
        "tool",
      ].sort(),
    );
    expect(JSON.stringify(events.cases)).not.toMatch(
      /"(private|visibility|sensitive|secret)"/,
    );
    h.agent.script = [
      { id: "c1", kind: "tool", name: "send_mail", status: "running" },
      { wait: 2000 },
      { kind: "approval", toolCallId: "call-7f3e", toolName: "send_mail" },
      { wait: 2000 },
      { kind: "completion", text: "Sent." },
    ];
    await h.worker.handle(h.job());
    const shown = h.port.calls
      .map((call) => JSON.stringify(call.args))
      .join("");
    expect(shown).toContain("send_mail");
    expect(shown).not.toContain("call-7f3e");
  });

  it("maps the session to the channel's message, then again to the thread once it exists (§3.2)", async () => {
    await h.worker.handle(h.job());
    expect(h.port.count("startThread")).toBe(1);
    const [first, second] = h.agent.targets;
    expect(first?.target).toEqual({
      applicationId: APPLICATION,
      channelId: CHANNEL,
      guildId: GUILD,
      messageId: h.port.originalId,
      userId: ALICE,
    });
    expect(second).toEqual({
      sessionId: first?.sessionId,
      target: { ...first?.target, threadId: h.port.originalId },
    });
    // The thread is started after the whole answer was shown.
    const methods = h.port.calls.map((call) => call.method);
    expect(methods.lastIndexOf("editOriginal")).toBeLessThan(
      methods.indexOf("startThread"),
    );
  });

  it("keeps the first mapping when no thread is started: without the permission, or when starting it fails", async () => {
    await h.worker.handle(h.job({ appPermissions: String(1n << 10n) }));
    expect(h.agent.targets).toHaveLength(1);
    expect(h.agent.targets[0]?.target).not.toHaveProperty("threadId");

    h.port.failures.set("startThread", [new DiscordError(403, 50013, "x")]);
    await h.worker.handle(h.job({ n: 905 }));
    expect(h.port.count("startThread")).toBe(1);
    expect(h.agent.targets).toHaveLength(2);
    expect(h.agent.targets[1]?.target).not.toHaveProperty("threadId");
  });

  it("runs a private /ask privately: every edit ephemeral, no thread, nothing deleted, mapped as private", async () => {
    h.agent.script = [
      { kind: "text", text: "Only for you " },
      { wait: 2000 },
      { kind: "text", text: "and nobody else." },
      { kind: "completion" },
    ];
    await h.worker.handle(h.job({ ephemeral: true }));
    const edits = h.port.bodies("editOriginal");
    expect(edits.length).toBeGreaterThan(1);
    for (const body of edits) expect(body.flags).toBe(EPHEMERAL);
    expect(edits.at(-1)?.content).toContain("Only for you and nobody else.");
    expect(h.port.count("startThread")).toBe(0);
    expect(h.port.count("deleteOriginal")).toBe(0);
    expect(h.port.count("createMessage")).toBe(0);
    expect(h.agent.targets).toHaveLength(1);
    expect(typeof h.agent.targets[0]?.sessionId).toBe("string");
    expect(h.agent.targets[0]?.target).toEqual({
      applicationId: APPLICATION,
      channelId: CHANNEL,
      guildId: GUILD,
      messageId: h.port.originalId,
      private: true,
      userId: ALICE,
    });
  });

  it("charges the quotas once per interaction: a redelivered job is not charged again", async () => {
    const job = h.job();
    await h.worker.handle(job);
    await h.worker.handle(job);
    const [user, server] = quotaEntries(DEFAULT_QUOTAS, {
      applicationId: "deployment-1",
      externalUserId: ALICE,
      installation: `${APPLICATION}:${GUILD}`,
    });
    const hour = windowOf(new Date(h.clock.now()));
    expect(await h.quotas.quotaUsed(user!.key, hour)).toBe(1);
    expect(await h.quotas.quotaUsed(server!.key, hour)).toBe(1);
    // Both ran into the same idempotent turn at the runtime.
    expect(h.agent.started.map((one) => one.externalEventId)).toEqual([
      `discord:${id(900)}`,
      `discord:${id(900)}`,
    ]);
    await h.worker.handle(h.job({ n: 906 }));
    expect(await h.quotas.quotaUsed(user!.key, hour)).toBe(2);
  });

  it("charges nothing when another job holds the thread's turn", async () => {
    const thread = {
      applicationId: APPLICATION,
      channelId: id(702),
      guildId: GUILD,
      parentId: CHANNEL,
      thread: id(702),
    };
    await h.store.claimTurn(
      `${APPLICATION}:${GUILD}:${CHANNEL}:${id(702)}`,
      `${id(1)}:other`,
      new Date(h.clock.now() + 60_000),
      new Date(h.clock.now()),
    );
    await h.worker.handle(
      h.job({ key: thread, n: 907, threadFromOriginal: false }),
    );
    expect(h.port.bodies("followUp").at(-1)?.content).toBe(WORDS.busy);
    const [user] = quotaEntries(DEFAULT_QUOTAS, {
      applicationId: "deployment-1",
      externalUserId: ALICE,
      installation: `${APPLICATION}:${GUILD}`,
    });
    expect(
      await h.quotas.quotaUsed(user!.key, windowOf(new Date(h.clock.now()))),
    ).toBe(0);
  });

  it("drops a job past the token's 15 minutes without touching its token, which the queue may have dropped (§5)", async () => {
    const job = h.job();
    h.clock.advance(15 * 60 * 1000);
    const { token: _dropped, ...withoutToken } = job;
    void _dropped;
    await h.worker.handle(withoutToken);
    await h.worker.handle(job);
    expect(h.port.calls).toEqual([]);
    expect(h.agent.started).toEqual([]);
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

  it("ends an answer with Open in Datalayer, whose press makes the asker's own one-use link to that session, answered only to them (DC-305)", async () => {
    await h.worker.handle(h.job());
    const last = h.port.bodies("editOriginal").at(-1)!;
    const button = (
      last.components?.[0] as
        | { components: Array<{ custom_id: string; label: string }> }
        | undefined
    )?.components[0];
    expect(button?.label).toBe("Open in Datalayer");
    expect(button?.custom_id).toMatch(/^dc:open:/);
    const renderId = button!.custom_id.split(":")[2]!;
    const press = (n: number, userId = ALICE) =>
      h.job({
        command: undefined,
        component: { kind: "open", renderId },
        ephemeral: true,
        n,
        type: 3,
        userId,
      });
    await h.worker.handle(press(960));
    expect(h.hosts.handoffs).toEqual([
      { kind: "session", target: h.agent.targets[0]!.sessionId, user: ALICE },
    ]);
    const answer = h.port.bodies("editOriginal").at(-1)!;
    expect(answer.flags).toBe(EPHEMERAL);
    expect(answer.content).toContain(
      "https://datalayer.ai/hosts/open?code=dlho_test_1",
    );
    // Someone else's press makes nothing; an unlinked asker is told to link.
    h.hosts.links.set(BOB, "principal-bob");
    await h.worker.handle(press(961, BOB));
    expect(h.port.bodies("editOriginal").at(-1)?.content).toBe(
      WORDS.openNotYours,
    );
    h.hosts.links.delete(ALICE);
    await h.worker.handle(press(962));
    expect(h.port.bodies("editOriginal").at(-1)?.content).toBe(WORDS.notLinked);
    expect(h.hosts.handoffs).toHaveLength(1);

    // An approval's button (DC-302's card) opens the approval, for its owner.
    h.hosts.links.set(ALICE, "principal-alice");
    await h.store.saveComponent({
      applicationId: APPLICATION,
      guildId: GUILD,
      kind: "open",
      ownerId: ALICE,
      payload: {
        applicationId: "deployment-1",
        kind: "approval",
        target: "ap-1",
      },
      renderId: "render-approval-1",
    });
    await h.worker.handle(
      h.job({
        command: undefined,
        component: { kind: "open", renderId: "render-approval-1" },
        ephemeral: true,
        n: 963,
        type: 3,
      }),
    );
    expect(h.hosts.handoffs.at(-1)).toEqual({
      kind: "approval",
      target: "ap-1",
      user: ALICE,
    });
  });

  it("puts Open in Datalayer on the private follow-up of a secret-bearing answer too", async () => {
    h.agent.script = [
      { kind: "text", text: `Your key is dlhk_${"q".repeat(20)} ` },
      { kind: "completion" },
    ];
    await h.worker.handle(h.job());
    const follow = h.port.bodies("followUp")[0]!;
    expect(follow.flags).toBe(EPHEMERAL);
    expect(JSON.stringify(follow.components)).toContain("Open in Datalayer");
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

/** A worker over a real `HttpDiscordPort` and a real `HttpAgentClient`, on fetch fakes. */
function wired(answer: (method: string, url: string) => Response | undefined) {
  const clock = new FakeClock();
  const cipher = testCipher();
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImplementation = (async (
    input: string | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) as unknown }
        : {}),
    });
    const answered = answer(method, url);
    if (!answered) throw new Error(`unexpected ${method} ${url}`);
    return answered;
  }) as typeof fetch;
  const API = "https://r1.datalayer.run";
  const hostKeyFor = async () => "dlhk_test_key";
  const agent = new HttpAgentClient<DiscordTurn>(
    API,
    new HostKeyCredentials<DiscordTurn>(
      API,
      hostKeyFor,
      discordShape,
      fetchImplementation,
    ),
    discordShape,
    fetchImplementation,
    hostKeyFor,
  );
  const limiter = new DiscordRateLimiter(clock);
  const port = new HttpDiscordPort(
    {
      applicationId: APPLICATION,
      botToken: "test-only",
      clientSecret: "test-only",
    },
    limiter,
    fetchImplementation,
  );
  const hosts = new FakeHosts();
  hosts.links.set(ALICE, "principal-alice");
  const store = new MemoryStore();
  const worker = new Worker({
    agent,
    applicationId: APPLICATION,
    asPerson: new FakeAsPerson(),
    cipher,
    clock,
    hosts: hosts.client,
    limits: DEFAULT_QUOTAS,
    logger: quietLogger(),
    openLink: (request, kind, target) => hosts.openLink(request, kind, target),
    port,
    quotas: new MemoryQuotaStore(),
    store,
    webUrl: "https://datalayer.ai",
  });
  const job = () => {
    return {
      appPermissions: "309237763136",
      command: { name: "ask", options: { question: "What changed?" } },
      ephemeral: false,
      id: id(900),
      key: {
        applicationId: APPLICATION,
        channelId: CHANNEL,
        guildId: GUILD,
        thread: "",
      },
      kind: "interaction" as const,
      receivedAt: clock.now(),
      threadFromOriginal: true,
      token: cipher.encrypt("interaction-token-for-tests", id(900)),
      type: 2,
      userId: ALICE,
      userName: "alice",
    };
  };
  return { API, calls, cipher, clock, job, limiter, store, worker };
}

const EXCHANGED = (API: string) => ({
  access_token: "host-token",
  deployment: {
    app_name: "Analyst",
    app_uid: "app-1",
    uid: "deployment-1",
    version: 1,
  },
  exp: 4102444800,
  expires_in: 900,
  host_uid: "host-1",
  principal_uid: "principal-alice",
  session_api: { agent: "agent-1", url: `${API}/rt-1/api/v1/apps/sessions` },
  success: true,
  token_type: "Bearer",
});

const STREAM = (session: string, ...texts: string[]) =>
  new Response(
    [
      { name: "loop.session", type: "CUSTOM", value: { uid: session } },
      {
        name: "loop.turn",
        type: "CUSTOM",
        value: { replayed: false, session, state: "running", turn: "t1" },
      },
      ...texts.map((delta) => ({ delta, type: "TEXT_MESSAGE_CONTENT" })),
      { type: "RUN_FINISHED" },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

describe("/ask through the real clients (DC-105)", () => {
  it("PUTs the channel's message as the target, then the thread once it is started", async () => {
    const original = id(500);
    const session = sessionUidOf({
      applicationId: APPLICATION,
      channelId: CHANNEL,
      guildId: GUILD,
      thread: original,
    });
    const w = wired((method, url) => {
      if (url.endsWith("/messages/@original") && method === "GET")
        return Response.json({ channel_id: CHANNEL, id: original });
      if (url.endsWith("/messages/@original") && method === "PATCH")
        return Response.json({ channel_id: CHANNEL, id: original });
      if (url.endsWith("/apps/hosts/self/token"))
        return Response.json(EXCHANGED("https://r1.datalayer.run"));
      if (url.endsWith("/rt-1/api/v1/apps/sessions"))
        return STREAM(session, "Option B ", "is safer.");
      if (url.endsWith(`/apps/hosts/sessions/${session}`) && method === "PUT")
        return Response.json({ success: true });
      if (url.endsWith(`/messages/${original}/threads`))
        return Response.json({ id: original });
      return undefined;
    });
    await w.store.saveInstallation(installation(w.cipher));
    await w.worker.handle(w.job());
    const puts = w.calls.filter((call) => call.method === "PUT");
    expect(puts.map((call) => call.body)).toEqual([
      {
        target: {
          applicationId: APPLICATION,
          channelId: CHANNEL,
          guildId: GUILD,
          messageId: original,
          userId: ALICE,
        },
      },
      {
        target: {
          applicationId: APPLICATION,
          channelId: CHANNEL,
          guildId: GUILD,
          messageId: original,
          threadId: original,
          userId: ALICE,
        },
      },
    ]);
    const order = w.calls.map((call) => `${call.method} ${call.url}`);
    expect(
      order.findIndex((one) => one.endsWith(`/messages/${original}/threads`)),
    ).toBeLessThan(order.lastIndexOf(puts[1] ? `PUT ${puts[1].url}` : ""));
  });

  it("honours a 429 on an edit during a turn: waits retry_after, counts it, and the answer still arrives", async () => {
    const original = id(500);
    const session = sessionUidOf({
      applicationId: APPLICATION,
      channelId: CHANNEL,
      guildId: GUILD,
      thread: original,
    });
    let patches = 0;
    const w = wired((method, url) => {
      if (url.endsWith("/messages/@original") && method === "GET")
        return Response.json({ channel_id: CHANNEL, id: original });
      if (url.endsWith("/messages/@original") && method === "PATCH") {
        patches += 1;
        if (patches === 1)
          return new Response(
            JSON.stringify({ global: false, retry_after: 1.25 }),
            { headers: { "x-ratelimit-scope": "user" }, status: 429 },
          );
        return Response.json({ channel_id: CHANNEL, id: original });
      }
      if (url.endsWith("/apps/hosts/self/token"))
        return Response.json(EXCHANGED("https://r1.datalayer.run"));
      if (url.endsWith("/rt-1/api/v1/apps/sessions"))
        return STREAM(session, "Option B ", "is safer.");
      if (url.endsWith(`/apps/hosts/sessions/${session}`))
        return Response.json({ success: true });
      if (url.endsWith(`/messages/${original}/threads`))
        return Response.json({ id: original });
      return undefined;
    });
    await w.store.saveInstallation(installation(w.cipher));
    const start = w.clock.now();
    await w.worker.handle(w.job());
    expect(w.limiter.limited.user).toBe(1);
    expect(w.limiter.invalidRequests()).toBe(1);
    expect(w.clock.now() - start).toBeGreaterThanOrEqual(1250);
    const edits = w.calls.filter(
      (call) => call.method === "PATCH" && call.url.endsWith("@original"),
    );
    // The refused edit was sent again, then the final answer.
    expect(edits.length).toBeGreaterThanOrEqual(3);
    expect(
      (edits.at(-1)?.body as { content?: string } | undefined)?.content,
    ).toContain("Option B is safer.");
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
