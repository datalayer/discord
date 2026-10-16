import type {
  DatalayerHostClient,
  Logger,
  SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { DiscordPort } from "./discord-port.js";
import { externalIdOf } from "./domain.js";
import type { DiscordStore } from "./store.js";

/**
 * Removal from a server (DC-107). Discord sends no
 * event when a bot is removed from a server (`APPLICATION_DEAUTHORIZED` names
 * a user, never a guild, and is never mapped to one), so a removal is found
 * by Unknown Guild on use and by a daily reconciliation of the bound servers
 * against the bot's guild list (200 a page, paginated with `after`); from
 * Phase 2 also by the gateway's `GUILD_DELETE` without `unavailable`. Each
 * path marks the installation removed once, revokes it at ai-agents
 * (`DELETE /apps/hosts/self`), and the purge deletes its rows 24 hours later.
 * Late queued work of a removed installation is dropped by the worker.
 */

/** Discord's page size for `GET /users/@me/guilds`. */
export const GUILD_PAGE = 200;
/** The audited grace before a removed server's rows are deleted. */
export const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;

export type RemovalDependencies = Readonly<{
  applicationId: string;
  store: DiscordStore;
  hosts: Pick<DatalayerHostClient, "uninstalled">;
  cipher: SecretCipher;
  logger: Logger;
  now?: () => number;
}>;

/** Mark one server removed and revoke it at Datalayer: `false` when it already was. */
export async function removeInstallation(
  dependencies: RemovalDependencies,
  guildId: string,
  why: "unknown-guild" | "reconciliation" | "guild-delete",
): Promise<boolean> {
  const { store, applicationId } = dependencies;
  const now = new Date((dependencies.now ?? Date.now)());
  const installation = await store.installation(applicationId, guildId);
  if (!installation) return false;
  const changed = await store.setInstallationState(
    applicationId,
    guildId,
    "removed",
    now,
  );
  if (!changed) return false;
  const externalId = externalIdOf(applicationId, guildId);
  try {
    await dependencies.hosts.uninstalled(
      dependencies.cipher.decrypt(installation.hostKey, externalId),
    );
  } catch (error) {
    // Marked removed here whatever Datalayer said; its key opens nothing
    // once the owner disconnects it, and the purge deletes it.
    dependencies.logger.warn("removal.revoke_failed", { error });
  }
  dependencies.logger.audit("admin.changed", {
    installation: externalId,
    reason: `removed:${why}`,
  });
  return true;
}

/**
 * The daily reconciliation: every bound server Discord no longer lists for
 * the bot is removed. Answers how many were.
 */
export async function reconcile(
  dependencies: RemovalDependencies & { port: Pick<DiscordPort, "botGuilds"> },
): Promise<number> {
  const listed = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const page = await dependencies.port.botGuilds(after);
    for (const guild of page) listed.add(guild.id);
    if (page.length < GUILD_PAGE) break;
    after = page[page.length - 1]!.id;
  }
  let removed = 0;
  for (const state of ["active", "paused"] as const)
    for (const installation of await dependencies.store.installations(state))
      if (
        installation.applicationId === dependencies.applicationId &&
        !listed.has(installation.guildId) &&
        (await removeInstallation(
          dependencies,
          installation.guildId,
          "reconciliation",
        ))
      )
        removed += 1;
  return removed;
}

/** Delete the rows of servers removed more than 24 hours ago: how many servers. */
export async function purgeRemoved(
  dependencies: RemovalDependencies,
): Promise<number> {
  const before = (dependencies.now ?? Date.now)() - PURGE_AFTER_MS;
  let purged = 0;
  for (const installation of await dependencies.store.installations("removed"))
    if (
      installation.applicationId === dependencies.applicationId &&
      installation.removedAt &&
      installation.removedAt.getTime() <= before
    ) {
      await dependencies.store.purgeInstallation(
        installation.applicationId,
        installation.guildId,
      );
      dependencies.logger.audit("admin.changed", {
        installation: externalIdOf(
          installation.applicationId,
          installation.guildId,
        ),
        reason: "purged",
      });
      purged += 1;
    }
  return purged;
}
