import { randomUUID } from "node:crypto";

import type { EncryptedSecret } from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { GatewaySession, LeaderLock } from "./gateway.js";
import type { NotificationMode } from "./render.js";
import { SolrConflict, textOf } from "./solr/client.js";
import { CLAIM } from "./solr/queue.js";
import { lockKey, type Fields, type SolrRecords } from "./solr/records.js";
import type {
  Allowance,
  ComponentRow,
  CustomApp,
  DiscordStore,
  Installation,
  InstallationState,
  ThreadBinding,
  TurnClaim,
  UserLink,
} from "./store.js";

/**
 * The memory store's behavior in the service's Solr collection (`discord`):
 * one record kind per object, each under its natural key (`key_s`), the
 * object whole in `record_stored` (the host key, delivery secret, bot token
 * and bind code still encrypted by `SecretCipher`, as they were in
 * PostgreSQL), the fields searched on beside it. A unique constraint is a
 * keyed record; a conditional update, a counter or a claim is an `update`
 * under the key's lock (`solr/records.ts`).
 */

const INSTALLATION = "installation";
const CUSTOM_APP = "custom_app";
const DIRECT_CHOICE = "direct_choice";
const GATEWAY_SESSION = "gateway_session";
const USER_LINK = "user_link";
const THREAD = "thread";
const TURN = "turn";
const COMPONENT = "component";
const ALLOWANCE = "allowance";
const OAUTH_STATE = "oauth_state";
const LEADER = "leader";
const JOB = "job";
const USAGE = "usage";

/** The lock of a host uid: what the unique index on it was. */
const HOST = "installation_host";

type InstallationRecord = Omit<Installation, "removedAt"> & {
  removedAt?: string;
};
type CustomAppRecord = Omit<CustomApp, "createdAt"> & { createdAt: string };
type TurnRecord = {
  owner: string;
  /** Epoch milliseconds. */
  leaseUntil: number;
  runId?: string;
  sessionUid?: string;
  stopRequested: boolean;
};
type StateRecord = { bindCode: EncryptedSecret; expiresAt: number };
type Lease = { holder: string; until: number };

const pair = (applicationId: string, other: string): string =>
  `${applicationId}:${other}`;

const installationOf = (record: InstallationRecord): Installation => {
  const { removedAt, ...rest } = record;
  return removedAt ? { ...rest, removedAt: new Date(removedAt) } : rest;
};

const installationFields = (one: InstallationRecord): Fields => ({
  application_id_s: one.applicationId,
  guild_id_s: one.guildId,
  host_uid_s: one.hostUid,
  state_s: one.state,
});

const customAppOf = (record: CustomAppRecord): CustomApp => ({
  ...record,
  createdAt: new Date(record.createdAt),
});

const componentFields = (row: ComponentRow): Fields => ({
  answered_by_s: row.answeredBy,
  application_id_s: row.applicationId,
  approval_id_s:
    typeof row.payload.approvalId === "string"
      ? row.payload.approvalId
      : undefined,
  author_id_s:
    typeof row.payload.authorId === "string" ? row.payload.authorId : undefined,
  guild_id_s: row.guildId,
  kind_s: row.kind,
  owner_id_s: row.ownerId,
});

const threadFields = (binding: ThreadBinding): Fields => ({
  application_id_s: binding.applicationId,
  guild_id_s: binding.guildId,
  opened_by_s: binding.openedBy,
});

/** An object without its `undefined` fields: kept as the memory store keeps it. */
const plain = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, one]) => one !== undefined),
  ) as T;

export class SolrDiscordStore implements DiscordStore {
  constructor(readonly records: SolrRecords) {}

  // -- installations ---------------------------------------------------------

  async installation(applicationId: string, guildId: string) {
    const record = await this.records.get<InstallationRecord>(
      INSTALLATION,
      pair(applicationId, guildId),
    );
    return record ? installationOf(record) : undefined;
  }

  async installationByHost(hostUid: string) {
    const [record] = await this.records.find<InstallationRecord>(
      INSTALLATION,
      { host_uid_s: hostUid },
      { rows: 1 },
    );
    return record ? installationOf(record) : undefined;
  }

