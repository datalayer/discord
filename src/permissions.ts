/**
 * What the install link asks of a server (plans/DISCORD.md §6.2): each
 * permission with its bit and why the bot needs it, and the integer the
 * install link carries, computed from the table, never typed by hand. No
 * administrator, manage, mention-everyone or private-thread permission.
 *
 * USE_APPLICATION_COMMANDS is not asked for: Discord's permission table
 * describes it as what allows *members* to use application commands, and
 * nothing in the interactions docs makes the app need it to receive or
 * answer them (DC-001, read 16 October 2026; to confirm on the development
 * application).
 */

export type BotPermission = Readonly<{
  name: string;
  bit: bigint;
  why: string;
}>;

export const BOT_PERMISSIONS: readonly BotPermission[] = [
  {
    name: "VIEW_CHANNEL",
    bit: 1n << 10n,
    why: "See the channel it is used in; without it every other permission is denied.",
  },
  {
    name: "SEND_MESSAGES",
    bit: 1n << 11n,
    why: "Answer after the interaction token expires, and post deliveries.",
  },
  {
    name: "SEND_MESSAGES_IN_THREADS",
    bit: 1n << 38n,
    why: "Answer in threads, which do not inherit SEND_MESSAGES.",
  },
  {
    name: "CREATE_PUBLIC_THREADS",
    bit: 1n << 35n,
    why: "Start the thread on a mention or an /ask answer.",
  },
  {
    name: "READ_MESSAGE_HISTORY",
    bit: 1n << 16n,
    why: "Reply to a message.",
  },
  {
    name: "EMBED_LINKS",
    bit: 1n << 14n,
    why: "Citations and answer embeds.",
  },
  {
    name: "ATTACH_FILES",
    bit: 1n << 15n,
    why: "Results whose classification allows a file.",
  },
  {
    name: "ADD_REACTIONS",
    bit: 1n << 6n,
    why: "The ⏳ reaction on a mention while its turn runs (Phase 2).",
  },
];

/** The permissions integer of the install link, as Discord reads it (a decimal string). */
export function permissionsInteger(
  permissions: readonly BotPermission[] = BOT_PERMISSIONS,
): string {
  return permissions.reduce((all, one) => all | one.bit, 0n).toString();
}

/** Which of the asked permissions a place lacks, from an interaction's `app_permissions`. */
export function missingPermissions(
  appPermissions: string,
  needed: readonly string[],
): string[] {
  const granted = BigInt(appPermissions);
  return needed.filter((name) => {
    const permission = BOT_PERMISSIONS.find((one) => one.name === name);
    if (!permission)
      throw new Error(`Not a permission the bot asks for: ${name}`);
    return (granted & permission.bit) === 0n;
  });
}
