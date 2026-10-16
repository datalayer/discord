import {
  usableAllowances,
  type EncryptedSecret,
  type Logger,
  type SecretCipher,
  type WorkQueue,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { DIRECT, type ThreadKey } from "./domain.js";
import { EPHEMERAL, NO_MENTIONS } from "./render.js";
import type { DiscordJob } from "./resources.js";
import type { DiscordStore } from "./store.js";
import { BodyTooLargeError, rawBodyOf, signedByDiscord } from "./verify.js";

/**
 * `POST /discord/interactions` (DC-102): verify the
 * signature and the window on the raw body (401 otherwise), answer PING,
 * normalize, claim the interaction id and enqueue its job in one
 * transaction, and answer inline within three seconds — a deferral whose
 * ephemeral state is decided here, a modal, autocomplete from the cache, or,
 * when nothing could be persisted, an ephemeral refusal (Discord does not
 * retry an interaction). No network call is made before answering.
 */

/** Interaction types (Discord). */
const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const AUTOCOMPLETE = 4;
const MODAL_SUBMIT = 5;

/** Response types (Discord). */
export const RESPONSE = {
  autocomplete: 8,
  deferredMessage: 5,
  deferredUpdate: 6,
  message: 4,
  modal: 9,
  pong: 1,
} as const;

/** Thread channel types: announcement, public, private. */
const THREAD_TYPES = new Set([10, 11, 12]);
const DM_TYPES = new Set([1, 3]);

/** The component kinds a `custom_id` names (`dc:<kind>:<render id>`). */
export const COMPONENT_KINDS = [
  "stop",
  "approve",
  "reject",
  "show",
  "answer",
  "app",
  "start-over",
  "open",
] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

const RENDER_ID = /^[A-Za-z0-9_-]{8,40}$/;

/** A component's `custom_id`, or `undefined` for one the service never made. */
export function componentOf(
  customId: string,
): { kind: ComponentKind; renderId: string } | undefined {
  const [prefix, kind, renderId, ...rest] = customId.split(":");
  if (prefix !== "dc" || rest.length || !renderId || !RENDER_ID.test(renderId))
    return undefined;
  if (!(COMPONENT_KINDS as readonly string[]).includes(kind ?? ""))
    return undefined;
  return { kind: kind as ComponentKind, renderId };
}

/** A new render id: what a `custom_id` points at. */
export function newRenderId(): string {
  return randomBytes(12).toString("base64url");
}

const user = z.object({ id: z.string(), username: z.string().optional() });
const option: z.ZodType<{
  name: string;
  type: number;
  value?: unknown;
  focused?: boolean;
  options?: unknown[];
}> = z.lazy(() =>
  z
    .object({
      name: z.string(),
      type: z.number(),
      value: z.unknown().optional(),
      focused: z.boolean().optional(),
      options: z.array(option).optional(),
    })
    .loose(),
);

const interactionSchema = z
  .object({
    id: z.string().regex(/^\d{17,20}$/),
    application_id: z.string(),
    type: z.number().int(),
    token: z.string().min(1).optional(),
    guild_id: z.string().optional(),
    channel: z
      .object({
        id: z.string(),
        type: z.number(),
        parent_id: z.string().nullable().optional(),
      })
      .loose()
      .optional(),
    member: z.object({ user }).loose().optional(),
    user: user.optional(),
    app_permissions: z.string().optional(),
    data: z
      .object({
        name: z.string().optional(),
        type: z.number().optional(),
        custom_id: z.string().optional(),
        values: z.array(z.string()).optional(),
        options: z.array(option).optional(),
        target_id: z.string().optional(),
        resolved: z
          .object({
            messages: z
              .record(
                z.string(),
                z
                  .object({
                    id: z.string(),
                    content: z.string().optional(),
                    author: user.optional(),
                  })
                  .loose(),
              )
              .optional(),
          })
          .loose()
          .optional(),
        components: z.array(z.unknown()).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

type Interaction = z.infer<typeof interactionSchema>;

/** What the worker is handed: the interaction normalized, its token encrypted. */
export type InteractionJob = Readonly<{
  kind: "interaction";
  id: string;
  type: number;
  key: ThreadKey;
  /** Whether `key.thread` waits for the `@original` message's id. */
  threadFromOriginal: boolean;
  userId: string;
  userName: string;
  /** Encrypted, bound to the interaction id; never logged. */
  token: EncryptedSecret;
  receivedAt: number;
  appPermissions: string;
  /** Whether the deferral was ephemeral: Discord keeps it. */
  ephemeral: boolean;
  command?: Readonly<{
    name: string;
    subcommand?: string;
    options: Readonly<Record<string, string | number | boolean>>;
  }>;
  component?: Readonly<{ kind: ComponentKind; renderId: string }>;
  values?: readonly string[];
  /** A modal's fields, by custom id. */
  fields?: Readonly<Record<string, string>>;
  modal?: string;
  /**
   * The message *Ask Datalayer* asks about (DC-206): set by the
   * worker, never by the ingress; the turn's provenance names it.
   */
  aboutMessageId?: string;
}>;

/** A message answered inline, ephemeral. */
const inline = (content: string) => ({
  data: { allowed_mentions: NO_MENTIONS, content, flags: EPHEMERAL },
  type: RESPONSE.message,
});

/** What the ingress says when the request could not be kept. */
export const NOT_TAKEN =
  "Datalayer could not take this request just now. Nothing was sent: try again in a moment.";
export const UNKNOWN_COMPONENT =
  "This button is not one @Datalayer knows. Nothing was done.";

function optionsOf(
  options: readonly {
    name: string;
    type: number;
    value?: unknown;
    options?: unknown[];
  }[] = [],
): { subcommand?: string; options: Record<string, string | number | boolean> } {
  const first = options[0];
  if (first && (first.type === 1 || first.type === 2))
    return {
      subcommand: first.name,
      ...optionsOf((first.options ?? []) as typeof options),
    };
  const values: Record<string, string | number | boolean> = {};
  for (const one of options)
    if (
      typeof one.value === "string" ||
      typeof one.value === "number" ||
      typeof one.value === "boolean"
    )
      values[one.name] = one.value;
  return { options: values };
}

function focusedOf(
  options: readonly {
    name: string;
    value?: unknown;
    focused?: boolean;
    options?: unknown[];
  }[] = [],
): string | undefined {
  for (const one of options) {
    if (one.focused) return typeof one.value === "string" ? one.value : "";
    const inner = focusedOf((one.options ?? []) as typeof options);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

function fieldsOf(components: readonly unknown[] = []): Record<string, string> {
  const fields: Record<string, string> = {};
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const one = node as {
      custom_id?: unknown;
      value?: unknown;
      components?: unknown[];
      component?: unknown;
    };
    if (typeof one.custom_id === "string" && typeof one.value === "string")
      fields[one.custom_id] = one.value;
    one.components?.forEach(visit);
    if (one.component) visit(one.component);
  };
  components.forEach(visit);
  return fields;
}

/** The conversation an interaction comes from. */
export function keyOf(interaction: Interaction): {
  key: ThreadKey;
  threadFromOriginal: boolean;
} {
  const channel = interaction.channel;
  if (!channel) throw new Error("An interaction without its channel.");
  if (!interaction.guild_id || DM_TYPES.has(channel.type))
    return {
      key: {
        applicationId: interaction.application_id,
        channelId: channel.id,
        guildId: DIRECT,
        thread: channel.id,
      },
      threadFromOriginal: false,
    };
  if (THREAD_TYPES.has(channel.type) && channel.parent_id)
    return {
      key: {
        applicationId: interaction.application_id,
        channelId: channel.id,
        guildId: interaction.guild_id,
        parentId: channel.parent_id,
        thread: channel.id,
      },
      threadFromOriginal: false,
    };
  return {
    key: {
      applicationId: interaction.application_id,
      channelId: channel.id,
      guildId: interaction.guild_id,
      // Filled with the `@original` message's id by the worker.
      thread: "",
    },
    threadFromOriginal: true,
  };
}

export type InteractionDependencies = Readonly<{
  applicationId: string;
  publicKey: string;
  queue: WorkQueue<DiscordJob>;
  store: DiscordStore;
  cipher: SecretCipher;
  logger: Logger;
  /** Now, in milliseconds. */
  now?: () => number;
}>;

/** The interactions endpoint as a Node request handler. */
export function interactionsRoute(dependencies: InteractionDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const send = (status: number, body?: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    let rawBody: Buffer;
    try {
      rawBody = await rawBodyOf(request);
    } catch (error) {
      if (error instanceof BodyTooLargeError)
        return send(413, { error: "too large" });
      throw error;
    }
    if (
      !(await signedByDiscord(
        request,
        rawBody,
        dependencies.publicKey,
        Math.floor(now() / 1000),
      ))
    )
      return send(401, { error: "invalid request signature" });
    let parsed: Interaction;
    try {
      parsed = interactionSchema.parse(JSON.parse(rawBody.toString("utf8")));
    } catch {
      return send(400, { error: "not an interaction" });
    }
    if (parsed.type === PING) return send(200, { type: RESPONSE.pong });
    if (parsed.application_id !== dependencies.applicationId)
      return send(400, { error: "another application's interaction" });
    send(200, await answerOf(parsed, dependencies, now));
  };
}

/** The inline answer to a verified interaction, after its job is kept. */
async function answerOf(
  interaction: Interaction,
  dependencies: InteractionDependencies,
  now: () => number,
): Promise<unknown> {
  const { store } = dependencies;
  const { key, threadFromOriginal } = keyOf(interaction);
  const person = interaction.member?.user ?? interaction.user;
  if (!person || !interaction.token) return inline(NOT_TAKEN);
  const data = interaction.data ?? {};

  if (interaction.type === AUTOCOMPLETE) {
    // From the cached allowance list, never a network call.
    const typed = (focusedOf(data.options) ?? "").toLowerCase();
    const allowances = usableAllowances(
      await store.allowances(key.applicationId, key.guildId),
      key.guildId === DIRECT ? "direct" : "channel",
    );
    return {
      data: {
        choices: allowances
          .filter((one) => one.name.toLowerCase().includes(typed))
          .slice(0, 25)
          .map((one) => ({
            name: one.name.slice(0, 100),
            value: one.applicationId,
          })),
      },
      type: RESPONSE.autocomplete,
    };
  }

  // The message command: a modal asking what to ask, the target kept for
  // its submit (DC-206). No network call.
  if (interaction.type === APPLICATION_COMMAND && data.type === 3) {
    const target = data.target_id
      ? data.resolved?.messages?.[data.target_id]
      : undefined;
    if (!target) return inline(NOT_TAKEN);
    const renderId = newRenderId();
    try {
      await store.saveComponent({
        applicationId: key.applicationId,
        guildId: key.guildId,
        kind: "ask-message",
        ownerId: person.id,
        payload: {
          authorId: target.author?.id ?? "",
          content: target.content ?? "",
          messageId: target.id,
        },
        renderId,
      });
    } catch {
      return inline(NOT_TAKEN);
    }
    return {
      data: {
        components: [
          {
            components: [
              {
                custom_id: "question",
                label: "What should Datalayer do with this message?",
                max_length: 4000,
                min_length: 1,
                placeholder: "Summarize it, answer it, check it…",
                required: true,
                style: 2,
                type: 4,
              },
            ],
            type: 1,
          },
        ],
        custom_id: `dc:ask-message:${renderId}`,
        title: "Ask Datalayer",
      },
      type: RESPONSE.modal,
    };
  }

  let component: InteractionJob["component"];
  let answer: unknown;
  let ephemeral = true;
  let command: InteractionJob["command"];
  let modal: string | undefined;

  if (interaction.type === APPLICATION_COMMAND) {
    command = { name: data.name ?? "", ...optionsOf(data.options) };
    if (command.name === "ask") {
      const linked = await store
        .linked(key.applicationId, key.guildId, person.id)
        .catch(() => undefined);
      // Public only in a server, for a linked person who did not ask for
      // privacy; Discord keeps the deferral's ephemeral state.
      ephemeral =
        key.guildId !== DIRECT &&
        (command.options.private === true || linked !== true);
    } else if (
      command.name !== "datalayer" &&
      command.name !== "datalayer-admin"
    )
      return inline("This command is not one @Datalayer knows.");
    answer = {
      data: ephemeral ? { flags: EPHEMERAL } : {},
      type: RESPONSE.deferredMessage,
    };
  } else if (interaction.type === MESSAGE_COMPONENT) {
    component = componentOf(data.custom_id ?? "");
    if (!component) return inline(UNKNOWN_COMPONENT);
    if (component.kind === "approve" || component.kind === "reject") {
      // The confirmation modal at once: type 9 is not allowed later.
      return {
        data: {
          components: [
            {
              components: [
                {
                  custom_id: "note",
                  label: "A note for the record (optional)",
                  max_length: 500,
                  required: false,
                  style: 2,
                  type: 4,
                },
              ],
              type: 1,
            },
          ],
          custom_id: `dc:confirm-${component.kind}:${component.renderId}`,
          title:
            component.kind === "approve"
              ? "Approve this request?"
              : "Reject this request?",
        },
        type: RESPONSE.modal,
      };
    }
    if (component.kind === "show" || component.kind === "open") {
      // Answered privately after a network read (*Open in Datalayer* makes the presser's own one-use link).
      answer = { data: { flags: EPHEMERAL }, type: RESPONSE.deferredMessage };
    } else {
      ephemeral = false;
      answer = { type: RESPONSE.deferredUpdate };
    }
  } else if (interaction.type === MODAL_SUBMIT) {
    modal = data.custom_id ?? "";
    const [prefix, kind, renderId] = modal.split(":");
    if (
      prefix !== "dc" ||
      !renderId ||
      !RENDER_ID.test(renderId) ||
      !["confirm-approve", "confirm-reject", "ask-message"].includes(kind ?? "")
    )
      return inline(UNKNOWN_COMPONENT);
    if (kind === "ask-message") {
      answer = { data: { flags: EPHEMERAL }, type: RESPONSE.deferredMessage };
    } else {
      ephemeral = false;
      answer = { type: RESPONSE.deferredUpdate };
    }
  } else {
    return inline("This kind of request is not one @Datalayer answers.");
  }

  const job: InteractionJob = {
    appPermissions: interaction.app_permissions ?? "0",
    ephemeral,
    id: interaction.id,
    key,
    kind: "interaction",
    receivedAt: now(),
    threadFromOriginal,
    token: dependencies.cipher.encrypt(interaction.token, interaction.id),
    type: interaction.type,
    userId: person.id,
    userName: person.username ?? "",
    ...(command ? { command } : {}),
    ...(component ? { component } : {}),
    ...(data.values ? { values: data.values } : {}),
    ...(modal ? { fields: fieldsOf(data.components), modal } : {}),
  };
  try {
    // The claim and the job in one transaction; a duplicate gets
    // the same answer it got the first time, and nothing is enqueued.
    const fresh = await dependencies.queue.enqueue(
      job,
      `interaction:${interaction.id}`,
    );
    if (!fresh)
      dependencies.logger.info("interaction.duplicate", {
        interaction: interaction.id,
      });
  } catch (error) {
    dependencies.logger.error("interaction.not_persisted", { error });
    return inline(NOT_TAKEN);
  }
  return answer;
}
