import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import {
  answers,
  Gateway,
  INTENTS,
  PostgresLeaderLock,
  RESUME_CLOSE,
  type GatewayBot,
  type GatewayMessage,
  type GatewaySession,
  type GatewayTimers,
  type LeaderLock,
  type MessageJob,
  type SocketEvents,
} from "../../src/gateway.js";
import {
  ALICE,
  APPLICATION,
  CHANNEL,
  GUILD,
  id,
  quietLogger,
} from "../support/discord.js";

/**
 * The gateway role on fixtures (DC-201): Hello and the heartbeat, a missed
 * ACK reconnecting and resuming, Discord's reconnect, a resumable and a
 * non-resumable invalid session, the identify budget, a fatal close, a lost
 * leader lock, and the message filter with its claim and queue. A fake
 * socket stands for Discord's gateway; time moves by hand.
 */

const BOT = id(99);
const TOKEN = "bot-token-for-tests";

/** Timers run by hand: `advance` fires every timer due, in order. */
class Clock implements GatewayTimers {
  at = 0;
  #next = 0;
  readonly #timers = new Map<number, { due: number; run: () => void }>();
  set(run: () => void, ms: number): unknown {
    const handle = (this.#next += 1);
    this.#timers.set(handle, { due: this.at + ms, run });
    return handle;
  }
  clear(handle: unknown): void {
    this.#timers.delete(handle as number);
  }
  now(): number {
    return this.at;
  }
  async advance(ms: number): Promise<void> {
    const end = this.at + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, one]) => one.due <= end)
        .sort(([, a], [, b]) => a.due - b.due)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.at = due[1].due;
      due[1].run();
      await settle();
    }
    this.at = end;
    await settle();
  }
}

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

class FakeSocket {
  readonly sent: Array<{ op: number; d: unknown }> = [];
  closedWith?: number;
  constructor(
    readonly url: string,
    readonly on: SocketEvents,
  ) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data) as { op: number; d: unknown });
  }
  close(code?: number): void {
    this.closedWith = code;
  }
  /** Discord sends. */
  async receive(op: number, d: unknown, s?: number, t?: string) {
    this.on.message(JSON.stringify({ d, op, s: s ?? null, t: t ?? null }));
    await settle();
  }
  ops(): number[] {
    return this.sent.map((one) => one.op);
  }
}

class Lock implements LeaderLock {
  free = true;
  mine = false;
  acquired = 0;
  async acquire() {
    if (!this.free && !this.mine) return false;
    this.free = false;
    this.mine = true;
    this.acquired += 1;
    return true;
  }
  async held() {
    return this.mine;
  }
  async release() {
    // Only a holder frees it: a lost lock is someone else's now.
    if (this.mine) this.free = true;
    this.mine = false;
  }
}

const message = (overrides: Partial<GatewayMessage> = {}): GatewayMessage => ({
  author: { id: ALICE, username: "alice" },
  channel_id: CHANNEL,
  content: `<@${BOT}> what changed?`,
  guild_id: GUILD,
  id: id(700),
  mentions: [{ id: BOT }],
  type: 0,
  ...overrides,
});

