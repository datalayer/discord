import type { DiscordRateLimiter } from "./rate-limit.js";

/**
 * Discord's REST API as the service uses it:
 * the interaction's `@original` (read, edited, deleted), follow-ups, bot
 * messages and threads once the interaction token is spent, the bot's guild
 * list for the removal reconciliation, and the OAuth2 code exchange. The
 * worker speaks to this port only; tests give it a fake.
 */

/** A message as the service sends it: content, components, flags, mentions. */
export type MessageBody = Readonly<{
  content?: string;
  embeds?: readonly unknown[];
  components?: readonly unknown[];
  flags?: number;
  allowed_mentions: Readonly<{ parse: readonly string[]; users?: string[] }>;
  /** A reply to a message (a bot message answering a person's, DC-202). */
  message_reference?: Readonly<{
    message_id: string;
    fail_if_not_exists: boolean;
  }>;
}>;

/** A channel as the bot reads it: its type, and a thread's parent. */
export type ChannelView = Readonly<{
  id: string;
  type: number;
  parentId?: string;
}>;

export type SentMessage = Readonly<{ id: string; channelId: string }>;

/** What Discord refused: its status and its JSON error code. */
export class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    readonly route: string,
  ) {
    super(`Discord answered ${status} to ${route}${code ? ` (${code})` : ""}`);
  }

  /** The interaction token is spent or unknown: never used again. */
  get tokenGone(): boolean {
    return this.status === 404 || this.code === 50027;
  }

  /** The bot cannot reach the place: removed, or a permission is missing. */
  get noAccess(): boolean {
    return this.status === 403 || this.code === 10004 || this.code === 50001;
  }
}

/** What the bot authorization's token response says: the guild is read here. */
export type BotAuthorization = Readonly<{
  guild?: Readonly<{ id: string; name?: string }>;
  permissions?: string;
  scope: string;
  userId?: string;
}>;

export interface DiscordPort {
  original(token: string): Promise<SentMessage>;
  editOriginal(token: string, body: MessageBody): Promise<SentMessage>;
  deleteOriginal(token: string): Promise<void>;
  followUp(token: string, body: MessageBody): Promise<SentMessage>;
  createMessage(channelId: string, body: MessageBody): Promise<SentMessage>;
  editMessage(
    channelId: string,
    messageId: string,
    body: MessageBody,
  ): Promise<SentMessage>;
  /** A public thread from a message: its id is the message's (Discord's rule). */
  startThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<{ id: string }>;
  /** A server's name, as the bot sees it (the direct-message choice, DC-203). */
  guildName(guildId: string): Promise<string>;
  /** A channel's type and parent (a mention's place, DC-202). */
  channel(channelId: string): Promise<ChannelView>;
  /** The bot's own reaction on a message (⏳ while it answers). */
  addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<void>;
  removeReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<void>;
  /** One page of the bot's guilds, after a guild id: at most 200. */
  botGuilds(after?: string): Promise<Array<{ id: string }>>;
  /** The OAuth2 code exchange of an install. */
  authorize(code: string, redirectUri: string): Promise<BotAuthorization>;
}

const API = "https://discord.com/api/v10";

/** The REST port over `fetch`, bucket-aware through `DiscordRateLimiter`. */
export class HttpDiscordPort implements DiscordPort {
  constructor(
    readonly settings: Readonly<{
      applicationId: string;
      botToken: string;
      clientSecret: string;
    }>,
    readonly limiter: DiscordRateLimiter,
    readonly fetchImplementation: typeof fetch = fetch,
    /** How often one call is retried after a 429 before it fails. */
    readonly retries = 2,
  ) {}

