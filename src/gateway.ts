import type { Logger } from "@datalayer/agent-runtimes/lib/portable/hosts";
import pg from "pg";

/**
 * The gateway role (DC-201): one connection to Discord's gateway for the
 * application, held by the replica that owns the leader lock. It identifies
 * with three non-privileged intents only (GUILDS, GUILD_MESSAGES,
 * DIRECT_MESSAGES: no MESSAGE_CONTENT), heartbeats on Discord's interval
 * and reconnects when an ACK is missed, resumes a session it can resume and
 * identifies again when Discord says it cannot, spends identifies within
 * the budget `GET /gateway/bot` answers, and lets through only the messages
 * @Datalayer answers: a mention of the bot (a reply to its message with the
 * ping on is one) and a direct message, never a bot's or a webhook's. Each
 * kept message is claimed and queued once by its id; the worker answers it.
 */

/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES: no privileged intent. */
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 12);

const OP = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  resume: 6,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
  heartbeatAck: 11,
} as const;

/** Close codes after which the connection is never retried: a wrong token, intents or shard. */
export const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** Close codes after which the session cannot be resumed: identify again. */
const FRESH_CLOSE_CODES = new Set([4007, 4009]);
/** What the service closes with when it means to resume (never 1000/1001, which end the session). */
export const RESUME_CLOSE = 4900;

/** A socket as the gateway uses it; `WebSocket` in production, a fake in tests. */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number): void;
}

export type SocketEvents = Readonly<{
  message(data: string): void;
  close(code: number): void;
}>;

export type SocketFactory = (url: string, on: SocketEvents) => GatewaySocket;

/** The one leader: PostgreSQL's advisory lock in production. */
export interface LeaderLock {
  /** Take the lock if free: whether this replica now leads. */
  acquire(): Promise<boolean>;
  /** Whether it is still held (the lock's connection alive). */
  held(): Promise<boolean>;
  release(): Promise<void>;
}

/** Timers, injected so tests drive time by hand. */
export interface GatewayTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

/** What `GET /gateway/bot` answers: the address and the identify budget. */
export type GatewayBot = Readonly<{
  url: string;
  session_start_limit: Readonly<{
    remaining: number;
    reset_after: number;
    max_concurrency: number;
  }>;
}>;

/** A message the gateway keeps, as the worker reads it. */
export type MessageJob = Readonly<{
  kind: "message";
  id: string;
  applicationId: string;
  guildId?: string;
  channelId: string;
  authorId: string;
  authorName: string;
  /** Empty without MESSAGE_CONTENT, but for a mention and a direct message. */
  content: string;
  /** Whether it mentions the bot (a reply to its message with the ping on does). */
  mentioned: boolean;
  /** The message replied to, when it is one. */
  reference?: Readonly<{ messageId: string; authorId?: string }>;
  receivedAt: number;
}>;

type Author = { id: string; username?: string; bot?: boolean };
export type GatewayMessage = Readonly<{
  id: string;
  channel_id: string;
  guild_id?: string;
  author: Author;
  content?: string;
  type?: number;
  webhook_id?: string;
  mentions?: ReadonlyArray<{ id: string }>;
  message_reference?: Readonly<{ message_id?: string }>;
  referenced_message?: Readonly<{ id: string; author?: Author }> | null;
}>;

/** Message types a person writes: a message and a reply. */
const PERSON_TYPES = new Set([0, 19]);

/** Whether a message mentions the bot. */
export function mentions(message: GatewayMessage, botId: string): boolean {
  return (message.mentions ?? []).some((one) => one.id === botId);
}

/**
 * Whether @Datalayer answers a message: a person's (no bot, no webhook,
 * no system message) direct message, a server message that mentions the
 * bot — a reply to one of its messages with the ping on mentions it — or a
 * reply to one of its messages with the ping off, which is told once that a
 * mention is what reaches it.
 */
export function answers(message: GatewayMessage, botId: string): boolean {
  if (message.author.bot || message.webhook_id) return false;
  if (!PERSON_TYPES.has(message.type ?? 0)) return false;
  if (!message.guild_id) return true;
  return (
    mentions(message, botId) || message.referenced_message?.author?.id === botId
  );
}

