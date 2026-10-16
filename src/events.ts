import type {
  Logger,
  WorkQueue,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import type { DiscordJob } from "./resources.js";
import type { DiscordStore } from "./store.js";
import { BodyTooLargeError, rawBodyOf, signedByDiscord } from "./verify.js";

/**
 * `POST /discord/events` (plans/DISCORD.md §7.2, DC-103): Discord's webhook
 * events, verified like interactions. PING (type 0) is answered 204; an
 * event is claimed once (by the hash of its body: events carry no id) and
 * persisted, then answered 204 within three seconds. Discord retries an
 * unanswered event for ten minutes, out of order, and stops sending to an
 * app that fails too often: so once persisted, the event's handling runs
 * from the queue, and a handling that fails is dead-lettered there, never a
 * non-2xx here. Only `APPLICATION_AUTHORIZED` is subscribed;
 * `APPLICATION_DEAUTHORIZED` names no server and is never mapped to one
 * (§7.4).
 */

const eventSchema = z
  .object({
    version: z.number(),
    application_id: z.string(),
    type: z.number().int(),
    event: z
      .object({
        type: z.string(),
        timestamp: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export type EventJob = Readonly<{
  kind: "event";
  type: string;
  guildId?: string;
  integrationType?: number;
  at?: string;
}>;

export function eventsRoute(
  dependencies: Readonly<{
    applicationId: string;
    publicKey: string;
    queue: WorkQueue<DiscordJob>;
    logger: Logger;
    now?: () => number;
  }>,
) {
  const now = dependencies.now ?? Date.now;
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const send = (status: number) => {
      response.writeHead(status);
      response.end();
    };
    let rawBody: Buffer;
    try {
      rawBody = await rawBodyOf(request);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return send(413);
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
      return send(401);
    const parsed = eventSchema.safeParse(
      ((): unknown => {
        try {
          return JSON.parse(rawBody.toString("utf8")) as unknown;
        } catch {
          return undefined;
        }
      })(),
    );
    if (
      !parsed.success ||
      parsed.data.application_id !== dependencies.applicationId
    )
      return send(400);
    if (parsed.data.type === 0) return send(204);
    const event = parsed.data.event;
    if (!event) return send(400);
    const guild = event.data?.guild as { id?: unknown } | undefined;
    const job: EventJob = {
      kind: "event",
      type: event.type,
      ...(event.timestamp ? { at: event.timestamp } : {}),
      ...(typeof guild?.id === "string" ? { guildId: guild.id } : {}),
      ...(typeof event.data?.integration_type === "number"
        ? { integrationType: event.data.integration_type }
        : {}),
    };
    try {
      await dependencies.queue.enqueue(
        job,
        `event:${createHash("sha256").update(rawBody).digest("hex")}`,
      );
    } catch (error) {
      // Not persisted: Discord tries again for ten minutes.
      dependencies.logger.error("event.not_persisted", { error });
      return send(500);
    }
    send(204);
  };
}

/**
 * An event's handling, from the queue: an authorization for a server
 * already removed is ignored (events arrive out of order); one for a bound
 * server changes nothing (the callback binds); a user's authorization (the
 * future user install) is logged only.
 */
export async function handleEvent(
  job: EventJob,
  dependencies: Readonly<{
    applicationId: string;
    store: Pick<DiscordStore, "installation">;
    logger: Logger;
  }>,
): Promise<"ignored" | "seen"> {
  if (job.type !== "APPLICATION_AUTHORIZED" || !job.guildId) {
    dependencies.logger.info("event.ignored", { type: job.type });
    return "ignored";
  }
  const installation = await dependencies.store.installation(
    dependencies.applicationId,
    job.guildId,
  );
  if (!installation || installation.state === "removed") {
    dependencies.logger.info("event.ignored", {
      state: installation?.state ?? "unbound",
      type: job.type,
    });
    return "ignored";
  }
  dependencies.logger.info("event.seen", { type: job.type });
  return "seen";
}