  async saveInstallation(installation: Installation) {
    const key = pair(installation.applicationId, installation.guildId);
    // The key and version describe the secret: never kept without it.
    const record: InstallationRecord = plain({
      ...installation,
      deliveryKey: installation.deliverySecret
        ? installation.deliveryKey
        : undefined,
      deliveryVersion: installation.deliverySecret
        ? installation.deliveryVersion
        : undefined,
      removedAt: installation.removedAt?.toISOString(),
    });
    // One installation per host uid, as its unique index was.
    await this.records.locked(
      [lockKey(INSTALLATION, key), lockKey(HOST, installation.hostUid)],
      async () => {
        const holders = await this.records.find<InstallationRecord>(
          INSTALLATION,
          { host_uid_s: installation.hostUid },
        );
        if (holders.some((one) => pair(one.applicationId, one.guildId) !== key))
          throw new Error("duplicate key value violates unique constraint");
        await this.records.put(
          INSTALLATION,
          key,
          record,
          installationFields(record),
        );
      },
    );
  }

  async setInstallationState(
    applicationId: string,
    guildId: string,
    state: InstallationState,
    at: Date,
  ) {
    let changed = false;
    // A removed installation never comes back but by a new install.
    await this.records.update<InstallationRecord>(
      INSTALLATION,
      pair(applicationId, guildId),
      (before) => {
        if (!before || before.state === state || before.state === "removed")
          return undefined;
        changed = true;
        const record: InstallationRecord = {
          ...before,
          state,
          ...(state === "removed" ? { removedAt: at.toISOString() } : {}),
        };
        return { fields: installationFields(record), record };
      },
    );
    return changed;
  }

  async setNotifications(
    applicationId: string,
    guildId: string,
    mode: NotificationMode,
  ) {
    let changed = false;
    await this.records.update<InstallationRecord>(
      INSTALLATION,
      pair(applicationId, guildId),
      (before) => {
        if (!before || before.state === "removed") return undefined;
        changed = true;
        const record: InstallationRecord = { ...before, notifications: mode };
        return { fields: installationFields(record), record };
      },
    );
    return changed;
  }

  async installations(state?: InstallationState) {
    const records = await this.records.find<InstallationRecord>(
      INSTALLATION,
      { state_s: state },
      { sort: "guild_id_s asc, uid asc" },
    );
    return records.map(installationOf);
  }

  async purgeInstallation(applicationId: string, guildId: string) {
    const of = { application_id_s: applicationId, guild_id_s: guildId };
    const threads = await this.records.find<ThreadBinding>(THREAD, of);
    for (const thread of threads)
      await this.records.remove(TURN, thread.threadKey);
    for (const kind of [THREAD, USER_LINK, COMPONENT, DIRECT_CHOICE])
      await this.records.removeWhere(kind, of);
    await this.records.remove(ALLOWANCE, pair(applicationId, guildId));
    await this.records.remove(INSTALLATION, pair(applicationId, guildId));
  }

  // -- direct messages and the gateway session -------------------------------

  async directChoice(applicationId: string, userId: string) {
    return (
      await this.records.get<{ guildId: string }>(
        DIRECT_CHOICE,
        pair(applicationId, userId),
      )
    )?.guildId;
  }

  async setDirectChoice(
    applicationId: string,
    userId: string,
    guildId: string,
  ) {
    await this.records.put(
      DIRECT_CHOICE,
      pair(applicationId, userId),
      { guildId },
      {
        application_id_s: applicationId,
        guild_id_s: guildId,
        user_id_s: userId,
      },
    );
  }

  async gatewaySession(applicationId: string) {
    return this.records.get<GatewaySession>(GATEWAY_SESSION, applicationId);
  }

  async saveGatewaySession(
    applicationId: string,
    session: GatewaySession | undefined,
  ) {
    if (!session) await this.records.remove(GATEWAY_SESSION, applicationId);
    else
      await this.records.put(GATEWAY_SESSION, applicationId, {
        id: session.id,
        resumeUrl: session.resumeUrl,
        seq: session.seq,
      });
  }

  // -- custom applications ---------------------------------------------------

  async customApp(applicationId: string) {
    const record = await this.records.get<CustomAppRecord>(
      CUSTOM_APP,
      applicationId,
    );
    return record ? customAppOf(record) : undefined;
  }

  async saveCustomApp(app: CustomApp) {
    await this.records.update<CustomAppRecord>(
      CUSTOM_APP,
      app.applicationId,
      (before) => {
        // Made once: a new key or token keeps when it was first brought.
        const createdAt =
          before?.createdAt ?? (app.createdAt ?? new Date()).toISOString();
        return {
          fields: { created_at_dt: createdAt },
          record: {
            applicationId: app.applicationId,
            botToken: app.botToken,
            createdAt,
            publicKey: app.publicKey,
          },
        };
      },
    );
  }

