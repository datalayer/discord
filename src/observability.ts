import { pseudonym } from "@datalayer/agent-runtimes/lib/portable/hosts";

/**
 * Discord's side of the shared observability:
 * what its pseudonyms are salted with, and its span attribute names. Logs,
 * redaction (Discord's token shapes included), audit and spans are the
 * shared host kit's.
 */

/** What Discord's pseudonyms are salted with. */
export const LOG_SALT =
  process.env.DATALAYER_DISCORD_LOG_SALT ?? "datalayer-discord";

/** The pseudonymous attributes of a Discord place, for a span. */
export function traceAttributes(key: {
  applicationId: string;
  guildId?: string;
  channelId?: string;
}): Record<string, string> {
  return {
    "datalayer.discord.installation": pseudonym(
      `${key.applicationId}:${key.guildId ?? "@me"}`,
      LOG_SALT,
    ),
    ...(key.channelId
      ? { "datalayer.discord.channel": pseudonym(key.channelId, LOG_SALT) }
      : {}),
  };
}