/** The job a kept message becomes. */
export function messageJob(
  message: GatewayMessage,
  applicationId: string,
  receivedAt: number,
  botId: string,
): MessageJob {
  const replied = message.referenced_message;
  return {
    applicationId,
    authorId: message.author.id,
    authorName: message.author.username ?? "",
    channelId: message.channel_id,
    content: message.content ?? "",
    id: message.id,
    kind: "message",
    mentioned: mentions(message, botId),
    receivedAt,
    ...(message.guild_id ? { guildId: message.guild_id } : {}),
    ...(message.message_reference?.message_id
      ? {
          reference: {
            messageId: message.message_reference.message_id,
            ...(replied?.author?.id ? { authorId: replied.author.id } : {}),
          },
        }
      : {}),
  };
}

export type GatewayDependencies = Readonly<{
  token: string;
  applicationId: string;
  socket: SocketFactory;
  bot: () => Promise<GatewayBot>;
  lock: LeaderLock;
  timers: GatewayTimers;
  /** Claim and queue a kept message once, by its id: whether it was new. */
  enqueue: (job: MessageJob, idempotencyKey: string) => Promise<boolean>;
  logger: Logger;
  /** 0 ≤ jitter < 1, for the first heartbeat and the invalid-session wait. */
  random?: () => number;
  /** How often the lock is checked while leading. */
  lockCheckMs?: number;
  /** How long a replica that does not lead waits before trying again. */
  followerRetryMs?: number;
}>;

type Session = { id: string; resumeUrl: string; seq: number | null };

/**
 * One gateway connection, while this replica leads. `start` returns at once;
 * `stop` closes the connection and releases the lock.
 */
export class Gateway {
  #socket: GatewaySocket | undefined;
  #session: Session | undefined;
  #seq: number | null = null;
  #heartbeat: unknown;
  #lockTimer: unknown;
  #retry: unknown;
  #acked = true;
  #botId = "";
  #leading = false;
  #stopped = false;
  #fatal = false;
  /** The connection's generation: a stale socket's events are ignored. */
  #generation = 0;

  constructor(readonly deps: GatewayDependencies) {}

  /** Whether this replica holds the lock and a connection. */
  get leading(): boolean {
    return this.#leading;
  }

  /** The session Discord gave, for a resume (none after an invalid session). */
  get session(): Readonly<Session> | undefined {
    return this.#session;
  }

  start(): void {
    void this.#lead();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#close(1000);
    this.deps.timers.clear(this.#retry);
    this.deps.timers.clear(this.#lockTimer);
    if (this.#leading) await this.deps.lock.release();
    this.#leading = false;
  }

  async #lead(): Promise<void> {
    if (this.#stopped || this.#fatal) return;
    const { lock, timers, logger } = this.deps;
    let taken = false;
    try {
      taken = await lock.acquire();
    } catch (error) {
      logger.warn("gateway.lock_unavailable", { error });
    }
    if (!taken) {
      this.#retry = timers.set(
        () => void this.#lead(),
        this.deps.followerRetryMs ?? 15_000,
      );
      return;
    }
    this.#leading = true;
    logger.info("gateway.leading", {});
    this.#watchLock();
    await this.#connect(false);
  }

  /** While leading, the lock is checked; lost, the connection closes at once. */
  #watchLock(): void {
    const { lock, timers, logger } = this.deps;
    this.#lockTimer = timers.set(() => {
      void (async () => {
        let held = false;
        try {
          held = await lock.held();
        } catch {
          held = false;
        }
        if (!held) {
          logger.warn("gateway.lock_lost", {});
          this.#leading = false;
          this.#close(1000);
          this.#session = undefined;
          await lock.release().catch(() => undefined);
          void this.#lead();
          return;
        }
        if (this.#leading) this.#watchLock();
      })();
    }, this.deps.lockCheckMs ?? 10_000);
  }