  async customApps() {
    const records = await this.records.find<CustomAppRecord>(
      CUSTOM_APP,
      {},
      { sort: "created_at_dt asc, uid asc" },
    );
    return records.map(customAppOf);
  }

  async deleteCustomApp(applicationId: string) {
    await this.records.remove(CUSTOM_APP, applicationId);
  }

  // -- links -----------------------------------------------------------------

  async link(applicationId: string, guildId: string, userId: string) {
    return this.records.get<UserLink>(
      USER_LINK,
      `${applicationId}:${guildId}:${userId}`,
    );
  }

  async setLinked(
    applicationId: string,
    guildId: string,
    userId: string,
    linked: boolean,
  ) {
    await this.#updateLink(applicationId, guildId, userId, (before) =>
      linked || before?.pendingUntil === undefined
        ? { linked }
        : { linked, pendingUntil: before.pendingUntil },
    );
  }

  async setLinkPending(
    applicationId: string,
    guildId: string,
    userId: string,
    until: number | undefined,
  ) {
    await this.#updateLink(applicationId, guildId, userId, (before) => {
      const linked = before?.linked ?? false;
      return until === undefined ? { linked } : { linked, pendingUntil: until };
    });
  }

  async #updateLink(
    applicationId: string,
    guildId: string,
    userId: string,
    change: (before: UserLink | undefined) => UserLink,
  ): Promise<void> {
    await this.records.update<UserLink>(
      USER_LINK,
      `${applicationId}:${guildId}:${userId}`,
      (before) => ({
        fields: {
          application_id_s: applicationId,
          guild_id_s: guildId,
          user_id_s: userId,
        },
        record: change(before),
      }),
    );
  }

  async linkedGuilds(applicationId: string, userId: string) {
    const stored = await this.records.findStored<UserLink>(
      USER_LINK,
      { application_id_s: applicationId, user_id_s: userId },
      { sort: "guild_id_s asc, uid asc" },
    );
    return stored.map((one) => textOf(one.doc.guild_id_s));
  }

  async forgetUser(applicationId: string, userId: string) {
    if (!/^\d{17,20}$/.test(userId) || !/^\d{17,20}$/.test(applicationId))
      throw new Error("forgetUser names a Discord application and user id.");
    let count = 0;
    const app = { application_id_s: applicationId };
    if (await this.#removeIf(DIRECT_CHOICE, pair(applicationId, userId)))
      count += 1;
    for (const link of await this.records.findStored(USER_LINK, {
      ...app,
      user_id_s: userId,
    }))
      if (await this.#removeIf(USER_LINK, textOf(link.doc.key_s))) count += 1;
    for (const thread of await this.records.find<ThreadBinding>(THREAD, {
      ...app,
      opened_by_s: userId,
    }))
      if (
        await this.#changeIf<ThreadBinding>(
          THREAD,
          thread.threadKey,
          (one) => one.openedBy === userId,
          (one) => plain({ ...one, openedBy: undefined }),
          threadFields,
        )
      )
        count += 1;
    // Their components, and another person's "Ask Datalayer" on their
    // message, which keeps its author and text until it is submitted.
    for (const where of [
      { ...app, owner_id_s: userId },
      { ...app, author_id_s: userId, kind_s: "ask-message" },
    ])
      for (const row of await this.records.find<ComponentRow>(COMPONENT, where))
        if (await this.#removeIf(COMPONENT, row.renderId)) count += 1;
    // A press is kept answered, by nobody it names.
    for (const row of await this.records.find<ComponentRow>(COMPONENT, {
      ...app,
      answered_by_s: userId,
    }))
      if (
        await this.#changeIf<ComponentRow>(
          COMPONENT,
          row.renderId,
          (one) => one.answeredBy === userId,
          (one) => ({ ...one, answeredBy: "forgotten" }),
          componentFields,
        )
      )
        count += 1;
    // Their quota counts in every server (`userQuotaKey`:
    // user:<application>:<guild>:<user>, both ids digits only).
    const usage = [`usage_key_s:user\\:${applicationId}\\:*\\:${userId}`];
    const counts = await this.records.count(USAGE, {}, usage);
    if (counts) await this.records.removeWhere(USAGE, {}, usage);
    count += counts;
    // Their queued and dead requests; the one running now (this `forget`
    // among them) is deleted by the queue when it is done.
    const jobs = (await this.records.findStored<null>(JOB)).filter((job) => {
      if (job.doc.state_s === "processing") return false;
      const payload = payloadOf(job.doc.payload_stored);
      const key = payload?.key as { applicationId?: unknown } | undefined;
      return (
        payload?.kind === "interaction" &&
        key?.applicationId === applicationId &&
        payload.userId === userId
      );
    });
    await this.records.client.deleteIds(jobs.map((job) => job.id));
    return count + jobs.length;
  }

  /** Delete a keyed record when there is one: whether there was. */
  async #removeIf(kind: string, key: string): Promise<boolean> {
    let removed = false;
    await this.records.update(kind, key, (before) => {
      if (before === undefined) return undefined;
      removed = true;
      return null;
    });
    return removed;
  }

  /** Change a keyed record when it still is as found: whether it was. */
  async #changeIf<T>(
    kind: string,
    key: string,
    still: (before: T) => boolean,
    change: (before: T) => T,
    fields: (record: T) => Fields,
  ): Promise<boolean> {
    let changed = false;
    await this.records.update<T>(kind, key, (before) => {
      if (before === undefined || !still(before)) return undefined;
      changed = true;
      const record = change(before);
      return { fields: fields(record), record };
    });
    return changed;
  }

  // -- threads and turns -----------------------------------------------------

  async thread(threadKey: string) {
    return this.records.get<ThreadBinding>(THREAD, threadKey);
  }

  async saveThread(binding: ThreadBinding) {
    const record = plain({ ...binding });
    await this.records.put(
      THREAD,
      binding.threadKey,
      record,
      threadFields(record),
    );
  }

  async claimTurn(
    threadKey: string,
    owner: string,
    leaseUntil: Date,
    now: Date,
  ): Promise<TurnClaim> {
    let claim: TurnClaim = { again: false, ok: true };
    // Under the thread's lock: a missing record cannot let two workers
    // start. Taken over only from its own owner or once its lease ran out.
    await this.records.update<TurnRecord>(TURN, threadKey, (held) => {
      if (held && held.owner === owner) {
        claim = { again: true, ok: true };
        return { record: { ...held, leaseUntil: leaseUntil.getTime() } };
      }
      if (held && held.leaseUntil > now.getTime()) {
        claim = { ok: false, owner: held.owner };
        return undefined;
      }
      return {
        record: {
          leaseUntil: leaseUntil.getTime(),
          owner,
          stopRequested: false,
        },
      };
    });
    return claim;
  }

  async renewTurn(threadKey: string, owner: string, leaseUntil: Date) {
    await this.#changeTurn(threadKey, owner, (held) => ({
      ...held,
      leaseUntil: leaseUntil.getTime(),
    }));
  }

  async setTurnRun(
    threadKey: string,
    owner: string,
    sessionUid: string,
    runId?: string,
  ) {
    await this.#changeTurn(threadKey, owner, (held) => ({
      ...held,
      sessionUid,
      ...(runId ? { runId } : {}),
    }));
  }

  async #changeTurn(
    threadKey: string,
    owner: string,
    change: (held: TurnRecord) => TurnRecord,
  ): Promise<void> {
    await this.records.update<TurnRecord>(TURN, threadKey, (held) =>
      held?.owner === owner ? { record: change(held) } : undefined,
    );
  }

  async turn(threadKey: string) {
    const held = await this.records.get<TurnRecord>(TURN, threadKey);
    return held
      ? {
          owner: held.owner,
          runId: held.runId,
          sessionUid: held.sessionUid,
          stopRequested: held.stopRequested,
        }
      : undefined;
  }

  async requestStop(threadKey: string) {
    let requested = false;
    await this.records.update<TurnRecord>(TURN, threadKey, (held) => {
      if (!held) return undefined;
      requested = true;
      return { record: { ...held, stopRequested: true } };
    });
    return requested;
  }

  async releaseTurn(threadKey: string, owner: string) {
    await this.records.update<TurnRecord>(TURN, threadKey, (held) =>
      held?.owner === owner ? null : undefined,
    );
  }

  // -- components ------------------------------------------------------------

  async saveComponent(row: ComponentRow) {
    // Made once: a render id already kept keeps its first row.
    const record = plain({ ...row });
    await this.records.create(
      COMPONENT,
      row.renderId,
      record,
      componentFields(record),
    );
  }

  async component(renderId: string) {
    return this.records.get<ComponentRow>(COMPONENT, renderId);
  }

  async answerComponent(renderId: string, by: string) {
    return this.#changeIf<ComponentRow>(
      COMPONENT,
      renderId,
      (row) => !row.answeredBy,
      (row) => ({ ...row, answeredBy: by }),
      componentFields,
    );
  }

  async approvalComponents(
    applicationId: string,
    guildId: string,
    approvalId: string,
  ) {
    // Oldest first: a uid is a ULID, minted when the row was made.
    return this.records.find<ComponentRow>(COMPONENT, {
      application_id_s: applicationId,
      approval_id_s: approvalId,
      guild_id_s: guildId,
    });
  }

  // -- allowances ------------------------------------------------------------

  async allowances(applicationId: string, guildId: string) {
    return (
      (
        await this.records.get<{ allowances: Allowance[] }>(
          ALLOWANCE,
          pair(applicationId, guildId),
        )
      )?.allowances ?? []
    );
  }

  async setAllowances(
    applicationId: string,
    guildId: string,
    allowances: readonly Allowance[],
  ) {
    await this.records.put(
      ALLOWANCE,
      pair(applicationId, guildId),
      { allowances: [...allowances] },
      { application_id_s: applicationId, guild_id_s: guildId },
    );
  }

  // -- the queue's spent tokens ------------------------------------------------

  async dropSpentTokens(before: Date) {
    // Queued, running and dead jobs alike, each written back only if it is
    // still the version read: one changed meanwhile waits for the next minute.
    let dropped = 0;
    for (const job of await this.records.findStored<null>(JOB)) {
      const payload = payloadOf(job.doc.payload_stored);
      if (
        payload?.kind !== "interaction" ||
        !("token" in payload) ||
        Number(payload.receivedAt) >= before.getTime()
      )
        continue;
      const kept = { ...payload };
      delete kept.token;
      try {
        await this.records.client.add([
          {
            _version_: job.version,
            id: job.id,
            payload_stored: { set: JSON.stringify(kept) },
          },
        ]);
        dropped += 1;
      } catch (error) {
        if (!(error instanceof SolrConflict)) throw error;
      }
    }
    return dropped;
  }

  // -- the install's state and event claims ----------------------------------

  async saveState(nonce: string, bindCode: EncryptedSecret, expiresAt: Date) {
    const made = await this.records.create<StateRecord>(
      OAUTH_STATE,
      nonce,
      { bindCode, expiresAt: expiresAt.getTime() },
      { expires_dt: expiresAt },
    );
    if (!made)
      throw new Error("duplicate key value violates unique constraint");
  }

  async spendState(nonce: string, now: Date) {
    let spent: StateRecord | undefined;
    await this.records.update<StateRecord>(OAUTH_STATE, nonce, (before) => {
      spent = before;
      return before ? null : undefined;
    });
    return spent && spent.expiresAt > now.getTime()
      ? spent.bindCode
      : undefined;
  }

  /** The same claims as the queue's ingress claims (`type_s:claim`). */
  async claimEvent(id: string) {
    return this.records.create(CLAIM, id, { eventId: id });
  }

  async releaseEvent(id: string) {
    await this.records.remove(CLAIM, id);
  }
}

