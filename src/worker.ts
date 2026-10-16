import {
  HostRefusedError,
  quotaEntries,
  quotaWords,
  redact,
  resetOf,
  resolveApplication,
  TurnState,
  usableAllowances,
  userQuotaKey,
  windowOf,
  type AgentClient,
  type Clock,
  type DatalayerHostClient,
  type HostSelf,
  type Logger,
  type QuotaLimits,
  type QuotaStore,
  type SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { randomBytes } from "node:crypto";

import {
  DiscordError,
  type DiscordPort,
  type MessageBody,
} from "./discord-port.js";
import {
  DIRECT,
  externalIdOf,
  placeOf,
  threadIdOf,
  type DiscordTurn,
  type ThreadKey,
} from "./domain.js";
import { handleEvent, type EventJob } from "./events.js";
import { newRenderId, type InteractionJob } from "./interactions.js";
import { missingPermissions } from "./permissions.js";
import {
  EPHEMERAL,
  finalBodies,
  NO_MENTIONS,
  privately,
  progressBody,
} from "./render.js";
import type { DiscordStore, Installation, ThreadBinding } from "./store.js";
import { refusalWords, WORDS } from "./words.js";

/**
 * The worker (plans/DISCORD.md §7.5): what the ingress persisted, answered.
 * `/ask` end to end — the installation, the person's link, the application
 * (the shared resolution helper), quotas, the thread's turn claimed
 * insert-first, the turn started as the speaker (idempotent on the
 * interaction id), its stream reduced into the shared `TurnState` and edited
 * into `@original` at a bounded cadence, the thread started on the answer,
 * the switch to the bot token at 14 minutes or on a spent token, Stop, and a
 * private or refused turn after a public deferral answered ephemerally
 * (§7.1). Also `/datalayer` and the components of Phase 1.
 */

/** The bounded edit cadence: at most one edit every 1.5 s (§7.5). */
export const EDIT_INTERVAL_MS = 1500;
/** When the worker stops using the interaction token (valid 15 minutes). */
export const TOKEN_SWITCH_MS = 14 * 60 * 1000;
/** How long a thread's turn claim holds without renewal. */
export const TURN_LEASE_MS = 5 * 60 * 1000;
/** How often a running turn renews its claim. */
export const TURN_RENEW_MS = 60 * 1000;

/** Discord's JSON error code for a server the bot is no longer in. */
export const UNKNOWN_GUILD = 10004;

export type WorkerDependencies = Readonly<{
  applicationId: string;
  store: DiscordStore;
  port: DiscordPort;
  cipher: SecretCipher;
  hosts: Pick<
    DatalayerHostClient,
    "self" | "linkState" | "linkCode" | "unlink" | "admin"
  >;
  agent: AgentClient<DiscordTurn>;
  quotas: QuotaStore;
  limits: QuotaLimits;
  clock: Clock;
  logger: Logger;
  webUrl: string;
  /** This worker process: two copies of one job never both run a turn. */
  instance?: string;
  /** A server Discord says is unknown: removed (§7.4, `removal.ts`). */
  removed?: (guildId: string) => Promise<unknown>;
}>;

/** Whether a text holds a credential-shaped value (the shared redaction's shapes). */
export function secretBearing(text: string): boolean {
  return redact(text) !== text;
}

/** Where a turn's messages go: the interaction's `@original`, or a bot message. */
type Surface =
  | { kind: "interaction" }
  | { kind: "bot"; channelId: string; messageId?: string }
  | { kind: "gone" };

export class Worker {
  readonly instance: string;

  constructor(readonly deps: WorkerDependencies) {
    this.instance = deps.instance ?? randomBytes(6).toString("hex");
  }

  async handle(job: Readonly<{ kind: string }>): Promise<void> {
    if (job.kind === "interaction")
      return this.interaction(job as InteractionJob);
    if (job.kind === "event") {
      await handleEvent(job as EventJob, {
        applicationId: this.deps.applicationId,
        logger: this.deps.logger,
        store: this.deps.store,
      });
      return;
    }
    throw new Error(`A job of an unknown kind: ${job.kind}`);
  }

  async interaction(job: InteractionJob): Promise<void> {
    const token = this.deps.cipher.decrypt(job.token, job.id);
    // A spent token is never used: a job that waited past 15 minutes says nothing.
    if (this.deps.clock.now() - job.receivedAt >= 15 * 60 * 1000) {
      this.deps.logger.warn("interaction.expired", { interaction: job.id });
      return;
    }
    const say = (text: string) => this.#privately(job, token, text);
    if (job.key.guildId === DIRECT) return say(WORDS.directLater);
    const installation = await this.deps.store.installation(
      job.key.applicationId,
      job.key.guildId,
    );
    // Late work of a removed server is dropped, never reviving it (§7.4).
    if (installation?.state === "removed") return;
    if (!installation) return say(WORDS.notConnected);
    const hostKey = this.deps.cipher.decrypt(
      installation.hostKey,
      externalIdOf(installation.applicationId, installation.guildId),
    );
    try {
      if (job.command?.name === "ask")
        return await this.#ask(job, token, installation, hostKey);
      if (job.command?.name === "datalayer")
        return await this.#datalayer(job, token, installation, hostKey);
      if (job.component)
        return await this.#component(job, token, installation, hostKey);
      if (job.command?.name === "datalayer-admin")
        return await this.#admin(job, token, installation, hostKey);
      return await say("This request is not one @Datalayer answers yet.");
    } catch (error) {
      if (error instanceof DiscordError && error.code === UNKNOWN_GUILD) {
        await this.deps.removed?.(job.key.guildId);
        return;
      }
      if (error instanceof DiscordError && error.noAccess) {
        this.deps.logger.warn("discord.no_access", {
          interaction: job.id,
          error,
        });
        return;
      }
      throw error;
    }
  }

  /** An answer only the person sees, whatever the deferral was (§7.1). */
  async #privately(
    job: InteractionJob,
    token: string,
    text: string,
  ): Promise<void> {
    if (job.ephemeral) {
      await this.deps.port.editOriginal(token, {
        ...privately(text),
        components: [],
      });
      return;
    }
    // A public deferral cannot turn private: delete it, follow up ephemerally.
    await this.deps.port.deleteOriginal(token).catch((error: unknown) => {
      if (!(error instanceof DiscordError && error.tokenGone)) throw error;
    });
    await this.deps.port.followUp(token, privately(text));
  }

  async #linked(
    installation: Installation,
    hostKey: string,
    userId: string,
  ): Promise<{ linked: boolean; principalUid?: string }> {
    const state = await this.deps.hosts.linkState(hostKey, userId);
    await this.deps.store.setLinked(
      installation.applicationId,
      installation.guildId,
      userId,
      state.linked,
    );
    return state;
  }

  async #self(installation: Installation, hostKey: string): Promise<HostSelf> {
    const self = await this.deps.hosts.self(hostKey);
    await this.deps.store.setAllowances(
      installation.applicationId,
      installation.guildId,
      self.deployments.map((one) => ({
        applicationId: one.uid,
        channelPolicy: self.directOnly.includes(one.uid)
          ? ("direct-only" as const)
          : ("channels" as const),
        enabled: true,
        name: one.appName || one.uid,
      })),
    );
    return self;
  }

  async #ask(
    job: InteractionJob,
    token: string,
    installation: Installation,
    hostKey: string,
  ): Promise<void> {
    const { store, port, clock } = this.deps;
    const say = (text: string) => this.#privately(job, token, text);
    if (installation.state === "paused") return say(WORDS.paused);
    const link = await this.#linked(installation, hostKey, job.userId);
    if (!link.linked) return say(WORDS.notLinked);
    const self = await this.#self(installation, hostKey);
    if (self.paused) return say(WORDS.paused);

    // The thread: a first `/ask` in a channel is keyed on its `@original`
    // message, from which the answer's thread starts (§3.2).
    let key: ThreadKey = job.key;
    let messageId = job.id;
    if (job.threadFromOriginal) {
      const original = await port.original(token);
      key = { ...job.key, thread: original.id };
      messageId = original.id;
    }
    const threadKey = threadIdOf(key);
    const binding = await store.thread(threadKey);
    const explicit =
      typeof job.command?.options.application === "string"
        ? job.command.options.application
        : undefined;
    if (
      binding?.deploymentUid &&
      explicit &&
      explicit !== binding.deploymentUid
    )
      return say(WORDS.switchExplicitly);
    const allowances = await store.allowances(key.applicationId, key.guildId);
    const place = placeOf(key);
    const resolution = await resolveApplication({
      allowances,
      channel: async () => {
        const rule = self.channels.find((one) => one.id === place.id);
        return rule
          ? {
              state: rule.state,
              ...(rule.deployment ? { applicationId: rule.deployment } : {}),
            }
          : undefined;
      },
      defaultApplication: async () => self.defaultDeployment,
      explicit,
      next: async () => binding?.nextDeploymentUid,
      threadApplication: binding?.deploymentUid,
      visibility: "channel",
    });
    if (!resolution.ok) return say(refusalWords(resolution.refusal));

    const now = new Date(clock.now());
    const taken = await this.deps.quotas.takeQuota(
      quotaEntries(this.deps.limits, {
        applicationId: resolution.applicationId,
        externalUserId: job.userId,
        installation: externalIdOf(key.applicationId, key.guildId),
        organizationId: installation.organizationUid,
      }),
      windowOf(now),
    );
    if (!taken.ok)
      return say(
        quotaWords(
          {
            limit: taken.entry.limit,
            ok: false,
            resetsAt: resetOf(now),
            scope: taken.entry.scope,
          },
          "this server",
        ),
      );

    // One turn per thread, claimed insert-first (§7.5). A second copy of
    // this very job (another worker) says nothing; another person's prompt
    // is told what runs.
    const owner = `${job.id}:${this.instance}`;
    const claim = await store.claimTurn(
      threadKey,
      owner,
      new Date(clock.now() + TURN_LEASE_MS),
      now,
    );
    if (!claim.ok) {
      if (claim.owner.startsWith(`${job.id}:`)) return;
      return say(WORDS.busy);
    }
    try {
      await this.#turn(job, token, {
        applicationId: resolution.applicationId,
        binding,
        key,
        messageId,
        owner,
        principalUid: link.principalUid ?? "",
        threadKey,
      });
    } finally {
      await store.releaseTurn(threadKey, owner);
    }
  }

  async #turn(
    job: InteractionJob,
    token: string,
    turn: Readonly<{
      applicationId: string;
      binding?: ThreadBinding;
      key: ThreadKey;
      messageId: string;
      owner: string;
      principalUid: string;
      threadKey: string;
    }>,
  ): Promise<void> {
    const { store, port, clock, logger } = this.deps;
    const prompt = String(job.command?.options.question ?? "");
    const sameApplication =
      turn.binding?.deploymentUid === turn.applicationId &&
      Boolean(turn.binding.sessionUid);
    const generation = turn.binding?.generation ?? 0;
    const request = {
      applicationId: turn.applicationId,
      externalEventId: `discord:${job.id}`,
      externalUserId: job.userId,
      principalId: turn.principalUid,
      prompt,
      provenance: {
        key: turn.key,
        messageId: turn.messageId,
        userId: job.userId,
      },
      sessionGeneration: generation,
      ...(sameApplication ? { sessionId: turn.binding?.sessionUid } : {}),
    };
    let stream;
    try {
      stream = await this.deps.agent.startTurn(request);
    } catch (error) {
      if (
        error instanceof HostRefusedError &&
        [401, 403, 404].includes(error.status)
      ) {
        logger.audit("identity.refused", {
          installation: externalIdOf(turn.key.applicationId, turn.key.guildId),
          reason: String(error.status),
          user: job.userId,
        });
        return this.#privately(job, token, WORDS.refusedByDatalayer);
      }
      logger.error("turn.failed", { error, interaction: job.id });
      return this.#privately(job, token, WORDS.failed);
    }
    await store.saveThread({
      applicationId: turn.key.applicationId,
      channelId: turn.key.parentId ?? turn.key.channelId,
      deploymentUid: turn.applicationId,
      generation,
      guildId: turn.key.guildId,
      openedBy: turn.binding?.openedBy ?? job.userId,
      sessionUid: stream.sessionId,
      threadKey: turn.threadKey,
    });
    await store.setTurnRun(turn.threadKey, turn.owner, stream.sessionId);

    const stopId = newRenderId();
    await store.saveComponent({
      applicationId: turn.key.applicationId,
      guildId: turn.key.guildId,
      kind: "stop",
      ownerId: job.userId,
      payload: {
        applicationId: turn.applicationId,
        sessionUid: stream.sessionId,
        threadKey: turn.threadKey,
      },
      renderId: stopId,
    });

    const state = new TurnState();
    const permissions = job.appPermissions;
    const inThread = Boolean(turn.key.parentId);
    const mayPost =
      missingPermissions(permissions, [
        "VIEW_CHANNEL",
        inThread || job.threadFromOriginal
          ? "SEND_MESSAGES_IN_THREADS"
          : "SEND_MESSAGES",
      ]).length === 0;
    const mayThread =
      job.threadFromOriginal &&
      !job.ephemeral &&
      missingPermissions(permissions, [
        "VIEW_CHANNEL",
        "CREATE_PUBLIC_THREADS",
        "SEND_MESSAGES_IN_THREADS",
      ]).length === 0;
    let threadStarted = inThread;
    let surface: Surface = { kind: "interaction" };
    let secret = false;
    let lastEdit = Number.NEGATIVE_INFINITY;
    let lastRenew = clock.now();
    let lastShown = "";
    const flags = job.ephemeral ? EPHEMERAL : 0;
    const where = () => (threadStarted ? turn.key.thread : turn.key.channelId);

    const show = async (body: MessageBody): Promise<void> => {
      if (
        surface.kind === "interaction" &&
        clock.now() - job.receivedAt >= TOKEN_SWITCH_MS
      )
        surface = await this.#switch(job, token, mayPost, where());
      if (surface.kind === "interaction") {
        try {
          await port.editOriginal(token, body);
          return;
        } catch (error) {
          if (!(error instanceof DiscordError && error.tokenGone)) throw error;
          logger.warn("interaction.token_gone", { interaction: job.id });
          surface =
            mayPost && !job.ephemeral
              ? { channelId: where(), kind: "bot" }
              : { kind: "gone" };
        }
      }
      if (surface.kind === "bot") {
        const plain = { ...body, flags: undefined };
        if (surface.messageId)
          await port.editMessage(surface.channelId, surface.messageId, plain);
        else
          surface.messageId = (
            await port.createMessage(surface.channelId, plain)
          ).id;
      }
    };

    const progress = async (): Promise<void> => {
      const now = clock.now();
      if (now - lastRenew >= TURN_RENEW_MS) {
        await store.renewTurn(
          turn.threadKey,
          turn.owner,
          new Date(now + TURN_LEASE_MS),
        );
        lastRenew = now;
      }
      if (now - lastEdit < EDIT_INTERVAL_MS) return;
      // A secret-bearing answer is never shown where others read (§2, 5).
      const shown = secret && !job.ephemeral ? new TurnState() : state;
      if (shown !== state)
        shown.apply({ kind: "progress", label: state.status });
      const body = progressBody(shown, `dc:stop:${stopId}`, flags);
      if (body.content === lastShown) return;
      lastShown = body.content ?? "";
      lastEdit = now;
      await show(body);
      if (mayThread && !threadStarted && surface.kind === "interaction") {
        try {
          await port.startThread(
            turn.key.channelId,
            turn.key.thread,
            prompt.replace(/\s+/g, " ").slice(0, 90) || "Datalayer",
          );
          threadStarted = true;
        } catch (error) {
          logger.warn("thread.not_started", { error, interaction: job.id });
        }
      }
    };

    // The deferral already shows that @Datalayer is thinking: the first
    // edit comes with the first event, then at most one per interval.
    for await (const event of stream.updates) {
      state.apply(event);
      if (stream.run.id)
        await store.setTurnRun(
          turn.threadKey,
          turn.owner,
          stream.sessionId,
          stream.run.id,
        );
      if (!secret && secretBearing(state.answer)) secret = true;
      if (state.ended) break;
      await progress();
    }
    if (!state.ended) {
      // After Stop the run stream just ends: the host that pressed Stop says
      // so (DC-005's finding); any other end without an answer is a failure.
      const held = await store.turn(turn.threadKey);
      state.apply(
        held?.stopRequested
          ? { kind: "stop" }
          : { kind: "error", message: WORDS.endedEarly },
      );
    }
    await this.#finish(job, token, state, secret, surface, show);
  }

  /** The 14-minute switch (§7.5): from the token to a bot message, or to Datalayer. */
  async #switch(
    job: InteractionJob,
    token: string,
    mayPost: boolean,
    channelId: string,
  ): Promise<Surface> {
    if (mayPost && !job.ephemeral) return { channelId, kind: "bot" };
    // The last edit the token allows says where the answer waits.
    await this.deps.port
      .editOriginal(token, {
        allowed_mentions: NO_MENTIONS,
        components: [],
        content: `${WORDS.waitsInDatalayer} ${this.deps.webUrl}`,
        ...(job.ephemeral ? { flags: EPHEMERAL } : {}),
      })
      .catch(() => undefined);
    return { kind: "gone" };
  }

  async #finish(
    job: InteractionJob,
    token: string,
    state: TurnState,
    secret: boolean,
    surface: Surface,
    show: (body: MessageBody) => Promise<void>,
  ): Promise<void> {
    const { port } = this.deps;
    if (surface.kind === "gone") return;
    if (secret && !job.ephemeral) {
      if (surface.kind === "interaction") {
        const bodies = finalBodies(state, EPHEMERAL);
        await port.deleteOriginal(token);
        await port.followUp(token, {
          ...bodies[0]!,
          content: `${WORDS.private}\n\n${bodies[0]!.content ?? ""}`.slice(
            0,
            2000,
          ),
        });
        for (const body of bodies.slice(1)) await port.followUp(token, body);
      } else {
        await show({
          allowed_mentions: NO_MENTIONS,
          components: [],
          content: `${WORDS.privateAfterExpiry} ${this.deps.webUrl}`,
        });
      }
      return;
    }
    const bodies = finalBodies(state, job.ephemeral ? EPHEMERAL : 0);
    await show(bodies[0]!);
    for (const body of bodies.slice(1)) {
      if (surface.kind === "interaction") await port.followUp(token, body);
      else
        await port.createMessage(surface.channelId, {
          ...body,
          flags: undefined,
        });
    }
  }

  async #datalayer(
    job: InteractionJob,
    token: string,
    installation: Installation,
    hostKey: string,
  ): Promise<void> {
    const { store, hosts, webUrl } = this.deps;
    const say = (text: string) => this.#privately(job, token, text);
    const sub = job.command?.subcommand;
    const external = externalIdOf(
      installation.applicationId,
      installation.guildId,
    );
    if (sub === "link") {
      const link = await this.#linked(installation, hostKey, job.userId);
      if (link.linked)
        return say(
          "Your Datalayer account is linked here already. `/datalayer unlink` ends it.",
        );
      const { code } = await hosts.linkCode(hostKey, job.userId, job.userName);
      return say(
        `Link your Datalayer account: ${webUrl.replace(/\/+$/, "")}/hosts/link?code=${encodeURIComponent(code)}\nSign in to Datalayer, check what it shows and confirm. The link works once, for ten minutes.`,
      );
    }
    if (sub === "unlink") {
      const revoked = await hosts.unlink(hostKey, job.userId);
      await store.setLinked(
        installation.applicationId,
        installation.guildId,
        job.userId,
        false,
      );
      this.deps.logger.audit("identity.unlinked", {
        installation: external,
        user: job.userId,
      });
      return say(
        revoked
          ? "Your Datalayer account is unlinked from this server. `/datalayer link` links it again."
          : "Your Datalayer account was not linked here.",
      );
    }
    if (sub === "forget") {
      await hosts.unlink(hostKey, job.userId);
      const deleted = await store.forgetUser(
        installation.applicationId,
        job.userId,
      );
      this.deps.logger.audit("identity.unlinked", {
        installation: external,
        reason: "forget",
        user: job.userId,
      });
      return say(
        `Done: your account is unlinked and ${deleted} Discord record${deleted === 1 ? "" : "s"} naming you at Datalayer ${deleted === 1 ? "is" : "are"} deleted. Your sessions stay in Datalayer under its record retention; delete them there.`,
      );
    }
    if (sub === "status") {
      const link = await this.#linked(installation, hostKey, job.userId);
      const self = await this.#self(installation, hostKey);
      const thread = job.threadFromOriginal
        ? undefined
        : await store.thread(threadIdOf(job.key));
      const name = (uid?: string) =>
        self.deployments.find((one) => one.uid === uid)?.appName || uid;
      const used = await this.deps.quotas.quotaUsed(
        userQuotaKey(external, job.userId),
        windowOf(new Date(this.deps.clock.now())),
      );
      return say(
        [
          `This server is connected to Datalayer${self.paused || installation.state === "paused" ? ", paused" : ""}.`,
          link.linked
            ? "Your Datalayer account is linked."
            : "Your Datalayer account is not linked: `/datalayer link`.",
          thread?.deploymentUid
            ? `This thread runs ${name(thread.deploymentUid)}.`
            : self.defaultDeployment
              ? `New questions here go to ${name(self.defaultDeployment)}.`
              : "No default application: `/datalayer app`.",
          `You asked ${used} question${used === 1 ? "" : "s"} this hour (limit ${this.deps.limits.user}).`,
          `Guide: ${webUrl.replace(/\/+$/, "")}/docs/discord`,
        ].join("\n"),
      );
    }
    if (sub === "app" || sub === "start-over") {
      // A thread's application and session are switched inside the thread;
      // in a channel, `/ask application:` names it for that question.
      if (job.threadFromOriginal)
        return say(
          sub === "app"
            ? "In a channel, name the application with `/ask application:`. Inside a thread @Datalayer answers in, `/datalayer app` switches the thread's application."
            : "Start over works inside a thread @Datalayer answers in.",
        );
      const threadKey = threadIdOf(job.key);
      if (sub === "start-over") {
        await this.#newGeneration(threadKey, job.key, undefined);
        return say(
          "Done: the next question in this thread starts a new session.",
        );
      }
      await this.#self(installation, hostKey);
      const choices = usableAllowances(
        await store.allowances(
          installation.applicationId,
          installation.guildId,
        ),
        "channel",
      ).slice(0, 25);
      if (choices.length === 0) return say(refusalWords("no-application"));
      const renderId = newRenderId();
      await store.saveComponent({
        applicationId: installation.applicationId,
        guildId: installation.guildId,
        kind: "app",
        ownerId: job.userId,
        payload: { key: job.key },
        renderId,
      });
      await this.deps.port.editOriginal(token, {
        allowed_mentions: NO_MENTIONS,
        components: [
          {
            components: [
              {
                custom_id: `dc:app:${renderId}`,
                options: choices.map((one) => ({
                  label: one.name.slice(0, 100),
                  value: one.applicationId,
                })),
                placeholder: "Choose the application",
                type: 3,
              },
            ],
            type: 1,
          },
        ],
        content:
          "Which application answers in this thread? Switching starts a new session.",
        flags: EPHEMERAL,
      });
      return;
    }
    return say("This command is not one @Datalayer knows.");
  }

  /**
   * `/datalayer-admin` (§6.1, DC-106): Discord shows it only to members with
   * Manage Server; Datalayer then lets only the member linked to the
   * connection's owner pause, resume or set this channel's rule.
   */
  async #admin(
    job: InteractionJob,
    token: string,
    installation: Installation,
    hostKey: string,
  ): Promise<void> {
    const say = (text: string) => this.#privately(job, token, text);
    const sub = job.command?.subcommand;
    const place = placeOf(job.key);
    const state = job.command?.options.state;
    const change:
      | { paused?: boolean; channel?: { id: string; state: "allow" | "deny" } }
      | undefined =
      sub === "pause"
        ? { paused: true }
        : sub === "resume"
          ? { paused: false }
          : sub === "channel" && (state === "allow" || state === "deny")
            ? { channel: { id: place.id, state } }
            : undefined;
    if (!change) return say("This command is not one @Datalayer knows.");
    try {
      const answered = await this.deps.hosts.admin(hostKey, job.userId, change);
      if (change.paused !== undefined)
        await this.deps.store.setInstallationState(
          installation.applicationId,
          installation.guildId,
          answered.paused ? "paused" : "active",
          new Date(this.deps.clock.now()),
        );
    } catch (error) {
      if (error instanceof HostRefusedError && error.status === 403) {
        this.deps.logger.audit("identity.refused", {
          installation: externalIdOf(
            installation.applicationId,
            installation.guildId,
          ),
          reason: "admin",
          user: job.userId,
        });
        return say(WORDS.notOwner);
      }
      throw error;
    }
    this.deps.logger.audit("admin.changed", {
      by: job.userId,
      installation: externalIdOf(
        installation.applicationId,
        installation.guildId,
      ),
      reason: sub ?? "",
    });
    return say(
      sub === "pause"
        ? "@Datalayer is paused in this server: it answers nothing until `/datalayer-admin resume`."
        : sub === "resume"
          ? "@Datalayer answers again in this server."
          : change.channel?.state === "deny"
            ? "@Datalayer no longer answers in this channel or its threads."
            : "@Datalayer answers in this channel and its threads.",
    );
  }

  /** A new session generation for a thread (start over, switch), its application set or kept. */
  async #newGeneration(
    threadKey: string,
    key: ThreadKey,
    nextDeploymentUid: string | undefined,
  ): Promise<void> {
    const binding = await this.deps.store.thread(threadKey);
    await this.deps.store.saveThread({
      applicationId: key.applicationId,
      channelId: key.parentId ?? key.channelId,
      generation: (binding?.generation ?? 0) + 1,
      guildId: key.guildId,
      threadKey,
      ...(binding?.openedBy ? { openedBy: binding.openedBy } : {}),
      ...((nextDeploymentUid ?? binding?.nextDeploymentUid)
        ? { nextDeploymentUid: nextDeploymentUid ?? binding?.nextDeploymentUid }
        : {}),
    });
  }

  async #component(
    job: InteractionJob,
    token: string,
    installation: Installation,
    hostKey: string,
  ): Promise<void> {
    const { store } = this.deps;
    const component = job.component!;
    const row = await store.component(component.renderId);
    // An unknown, foreign or transplanted component does nothing (§7.6).
    if (
      !row ||
      row.kind !== component.kind ||
      row.applicationId !== installation.applicationId ||
      row.guildId !== installation.guildId
    ) {
      await this.deps.port.followUp(
        token,
        privately("This button no longer does anything."),
      );
      return;
    }
    if (component.kind === "stop") {
      const threadKey = String(row.payload.threadKey);
      const held = await store.turn(threadKey);
      if (!held) {
        await this.deps.port.followUp(
          token,
          privately("This turn has already ended."),
        );
        return;
      }
      // Datalayer stops the run as the person who pressed (their exchange).
      const link = await this.#linked(installation, hostKey, job.userId);
      if (!link.linked) {
        await this.deps.port.followUp(token, privately(WORDS.notLinked));
        return;
      }
      await store.requestStop(threadKey);
      try {
        await this.deps.agent.stopTurn(String(row.payload.sessionUid), {
          applicationId: String(row.payload.applicationId),
          externalEventId: `discord:${job.id}`,
          externalUserId: job.userId,
          principalId: link.principalUid ?? "",
          prompt: "",
          provenance: { key: job.key, messageId: job.id, userId: job.userId },
        });
      } catch (error) {
        if (error instanceof HostRefusedError) {
          await this.deps.port.followUp(
            token,
            privately(WORDS.refusedByDatalayer),
          );
          return;
        }
        throw error;
      }
      return;
    }
    if (component.kind === "app") {
      if (row.ownerId !== job.userId) {
        await this.deps.port.followUp(token, privately(WORDS.notYours));
        return;
      }
      const chosen = job.values?.[0];
      const allowed = usableAllowances(
        await store.allowances(
          installation.applicationId,
          installation.guildId,
        ),
        "channel",
      ).find((one) => one.applicationId === chosen);
      if (!chosen || !allowed) {
        await this.deps.port.followUp(
          token,
          privately(refusalWords("not-allowed")),
        );
        return;
      }
      const key = row.payload.key as ThreadKey;
      // A switch archives the binding and opens a new generation (S-208).
      await this.#newGeneration(threadIdOf(key), key, chosen);
      await this.deps.port.editOriginal(token, {
        allowed_mentions: NO_MENTIONS,
        components: [],
        content: `${allowed.name} answers the next question here, in a new session.`,
      });
      return;
    }
    await this.deps.port.followUp(
      token,
      privately("This button is not available yet."),
    );
  }
}