  async #connect(resume: boolean): Promise<void> {
    if (this.#stopped || !this.#leading) return;
    const { timers, logger } = this.deps;
    let url: string;
    if (resume && this.#session) url = this.#session.resumeUrl;
    else {
      this.#session = undefined;
      // The identify budget: never identify with none left.
      let bot: GatewayBot;
      try {
        bot = await this.deps.bot();
      } catch (error) {
        logger.warn("gateway.bot_unread", { error });
        this.#retry = timers.set(() => void this.#connect(false), 5_000);
        return;
      }
      if (bot.session_start_limit.remaining < 1) {
        logger.warn("gateway.identify_budget_spent", {
          reason: String(bot.session_start_limit.reset_after),
        });
        this.#retry = timers.set(
          () => void this.#connect(false),
          bot.session_start_limit.reset_after,
        );
        return;
      }
      url = bot.url;
    }
    const generation = (this.#generation += 1);
    this.#acked = true;
    this.#socket = this.deps.socket(`${url}/?v=10&encoding=json`, {
      close: (code) => {
        if (generation === this.#generation) this.#closed(code);
      },
      message: (data) => {
        if (generation === this.#generation) void this.#receive(data, resume);
      },
    });
  }

  #send(op: number, d: unknown): void {
    this.#socket?.send(JSON.stringify({ d, op }));
  }

  #close(code: number): void {
    this.deps.timers.clear(this.#heartbeat);
    const socket = this.#socket;
    this.#socket = undefined;
    this.#generation += 1;
    socket?.close(code);
  }

  /** Closed by Discord (or the network): retried, resumed when it can be. */
  #closed(code: number): void {
    const { logger, timers } = this.deps;
    timers.clear(this.#heartbeat);
    this.#socket = undefined;
    if (FATAL_CLOSE_CODES.has(code)) {
      this.#fatal = true;
      logger.error("gateway.refused", { reason: String(code) });
      return;
    }
    if (FRESH_CLOSE_CODES.has(code)) this.#session = undefined;
    logger.warn("gateway.closed", { reason: String(code) });
    this.#retry = timers.set(
      () => void this.#connect(Boolean(this.#session)),
      1_000,
    );
  }

  /** Reconnect now, resuming the session when there is one. */
  #reconnect(): void {
    this.#close(RESUME_CLOSE);
    void this.#connect(Boolean(this.#session));
  }

  async #receive(data: string, resuming: boolean): Promise<void> {
    const { timers, logger } = this.deps;
    let payload: { op: number; d: unknown; s?: number | null; t?: string };
    try {
      payload = JSON.parse(data) as typeof payload;
    } catch {
      logger.warn("gateway.unreadable", {});
      return;
    }
    if (typeof payload.s === "number") {
      this.#seq = payload.s;
      if (this.#session) this.#session.seq = payload.s;
    }
    switch (payload.op) {
      case OP.hello: {
        const interval = (payload.d as { heartbeat_interval: number })
          .heartbeat_interval;
        this.#beat(interval, interval * (this.deps.random ?? Math.random)());
        if (resuming && this.#session)
          this.#send(OP.resume, {
            seq: this.#session.seq,
            session_id: this.#session.id,
            token: this.deps.token,
          });
        else
          this.#send(OP.identify, {
            intents: INTENTS,
            properties: {
              browser: "datalayer",
              device: "datalayer",
              os: "linux",
            },
            token: this.deps.token,
          });
        return;
      }
      case OP.heartbeatAck:
        this.#acked = true;
        return;
      case OP.heartbeat:
        this.#send(OP.heartbeat, this.#seq);
        return;
      case OP.reconnect:
        logger.info("gateway.reconnect_asked", {});
        this.#reconnect();
        return;
      case OP.invalidSession: {
        const resumable = payload.d === true;
        if (!resumable) this.#session = undefined;
        logger.warn("gateway.invalid_session", {
          reason: resumable ? "resumable" : "identify again",
        });
        this.#close(RESUME_CLOSE);
        // Discord asks for one to five seconds before identifying again.
        this.#retry = timers.set(
          () => void this.#connect(resumable),
          1_000 + Math.floor((this.deps.random ?? Math.random)() * 4_000),
        );
        return;
      }
      case OP.dispatch:
        return this.#dispatch(payload.t ?? "", payload.d);
      default:
        return;
    }
  }

  async #dispatch(type: string, d: unknown): Promise<void> {
    const { logger } = this.deps;
    if (type === "READY") {
      const ready = d as {
        session_id: string;
        resume_gateway_url: string;
        user: { id: string };
      };
      this.#botId = ready.user.id;
      this.#session = {
        id: ready.session_id,
        resumeUrl: ready.resume_gateway_url,
        seq: this.#seq,
      };
      logger.info("gateway.ready", {});
      return;
    }
    if (type === "RESUMED") {
      logger.info("gateway.resumed", {});
      return;
    }
    if (type !== "MESSAGE_CREATE") return;
    const message = d as GatewayMessage;
    if (!this.#botId || !answers(message, this.#botId)) return;
    try {
      await this.deps.enqueue(
        messageJob(
          message,
          this.deps.applicationId,
          this.deps.timers.now(),
          this.#botId,
        ),
        `message:${message.id}`,
      );
    } catch (error) {
      // Not kept: the person is not answered; the next mention is.
      logger.error("gateway.not_enqueued", { error });
    }
  }

  /** Heartbeats on Discord's interval; a beat whose ACK never came reconnects. */
  #beat(interval: number, first: number): void {
    const { timers, logger } = this.deps;
    this.#heartbeat = timers.set(() => {
      if (!this.#acked) {
        logger.warn("gateway.ack_missed", {});
        this.#reconnect();
        return;
      }
      this.#acked = false;
      this.#send(OP.heartbeat, this.#seq);
      this.#beat(interval, interval);
    }, first);
  }
}