  async #call<T>(
    method: string,
    path: string,
    route: string,
    init: { body?: unknown; bot?: boolean; form?: URLSearchParams } = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      await this.limiter.before(route);
      const headers: Record<string, string> = {};
      if (init.bot) headers.authorization = `Bot ${this.settings.botToken}`;
      if (init.body !== undefined) headers["content-type"] = "application/json";
      const response = await this.fetchImplementation(`${API}${path}`, {
        body:
          init.form ??
          (init.body === undefined ? undefined : JSON.stringify(init.body)),
        headers,
        method,
      });
      const text = await response.text();
      const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      const wait = this.limiter.after({
        headers: response.headers,
        route,
        status: response.status,
        ...(typeof json.retry_after === "number"
          ? { retryAfter: json.retry_after }
          : {}),
      });
      if (wait !== undefined && attempt < this.retries) {
        await this.limiter.clock.sleep(wait);
        continue;
      }
      if (!response.ok)
        throw new DiscordError(
          response.status,
          typeof json.code === "number" ? json.code : undefined,
          route,
        );
      return json as T;
    }
  }

  #webhook(token: string): string {
    return `/webhooks/${this.settings.applicationId}/${encodeURIComponent(token)}`;
  }

  async original(token: string) {
    const message = await this.#call<{ id: string; channel_id: string }>(
      "GET",
      `${this.#webhook(token)}/messages/@original`,
      "webhook:original",
    );
    return { channelId: message.channel_id, id: message.id };
  }

  async editOriginal(token: string, body: MessageBody) {
    const message = await this.#call<{ id: string; channel_id: string }>(
      "PATCH",
      `${this.#webhook(token)}/messages/@original`,
      "webhook:original",
      { body },
    );
    return { channelId: message.channel_id, id: message.id };
  }

  async deleteOriginal(token: string) {
    await this.#call(
      "DELETE",
      `${this.#webhook(token)}/messages/@original`,
      "webhook:original",
    );
  }

  async followUp(token: string, body: MessageBody) {
    const message = await this.#call<{ id: string; channel_id: string }>(
      "POST",
      `${this.#webhook(token)}?wait=true`,
      "webhook:follow-up",
      { body },
    );
    return { channelId: message.channel_id, id: message.id };
  }

  async createMessage(channelId: string, body: MessageBody) {
    const message = await this.#call<{ id: string; channel_id: string }>(
      "POST",
      `/channels/${channelId}/messages`,
      `channel:${channelId}:messages`,
      { body, bot: true },
    );
    return { channelId: message.channel_id, id: message.id };
  }

  async editMessage(channelId: string, messageId: string, body: MessageBody) {
    const message = await this.#call<{ id: string; channel_id: string }>(
      "PATCH",
      `/channels/${channelId}/messages/${messageId}`,
      `channel:${channelId}:messages`,
      { body, bot: true },
    );
    return { channelId: message.channel_id, id: message.id };
  }

  async startThread(channelId: string, messageId: string, name: string) {
    return this.#call<{ id: string }>(
      "POST",
      `/channels/${channelId}/messages/${messageId}/threads`,
      `channel:${channelId}:threads`,
      { body: { auto_archive_duration: 1440, name }, bot: true },
    );
  }

  async guildName(guildId: string) {
    const guild = await this.#call<{ name?: string }>(
      "GET",
      `/guilds/${guildId}`,
      `guild:${guildId}`,
      { bot: true },
    );
    return guild.name ?? guildId;
  }

  async channel(channelId: string) {
    const channel = await this.#call<{
      id: string;
      type: number;
      parent_id?: string | null;
    }>("GET", `/channels/${channelId}`, `channel:${channelId}`, { bot: true });
    return {
      id: channel.id,
      type: channel.type,
      ...(channel.parent_id ? { parentId: channel.parent_id } : {}),
    };
  }

  async addReaction(channelId: string, messageId: string, emoji: string) {
    await this.#call(
      "PUT",
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      `channel:${channelId}:reactions`,
      { bot: true },
    );
  }

  async removeReaction(channelId: string, messageId: string, emoji: string) {
    await this.#call(
      "DELETE",
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      `channel:${channelId}:reactions`,
      { bot: true },
    );
  }

  async botGuilds(after?: string) {
    return this.#call<Array<{ id: string }>>(
      "GET",
      `/users/@me/guilds?limit=200${after ? `&after=${after}` : ""}`,
      "users:@me:guilds",
      { bot: true },
    );
  }

  async authorize(code: string, redirectUri: string) {
    const answered = await this.#call<{
      scope: string;
      guild?: { id: string; name?: string };
      permissions?: string;
    }>("POST", "/oauth2/token", "oauth2:token", {
      form: new URLSearchParams({
        client_id: this.settings.applicationId,
        client_secret: this.settings.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    return {
      scope: answered.scope,
      ...(answered.guild ? { guild: answered.guild } : {}),
      ...(answered.permissions ? { permissions: answered.permissions } : {}),
    };
  }
}
