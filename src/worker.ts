import {
  hostMayDecide,
  HostRefusedError,
  quotaEntries,
  quotaWords,
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
  type SessionBinder,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { randomBytes } from "node:crypto";

import { approvalCard, decidedBody, statusWords } from "./approval-card.js";
import type { AsPerson, Person } from "./as-person.js";
import {
  DeliveryHandler,
  finishApproval,
  saveCardRows,
  type DeliveryQueueJob,
} from "./deliveries.js";

import {
  DiscordError,
  type DiscordPort,
  type MessageBody,
} from "./discord-port.js";
import {
  DIRECT,
  externalIdOf,
  isDirect,
  placeOf,
  threadIdOf,
  type DiscordTurn,
  type DiscordTurnRequest,
  type ThreadKey,
} from "./domain.js";
import { handleEvent, type EventJob } from "./events.js";
import type { MessageJob } from "./gateway.js";
import { newRenderId, type InteractionJob } from "./interactions.js";
import { missingPermissions } from "./permissions.js";
import {
  answeredComponents,
  EPHEMERAL,
  finalBodies,
  NO_MENTIONS,
  OPEN_LABEL,
  privately,
  progressBody,
  askingMode,
  secretBearing,
  START_OVER_LABEL,
} from "./render.js";
import type {
  ComponentRow,
  DiscordStore,
  Installation,
  ThreadBinding,
} from "./store.js";
import { refusalWords, whoDecides, WORDS } from "./words.js";

/**
 * The worker: what the ingress persisted, answered.
 * `/ask` end to end — the installation, the person's link, the application
 * (the shared resolution helper), quotas, the thread's turn claimed
 * insert-first, the turn started as the speaker (idempotent on the
 * interaction id), its stream reduced into the shared `TurnState` and edited
 * into `@original` at a bounded cadence, the thread started on the answer,
 * the switch to the bot token at 14 minutes or on a spent token, Stop, and a
 * private or refused turn after a public deferral answered ephemerally.
 * Also `/datalayer` and the components of Phase 1.
 */

/** The bounded edit cadence: at most one edit every 1.5 s. */
export const EDIT_INTERVAL_MS = 1500;
/** How long Discord honours an interaction token. */
export const TOKEN_LIFETIME_MS = 15 * 60 * 1000;
/** When the worker stops using the interaction token (valid 15 minutes). */
export const TOKEN_SWITCH_MS = 14 * 60 * 1000;
/** How long a thread's turn claim holds without renewal. */
export const TURN_LEASE_MS = 5 * 60 * 1000;
/** How often a running turn renews its claim. */
export const TURN_RENEW_MS = 60 * 1000;

/** Discord's JSON error code for a server the bot is no longer in. */
export const UNKNOWN_GUILD = 10004;
/** The reaction on a message while @Datalayer answers it. */
export const WAITING = "⏳";
/** Thread channel types: announcement, public, private. */
const THREAD_TYPES = new Set([10, 11, 12]);
/** Discord's code when a thread was already started on the message. */
export const THREAD_EXISTS = 160004;

export type WorkerDependencies = Readonly<{
  applicationId: string;
  store: DiscordStore;
  port: DiscordPort;
  cipher: SecretCipher;
  hosts: Pick<
    DatalayerHostClient,
    "self" | "linkState" | "linkCode" | "unlink" | "admin" | "acknowledge"
  >;
  /**
   * Datalayer as one member: an approval read or decided, a
   * session's last answer read, with that member's own host token.
   */
  asPerson: AsPerson;
  /** Runs turns, and maps a session again once its answer's thread exists. */
  agent: AgentClient<DiscordTurn> & SessionBinder<DiscordTurn>;
  quotas: QuotaStore;
  limits: QuotaLimits;
  clock: Clock;
  logger: Logger;
  webUrl: string;
  /**
   * *Open in Datalayer* (S-305): a one-use path that opens a session
   * or an approval for the person `request` speaks for (their host token's
   * handoff).
   */
  openLink: (
    request: DiscordTurnRequest,
    kind: "session" | "approval",
    target: string,
  ) => Promise<string>;
  /** This worker process: two copies of one job never both run a turn. */
  instance?: string;
  /** A server Discord says is unknown: removed (`removal.ts`). */
  removed?: (guildId: string) => Promise<unknown>;
}>;

export { secretBearing };

/**
 * Everything of a turn that its messages can show: the answer, the
 * status line, the run's error, the question it ends on and the files it
 * names. A credential in any of them makes the whole output private, not
 * only one in the answer's words.
 */
export function shownText(state: TurnState): string {
  return [
    state.answer,
    state.status,
    state.error ?? "",
    state.asking?.prompt ?? "",
    ...(state.asking?.options ?? []),
    ...state.files.flatMap((file) => [file.name, file.url]),
  ].join("\n");
}

/** Where a turn's messages go: the interaction's `@original`, or a bot message. */
type Surface =
  | { kind: "interaction" }
  | { kind: "bot"; channelId: string; messageId?: string }
  | { kind: "gone" };

export class Worker {
  readonly instance: string;
  /** Datalayer's deliveries: approvals, decisions, finished turns (DC-301). */
  readonly deliveries: DeliveryHandler;

  constructor(readonly deps: WorkerDependencies) {
    this.instance = deps.instance ?? randomBytes(6).toString("hex");
    this.deliveries = new DeliveryHandler({
      asPerson: deps.asPerson,
      cipher: deps.cipher,
      hosts: deps.hosts,
      logger: deps.logger,
      port: deps.port,
      ...(deps.removed ? { removed: deps.removed } : {}),
      store: deps.store,
    });
  }

  async handle(job: Readonly<{ kind: string }>): Promise<void> {
    if (job.kind === "interaction")
      return this.interaction(job as InteractionJob);
    if (job.kind === "delivery")
      return this.deliveries.receive(job as DeliveryQueueJob);
    if (job.kind === "message") return this.message(job as MessageJob);
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
    // A spent token is never used: a job that waited past 15 minutes says
    // nothing, and its token may already be dropped from the queue.
    if (this.deps.clock.now() - job.receivedAt >= TOKEN_LIFETIME_MS) {
      this.deps.logger.warn("interaction.expired", { interaction: job.id });
      return;
    }
    const token = this.deps.cipher.decrypt(job.token, job.id);
    const say = (text: string) => this.#privately(job, token, text);
    if (job.key.guildId === DIRECT) return this.#directInteraction(job, token);
    const installation = await this.deps.store.installation(
      job.key.applicationId,
      job.key.guildId,
    );
    // Late work of a removed server is dropped, never reviving it.
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
      if (job.modal?.startsWith("dc:confirm-"))
        return await this.#decide(job, token, installation, hostKey);
      if (job.modal?.startsWith("dc:ask-message:"))
        return await this.#askMessage(job, token, installation, hostKey);
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

  /**
   * A message over the gateway (DC-202): a mention of @Datalayer in a
   * channel starts a thread on it, keyed by the thread's id, and runs the
   * person's turn there, posted as the bot; in a thread (a forum post is
   * one), and in a reply with the ping on to a bot message whose thread
   * exists, the session continues. ⏳ on the message while it runs. A
   * message without a question (empty, or a reply with the ping off) is
   * told once, as a reply, that a mention is what reaches @Datalayer.
   */
  async message(job: MessageJob): Promise<void> {
    const { store, port, cipher } = this.deps;
    if (!job.guildId) return this.#directMessage(job);
    const installation = await store.installation(
      job.applicationId,
      job.guildId,
    );
    if (!installation || installation.state === "removed") return;
    const hostKey = cipher.decrypt(
      installation.hostKey,
      externalIdOf(installation.applicationId, installation.guildId),
    );
    const prompt = job.content
      .replace(new RegExp(`<@!?${this.deps.applicationId}>`, "g"), "")
      .trim();
    // Said once per message, whatever redelivers it.
    const reply = async (text: string) => {
      if (!(await store.claimEvent(`message-said:${job.id}`))) return;
      await port.createMessage(job.channelId, {
        allowed_mentions: NO_MENTIONS,
        content: text,
        message_reference: { fail_if_not_exists: false, message_id: job.id },
      });
    };
    try {
      if (!job.mentioned || !prompt)
        return void (await reply(WORDS.mentionToContinue));
      if (installation.state === "paused")
        return void (await reply(WORDS.paused));
      const link = await this.#linked(installation, hostKey, job.authorId);
      if (!link.linked) return void (await reply(WORDS.notLinked));

      const base = {
        applicationId: job.applicationId,
        guildId: job.guildId,
      };
      const channel = await port.channel(job.channelId);
      let key: ThreadKey | undefined;
      if (THREAD_TYPES.has(channel.type) && channel.parentId)
        key = {
          ...base,
          channelId: channel.id,
          parentId: channel.parentId,
          thread: channel.id,
        };
      else if (job.reference) {
        // A reply to a bot message: its session, when it has one here.
        const replied: ThreadKey = {
          ...base,
          channelId: job.channelId,
          thread: job.reference.messageId,
        };
        const binding = await store.thread(threadIdOf(replied));
        if (binding?.threadExists)
          key = {
            ...replied,
            channelId: replied.thread,
            parentId: job.channelId,
          };
        else if (binding) key = replied;
      }
      if (!key) {
        // A new thread on the mention: its id is the message's.
        await port.startThread(
          job.channelId,
          job.id,
          prompt.replace(/\s+/g, " ").slice(0, 90) || "Datalayer",
        );
        key = {
          ...base,
          channelId: job.id,
          parentId: job.channelId,
          thread: job.id,
        };
        await port.createMessage(job.id, {
          allowed_mentions: NO_MENTIONS,
          content: `-# ${WORDS.mentionReliable}`,
        });
      }
      await port
        .addReaction(job.channelId, job.id, WAITING)
        .catch((error: unknown) =>
          this.deps.logger.warn("reaction.not_added", { error }),
        );
      try {
        await this.#ask(
          {
            appPermissions: installation.permissions,
            asBot: true,
            command: { name: "ask", options: { question: prompt } },
            ephemeral: false,
            id: job.id,
            key,
            kind: "interaction",
            receivedAt: job.receivedAt,
            replyTo: { channelId: job.channelId, messageId: job.id },
            threadFromOriginal: false,
            // No interaction token: a message's turn never uses one.
            token: cipher.encrypt("", job.id),
            type: 0,
            userId: job.authorId,
            userName: job.authorName,
          },
          "",
          installation,
          hostKey,
        );
      } finally {
        await port
          .removeReaction(job.channelId, job.id, WAITING)
          .catch((error: unknown) =>
            this.deps.logger.warn("reaction.not_removed", { error }),
          );
      }
    } catch (error) {
      if (error instanceof DiscordError && error.code === UNKNOWN_GUILD) {
        await this.deps.removed?.(job.guildId);
        return;
      }
      if (error instanceof DiscordError && error.noAccess) {
        this.deps.logger.warn("discord.no_access", { error });
        return;
      }
      throw error;
    }
  }

  /**
   * The installation a person's direct messages go to (DC-203): a bot DM
   * names no server, so it is the one server of this application where the
   * person is linked, or the one they chose among several (a select, held
   * with their question); none when they are linked nowhere.
   */
  async #directInstallation(
    applicationId: string,
    userId: string,
  ): Promise<
    | { installation: Installation; hostKey: string }
    | { choose: Installation[] }
    | undefined
  > {
    const { store, cipher } = this.deps;
    const candidates: Installation[] = [];
    for (const guildId of await store.linkedGuilds(applicationId, userId)) {
      if ((await store.link(applicationId, guildId, userId))?.linked !== true)
        continue;
      const one = await store.installation(applicationId, guildId);
      if (one && one.state !== "removed") candidates.push(one);
    }
    const chosen = await store.directChoice(applicationId, userId);
    const one =
      candidates.length === 1
        ? candidates[0]
        : candidates.find((each) => each.guildId === chosen);
    if (one)
      return {
        hostKey: cipher.decrypt(
          one.hostKey,
          externalIdOf(one.applicationId, one.guildId),
        ),
        installation: one,
      };
    return candidates.length ? { choose: candidates } : undefined;
  }

  /** The select of the servers a person's direct messages may go to, holding their question. */
  async #directChoiceBody(
    userId: string,
    choose: readonly Installation[],
    held: Readonly<{ prompt: string; messageId?: string }>,
  ): Promise<MessageBody> {
    const renderId = newRenderId();
    const first = choose[0]!;
    await this.deps.store.saveComponent({
      applicationId: first.applicationId,
      guildId: first.guildId,
      kind: "direct",
      ownerId: userId,
      payload: {
        guilds: choose.map((one) => one.guildId),
        prompt: held.prompt,
        ...(held.messageId ? { messageId: held.messageId } : {}),
      },
      renderId,
    });
    const options = [];
    for (const one of choose.slice(0, 25))
      options.push({
        label: (await this.deps.port.guildName(one.guildId)).slice(0, 100),
        value: one.guildId,
      });
    return {
      allowed_mentions: NO_MENTIONS,
      components: [
        {
          components: [
            {
              custom_id: `dc:direct:${renderId}`,
              options,
              placeholder: "Choose the server",
              type: 3,
            },
          ],
          type: 1,
        },
      ],
      content:
        "You are linked in several servers. Which one's Datalayer application answers your direct messages? Your question is answered once you choose.",
    };
  }

  /** The direct-message key: the DM channel, no server. */
  #directKey(applicationId: string, channelId: string): ThreadKey {
    return {
      applicationId,
      channelId,
      guildId: DIRECT,
      thread: channelId,
    };
  }

  /**
   * A direct message to the bot (DC-203): a private session of the person
   * with the installation their DMs go to, posted as the bot in the DM, under
   * ⏳; place `direct`, so an application kept to direct messages answers
   * here and nowhere else.
   */
  async #directMessage(job: MessageJob): Promise<void> {
    const { port, store } = this.deps;
    const reply = async (text: string) => {
      if (!(await store.claimEvent(`message-said:${job.id}`))) return;
      await port.createMessage(job.channelId, {
        allowed_mentions: NO_MENTIONS,
        content: text,
        message_reference: { fail_if_not_exists: false, message_id: job.id },
      });
    };
    const prompt = job.content.trim();
    if (!prompt) return void (await reply(WORDS.writeQuestion));
    const found = await this.#directInstallation(
      job.applicationId,
      job.authorId,
    );
    if (!found) return void (await reply(WORDS.directNotLinked));
    if ("choose" in found) {
      if (!(await store.claimEvent(`message-said:${job.id}`))) return;
      await port.createMessage(
        job.channelId,
        await this.#directChoiceBody(job.authorId, found.choose, {
          messageId: job.id,
          prompt,
        }),
      );
      return;
    }
    await this.#directTurn(
      {
        appPermissions: found.installation.permissions,
        asBot: true,
        command: { name: "ask", options: { question: prompt } },
        ephemeral: false,
        id: job.id,
        key: this.#directKey(job.applicationId, job.channelId),
        kind: "interaction",
        receivedAt: job.receivedAt,
        replyTo: { channelId: job.channelId, messageId: job.id },
        threadFromOriginal: false,
        token: this.deps.cipher.encrypt("", job.id),
        type: 0,
        userId: job.authorId,
        userName: job.authorName,
      },
      "",
      found.installation,
      found.hostKey,
      job.id,
    );
  }

  /** A turn in a DM, under ⏳ on the message it answers (when one). */
  async #directTurn(
    job: InteractionJob,
    token: string,
    installation: Installation,
    hostKey: string,
    messageId?: string,
  ): Promise<void> {
    const { port, logger } = this.deps;
    const channelId = job.key.channelId;
    if (messageId)
      await port
        .addReaction(channelId, messageId, WAITING)
        .catch((error: unknown) =>
          logger.warn("reaction.not_added", { error }),
        );
    try {
      await this.#ask(job, token, installation, hostKey);
    } finally {
      if (messageId)
        await port
          .removeReaction(channelId, messageId, WAITING)
          .catch((error: unknown) =>
            logger.warn("reaction.not_removed", { error }),
          );
    }
  }

  /**
   * An interaction in the bot's DM: a press finds its installation through
   * its row; `/ask` goes to the installation the person's DMs go to;
   * anything else is for a server.
   */
  async #directInteraction(job: InteractionJob, token: string): Promise<void> {
    const { store, cipher } = this.deps;
    const say = (text: string) => this.#privately(job, token, text);
    if (job.component) {
      const row = await store.component(job.component.renderId);
      const installation = row
        ? await store.installation(row.applicationId, row.guildId)
        : undefined;
      if (!row || !installation || installation.state === "removed") {
        await this.deps.port.followUp(
          token,
          privately("This button no longer does anything."),
        );
        return;
      }
      const hostKey = cipher.decrypt(
        installation.hostKey,
        externalIdOf(installation.applicationId, installation.guildId),
      );
      return this.#component(job, token, installation, hostKey);
    }
    if (job.command?.name !== "ask") return say(WORDS.directLater);
    const found = await this.#directInstallation(
      job.key.applicationId,
      job.userId,
    );
    if (!found) return say(WORDS.directNotLinked);
    if ("choose" in found) {
      await this.deps.port.editOriginal(
        token,
        await this.#directChoiceBody(job.userId, found.choose, {
          prompt: String(job.command.options.question ?? ""),
        }),
      );
      return;
    }
    return this.#ask(job, token, found.installation, found.hostKey);
  }

  /**
   * The server chosen for a person's DMs (DC-203): theirs only, once; kept,
   * then the question it held is answered there.
   */
  async #chooseDirect(
    job: InteractionJob,
    token: string,
    row: ComponentRow,
  ): Promise<void> {
    const { store, port, cipher } = this.deps;
    const say = (text: string) => port.followUp(token, privately(text));
    if (row.ownerId !== job.userId) return void (await say(WORDS.notYours));
    const listed: unknown = row.payload.guilds;
    const guilds = Array.isArray(listed)
      ? (listed as unknown[]).filter(
          (one): one is string => typeof one === "string",
        )
      : [];
    const chosen = job.values?.[0];
    if (!chosen || !guilds.includes(chosen))
      return void (await say("Choose one of the servers offered."));
    const installation = await store.installation(row.applicationId, chosen);
    if (!installation || installation.state === "removed")
      return void (await say(WORDS.removed));
    if (!(await store.answerComponent(row.renderId, job.userId)))
      return void (await say(WORDS.alreadyAnswered));
    await store.setDirectChoice(row.applicationId, job.userId, chosen);
    await port.editOriginal(token, {
      allowed_mentions: NO_MENTIONS,
      components: [],
      content: `Your direct messages go to ${await port.guildName(chosen)}'s Datalayer application now.`,
    });
    const prompt = row.payload.prompt;
    const messageId = row.payload.messageId;
    if (typeof prompt !== "string" || !prompt.trim()) return;
    const hostKey = cipher.decrypt(
      installation.hostKey,
      externalIdOf(installation.applicationId, installation.guildId),
    );
    return this.#directTurn(
      {
        ...job,
        asBot: true,
        command: { name: "ask", options: { question: prompt } },
        ephemeral: false,
        key: this.#directKey(row.applicationId, job.key.channelId),
        threadFromOriginal: false,
        ...(typeof messageId === "string"
          ? { replyTo: { channelId: job.key.channelId, messageId } }
          : {}),
      },
      token,
      installation,
      hostKey,
      typeof messageId === "string" ? messageId : undefined,
    );
  }

  /** An answer only the person sees, whatever the deferral was. */
  async #privately(
    job: InteractionJob,
    token: string,
    text: string,
    ours = false,
  ): Promise<void> {
    // A message's turn answers as a reply to that message.
    if (job.replyTo) {
      await this.deps.port.createMessage(job.replyTo.channelId, {
        allowed_mentions: NO_MENTIONS,
        content: text,
        message_reference: {
          fail_if_not_exists: false,
          message_id: job.replyTo.messageId,
        },
      });
      return;
    }
    // A pressed choice's turn never touches the answered message.
    if (job.asBot) {
      await this.deps.port.followUp(token, privately(text, ours));
      return;
    }
    if (job.ephemeral) {
      await this.deps.port.editOriginal(token, {
        ...privately(text, ours),
        components: [],
      });
      return;
    }
    // A public deferral cannot turn private: delete it, follow up ephemerally.
    await this.deps.port.deleteOriginal(token).catch((error: unknown) => {
      if (!(error instanceof DiscordError && error.tokenGone)) throw error;
    });
    await this.deps.port.followUp(token, privately(text, ours));
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
    // message, from which the answer's thread starts.
    let key: ThreadKey = job.key;
    let messageId = job.id;
    if (job.threadFromOriginal) {
      const original = await port.original(token);
      key = { ...job.key, thread: original.id };
      messageId = original.id;
    }
    // *Ask Datalayer*: the turn's provenance is the message asked about.
    if (job.aboutMessageId) messageId = job.aboutMessageId;
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
    // The installation's: a direct message's key names no server.
    const allowances = await store.allowances(
      installation.applicationId,
      installation.guildId,
    );
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
      visibility: isDirect(key) ? "direct" : "channel",
    });
    if (!resolution.ok) return say(refusalWords(resolution.refusal));

    // One turn per thread, claimed insert-first. A second copy of
    // this very job (another worker) says nothing; another person's prompt
    // is told what runs. Nothing is charged before the claim.
    const now = new Date(clock.now());
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
      // Quotas are taken once per interaction: a retried job, which
      // the runtime answers from the same turn, is never charged again.
      const refused = await this.#charge(job, key, installation, resolution);
      if (refused) return await say(refused);
      await this.#turn(job, token, {
        applicationId: resolution.applicationId,
        binding,
        guildId: installation.guildId,
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

  /**
   * Take the person's, the server's, the organization's and the
   * application's quota for this interaction, once: what is said when one is
   * spent, else `undefined`. The charge is claimed by the interaction id
   * before it is taken (released if taking it fails), so a redelivered job
   * goes on uncharged.
   */
  async #charge(
    job: InteractionJob,
    key: ThreadKey,
    installation: Installation,
    resolution: Readonly<{ applicationId: string }>,
  ): Promise<string | undefined> {
    const { store, clock } = this.deps;
    const charge = `quota:${job.id}`;
    if (!(await store.claimEvent(charge))) return undefined;
    const now = new Date(clock.now());
    let taken;
    try {
      taken = await this.deps.quotas.takeQuota(
        quotaEntries(this.deps.limits, {
          applicationId: resolution.applicationId,
          externalUserId: job.userId,
          installation: externalIdOf(
            installation.applicationId,
            installation.guildId,
          ),
          organizationId: installation.organizationUid,
        }),
        windowOf(now),
      );
    } catch (error) {
      await store.releaseEvent(charge);
      throw error;
    }
    if (taken.ok) return undefined;
    return quotaWords(
      {
        limit: taken.entry.limit,
        ok: false,
        resetsAt: resetOf(now),
        scope: taken.entry.scope,
      },
      "this server",
    );
  }

  async #turn(
    job: InteractionJob,
    token: string,
    turn: Readonly<{
      applicationId: string;
      binding?: ThreadBinding;
      /** The installation's server (a direct message's key names none). */
      guildId: string;
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
    // Inside an existing thread, unless the key names the `@original` a
    // thread would start from (a private *Ask Datalayer* asked in a thread
    // has its own session there, never the thread's).
    // A direct message's channel is its conversation, as a thread is.
    const inThread =
      (Boolean(turn.key.parentId) && !job.threadFromOriginal) ||
      isDirect(turn.key);
    const request = {
      applicationId: turn.applicationId,
      externalEventId: `discord:${job.id}`,
      externalUserId: job.userId,
      principalId: turn.principalUid,
      prompt,
      provenance: {
        key: turn.key,
        messageId: turn.messageId,
        private: job.ephemeral,
        // A first `/ask`'s thread does not exist yet: mapped without it,
        // then PUT again once it is started (`openThread` below).
        threadExists: inThread,
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
          installation: externalIdOf(turn.key.applicationId, turn.guildId),
          reason: String(error.status),
          user: job.userId,
        });
        return this.#privately(job, token, WORDS.refusedByDatalayer);
      }
      logger.error("turn.failed", { error, interaction: job.id });
      return this.#privately(job, token, WORDS.failed);
    }
    const bound: ThreadBinding = {
      applicationId: turn.key.applicationId,
      channelId: turn.key.parentId ?? turn.key.channelId,
      deploymentUid: turn.applicationId,
      generation,
      guildId: turn.guildId,
      openedBy: turn.binding?.openedBy ?? job.userId,
      sessionUid: stream.sessionId,
      threadExists: inThread,
      threadKey: turn.threadKey,
    };
    // Unshown until the answer is shown here: a `turn.completed` delivery
    // finishes a turn the worker could not (DC-301).
    await store.saveThread({ ...bound, unshownSessionUid: stream.sessionId });
    await store.setTurnRun(turn.threadKey, turn.owner, stream.sessionId);
    const sessionId = stream.sessionId;

    const stopId = newRenderId();
    await store.saveComponent({
      applicationId: turn.key.applicationId,
      guildId: turn.guildId,
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
    const mayPostIn = (thread: boolean) =>
      missingPermissions(permissions, [
        "VIEW_CHANNEL",
        thread ? "SEND_MESSAGES_IN_THREADS" : "SEND_MESSAGES",
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
    // Reassigned inside the callbacks below (the 14-minute switch), which
    // TypeScript's narrowing does not follow: typed as the union, not narrowed.
    let surface = { kind: "interaction" } as Surface;
    let secret = false;
    let lastEdit = Number.NEGATIVE_INFINITY;
    let lastRenew = clock.now();
    let lastShown = "";
    const flags = job.ephemeral ? EPHEMERAL : 0;
    const where = () => (threadStarted ? turn.key.thread : turn.key.channelId);

    /**
     * The answer's thread, started on `@original` once the whole output is
     * checked and may be public: only after the turn, never while a
     * secret-bearing output could still follow, so no public thread is left
     * on a message that is then deleted. The session is then mapped again
     * with the thread as its target.
     */
    const openThread = async (): Promise<void> => {
      if (!mayThread || threadStarted || secret) return;
      try {
        await port.startThread(
          turn.key.channelId,
          turn.key.thread,
          prompt.replace(/\s+/g, " ").slice(0, 90) || "Datalayer",
        );
      } catch (error) {
        // The target stays the channel's message it was mapped with.
        logger.warn("thread.not_started", { error, interaction: job.id });
        return;
      }
      threadStarted = true;
      try {
        await this.deps.agent.bindSession(sessionId, {
          ...request,
          provenance: { ...request.provenance, threadExists: true },
        });
      } catch (error) {
        logger.error("binding.not_updated", { error, interaction: job.id });
      }
    };

    /**
     * From the interaction token to a bot message where it may post:
     * beside `@original` in its channel (or in the thread it was asked in),
     * never in a thread started before the output is whole and checked.
     */
    const toBot = async (): Promise<Surface> => {
      if (job.ephemeral) return { kind: "gone" };
      return mayPostIn(threadStarted)
        ? { channelId: where(), kind: "bot" }
        : { kind: "gone" };
    };

    // A pressed choice's turn posts as the bot from its start (DC-304).
    if (job.asBot) surface = await toBot();

    const show = async (body: MessageBody): Promise<void> => {
      if (
        surface.kind === "interaction" &&
        clock.now() - job.receivedAt >= TOKEN_SWITCH_MS
      )
        surface = await this.#switch(job, token, toBot);
      if (surface.kind === "interaction") {
        try {
          await port.editOriginal(token, body);
          return;
        } catch (error) {
          if (!(error instanceof DiscordError && error.tokenGone)) throw error;
          logger.warn("interaction.token_gone", { interaction: job.id });
          surface = await toBot();
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
      // Where others read the running answer is never shown: only
      // its status and length, the whole answer once it is checked.
      const body = progressBody(
        state,
        `dc:stop:${stopId}`,
        flags,
        !job.ephemeral,
      );
      if (body.content === lastShown) return;
      lastShown = body.content ?? "";
      lastEdit = now;
      await show(body);
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
      if (!secret && secretBearing(shownText(state))) secret = true;
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
    const openId = newRenderId();
    await store.saveComponent({
      applicationId: turn.key.applicationId,
      guildId: turn.guildId,
      kind: "open",
      ownerId: job.userId,
      payload: {
        applicationId: turn.applicationId,
        kind: "session",
        target: sessionId,
      },
      renderId: openId,
    });
    // A private *Ask Datalayer* answer may be posted in the message's
    // thread by the person who asked, once: never one that holds a secret,
    // nor one that failed or said nothing.
    let postId: string | undefined;
    if (
      job.aboutMessageId &&
      job.ephemeral &&
      !secret &&
      surface.kind === "interaction" &&
      state.answer.trim() &&
      state.ending !== "error"
    ) {
      postId = newRenderId();
      await store.saveComponent({
        applicationId: turn.key.applicationId,
        guildId: turn.guildId,
        kind: "post",
        ownerId: job.userId,
        payload: {
          applicationId: turn.applicationId,
          channelId: turn.key.channelId,
          messageId: job.aboutMessageId,
          openId,
          parentId: turn.key.parentId ?? "",
          sessionUid: sessionId,
          texts: finalBodies(state).map((body) => body.content ?? ""),
        },
        renderId: postId,
      });
    }
    // A question it ended on: five or fewer choices as buttons for the
    // person who asked, answered once per asking event (one `asking` row
    // all its buttons point at); never on a private or secret answer.
    let choiceIds: string[] | undefined;
    const asking = state.asking;
    if (
      asking &&
      askingMode(asking) === "buttons" &&
      !job.ephemeral &&
      !secret &&
      surface.kind !== "gone"
    ) {
      const askingId = newRenderId();
      await store.saveComponent({
        applicationId: turn.key.applicationId,
        guildId: turn.guildId,
        kind: "asking",
        ownerId: job.userId,
        payload: {
          open: `dc:open:${openId}`,
          sessionUid: sessionId,
          threadKey: turn.threadKey,
        },
        renderId: askingId,
      });
      choiceIds = [];
      for (const option of asking.options ?? []) {
        const choiceId = newRenderId();
        await store.saveComponent({
          applicationId: turn.key.applicationId,
          guildId: turn.guildId,
          kind: "answer",
          ownerId: job.userId,
          payload: {
            askingId,
            key: turn.key,
            option,
            threadKey: turn.threadKey,
          },
          renderId: choiceId,
        });
        choiceIds.push(`dc:answer:${choiceId}`);
      }
    }
    await this.#finish(
      job,
      token,
      state,
      secret,
      surface,
      show,
      `dc:open:${openId}`,
      postId && `dc:post:${postId}`,
      choiceIds,
    );
    // The output was whole, checked and public: its thread now has a place
    // on `@original`, also after the 14-minute switch.
    if (!job.ephemeral && surface.kind !== "gone") await openThread();
    // Shown (or said private): no delivery repeats it. A turn that could
    // show nothing stays unshown for `turn.completed`.
    if (surface.kind !== "gone")
      await store.saveThread({ ...bound, threadExists: threadStarted });
  }

  /** The 14-minute switch: from the token to a bot message, or to Datalayer. */
  async #switch(
    job: InteractionJob,
    token: string,
    toBot: () => Promise<Surface>,
  ): Promise<Surface> {
    const next = await toBot();
    if (next.kind === "bot") return next;
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
    openId: string,
    postId?: string,
    choiceIds?: readonly string[],
  ): Promise<void> {
    const { port } = this.deps;
    if (surface.kind === "gone") return;
    if (secret && !job.ephemeral) {
      if (surface.kind === "interaction") {
        const bodies = finalBodies(state, EPHEMERAL, openId);
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
    const bodies = finalBodies(
      state,
      job.ephemeral ? EPHEMERAL : 0,
      openId,
      postId,
      choiceIds,
    );
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
      const { code, expiresIn } = await hosts.linkCode(
        hostKey,
        job.userId,
        job.userName,
      );
      // Until the code expires the cached "not linked" is not trusted: the
      // ingress asks Datalayer before deferring an /ask.
      await store.setLinkPending(
        installation.applicationId,
        installation.guildId,
        job.userId,
        this.deps.clock.now() + expiresIn * 1000,
      );
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
      // Forgotten everywhere it is forgotten: unlinked at Datalayer in
      // every server of this application where the service knew a link,
      // and every row naming them here deleted, not only this server's.
      const guilds = new Set([
        installation.guildId,
        ...(await store.linkedGuilds(installation.applicationId, job.userId)),
      ]);
      for (const guildId of guilds) {
        const one =
          guildId === installation.guildId
            ? installation
            : await store.installation(installation.applicationId, guildId);
        if (!one || one.state === "removed") continue;
        await hosts.unlink(
          guildId === installation.guildId
            ? hostKey
            : this.deps.cipher.decrypt(
                one.hostKey,
                externalIdOf(one.applicationId, one.guildId),
              ),
          job.userId,
        );
        this.deps.logger.audit("identity.unlinked", {
          installation: externalIdOf(one.applicationId, one.guildId),
          reason: "forget",
          user: job.userId,
        });
      }
      const deleted = await store.forgetUser(
        installation.applicationId,
        job.userId,
      );
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
      // Only an authorized person starts over or switches: linked,
      // and the thread's opener while one is recorded.
      const link = await this.#linked(installation, hostKey, job.userId);
      if (!link.linked) return say(WORDS.notLinked);
      const opener = (await store.thread(threadKey))?.openedBy;
      if (opener && opener !== job.userId) return say(WORDS.notOpener);
      if (sub === "start-over") {
        // Held for its own person, with the thread key in the row: the
        // press archives the binding into a new generation, once.
        const renderId = newRenderId();
        await store.saveComponent({
          applicationId: installation.applicationId,
          guildId: installation.guildId,
          kind: "start-over",
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
                  custom_id: `dc:start-over:${renderId}`,
                  label: START_OVER_LABEL,
                  style: 4,
                  type: 2,
                },
              ],
              type: 1,
            },
          ],
          content:
            "Start over? The next question in this thread then starts a new session; this one stays in Datalayer.",
          flags: EPHEMERAL,
        });
        return;
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
   * `/datalayer-admin` (DC-106): Discord shows it only to members with
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
    if (sub === "notifications")
      return this.#notifications(job, token, installation, hostKey);
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

  /**
   * `/datalayer-admin notifications quiet|noisy` (DC-307): how the server
   * hears routine posts, kept on the installation. Only the owner of the
   * connection, linked to it — ai-agents' rule for its admin route, read
   * here through the link and the installation's account.
   */
  async #notifications(
    job: InteractionJob,
    token: string,
    installation: Installation,
    hostKey: string,
  ): Promise<void> {
    const say = (text: string) => this.#privately(job, token, text);
    const mode = job.command?.options.mode;
    if (mode !== "quiet" && mode !== "noisy")
      return say("This command is not one @Datalayer knows.");
    const external = externalIdOf(
      installation.applicationId,
      installation.guildId,
    );
    const link = await this.#linked(installation, hostKey, job.userId);
    const self = await this.deps.hosts.self(hostKey);
    if (!link.linked || link.principalUid !== self.accountUid) {
      this.deps.logger.audit("identity.refused", {
        installation: external,
        reason: "admin",
        user: job.userId,
      });
      return say(WORDS.notOwner);
    }
    await this.deps.store.setNotifications(
      installation.applicationId,
      installation.guildId,
      mode,
    );
    this.deps.logger.audit("admin.changed", {
      by: job.userId,
      installation: external,
      reason: `notifications:${mode}`,
    });
    return say(
      mode === "quiet"
        ? "@Datalayer's later posts in this server notify no one. A person a decision waits on is still notified."
        : "@Datalayer's later posts in this server notify as any message does. It still pings no one but a person a decision waits on.",
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
      ...(binding?.threadExists ? { threadExists: true } : {}),
      ...((nextDeploymentUid ?? binding?.nextDeploymentUid)
        ? { nextDeploymentUid: nextDeploymentUid ?? binding?.nextDeploymentUid }
        : {}),
    });
  }

  /**
   * *Open in Datalayer*: the person the button is for (who asked, or
   * whom an approval waits on), linked, gets their own one-use link to the
   * session or the approval, answered only to them. Datalayer checks the
   * target against their host token's deployment when it makes the link,
   * and the signed-in person against it when the link is opened.
   */
  async #open(
    job: InteractionJob,
    token: string,
    row: ComponentRow,
  ): Promise<void> {
    const say = (text: string) => this.#privately(job, token, text);
    const { kind, target, applicationId } = row.payload;
    if (
      (kind !== "session" && kind !== "approval") ||
      typeof target !== "string" ||
      typeof applicationId !== "string"
    )
      throw new Error(
        `An Open button's row names nothing to open: ${row.renderId}`,
      );
    if (row.ownerId !== job.userId) return say(WORDS.openNotYours);
    const installation = await this.deps.store.installation(
      job.key.applicationId,
      job.key.guildId,
    );
    if (!installation) return say(WORDS.notConnected);
    const hostKey = this.deps.cipher.decrypt(
      installation.hostKey,
      externalIdOf(installation.applicationId, installation.guildId),
    );
    const link = await this.#linked(installation, hostKey, job.userId);
    if (!link.linked) return say(WORDS.notLinked);
    let path: string;
    try {
      path = await this.deps.openLink(
        {
          applicationId,
          externalEventId: `discord:${job.id}`,
          externalUserId: job.userId,
          principalId: link.principalUid ?? "",
          prompt: "",
          provenance: {
            key: job.key,
            messageId: job.id,
            private: true,
            threadExists: Boolean(job.key.parentId),
            userId: job.userId,
          },
        },
        kind,
        target,
      );
    } catch (error) {
      if (error instanceof HostRefusedError) {
        this.deps.logger.audit("identity.refused", {
          installation: externalIdOf(
            installation.applicationId,
            installation.guildId,
          ),
          reason: `open:${error.status}`,
          user: job.userId,
        });
        return say(WORDS.refusedByDatalayer);
      }
      throw error;
    }
    return say(
      `${WORDS.openHere} ${this.deps.webUrl.replace(/\/+$/, "")}${path}`,
    );
  }

  /**
   * *Ask Datalayer* on a message (DC-206): the modal's submit, by the
   * person who opened it, becomes their own private turn — the instruction
   * and the message's text, quoted as what it is, with the message as the
   * turn's provenance — answered only to them. Its row is answered once.
   */
  async #askMessage(
    job: InteractionJob,
    token: string,
    installation: Installation,
    hostKey: string,
  ): Promise<void> {
    const renderId = (job.modal ?? "").split(":")[2] ?? "";
    const row = await this.deps.store.component(renderId);
    if (
      !row ||
      row.kind !== "ask-message" ||
      row.applicationId !== installation.applicationId ||
      row.guildId !== installation.guildId
    )
      return this.#privately(job, token, "This request is no longer known.");
    if (row.ownerId !== job.userId)
      return this.#privately(job, token, WORDS.notYours);
    const { content, messageId } = row.payload;
    if (typeof content !== "string" || typeof messageId !== "string")
      throw new Error(`An Ask Datalayer row names no message: ${row.renderId}`);
    const instruction = (job.fields?.question ?? "").trim();
    if (!instruction)
      return this.#privately(job, token, "Say what Datalayer should do.");
    // Linked first, so a refusal leaves the request to try again.
    const link = await this.#linked(installation, hostKey, job.userId);
    if (!link.linked) return this.#privately(job, token, WORDS.notLinked);
    if (!(await this.deps.store.answerComponent(row.renderId, job.userId)))
      return this.#privately(job, token, WORDS.alreadyAnswered);
    const quoted = content
      ? content
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")
      : "> (a message without text)";
    return this.#ask(
      {
        ...job,
        aboutMessageId: messageId,
        command: {
          name: "ask",
          options: {
            private: true,
            question: `${instruction}\n\nThe message, as written in Discord:\n${quoted}`,
          },
        },
        ephemeral: true,
        // Its own session, keyed on its private `@original`: never the
        // thread's or the channel's, which others read.
        key: { ...job.key, thread: "" },
        threadFromOriginal: true,
      },
      token,
      installation,
      hostKey,
    );
  }

  /**
   * A question's choice pressed (DC-304): by the person who asked, once per
   * asking event — the first choice answers it, any later press of any of
   * its buttons is told so. The choice is their own next turn in the
   * session, posted as the bot in the session's thread (or beside the
   * answered message when no thread exists), never over the answered
   * message, whose buttons only are replaced by what answered.
   */
  async #answer(
    job: InteractionJob,
    token: string,
    installation: Installation,
    hostKey: string,
    row: ComponentRow,
  ): Promise<void> {
    const { port, store } = this.deps;
    const say = (text: string) => port.followUp(token, privately(text));
    if (row.ownerId !== job.userId) return void (await say(WORDS.notYours));
    const { askingId, option, threadKey } = row.payload;
    const key = row.payload.key as ThreadKey | undefined;
    if (
      typeof askingId !== "string" ||
      typeof option !== "string" ||
      typeof threadKey !== "string" ||
      !key
    )
      throw new Error(`A choice's row names no question: ${row.renderId}`);
    if (!(await store.answerComponent(askingId, job.userId)))
      return void (await say(WORDS.alreadyAnswered));
    await store.answerComponent(row.renderId, job.userId);
    // The first accepted answer replaces the buttons with what answered
    // (DC-304): components only, the answer's text kept.
    const open = (await store.component(askingId))?.payload.open;
    if (typeof open !== "string")
      throw new Error(`A question's row names no session button: ${askingId}`);
    await port.editOriginal(token, answeredComponents(option, open));
    const binding = await store.thread(threadKey);
    // Where the session's thread is: the key keeps the thread's id (the
    // answered message's, for a first `/ask`); a thread not started leaves
    // the answer beside that message in its channel.
    const where: ThreadKey =
      binding?.threadExists && !key.parentId
        ? {
            ...key,
            channelId: key.thread,
            parentId: key.channelId,
          }
        : key;
    return this.#ask(
      {
        ...job,
        asBot: true,
        command: { name: "ask", options: { question: option } },
        ephemeral: false,
        key: where,
        threadFromOriginal: false,
      },
      token,
      installation,
      hostKey,
    );
  }

  /**
   * *Post in thread* on a private *Ask Datalayer* answer (DC-206): by the
   * person who asked, once, never for an answer holding a secret. The
   * answer is posted as the bot in the message's thread (started on the
   * message when it has none), and the session is mapped again with that
   * thread as its target; a thread the press started is bound to the session.
   */
  async #post(
    job: InteractionJob,
    token: string,
    installation: Installation,
    hostKey: string,
    row: ComponentRow,
  ): Promise<void> {
    const { port, store } = this.deps;
    const say = (text: string) => port.followUp(token, privately(text));
    if (row.ownerId !== job.userId) return void (await say(WORDS.notYours));
    const {
      applicationId,
      channelId,
      messageId,
      openId,
      parentId,
      sessionUid,
    } = row.payload;
    const listed: unknown = row.payload.texts;
    const texts = Array.isArray(listed)
      ? (listed as unknown[]).filter(
          (one): one is string => typeof one === "string",
        )
      : [];
    if (
      typeof applicationId !== "string" ||
      typeof channelId !== "string" ||
      typeof messageId !== "string" ||
      typeof openId !== "string" ||
      typeof parentId !== "string" ||
      typeof sessionUid !== "string" ||
      !texts.length ||
      texts.length !== (listed as unknown[]).length
    )
      throw new Error(`A Post in thread row names no answer: ${row.renderId}`);
    // Checked again on the press: a secret is never posted.
    if (texts.some((one) => secretBearing(one)))
      return void (await say(WORDS.private));
    if (installation.state === "paused") return void (await say(WORDS.paused));
    const inThread = Boolean(parentId);
    if (
      missingPermissions(job.appPermissions, [
        "VIEW_CHANNEL",
        "SEND_MESSAGES_IN_THREADS",
        ...(inThread ? [] : ["CREATE_PUBLIC_THREADS"]),
      ]).length
    )
      return void (await say(WORDS.cannotPostThread));
    const link = await this.#linked(installation, hostKey, job.userId);
    if (!link.linked) return void (await say(WORDS.notLinked));
    if (!(await store.answerComponent(row.renderId, job.userId)))
      return void (await say(WORDS.alreadyAnswered));

    // The message's thread: the thread it is in, or the one started on it
    // (a thread from a message has the message's id).
    let threadId = channelId;
    let started = false;
    if (!inThread) {
      threadId = messageId;
      try {
        await port.startThread(channelId, messageId, "Datalayer");
        started = true;
      } catch (error) {
        if (!(error instanceof DiscordError && error.code === THREAD_EXISTS))
          throw error;
      }
    }
    for (const [at, content] of texts.entries())
      await port.createMessage(threadId, {
        allowed_mentions: NO_MENTIONS,
        components: [],
        content:
          at === 0
            ? `-# <@${job.userId}> asked Datalayer about this message\n${content}`.slice(
                0,
                2000,
              )
            : content,
      });
    const key: ThreadKey = {
      applicationId: installation.applicationId,
      channelId: threadId,
      guildId: installation.guildId,
      parentId: inThread ? parentId : channelId,
      thread: threadId,
    };
    try {
      await this.deps.agent.bindSession(sessionUid, {
        applicationId,
        externalEventId: `discord:${job.id}`,
        externalUserId: job.userId,
        principalId: link.principalUid ?? "",
        prompt: "",
        provenance: {
          key,
          messageId,
          private: false,
          threadExists: true,
          userId: job.userId,
        },
        sessionId: sessionUid,
      });
    } catch (error) {
      this.deps.logger.error("binding.not_updated", {
        error,
        interaction: job.id,
      });
    }
    // A thread this press started continues the session; an existing
    // thread keeps its own.
    const threadKey = threadIdOf(key);
    if (started && !(await store.thread(threadKey)))
      await store.saveThread({
        applicationId: installation.applicationId,
        channelId: key.parentId ?? channelId,
        deploymentUid: applicationId,
        generation: 0,
        guildId: installation.guildId,
        openedBy: job.userId,
        sessionUid,
        threadKey,
      });
    // The private answer keeps *Open in Datalayer*, without the button.
    await port.editOriginal(token, {
      allowed_mentions: NO_MENTIONS,
      components: [
        {
          components: [
            {
              custom_id: `dc:open:${openId}`,
              label: OPEN_LABEL,
              style: 2,
              type: 2,
            },
          ],
          type: 1,
        },
      ],
    });
    await say(`Posted in <#${threadId}>.`);
  }

  /** The person a press or a submit speaks for, on one deployment. */
  #person(hostKey: string, job: InteractionJob, deploymentUid: string): Person {
    return { deploymentUid, hostKey, userId: job.userId };
  }

  /**
   * *Show the request* (DC-302): the press was deferred privately
   * (type 5, flag 64), so its `@original` is filled with the card for the
   * person the approval waits on, read as them; anyone else is told who
   * decides. An approval no longer pending updates its thread line instead.
   */
  async #show(
    job: InteractionJob,
    token: string,
    installation: Installation,
    hostKey: string,
    row: ComponentRow,
  ): Promise<void> {
    const say = (text: string) => this.#privately(job, token, text);
    const { approvalId, deploymentUid, appName } = row.payload;
    if (
      typeof approvalId !== "string" ||
      typeof deploymentUid !== "string" ||
      typeof appName !== "string"
    )
      throw new Error(`A Show button's row names no approval: ${row.renderId}`);
    if (row.ownerId !== job.userId)
      return this.#privately(job, token, whoDecides(row.ownerId), true);
    const link = await this.#linked(installation, hostKey, job.userId);
    if (!link.linked) return say(WORDS.notLinked);
    let presentation;
    try {
      presentation = await this.deps.asPerson.presentation(
        this.#person(hostKey, job, deploymentUid),
        approvalId,
      );
    } catch (error) {
      if (
        error instanceof HostRefusedError &&
        [403, 404].includes(error.status)
      )
        return say(WORDS.notYours);
      throw error;
    }
    const rows = await this.deps.store.approvalComponents(
      installation.applicationId,
      installation.guildId,
      approvalId,
    );
    if (presentation.status !== "pending") {
      await finishApproval(this.deps.port, rows, presentation.status);
      return say(
        `${statusWords(presentation.status)}: this request is no longer waiting.`,
      );
    }
    const ids = {
      approve: newRenderId(),
      open: newRenderId(),
      reject: newRenderId(),
    };
    const card = approvalCard(presentation, {
      appName,
      flags: EPHEMERAL,
      ids,
    });
    await saveCardRows(
      this.deps.store,
      {
        applicationId: installation.applicationId,
        guildId: installation.guildId,
        ownerId: job.userId,
      },
      ids,
      {
        approvalId,
        deploymentUid,
        digest: presentation.digest,
        toolName: presentation.tool_name,
      },
    );
    await this.deps.port.editOriginal(token, card.body);
  }

  /**
   * A confirmed Approve or Reject (DC-303): the modal's submit was
   * deferred as an update of the card, so the card is edited once decided
   * and anything else is said in a private follow-up. Only the person the
   * card was made for decides; the approval is read again as them, decided
   * only when still pending, still the presentation shown (its digest) and
   * one a host may decide, and once (claimed by the approval).
   */
  async #decide(
    job: InteractionJob,
    token: string,
    installation: Installation,
    hostKey: string,
  ): Promise<void> {
    const { store, port, logger } = this.deps;
    const tell = (text: string) =>
      port.followUp(token, privately(text)).then(() => undefined);
    const [, kind, renderId] = (job.modal ?? "").split(":");
    const approve = kind === "confirm-approve";
    const row = renderId ? await store.component(renderId) : undefined;
    if (
      !row ||
      row.kind !== (approve ? "approve" : "reject") ||
      row.applicationId !== installation.applicationId ||
      row.guildId !== installation.guildId
    )
      return tell("This button no longer does anything.");
    const { approvalId, deploymentUid, digest, toolName } = row.payload;
    if (
      typeof approvalId !== "string" ||
      typeof deploymentUid !== "string" ||
      typeof digest !== "string" ||
      typeof toolName !== "string"
    )
      throw new Error(`A decision's row names no approval: ${row.renderId}`);
    if (row.ownerId !== job.userId)
      return port
        .followUp(token, privately(whoDecides(row.ownerId), true))
        .then(() => undefined);
    const claim = `decision:${installation.applicationId}:${approvalId}`;
    if (!(await store.claimEvent(claim))) return tell(WORDS.alreadyAnswered);
    let decided = false;
    try {
      const link = await this.#linked(installation, hostKey, job.userId);
      if (!link.linked) return await tell(WORDS.notLinked);
      const person = this.#person(hostKey, job, deploymentUid);
      const rows = () =>
        store.approvalComponents(
          installation.applicationId,
          installation.guildId,
          approvalId,
        );
      let presentation;
      try {
        presentation = await this.deps.asPerson.presentation(
          person,
          approvalId,
        );
      } catch (error) {
        if (
          error instanceof HostRefusedError &&
          [403, 404].includes(error.status)
        )
          return await tell(WORDS.notYours);
        throw error;
      }
      if (presentation.status !== "pending") {
        decided = true;
        await finishApproval(port, await rows(), presentation.status);
        await port.editOriginal(
          token,
          decidedBody(toolName, presentation.status),
        );
        return;
      }
      if (presentation.digest !== digest || !hostMayDecide(presentation))
        return await tell(WORDS.approvalChanged);
      let status: string;
      try {
        ({ status } = await this.deps.asPerson.decide(person, approvalId, {
          approve,
          digest,
          ...(job.fields?.note ? { note: job.fields.note } : {}),
        }));
      } catch (error) {
        if (error instanceof HostRefusedError) {
          if (error.status === 404) return await tell(WORDS.notYours);
          if (error.status === 403 || error.status === 409)
            return await tell(WORDS.approvalChanged);
        }
        throw error;
      }
      decided = true;
      // The decision itself is audited at Datalayer, as the person.
      logger.info("approval.decided", { status });
      const all = await rows();
      for (const one of all)
        await store.answerComponent(one.renderId, job.userId);
      await finishApproval(port, all, status, job.userId);
      await port.editOriginal(token, decidedBody(toolName, status, job.userId));
    } finally {
      if (!decided) await store.releaseEvent(claim);
    }
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
    // An unknown, foreign or transplanted component does nothing.
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
      const { threadKey, sessionUid, applicationId } = row.payload;
      if (
        typeof threadKey !== "string" ||
        typeof sessionUid !== "string" ||
        typeof applicationId !== "string"
      )
        throw new Error(`A Stop button's row names no turn: ${row.renderId}`);
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
        await this.deps.agent.stopTurn(sessionUid, {
          applicationId,
          externalEventId: `discord:${job.id}`,
          externalUserId: job.userId,
          principalId: link.principalUid ?? "",
          prompt: "",
          provenance: {
            key: job.key,
            messageId: job.id,
            private: job.ephemeral,
            threadExists: Boolean(job.key.parentId),
            userId: job.userId,
          },
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
    if (component.kind === "open") return this.#open(job, token, row);
    if (component.kind === "post")
      return this.#post(job, token, installation, hostKey, row);
    if (component.kind === "direct") return this.#chooseDirect(job, token, row);
    if (component.kind === "show")
      return this.#show(job, token, installation, hostKey, row);
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
      // Answered once: a second choice from the same menu changes nothing.
      if (!(await store.answerComponent(row.renderId, job.userId))) {
        await this.deps.port.followUp(token, privately(WORDS.alreadyAnswered));
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
    if (component.kind === "answer")
      return this.#answer(job, token, installation, hostKey, row);
    if (component.kind === "start-over") {
      if (row.ownerId !== job.userId) {
        await this.deps.port.followUp(token, privately(WORDS.notYours));
        return;
      }
      if (!(await store.answerComponent(row.renderId, job.userId))) {
        await this.deps.port.followUp(token, privately(WORDS.alreadyAnswered));
        return;
      }
      const key = row.payload.key as ThreadKey;
      await this.#newGeneration(threadIdOf(key), key, undefined);
      await this.deps.port.editOriginal(token, {
        allowed_mentions: NO_MENTIONS,
        components: [],
        content: "Done: the next question in this thread starts a new session.",
      });
      return;
    }
    await this.deps.port.followUp(
      token,
      privately("This button is not available yet."),
    );
  }
}
