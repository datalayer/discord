import {
  receiveDelivery,
  type DatalayerHostClient,
  type DeliveryJob,
  type DeliverySink,
  type HostDelivery,
  type Logger,
  type SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { z } from "zod";

import { approvalCard, decidedBody, waitingLine } from "./approval-card.js";
import type { AsPerson, Person } from "./as-person.js";
import {
  DiscordError,
  type DiscordPort,
  type MessageBody,
  type SentMessage,
} from "./discord-port.js";
import { DIRECT, externalIdOf, threadIdOf } from "./domain.js";
import { newRenderId } from "./interactions.js";
import { OPEN_LABEL, routine, secretBearing } from "./render.js";
import type { DiscordStore, Installation } from "./store.js";
import { WORDS } from "./words.js";

/**
 * Datalayer's deliveries to Discord (DC-301 to DC-303):
 * the shared signed webhook and outbox (`receiveDelivery`, each
 * handled once by its uid, then acknowledged), shown with the bot token
 * where the session was mapped — an approval as a line in its thread that
 * pings its owner alone with *Show the request* (or the card itself in a
 * DM), a decision taken anywhere as that line's outcome, and a turn whose
 * answer was not shown here finished as a bot message. A thread that is
 * gone (deleted, or archived and locked) falls back to its parent channel;
 * a removed installation's deliveries are dropped.
 */

/** The target `targetOf` (domain.ts) gave, handed back verbatim with each delivery. */
export const targetSchema = z
  .object({
    applicationId: z.string().regex(/^\d{17,20}$/),
    guildId: z.string().min(1),
    channelId: z.string().regex(/^\d{17,20}$/),
    messageId: z.string().regex(/^\d{17,20}$/),
    threadId: z
      .string()
      .regex(/^\d{17,20}$/)
      .optional(),
    private: z.literal(true).optional(),
    userId: z.string().regex(/^\d{17,20}$/),
  })
  .strict();
export type DeliveryTarget = z.infer<typeof targetSchema>;

/** The queue's job for one delivery of one installation. */
export type DeliveryQueueJob = DeliveryJob & Readonly<{ kind: "delivery" }>;

/** Discord's codes for a channel that is gone or a thread that cannot take a message. */
const UNKNOWN_CHANNEL = 10003;
const THREAD_ARCHIVED = 50083;

/** The installation's associated data for its delivery secret at rest. */
export const deliverySecretData = (installation: Installation): string =>
  `delivery:${externalIdOf(installation.applicationId, installation.guildId)}`;

/** The store, as the shared deliveries read it: a removed installation has no key. */
export function deliverySinkOf(
  store: DiscordStore,
  cipher: SecretCipher,
): DeliverySink {
  const keyOf = (installation: Installation) =>
    cipher.decrypt(
      installation.hostKey,
      externalIdOf(installation.applicationId, installation.guildId),
    );
  return {
    boundHosts: async () =>
      (await store.installations())
        .filter((one) => one.state !== "removed")
        .map((one) => ({ hostKey: keyOf(one), hostUid: one.hostUid })),
    deliverySecretOf: async (hostUid) => {
      const installation = await store.installationByHost(hostUid);
      return installation?.deliverySecret && installation.state !== "removed"
        ? cipher.decrypt(
            installation.deliverySecret,
            deliverySecretData(installation),
          )
        : undefined;
    },
    hostKeyOf: async (hostUid) => {
      const installation = await store.installationByHost(hostUid);
      return installation && installation.state !== "removed"
        ? keyOf(installation)
        : undefined;
    },
  };
}

export type DeliveryDependencies = Readonly<{
  store: DiscordStore;
  cipher: SecretCipher;
  port: DiscordPort;
  hosts: Pick<DatalayerHostClient, "acknowledge">;
  asPerson: AsPerson;
  logger: Logger;
  /** A server Discord says is unknown: removed. */
  removed?: (guildId: string) => Promise<unknown>;
}>;

export class DeliveryHandler {
  constructor(readonly deps: DeliveryDependencies) {}

  /** One delivery of an installation, handled once, then acknowledged at Datalayer. */
  async receive(job: DeliveryJob): Promise<void> {
    const { store, cipher, hosts } = this.deps;
    await receiveDelivery(job, {
      claims: store,
      client: hosts,
      handle: async (delivery) => {
        const installation = await store.installationByHost(job.hostUid);
        if (installation && installation.state !== "removed")
          await this.handle(installation, delivery);
      },
      sink: deliverySinkOf(store, cipher),
    });
  }

  async handle(
    installation: Installation,
    delivery: HostDelivery,
  ): Promise<void> {
    const target = targetSchema.safeParse(delivery.payload.target);
    // A target this service did not give, or another server's: nothing
    // shown. A direct message's names no server (`@me`): the delivery came
    // with this installation's key, so its session is this installation's.
    if (
      !target.success ||
      target.data.applicationId !== installation.applicationId ||
      (target.data.guildId !== installation.guildId &&
        target.data.guildId !== DIRECT)
    ) {
      this.deps.logger.warn("delivery.foreign_target", {
        delivery: delivery.delivery,
      });
      return;
    }
    try {
      switch (delivery.event) {
        case "approval.requested":
          return await this.#requested(
            installation,
            target.data,
            delivery.payload,
          );
        case "approval.decided":
          return await this.#decided(installation, delivery.payload);
        case "turn.completed":
          return await this.#completed(
            installation,
            target.data,
            delivery.payload,
          );
      }
    } catch (error) {
      if (error instanceof DiscordError && error.code === 10004) {
        await this.deps.removed?.(installation.guildId);
        return;
      }
      throw error;
    }
  }

  #person(
    installation: Installation,
    userId: string,
    deploymentUid: string,
  ): Person {
    return {
      deploymentUid,
      hostKey: this.deps.cipher.decrypt(
        installation.hostKey,
        externalIdOf(installation.applicationId, installation.guildId),
      ),
      userId,
    };
  }

  /**
   * Post where the session lives: its thread, else (no thread, or one that
   * is gone) its channel. `undefined` when the bot may not post there.
   */
  async #post(
    target: DeliveryTarget,
    body: MessageBody,
  ): Promise<SentMessage | undefined> {
    const { port, logger } = this.deps;
    if (target.threadId)
      try {
        return await port.createMessage(target.threadId, body);
      } catch (error) {
        if (
          !(
            error instanceof DiscordError &&
            (error.code === UNKNOWN_CHANNEL ||
              error.code === THREAD_ARCHIVED ||
              error.status === 404)
          )
        )
          throw error;
        logger.warn("delivery.thread_gone", { code: error.code });
      }
    try {
      return await port.createMessage(target.channelId, body);
    } catch (error) {
      if (
        error instanceof DiscordError &&
        error.code !== 10004 &&
        (error.noAccess || error.code === UNKNOWN_CHANNEL)
      ) {
        logger.warn("delivery.no_access", { code: error.code });
        return undefined;
      }
      throw error;
    }
  }

  async #appName(
    installation: Installation,
    deploymentUid: string,
  ): Promise<string> {
    const allowances = await this.deps.store.allowances(
      installation.applicationId,
      installation.guildId,
    );
    return (
      allowances.find((one) => one.applicationId === deploymentUid)?.name ?? ""
    );
  }

  async #requested(
    installation: Installation,
    target: DeliveryTarget,
    payload: Readonly<{
      approval_id: string;
      deployment_uid: string;
      session_uid: string;
      tool_name: string;
    }>,
  ): Promise<void> {
    const { store, logger } = this.deps;
    // A private turn shows nothing where others read: its approval
    // waits in Datalayer, where its owner is told.
    if (target.private) {
      logger.info("delivery.private", { event: "approval.requested" });
      return;
    }
    if (
      (
        await store.approvalComponents(
          installation.applicationId,
          installation.guildId,
          payload.approval_id,
        )
      ).length > 0
    )
      return;
    const appName = await this.#appName(installation, payload.deployment_uid);
    const common = {
      applicationId: installation.applicationId,
      guildId: installation.guildId,
      ownerId: target.userId,
    };
    if (target.guildId === DIRECT) {
      // A DM: the card itself, to the only person who reads there.
      const person = this.#person(
        installation,
        target.userId,
        payload.deployment_uid,
      );
      const presentation = await this.deps.asPerson.presentation(
        person,
        payload.approval_id,
      );
      const ids = {
        approve: newRenderId(),
        open: newRenderId(),
        reject: newRenderId(),
      };
      const card = approvalCard(presentation, { appName, ids });
      const posted = await this.#post(target, card.body);
      if (!posted) return;
      await saveCardRows(
        store,
        common,
        ids,
        {
          approvalId: payload.approval_id,
          deploymentUid: payload.deployment_uid,
          digest: presentation.digest,
          toolName: presentation.tool_name,
        },
        posted,
      );
      return;
    }
    const showId = newRenderId();
    const posted = await this.#post(
      target,
      waitingLine(appName, target.userId, payload.tool_name, showId),
    );
    if (!posted) return;
    await store.saveComponent({
      ...common,
      kind: "show",
      payload: {
        appName,
        approvalId: payload.approval_id,
        channelId: posted.channelId,
        deploymentUid: payload.deployment_uid,
        messageId: posted.id,
        sessionUid: payload.session_uid,
        toolName: payload.tool_name,
      },
      renderId: showId,
    });
  }

  async #decided(
    installation: Installation,
    payload: Readonly<{ approval_id: string; status: string }>,
  ): Promise<void> {
    const rows = await this.deps.store.approvalComponents(
      installation.applicationId,
      installation.guildId,
      payload.approval_id,
    );
    await finishApproval(this.deps.port, rows, payload.status);
  }

  async #completed(
    installation: Installation,
    target: DeliveryTarget,
    payload: Readonly<{ deployment_uid: string; session_uid: string }>,
  ): Promise<void> {
    const { store } = this.deps;
    const threadKey = threadIdOf({
      applicationId: target.applicationId,
      channelId: target.channelId,
      guildId: target.guildId,
      thread: target.threadId ?? target.messageId,
    });
    const binding = await store.thread(threadKey);
    // Its answer was shown as it streamed: nothing more to say. A private
    // turn's is never said where others read: it waits in Datalayer.
    if (binding?.unshownSessionUid !== payload.session_uid) return;
    if (target.private) {
      this.deps.logger.info("delivery.private", { event: "turn.completed" });
      return;
    }
    const openId = newRenderId();
    await store.saveComponent({
      applicationId: installation.applicationId,
      guildId: installation.guildId,
      kind: "open",
      ownerId: target.userId,
      payload: {
        applicationId: payload.deployment_uid,
        kind: "session",
        target: payload.session_uid,
      },
      renderId: openId,
    });
    const text = await this.deps.asPerson.lastAnswer(
      this.#person(installation, target.userId, payload.deployment_uid),
      payload.session_uid,
    );
    // Where others read, an answer that holds something private is never
    // shown: only that it waits in Datalayer.
    const content =
      text === undefined || secretBearing(text)
        ? WORDS.finishedInDatalayer
        : text || WORDS.endedEarly;
    // Quiet or noisy: the server's own choice (DC-307).
    const bodies = routine(content, installation.notifications);
    const last = bodies.length - 1;
    for (const [at, body] of bodies.entries())
      if (
        !(await this.#post(
          target,
          at === last
            ? {
                ...body,
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
              }
            : body,
        ))
      )
        return;
    await store.saveThread({ ...binding, unshownSessionUid: undefined });
  }
}