describe("the gateway role (DC-201)", () => {
  let clock: Clock;
  let sockets: FakeSocket[];
  let lock: Lock;
  let queued: Array<{ job: MessageJob; key: string }>;
  let claimed: Set<string>;
  let bot: GatewayBot;
  let botReads: number;
  let lines: string[];
  let gateway: Gateway;

  beforeEach(() => {
    clock = new Clock();
    sockets = [];
    lock = new Lock();
    queued = [];
    claimed = new Set();
    botReads = 0;
    lines = [];
    bot = {
      session_start_limit: {
        max_concurrency: 1,
        remaining: 900,
        reset_after: 60_000,
      },
      url: "wss://gateway.discord.gg",
    };
    gateway = new Gateway({
      applicationId: APPLICATION,
      bot: async () => {
        botReads += 1;
        return bot;
      },
      enqueue: async (job, key) => {
        if (claimed.has(key)) return false;
        claimed.add(key);
        queued.push({ job, key });
        return true;
      },
      lock,
      lockCheckMs: 10_000,
      logger: quietLogger(lines),
      random: () => 0.5,
      socket: (url, on) => {
        const socket = new FakeSocket(url, on);
        sockets.push(socket);
        return socket;
      },
      timers: clock,
      token: TOKEN,
    });
  });

  const current = () => sockets.at(-1)!;

  /** Start, Hello, identify, READY: a live session. */
  async function ready(): Promise<FakeSocket> {
    gateway.start();
    await settle();
    const socket = current();
    await socket.receive(10, { heartbeat_interval: 40_000 });
    await socket.receive(
      0,
      {
        resume_gateway_url: "wss://resume.discord.gg",
        session_id: "session-1",
        user: { id: BOT },
      },
      1,
      "READY",
    );
    return socket;
  }

  it("identifies on Hello with the three non-privileged intents only, and heartbeats on the interval", async () => {
    const socket = await ready();
    expect(socket.url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    const identify = socket.sent[0]!;
    expect(identify.op).toBe(2);
    expect(identify.d).toMatchObject({ intents: INTENTS, token: TOKEN });
    expect(INTENTS).toBe(1 + 512 + 4096);
    // No MESSAGE_CONTENT (1 << 15), no GUILD_MEMBERS (1 << 1), no GUILD_PRESENCES (1 << 8).
    for (const privileged of [1, 8, 15])
      expect(INTENTS & (1 << privileged)).toBe(0);
    // The first beat after interval × jitter, carrying the last sequence.
    await clock.advance(19_999);
    expect(socket.ops()).toEqual([2]);
    await clock.advance(1);
    expect(socket.sent.at(-1)).toEqual({ d: 1, op: 1 });
    await socket.receive(11, null);
    await clock.advance(40_000);
    expect(socket.ops()).toEqual([2, 1, 1]);
    // Discord asking for a beat gets one at once.
    await socket.receive(1, null);
    expect(socket.ops()).toEqual([2, 1, 1, 1]);
    expect(gateway.leading).toBe(true);
    expect(lock.acquired).toBe(1);
  });

  it("reconnects when an ACK is missed and resumes the session on the resume address", async () => {
    const socket = await ready();
    await clock.advance(20_000);
    // No ACK for that beat: the next beat's time reconnects instead.
    await clock.advance(40_000);
    expect(socket.closedWith).toBe(RESUME_CLOSE);
    const next = current();
    expect(next).not.toBe(socket);
    expect(next.url).toBe("wss://resume.discord.gg/?v=10&encoding=json");
    await next.receive(10, { heartbeat_interval: 40_000 });
    expect(next.sent[0]).toEqual({
      d: { seq: 1, session_id: "session-1", token: TOKEN },
      op: 6,
    });
    await next.receive(0, {}, 2, "RESUMED");
    // A resume spends no identify.
    expect(botReads).toBe(1);
    expect(lines.join("\n")).toContain("gateway.ack_missed");
  });

  it("reconnects and resumes when Discord asks, and when the connection drops", async () => {
    const socket = await ready();
    await socket.receive(7, null);
    expect(socket.closedWith).toBe(RESUME_CLOSE);
    const second = current();
    await second.receive(10, { heartbeat_interval: 40_000 });
    expect(second.ops()).toEqual([6]);
    // A drop (1006): resumed after a second.
    second.on.close(1006);
    await clock.advance(1_000);
    const third = current();
    expect(third).not.toBe(second);
    await third.receive(10, { heartbeat_interval: 40_000 });
    expect(third.ops()).toEqual([6]);
    expect(botReads).toBe(1);
  });

  it("resumes after a resumable invalid session, and identifies again after one that is not", async () => {
    const socket = await ready();
    await socket.receive(9, true);
    await clock.advance(3_000);
    const resumed = current();
    expect(resumed).not.toBe(socket);
    await resumed.receive(10, { heartbeat_interval: 40_000 });
    expect(resumed.ops()).toEqual([6]);

    await resumed.receive(9, false);
    expect(gateway.session).toBeUndefined();
    // Between one and five seconds.
    await clock.advance(999);
    expect(current()).toBe(resumed);
    await clock.advance(2_001);
    const fresh = current();
    expect(fresh).not.toBe(resumed);
    expect(fresh.url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    await fresh.receive(10, { heartbeat_interval: 40_000 });
    expect(fresh.ops()).toEqual([2]);
    expect(botReads).toBe(2);
  });

  it("waits out a spent identify budget, and never retries a fatal close", async () => {
    bot = {
      ...bot,
      session_start_limit: {
        max_concurrency: 1,
        remaining: 0,
        reset_after: 30_000,
      },
    };
    gateway.start();
    await settle();
    expect(sockets).toHaveLength(0);
    expect(lines.join("\n")).toContain("gateway.identify_budget_spent");
    bot = {
      ...bot,
      session_start_limit: { max_concurrency: 1, remaining: 5, reset_after: 0 },
    };
    await clock.advance(30_000);
    expect(sockets).toHaveLength(1);
    const socket = current();
    await socket.receive(10, { heartbeat_interval: 40_000 });
    // 4014: a disallowed intent. Never retried.
    socket.on.close(4014);
    await clock.advance(120_000);
    expect(sockets).toHaveLength(1);
    expect(lines.join("\n")).toContain("gateway.refused");
  });

  it("closes the connection at once when the leader lock is lost, and leads again only once it is taken", async () => {
    const socket = await ready();
    lock.mine = false;
    lock.free = false;
    await clock.advance(10_000);
    expect(socket.closedWith).toBe(1000);
    expect(gateway.leading).toBe(false);
    expect(lines.join("\n")).toContain("gateway.lock_lost");
    // Another replica holds it: no connection here.
    lock.free = false;
    await clock.advance(30_000);
    expect(sockets).toHaveLength(1);
    // Free again: this one leads, with a new identify.
    lock.free = true;
    await clock.advance(15_000);
    expect(gateway.leading).toBe(true);
    expect(sockets).toHaveLength(2);
    await current().receive(10, { heartbeat_interval: 40_000 });
    expect(current().ops()).toEqual([2]);
  });

  it("leaves its session to the next leader when it stops: closed resumable, kept with its sequence, and resumed by the replica that takes the lock", async () => {
    let kept: GatewaySession | undefined;
    const sessions = {
      load: async () => kept,
      save: async (session: GatewaySession | undefined) => {
        kept = session;
      },
    };
    const leader = new Gateway({ ...gateway.deps, sessions });
    leader.start();
    await settle();
    const socket = current();
    await socket.receive(10, { heartbeat_interval: 40_000 });
    await socket.receive(
      0,
      {
        resume_gateway_url: "wss://resume.discord.gg",
        session_id: "session-1",
        user: { id: BOT },
      },
      1,
      "READY",
    );
    await socket.receive(0, message(), 7, "MESSAGE_CREATE");
    // A rollout stops it: SIGTERM.
    await leader.stop();
    expect(socket.closedWith).toBe(RESUME_CLOSE);
    expect(kept).toEqual({
      id: "session-1",
      resumeUrl: "wss://resume.discord.gg",
      seq: 7,
    });
    expect(lock.free).toBe(true);

    // The next replica takes the lock and resumes that session.
    const next = new Gateway({ ...gateway.deps, sessions });
    next.start();
    await settle();
    const resumed = current();
    expect(resumed.url).toBe("wss://resume.discord.gg/?v=10&encoding=json");
    await resumed.receive(10, { heartbeat_interval: 40_000 });
    expect(resumed.sent[0]).toEqual({
      d: { seq: 7, session_id: "session-1", token: TOKEN },
      op: 6,
    });
    expect(kept).toBeUndefined();
    await resumed.receive(0, {}, 8, "RESUMED");
    // One identify in all: the session outlived the pod.
    expect(botReads).toBe(1);
    // Resumed without READY, it still knows the bot (the application's id).
    await resumed.receive(
      0,
      message({ id: id(790), mentions: [{ id: APPLICATION }] }),
      9,
      "MESSAGE_CREATE",
    );
    expect(queued.map((one) => one.key)).toContain(`message:${id(790)}`);
  });

  it("keeps a mention of the bot and a direct message, once each, and nothing else", async () => {
    const socket = await ready();
    const dispatch = (one: GatewayMessage, s: number) =>
      socket.receive(0, one, s, "MESSAGE_CREATE");
    await dispatch(message(), 2);
    // The same message again (a resume replays): queued once.
    await dispatch(message(), 3);
    // A direct message: no guild.
    await dispatch(
      message({ guild_id: undefined, id: id(701), mentions: [] }),
      4,
    );
    // A reply to the bot's message with the ping on mentions it.
    await dispatch(
      message({
        content: "",
        id: id(702),
        message_reference: { message_id: id(650) },
        referenced_message: { author: { bot: true, id: BOT }, id: id(650) },
        type: 19,
      }),
      5,
    );
    // A reply to its message with the ping off: kept, to be told once
    // that a mention reaches it.
    await dispatch(
      message({
        content: "",
        id: id(704),
        mentions: [],
        message_reference: { message_id: id(650) },
        referenced_message: { author: { bot: true, id: BOT }, id: id(650) },
        type: 19,
      }),
      7,
    );
    // Ignored: a plain message, a reply to someone else, a bot, a
    // webhook, a system message.
    await dispatch(message({ id: id(703), mentions: [] }), 6);
    await dispatch(
      message({
        id: id(708),
        mentions: [],
        message_reference: { message_id: id(651) },
        referenced_message: { author: { id: id(13) }, id: id(651) },
        type: 19,
      }),
      11,
    );
    await dispatch(
      message({ author: { bot: true, id: id(98) }, id: id(705) }),
      8,
    );
    await dispatch(message({ id: id(706), webhook_id: id(97) }), 9);
    await dispatch(message({ id: id(707), type: 7 }), 10);
    expect(queued.map((one) => one.key)).toEqual([
      `message:${id(700)}`,
      `message:${id(701)}`,
      `message:${id(702)}`,
      `message:${id(704)}`,
    ]);
    expect(queued.map((one) => one.job.mentioned)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(queued[0]!.job).toMatchObject({
      applicationId: APPLICATION,
      authorId: ALICE,
      channelId: CHANNEL,
      guildId: GUILD,
      kind: "message",
    });
    expect(queued[1]!.job.guildId).toBeUndefined();
    expect(queued[2]!.job.reference).toEqual({
      authorId: BOT,
      messageId: id(650),
    });
    // The sequence followed every dispatch: the next beat carries it.
    await clock.advance(20_000);
    expect(socket.sent.at(-1)).toEqual({ d: 10, op: 1 });
  });

  it("filters by the rule alone: a person's mention or direct message", () => {
    expect(answers(message(), BOT)).toBe(true);
    expect(answers(message({ mentions: [{ id: id(5) }] }), BOT)).toBe(false);
    expect(answers(message({ guild_id: undefined, mentions: [] }), BOT)).toBe(
      true,
    );
    expect(answers(message({ author: { bot: true, id: BOT } }), BOT)).toBe(
      false,
    );
  });
});

const DATABASE_URL = process.env.DATALAYER_DISCORD_TEST_DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))(
  "the leader lock on PostgreSQL (DC-201)",
  () => {
    it("lets one replica lead; a lost connection loses the lock, which the other then takes", async () => {
      const key = `discord-gateway:test-${Date.now()}`;
      const one = new PostgresLeaderLock(DATABASE_URL!, key);
      const two = new PostgresLeaderLock(DATABASE_URL!, key);
      expect(await one.acquire()).toBe(true);
      expect(await two.acquire()).toBe(false);
      expect(await one.held()).toBe(true);
      // The leader's connection ends (a pod killed): its lock goes with it.
      const admin = new pg.Client({ connectionString: DATABASE_URL });
      await admin.connect();
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'datalayer-discord-gateway' AND pid <> pg_backend_pid()",
      );
      await admin.end();
      expect(await one.held()).toBe(false);
      expect(await two.acquire()).toBe(true);
      await one.release();
      await two.release();
    });
  },
);
