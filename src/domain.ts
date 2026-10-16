import {
  hostSessionUid,
  type HostShape,
  type HostTurnRequest,
  type Place,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

/**
 * What is Discord's own in a turn: the thread
 * key, the installation's external id, the session uid, the place sent to
 * Datalayer and the delivery target. The rest is the shared host kit's.
 */

/** The host kind Datalayer knows Discord by. */
export const HOST_KIND = "discord";

/** Where a DM stands in for a guild: `<application_id>:@me` (reserved). */
export const DIRECT = "@me";

/**
 * A Discord conversation: a guild channel, a thread in it (with its parent),
 * or the bot's DM. `thread` is the thread's channel id, or, for a first
 * `/ask` in a channel, the id of the `@original` message the answer's
 * thread starts from.
 */
export type ThreadKey = Readonly<{
  applicationId: string;
  /** The guild, or `@me` for a direct message. */
  guildId: string;
  channelId: string;
  /** The thread's parent channel, when `channelId` is a thread. */
  parentId?: string;
  thread: string;
}>;

/** A turn's provenance as Discord knows it: where, who, and which message or interaction. */
export type DiscordTurn = Readonly<{
  key: ThreadKey;
  /** The interaction's `@original` message, or the gateway message. */
  messageId: string;
  userId: string;
  /**
   * Whether `key.thread` is a thread that exists: inside a thread, or once
   * the answer's thread was started from `@original`. Until then it
   * only names the message the thread would start from.
   */
  threadExists: boolean;
  /** Whether only the person sees the turn (an ephemeral `/ask`): nothing of it is posted where others read. */
  private: boolean;
}>;

export type DiscordTurnRequest = HostTurnRequest<DiscordTurn>;

/** The installation's external id at Datalayer: `<application_id>:<guild_id>`. */
export function externalIdOf(applicationId: string, guildId: string): string {
  return `${applicationId}:${guildId}`;
}

/** Whether a key is the bot's DM. */
export function isDirect(key: Pick<ThreadKey, "guildId">): boolean {
  return key.guildId === DIRECT;
}

/**
 * A thread's stable id in the service's own tables: the same for a first
 * `/ask` in a channel (channel, `@original`) and for the thread started from
 * that message, whose id is the message's (Discord's rule), seen from inside
 * (thread, parent).
 */
export function threadIdOf(key: ThreadKey): string {
  if (!key.thread) throw new Error("A thread key without its thread.");
  return [
    key.applicationId,
    key.guildId,
    key.parentId ?? key.channelId,
    key.thread,
  ].join(":");
}

/**
 * Where Datalayer checks the channel policy: a guild channel
 * as itself, a thread as its parent channel, the bot's DM as `direct`.
 */
export function placeOf(key: ThreadKey): Place {
  if (isDirect(key)) return { id: key.channelId, kind: "direct" };
  return { id: key.parentId ?? key.channelId, kind: "channel" };
}

/** `discord-<40 hex>` over application, guild, channel and thread. */
export function sessionUidOf(key: ThreadKey, generation?: number): string {
  return hostSessionUid(
    HOST_KIND,
    [key.applicationId, key.guildId, key.parentId ?? key.channelId, key.thread],
    generation,
  );
}

/**
 * The delivery target handed back with every delivery: at most 2 KB,
 * validated again when a delivery comes back (`targetSchema`, DC-301). It
 * names a thread only once the thread exists: a first `/ask` is mapped
 * without one, and PUT again once its answer's thread is started; a
 * private turn says so, so nothing of it is delivered where others read.
 */
export function targetOf(turn: DiscordTurn): Record<string, unknown> {
  return {
    applicationId: turn.key.applicationId,
    channelId: turn.key.parentId ?? turn.key.channelId,
    guildId: turn.key.guildId,
    messageId: turn.messageId,
    ...(turn.threadExists ? { threadId: turn.key.thread } : {}),
    ...(turn.private ? { private: true } : {}),
    userId: turn.userId,
  };
}

/** The `HostShape` injected into the shared agent client. */
export const discordShape: HostShape<DiscordTurn> = {
  notBound:
    "This server is not connected to Datalayer. An owner adds @Datalayer from Ship → Discord in Datalayer.",
  placeOf: (request) => placeOf(request.provenance.key),
  // On the turn itself: where it was asked, at most 1 KiB.
  provenanceOf: (request) => ({
    host_kind: HOST_KIND,
    message_id: request.provenance.messageId,
    place: placeOf(request.provenance.key),
    thread: request.provenance.key.thread,
  }),
  sessionUidOf: (request) =>
    sessionUidOf(request.provenance.key, request.sessionGeneration),
  targetOf: (request) => targetOf(request.provenance),
};