function payloadOf(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string") return undefined;
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/**
 * The gateway's leader (DC-201) as a lease in the collection
 * (`type_s:leader`, keyed by `discord-gateway:<application id>`): taken when
 * free, run out or already this replica's, renewed at every check
 * (`held`), given back on `release`. A lease, not a lock bound to a
 * connection: a leader cut off from Solr stops at its next check, which
 * fails; another replica takes the lease once it ran out. The lease outlasts
 * the gateway's check interval (10 seconds) three times, so two replicas
 * lead together only when a leader's checks stall past the whole lease.
 */
export class SolrLeaderLock implements LeaderLock {
  readonly #holder = randomUUID();

  constructor(
    readonly records: SolrRecords,
    readonly key: string,
    readonly leaseMs = 30_000,
  ) {}

  async acquire(): Promise<boolean> {
    return this.#take(true);
  }

  async held(): Promise<boolean> {
    return this.#take(false);
  }

  async release(): Promise<void> {
    await this.records.update<Lease>(LEADER, this.key, (before) =>
      before?.holder === this.#holder ? null : undefined,
    );
  }

  /** Renew this replica's lease; with `free`, take one that is free or ran out. */
  async #take(free: boolean): Promise<boolean> {
    const now = Date.now();
    const kept = await this.records.update<Lease>(
      LEADER,
      this.key,
      (before) => {
        const mine = before?.holder === this.#holder;
        if (!mine && !(free && (!before || before.until <= now)))
          return undefined;
        const until = now + this.leaseMs;
        return {
          fields: { holder_s: this.#holder, until_dt: new Date(until) },
          record: { holder: this.#holder, until },
        };
      },
    );
    return kept?.holder === this.#holder;
  }
}
