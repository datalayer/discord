import type {
  EncryptedSecret,
  Queryable,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type {
  Allowance,
  ComponentRow,
  DiscordStore,
  Installation,
  InstallationState,
  ThreadBinding,
  TurnClaim,
} from "./store.js";

/** The memory store's behavior on PostgreSQL (`migrations/`, plans/DISCORD.md §5). */

type InstallationRow = {
  application_id: string;
  guild_id: string;
  datalayer_host_uid: string;
  datalayer_host_key: EncryptedSecret;
  datalayer_organization_uid: string;
  installed_by: string;
  permissions: string;
  state: InstallationState;
  delivery_secret: EncryptedSecret | null;
  removed_at: Date | null;
};

const installationOf = (row: InstallationRow): Installation => ({
  applicationId: row.application_id,
  guildId: row.guild_id,
  hostKey: row.datalayer_host_key,
  hostUid: row.datalayer_host_uid,
  installedBy: row.installed_by,
  organizationUid: row.datalayer_organization_uid,
  permissions: row.permissions,
  state: row.state,
  ...(row.delivery_secret ? { deliverySecret: row.delivery_secret } : {}),
  ...(row.removed_at ? { removedAt: row.removed_at } : {}),
});

type ThreadRow = {
  thread_key: string;
  application_id: string;
  guild_id: string;
  channel_id: string;
  session_uid: string | null;
  generation: number;
  deployment_uid: string | null;
  next_deployment_uid: string | null;
  opened_by: string | null;
};

const threadOf = (row: ThreadRow): ThreadBinding => ({
  applicationId: row.application_id,
  channelId: row.channel_id,
  generation: row.generation,
  guildId: row.guild_id,
  threadKey: row.thread_key,
  ...(row.session_uid ? { sessionUid: row.session_uid } : {}),
  ...(row.deployment_uid ? { deploymentUid: row.deployment_uid } : {}),
  ...(row.next_deployment_uid
    ? { nextDeploymentUid: row.next_deployment_uid }
    : {}),
  ...(row.opened_by ? { openedBy: row.opened_by } : {}),
});

export class PostgresStore implements DiscordStore {
  constructor(readonly database: Queryable) {}

  async installation(applicationId: string, guildId: string) {
    const { rows } = await this.database.query<InstallationRow>(
      "SELECT * FROM discord_installation WHERE application_id = $1 AND guild_id = $2",
      [applicationId, guildId],
    );
    return rows[0] ? installationOf(rows[0]) : undefined;
  }

  async installationByHost(hostUid: string) {
    const { rows } = await this.database.query<InstallationRow>(
      "SELECT * FROM discord_installation WHERE datalayer_host_uid = $1",
      [hostUid],
    );
    return rows[0] ? installationOf(rows[0]) : undefined;
  }

  async saveInstallation(one: Installation) {
    await this.database.query(
      `INSERT INTO discord_installation
         (application_id, guild_id, datalayer_host_uid, datalayer_host_key,
          datalayer_organization_uid, installed_by, permissions, state,
          delivery_secret, removed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (application_id, guild_id) DO UPDATE SET
         datalayer_host_uid = EXCLUDED.datalayer_host_uid,
         datalayer_host_key = EXCLUDED.datalayer_host_key,
         datalayer_organization_uid = EXCLUDED.datalayer_organization_uid,
         installed_by = EXCLUDED.installed_by,
         permissions = EXCLUDED.permissions,
         state = EXCLUDED.state,
         delivery_secret = EXCLUDED.delivery_secret,
         removed_at = EXCLUDED.removed_at,
         updated_at = now()`,
      [
        one.applicationId,
        one.guildId,
        one.hostUid,
        one.hostKey,
        one.organizationUid,
        one.installedBy,
        one.permissions,
        one.state,
        one.deliverySecret ?? null,
        one.removedAt ?? null,
      ],
    );
  }

  async setInstallationState(
    applicationId: string,
    guildId: string,
    state: InstallationState,
    at: Date,
  ) {
    // A removed installation never comes back but by a new install (§7.4).
    const { rowCount } = await this.database.query(
      `UPDATE discord_installation
         SET state = $3, updated_at = now(),
             removed_at = CASE WHEN $3 = 'removed' THEN $4::timestamptz ELSE removed_at END
       WHERE application_id = $1 AND guild_id = $2
         AND state <> 'removed' AND state <> $3`,
      [applicationId, guildId, state, at],
    );
    return rowCount === 1;
  }

  async installations(state?: InstallationState) {
    const { rows } = await this.database.query<InstallationRow>(
      state
        ? "SELECT * FROM discord_installation WHERE state = $1 ORDER BY guild_id"
        : "SELECT * FROM discord_installation ORDER BY guild_id",
      state ? [state] : [],
    );
    return rows.map(installationOf);
  }

  async purgeInstallation(applicationId: string, guildId: string) {
    for (const table of [
      "discord_turn WHERE thread_key IN (SELECT thread_key FROM discord_thread_binding WHERE application_id = $1 AND guild_id = $2)",
      "discord_thread_binding WHERE application_id = $1 AND guild_id = $2",
      "discord_user_link WHERE application_id = $1 AND guild_id = $2",
      "discord_component WHERE application_id = $1 AND guild_id = $2",
      "discord_allowance WHERE application_id = $1 AND guild_id = $2",
      "discord_installation WHERE application_id = $1 AND guild_id = $2",
    ])
      await this.database.query(`DELETE FROM ${table}`, [
        applicationId,
        guildId,
      ]);
  }

  async linked(applicationId: string, guildId: string, userId: string) {
    const { rows } = await this.database.query<{ linked: boolean }>(
      "SELECT linked FROM discord_user_link WHERE application_id = $1 AND guild_id = $2 AND user_id = $3",
      [applicationId, guildId, userId],
    );
    return rows[0]?.linked;
  }

  async setLinked(
    applicationId: string,
    guildId: string,
    userId: string,
    linked: boolean,
  ) {
    await this.database.query(
      `INSERT INTO discord_user_link (application_id, guild_id, user_id, linked)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (application_id, guild_id, user_id)
       DO UPDATE SET linked = EXCLUDED.linked, updated_at = now()`,
      [applicationId, guildId, userId, linked],
    );
  }

  async forgetUser(applicationId: string, userId: string) {
    let count = 0;
    count +=
      (
        await this.database.query(
          "DELETE FROM discord_user_link WHERE application_id = $1 AND user_id = $2",
          [applicationId, userId],
        )
      ).rowCount ?? 0;
    count +=
      (
        await this.database.query(
          "UPDATE discord_thread_binding SET opened_by = NULL, updated_at = now() WHERE application_id = $1 AND opened_by = $2",
          [applicationId, userId],
        )
      ).rowCount ?? 0;
    count +=
      (
        await this.database.query(
          "DELETE FROM discord_component WHERE application_id = $1 AND owner_id = $2",
          [applicationId, userId],
        )
      ).rowCount ?? 0;
    return count;
  }

  async thread(threadKey: string) {
    const { rows } = await this.database.query<ThreadRow>(
      "SELECT * FROM discord_thread_binding WHERE thread_key = $1",
      [threadKey],
    );
    return rows[0] ? threadOf(rows[0]) : undefined;
  }

  async saveThread(binding: ThreadBinding) {
    await this.database.query(
      `INSERT INTO discord_thread_binding
         (thread_key, application_id, guild_id, channel_id, session_uid,
          generation, deployment_uid, next_deployment_uid, opened_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (thread_key) DO UPDATE SET
         session_uid = EXCLUDED.session_uid,
         generation = EXCLUDED.generation,
         deployment_uid = EXCLUDED.deployment_uid,
         next_deployment_uid = EXCLUDED.next_deployment_uid,
         opened_by = EXCLUDED.opened_by,
         updated_at = now()`,
      [
        binding.threadKey,
        binding.applicationId,
        binding.guildId,
        binding.channelId,
        binding.sessionUid ?? null,
        binding.generation,
        binding.deploymentUid ?? null,
        binding.nextDeploymentUid ?? null,
        binding.openedBy ?? null,
      ],
    );
  }

  async claimTurn(
    threadKey: string,
    owner: string,
    leaseUntil: Date,
    now: Date,
  ): Promise<TurnClaim> {
    // Insert first: a missing row cannot let two workers start (§7.5). The
    // row is taken over only from its own owner or once its lease ran out.
    const { rows } = await this.database.query<{
      owner: string;
      again: boolean;
    }>(
      `WITH previous AS (SELECT owner FROM discord_turn WHERE thread_key = $1)
       INSERT INTO discord_turn (thread_key, owner, lease_until)
       VALUES ($1, $2, $3)
       ON CONFLICT (thread_key) DO UPDATE SET
         owner = EXCLUDED.owner,
         lease_until = EXCLUDED.lease_until,
         stop_requested = CASE WHEN discord_turn.owner = EXCLUDED.owner
                               THEN discord_turn.stop_requested ELSE false END,
         run_id = CASE WHEN discord_turn.owner = EXCLUDED.owner
                       THEN discord_turn.run_id ELSE NULL END
       WHERE discord_turn.owner = EXCLUDED.owner OR discord_turn.lease_until <= $4
       RETURNING owner, COALESCE((SELECT owner FROM previous) = $2, false) AS again`,
      [threadKey, owner, leaseUntil, now],
    );
    if (rows[0]) return { again: rows[0].again, ok: true };
    const held = await this.turn(threadKey);
    return { ok: false, owner: held?.owner ?? "" };
  }

  async renewTurn(threadKey: string, owner: string, leaseUntil: Date) {
    await this.database.query(
      "UPDATE discord_turn SET lease_until = $3 WHERE thread_key = $1 AND owner = $2",
      [threadKey, owner, leaseUntil],
    );
  }

  async setTurnRun(
    threadKey: string,
    owner: string,
    sessionUid: string,
    runId?: string,
  ) {
    await this.database.query(
      "UPDATE discord_turn SET session_uid = $3, run_id = COALESCE($4, run_id) WHERE thread_key = $1 AND owner = $2",
      [threadKey, owner, sessionUid, runId ?? null],
    );
  }

  async turn(threadKey: string) {
    const { rows } = await this.database.query<{
      owner: string;
      run_id: string | null;
      session_uid: string | null;
      stop_requested: boolean;
    }>(
      "SELECT owner, run_id, session_uid, stop_requested FROM discord_turn WHERE thread_key = $1",
      [threadKey],
    );
    const row = rows[0];
    return row
      ? {
          owner: row.owner,
          stopRequested: row.stop_requested,
          ...(row.run_id ? { runId: row.run_id } : {}),
          ...(row.session_uid ? { sessionUid: row.session_uid } : {}),
        }
      : undefined;
  }

  async requestStop(threadKey: string) {
    const { rowCount } = await this.database.query(
      "UPDATE discord_turn SET stop_requested = true WHERE thread_key = $1",
      [threadKey],
    );
    return rowCount === 1;
  }

  async releaseTurn(threadKey: string, owner: string) {
    await this.database.query(
      "DELETE FROM discord_turn WHERE thread_key = $1 AND owner = $2",
      [threadKey, owner],
    );
  }

  async saveComponent(row: ComponentRow) {
    await this.database.query(
      `INSERT INTO discord_component
         (render_id, kind, application_id, guild_id, owner_id, payload, answered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (render_id) DO NOTHING`,
      [
        row.renderId,
        row.kind,
        row.applicationId,
        row.guildId,
        row.ownerId,
        row.payload,
        row.answeredBy ?? null,
      ],
    );
  }

  async component(renderId: string) {
    const { rows } = await this.database.query<{
      render_id: string;
      kind: string;
      application_id: string;
      guild_id: string;
      owner_id: string;
      payload: Record<string, unknown>;
      answered_by: string | null;
    }>("SELECT * FROM discord_component WHERE render_id = $1", [renderId]);
    const row = rows[0];
    return row
      ? {
          applicationId: row.application_id,
          guildId: row.guild_id,
          kind: row.kind,
          ownerId: row.owner_id,
          payload: row.payload,
          renderId: row.render_id,
          ...(row.answered_by ? { answeredBy: row.answered_by } : {}),
        }
      : undefined;
  }

  async answerComponent(renderId: string, by: string) {
    const { rowCount } = await this.database.query(
      "UPDATE discord_component SET answered_by = $2 WHERE render_id = $1 AND answered_by IS NULL",
      [renderId, by],
    );
    return rowCount === 1;
  }

  async allowances(applicationId: string, guildId: string) {
    const { rows } = await this.database.query<{ allowances: Allowance[] }>(
      "SELECT allowances FROM discord_allowance WHERE application_id = $1 AND guild_id = $2",
      [applicationId, guildId],
    );
    return rows[0]?.allowances ?? [];
  }

  async setAllowances(
    applicationId: string,
    guildId: string,
    allowances: readonly Allowance[],
  ) {
    await this.database.query(
      `INSERT INTO discord_allowance (application_id, guild_id, allowances)
       VALUES ($1, $2, $3)
       ON CONFLICT (application_id, guild_id)
       DO UPDATE SET allowances = EXCLUDED.allowances, updated_at = now()`,
      [applicationId, guildId, JSON.stringify(allowances)],
    );
  }

  async saveState(nonce: string, bindCode: EncryptedSecret, expiresAt: Date) {
    await this.database.query(
      "INSERT INTO discord_oauth_state (nonce, bind_code, expires_at) VALUES ($1, $2, $3)",
      [nonce, bindCode, expiresAt],
    );
  }

  async spendState(nonce: string, now: Date) {
    const { rows } = await this.database.query<{
      bind_code: EncryptedSecret;
      expires_at: Date;
    }>(
      "DELETE FROM discord_oauth_state WHERE nonce = $1 RETURNING bind_code, expires_at",
      [nonce],
    );
    return rows[0] && rows[0].expires_at > now ? rows[0].bind_code : undefined;
  }

  async claimEvent(id: string) {
    const { rowCount } = await this.database.query(
      "INSERT INTO discord_event_claims (event_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [id],
    );
    return rowCount === 1;
  }

  async releaseEvent(id: string) {
    await this.database.query(
      "DELETE FROM discord_event_claims WHERE event_id = $1",
      [id],
    );
  }
}