/** Save the rows of a card's Approve, Reject and Open buttons. */
export async function saveCardRows(
  store: DiscordStore,
  common: Readonly<{ applicationId: string; guildId: string; ownerId: string }>,
  ids: Readonly<{ approve: string; reject: string; open: string }>,
  approval: Readonly<{
    approvalId: string;
    deploymentUid: string;
    digest: string;
    toolName: string;
  }>,
  posted?: SentMessage,
): Promise<void> {
  const where = posted
    ? { channelId: posted.channelId, messageId: posted.id }
    : {};
  await store.saveComponent({
    ...common,
    kind: "approve",
    payload: { ...approval, ...where },
    renderId: ids.approve,
  });
  await store.saveComponent({
    ...common,
    kind: "reject",
    payload: { ...approval },
    renderId: ids.reject,
  });
  await store.saveComponent({
    ...common,
    kind: "open",
    payload: {
      applicationId: approval.deploymentUid,
      approvalId: approval.approvalId,
      kind: "approval",
      target: approval.approvalId,
    },
    renderId: ids.open,
  });
}

/**
 * Every message of an approval this service posted (its thread line, a DM's
 * card), decided: its outcome, by whom when decided in Discord, no buttons.
 */
export async function finishApproval(
  port: DiscordPort,
  rows: ReadonlyArray<{
    kind: string;
    answeredBy?: string;
    payload: Readonly<Record<string, unknown>>;
  }>,
  status: string,
  byUserId?: string,
): Promise<void> {
  const by =
    byUserId ??
    rows.find((one) => one.kind === "show" && one.answeredBy !== "forgotten")
      ?.answeredBy;
  for (const row of rows) {
    const { channelId, messageId, toolName } = row.payload;
    if (typeof channelId !== "string" || typeof messageId !== "string")
      continue;
    await port.editMessage(
      channelId,
      messageId,
      decidedBody(typeof toolName === "string" ? toolName : "", status, by),
    );
  }
}