/** `GET /gateway/bot` with the bot token: the address and the identify budget. */
export function gatewayBot(token: string): () => Promise<GatewayBot> {
  return async () => {
    const response = await fetch("https://discord.com/api/v10/gateway/bot", {
      headers: { authorization: `Bot ${token}` },
    });
    if (!response.ok)
      throw new Error(`Discord answered ${response.status} to gateway/bot`);
    return (await response.json()) as GatewayBot;
  };
}

/** The socket over Node's `WebSocket` (Node 22). */
export const webSocket: SocketFactory = (url, on) => {
  type Native = {
    addEventListener(
      type: "message" | "close",
      listener: (event: { data?: unknown; code?: number }) => void,
    ): void;
    send(data: string): void;
    close(code?: number): void;
  };
  const Native = (globalThis as { WebSocket?: new (url: string) => Native })
    .WebSocket;
  if (!Native) throw new Error("The gateway role needs Node 22's WebSocket.");
  const socket = new Native(url);
  socket.addEventListener("message", (event) =>
    on.message(typeof event.data === "string" ? event.data : ""),
  );
  socket.addEventListener("close", (event) => on.close(event.code ?? 1006));
  return {
    close: (code) => socket.close(code),
    send: (data) => socket.send(data),
  };
};

/** Node's timers. */
export const systemTimers: GatewayTimers = {
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
  now: () => Date.now(),
  set: (run, ms) => setTimeout(run, ms),
};

/**
 * The leader lock: a session-level advisory lock on a connection of its
 * own. Held while that connection lives; a lost connection is a lost lock,
 * which another replica then takes.
 */
export class PostgresLeaderLock implements LeaderLock {
  #client: pg.Client | undefined;
  #alive = false;

  constructor(
    readonly connectionString: string,
    readonly key: string,
  ) {}

  async acquire(): Promise<boolean> {
    if (this.#client && this.#alive) return true;
    const client = new pg.Client({
      application_name: "datalayer-discord-gateway",
      connectionString: this.connectionString,
    });
    client.on("error", () => {
      this.#alive = false;
    });
    client.on("end", () => {
      this.#alive = false;
    });
    await client.connect();
    const { rows } = await client.query<{ taken: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS taken",
      [this.key],
    );
    if (!rows[0]?.taken) {
      await client.end();
      return false;
    }
    this.#client = client;
    this.#alive = true;
    return true;
  }

  async held(): Promise<boolean> {
    if (!this.#client || !this.#alive) return false;
    try {
      await this.#client.query("SELECT 1");
      return this.#alive;
    } catch {
      return false;
    }
  }

  async release(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    this.#alive = false;
    if (client) await client.end().catch(() => undefined);
  }
}
