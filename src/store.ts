import type {
  AllowanceView,
  DeliveryClaimStore,
  EncryptedSecret,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { GatewaySession } from "./gateway.js";
import type { NotificationMode } from "./render.js";

/**
 * What the service keeps: installations, link status,
 * thread bindings, the running turn's claim, components, the allowance cache
 * and the install's one-use state. PostgreSQL in production
 * (`postgres-store.ts`); this memory store in development and tests, with
 * the same behavior, held by the same tests.
 */

export type InstallationState = "active" | "paused" | "removed";

/**
 * A member's link, as Datalayer last said, and until when a link code
 * issued to them can still be confirmed there (epoch milliseconds): while
 * pending and not linked, the cached status is not trusted.
 */
export type UserLink = Readonly<{ linked: boolean; pendingUntil?: number }>;

export type Installation = Readonly<{
  applicationId: string;
  guildId: string;
  hostUid: string;
  /** Encrypted, bound to `<application_id>:<guild_id>`. */
  hostKey: EncryptedSecret;
  organizationUid: string;
  installedBy: string;
  permissions: string;
  state: InstallationState;
  /** How the server hears routine posts (DC-307): an owner's choice, quiet at install. */
  notifications: NotificationMode;
  deliverySecret?: EncryptedSecret;
  removedAt?: Date;
}>;

export type ThreadBinding = Readonly<{
  threadKey: string;
  applicationId: string;
  guildId: string;
  channelId: string;
  sessionUid?: string;
  generation: number;
  deploymentUid?: string;
  nextDeploymentUid?: string;
  openedBy?: string;
  /** Whether its thread exists in Discord: where a later turn posts (DC-304). */
  threadExists?: boolean;
  /**
   * The session whose answer the last turn did not show here (the worker
   * stopped, or could not post): a `turn.completed` delivery finishes it
   * (DC-301). Cleared once the answer is shown.
   */
  unshownSessionUid?: string;
}>;

/** What claiming a thread's turn answered: held by this job, or by another. */
export type TurnClaim =
  | Readonly<{ ok: true; again: boolean }>
  | Readonly<{ ok: false; owner: string }>;

export type ComponentRow = Readonly<{
  renderId: string;
  kind: string;
  applicationId: string;
  guildId: string;
  /** The Discord user the component is for (an approval's owner, the asker). */
  ownerId: string;
  payload: Readonly<Record<string, unknown>>;
  answeredBy?: string;
}>;

export type Allowance = AllowanceView;

export interface DiscordStore extends DeliveryClaimStore {
  installation(
    applicationId: string,
    guildId: string,
  ): Promise<Installation | undefined>;
  installationByHost(hostUid: string): Promise<Installation | undefined>;
  /** Insert or replace (a reinstall makes a removed installation active again). */
  saveInstallation(installation: Installation): Promise<void>;
  setInstallationState(
    applicationId: string,
    guildId: string,
    state: InstallationState,
    at: Date,
  ): Promise<boolean>;
  /** The server a person's direct messages go to, as they chose (DC-203). */
  directChoice(
    applicationId: string,
    userId: string,
  ): Promise<string | undefined>;
  setDirectChoice(
    applicationId: string,
    userId: string,
    guildId: string,
  ): Promise<void>;
  /** The gateway session a stopping leader left (DC-201), if any. */
  gatewaySession(applicationId: string): Promise<GatewaySession | undefined>;
  /** Keep it for the next leader, or clear it (`undefined`). */
  saveGatewaySession(
    applicationId: string,
    session: GatewaySession | undefined,
  ): Promise<void>;
  /** An owner's quiet or noisy (DC-307); false when no live installation. */
  setNotifications(
    applicationId: string,
    guildId: string,
    mode: NotificationMode,
  ): Promise<boolean>;
  installations(state?: InstallationState): Promise<Installation[]>;
  /** Every row of a removed installation, gone (24 hours after removal). */
  purgeInstallation(applicationId: string, guildId: string): Promise<void>;

  link(
    applicationId: string,
    guildId: string,
    userId: string,
  ): Promise<UserLink | undefined>;
  /** As Datalayer said: linked ends a pending code; not linked keeps it. */
  setLinked(
    applicationId: string,
    guildId: string,
    userId: string,
    linked: boolean,
  ): Promise<void>;
  /**
   * A link code issued, confirmable until `until` (the row not linked); or,
   * with `undefined`, settled: the code expired and Datalayer still says
   * not linked.
   */
  setLinkPending(
    applicationId: string,
    guildId: string,
    userId: string,
    until: number | undefined,
  ): Promise<void>;
  /** The servers of an application where a person's link was ever recorded. */
  linkedGuilds(applicationId: string, userId: string): Promise<string[]>;
  /**
   * Every row naming a person in every server of the application, gone or
   * no longer naming them (`/datalayer forget`): link status, the
   * threads they opened, the components they own or answered, their quota
   * counts and their queued or dead jobs (PostgreSQL; the memory store's
   * queue and counts are process memory). How many rows.
   */
  forgetUser(applicationId: string, userId: string): Promise<number>;

  thread(threadKey: string): Promise<ThreadBinding | undefined>;
  saveThread(binding: ThreadBinding): Promise<void>;

  /**
   * Claim a thread's turn insert-first: taken when no turn holds it or
   * its lease ran out; `again` when this very job already holds it.
   */
  claimTurn(
    threadKey: string,
    owner: string,
    leaseUntil: Date,
    now: Date,
  ): Promise<TurnClaim>;
  renewTurn(threadKey: string, owner: string, leaseUntil: Date): Promise<void>;
  setTurnRun(
    threadKey: string,
    owner: string,
    sessionUid: string,
    runId?: string,
  ): Promise<void>;
  /** The running turn of a thread, if any. */
  turn(threadKey: string): Promise<
    | Readonly<{
        owner: string;
        runId?: string;
        sessionUid?: string;
        stopRequested: boolean;
      }>
    | undefined
  >;
  requestStop(threadKey: string): Promise<boolean>;
  releaseTurn(threadKey: string, owner: string): Promise<void>;

  saveComponent(row: ComponentRow): Promise<void>;
  component(renderId: string): Promise<ComponentRow | undefined>;
  /** Answer a component once: `false` when it was already answered. */
  answerComponent(renderId: string, by: string): Promise<boolean>;
  /** An approval's rows in a server (its thread line, its card's buttons), oldest first. */
  approvalComponents(
    applicationId: string,
    guildId: string,
    approvalId: string,
  ): Promise<ComponentRow[]>;

  allowances(applicationId: string, guildId: string): Promise<Allowance[]>;
  setAllowances(
    applicationId: string,
    guildId: string,
    allowances: readonly Allowance[],
  ): Promise<void>;

  /**
   * Drop the encrypted interaction token from every queued or dead job
   * received before `before` (a token is kept only its 15 minutes; the
   * job, kept 14 days when dead, keeps no spent token). How many.
   */
  dropSpentTokens(before: Date): Promise<number>;

  /** Keep an install's state nonce, with its encrypted bind code, until it expires. */
  saveState(
    nonce: string,
    bindCode: EncryptedSecret,
    expiresAt: Date,
  ): Promise<void>;
  /** Spend a state nonce once: its bind code, or `undefined` when unknown, spent or expired. */
  spendState(nonce: string, now: Date): Promise<EncryptedSecret | undefined>;
}

export class MemoryStore implements DiscordStore {
  readonly #installations = new Map<string, Installation>();
  readonly #links = new Map<string, UserLink>();
  readonly #threads = new Map<string, ThreadBinding>();
  readonly #turns = new Map<
    string,
    {
      owner: string;
      leaseUntil: Date;
      runId?: string;
      sessionUid?: string;
      stopRequested: boolean;
    }
  >();
  readonly #components = new Map<string, ComponentRow>();
  readonly #allowances = new Map<string, Allowance[]>();
  readonly #states = new Map<
    string,
    { bindCode: EncryptedSecret; expiresAt: Date }
  >();
  readonly #claims = new Set<string>();

  async installation(applicationId: string, guildId: string) {
    return this.#installations.get(`${applicationId}:${guildId}`);
  }

  async installationByHost(hostUid: string) {
    return [...this.#installations.values()].find(
      (one) => one.hostUid === hostUid,
    );
  }

  async saveInstallation(installation: Installation) {
    for (const [key, one] of this.#installations)
      if (
        one.hostUid === installation.hostUid &&
        key !== `${installation.applicationId}:${installation.guildId}`
      )
        throw new Error("duplicate key value violates unique constraint");
    this.#installations.set(
      `${installation.applicationId}:${installation.guildId}`,
      installation,
    );
  }

  async setInstallationState(
    applicationId: string,
    guildId: string,
    state: InstallationState,
    at: Date,
  ) {
    const key = `${applicationId}:${guildId}`;
    const one = this.#installations.get(key);
    if (!one || one.state === state) return false;
    if (one.state === "removed") return false;
    this.#installations.set(key, {
      ...one,
      state,
      ...(state === "removed" ? { removedAt: at } : {}),
    });
    return true;
  }

  readonly #gatewaySessions = new Map<string, GatewaySession>();
  readonly #directChoices = new Map<string, string>();

  async directChoice(applicationId: string, userId: string) {
    return this.#directChoices.get(`${applicationId}:${userId}`);
  }

  async setDirectChoice(
    applicationId: string,
    userId: string,
    guildId: string,
  ) {
    this.#directChoices.set(`${applicationId}:${userId}`, guildId);
  }

  async gatewaySession(applicationId: string) {
    return this.#gatewaySessions.get(applicationId);
  }

  async saveGatewaySession(
    applicationId: string,
    session: GatewaySession | undefined,
  ) {
    if (session) this.#gatewaySessions.set(applicationId, { ...session });
    else this.#gatewaySessions.delete(applicationId);
  }

  async setNotifications(
    applicationId: string,
    guildId: string,
    mode: NotificationMode,
  ) {
    const key = `${applicationId}:${guildId}`;
    const one = this.#installations.get(key);
    if (!one || one.state === "removed") return false;
    this.#installations.set(key, { ...one, notifications: mode });
    return true;
  }

  async installations(state?: InstallationState) {
    return [...this.#installations.values()].filter(
      (one) => !state || one.state === state,
    );
  }

  async purgeInstallation(applicationId: string, guildId: string) {
    const prefix = `${applicationId}:${guildId}:`;
    this.#installations.delete(`${applicationId}:${guildId}`);
    for (const key of [...this.#links.keys()])
      if (key.startsWith(prefix)) this.#links.delete(key);
    for (const [key, one] of [...this.#threads])
      if (one.applicationId === applicationId && one.guildId === guildId) {
        this.#threads.delete(key);
        this.#turns.delete(key);
      }
    for (const [key, one] of [...this.#components])
      if (one.applicationId === applicationId && one.guildId === guildId)
        this.#components.delete(key);
    this.#allowances.delete(`${applicationId}:${guildId}`);
    for (const [key, chosen] of [...this.#directChoices])
      if (key.startsWith(`${applicationId}:`) && chosen === guildId)
        this.#directChoices.delete(key);
  }

  async link(applicationId: string, guildId: string, userId: string) {
    return this.#links.get(`${applicationId}:${guildId}:${userId}`);
  }

  async setLinked(
    applicationId: string,
    guildId: string,
    userId: string,
    linked: boolean,
  ) {
    const key = `${applicationId}:${guildId}:${userId}`;
    const pendingUntil = this.#links.get(key)?.pendingUntil;
    this.#links.set(
      key,
      linked || pendingUntil === undefined
        ? { linked }
        : { linked, pendingUntil },
    );
  }

  async setLinkPending(
    applicationId: string,
    guildId: string,
    userId: string,
    until: number | undefined,
  ) {
    const key = `${applicationId}:${guildId}:${userId}`;
    const linked = this.#links.get(key)?.linked ?? false;
    this.#links.set(
      key,
      until === undefined ? { linked } : { linked, pendingUntil: until },
    );
  }

  async linkedGuilds(applicationId: string, userId: string) {
    return [...this.#links.keys()]
      .filter(
        (key) =>
          key.startsWith(`${applicationId}:`) && key.endsWith(`:${userId}`),
      )
      .map((key) => key.split(":")[1]!);
  }

  async forgetUser(applicationId: string, userId: string) {
    let count = 0;
    if (this.#directChoices.delete(`${applicationId}:${userId}`)) count += 1;
    for (const key of [...this.#links.keys()])
      if (key.startsWith(`${applicationId}:`) && key.endsWith(`:${userId}`)) {
        this.#links.delete(key);
        count += 1;
      }
    for (const [key, one] of [...this.#threads])
      if (one.applicationId === applicationId && one.openedBy === userId) {
        this.#threads.set(key, { ...one, openedBy: undefined });
        count += 1;
      }
    for (const [key, one] of [...this.#components])
      if (
        one.applicationId === applicationId &&
        (one.ownerId === userId ||
          (one.kind === "ask-message" && one.payload.authorId === userId))
      ) {
        this.#components.delete(key);
        count += 1;
      } else if (
        one.applicationId === applicationId &&
        one.answeredBy === userId
      ) {
        this.#components.set(key, { ...one, answeredBy: "forgotten" });
        count += 1;
      }
    return count;
  }

  async thread(threadKey: string) {
    return this.#threads.get(threadKey);
  }

  async saveThread(binding: ThreadBinding) {
    this.#threads.set(binding.threadKey, binding);
  }

  async claimTurn(
    threadKey: string,
    owner: string,
    leaseUntil: Date,
    now: Date,
  ): Promise<TurnClaim> {
    const held = this.#turns.get(threadKey);
    if (held && held.owner === owner) {
      held.leaseUntil = leaseUntil;
      return { again: true, ok: true };
    }
    if (held && held.leaseUntil > now) return { ok: false, owner: held.owner };
    this.#turns.set(threadKey, { leaseUntil, owner, stopRequested: false });
    return { again: false, ok: true };
  }

  async renewTurn(threadKey: string, owner: string, leaseUntil: Date) {
    const held = this.#turns.get(threadKey);
    if (held?.owner === owner) held.leaseUntil = leaseUntil;
  }

  async setTurnRun(
    threadKey: string,
    owner: string,
    sessionUid: string,
    runId?: string,
  ) {
    const held = this.#turns.get(threadKey);
    if (held?.owner === owner) {
      held.sessionUid = sessionUid;
      if (runId) held.runId = runId;
    }
  }

  async turn(threadKey: string) {
    const held = this.#turns.get(threadKey);
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
    const held = this.#turns.get(threadKey);
    if (!held) return false;
    held.stopRequested = true;
    return true;
  }

  async releaseTurn(threadKey: string, owner: string) {
    if (this.#turns.get(threadKey)?.owner === owner)
      this.#turns.delete(threadKey);
  }

  async saveComponent(row: ComponentRow) {
    this.#components.set(row.renderId, row);
  }

  async component(renderId: string) {
    return this.#components.get(renderId);
  }

  async answerComponent(renderId: string, by: string) {
    const row = this.#components.get(renderId);
    if (!row || row.answeredBy) return false;
    this.#components.set(renderId, { ...row, answeredBy: by });
    return true;
  }

  async approvalComponents(
    applicationId: string,
    guildId: string,
    approvalId: string,
  ) {
    return [...this.#components.values()].filter(
      (one) =>
        one.applicationId === applicationId &&
        one.guildId === guildId &&
        one.payload.approvalId === approvalId,
    );
  }

  async allowances(applicationId: string, guildId: string) {
    return this.#allowances.get(`${applicationId}:${guildId}`) ?? [];
  }

  async setAllowances(
    applicationId: string,
    guildId: string,
    allowances: readonly Allowance[],
  ) {
    this.#allowances.set(`${applicationId}:${guildId}`, [...allowances]);
  }

  async dropSpentTokens() {
    // The memory queue's jobs live in process memory and end with it.
    return 0;
  }

  async saveState(nonce: string, bindCode: EncryptedSecret, expiresAt: Date) {
    this.#states.set(nonce, { bindCode, expiresAt });
  }

  async spendState(nonce: string, now: Date) {
    const state = this.#states.get(nonce);
    this.#states.delete(nonce);
    return state && state.expiresAt > now ? state.bindCode : undefined;
  }

  async claimEvent(id: string) {
    if (this.#claims.has(id)) return false;
    this.#claims.add(id);
    return true;
  }

  async releaseEvent(id: string) {
    this.#claims.delete(id);
  }
}
