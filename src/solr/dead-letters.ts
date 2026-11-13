import {
  Logger,
  payloadHash,
  redact,
  redactCredentials,
  type DeadLetter,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { SolrWorkQueue } from "./queue.js";

/**
 * Dead letters (S-405) of the Solr queue, as the host kit's `DeadLetters`
 * are of its Postgres one: metadata and a hash of each payload by default;
 * a replay puts one back to work once; a payload read is a dead job's only,
 * needs a reason, is kept (`type_s:payload_access`) and audited, its
 * credentials still redacted. Every replay is kept (`type_s:job_replay`).
 * A job's id here is its uid.
 */
export class SolrDeadLetters {
  constructor(
    readonly queue: SolrWorkQueue<unknown>,
    readonly service: string,
    readonly logger: Logger = new Logger(),
  ) {}

  async list(limit = 50): Promise<DeadLetter[]> {
    const dead = await this.queue.dead(limit);
    return Promise.all(
      dead.map(async (one) => ({
        attempts: one.attempts,
        createdAt: one.createdAt,
        id: one.id,
        kind: one.kind,
        lastError: String(redact(one.lastError ?? "")),
        payloadHash: payloadHash(await this.queue.payloadOf(one.id)),
      })),
    );
  }

  async replay(id: string, operator: string): Promise<boolean> {
    if (!operator.trim()) throw new Error("Name who replays the job.");
    const replayed = await this.queue.replay(id, operator);
    this.logger.audit("admin.changed", {
      by: operator,
      installation: `${this.service}-queue`,
      job: id,
      reason: replayed ? "dead job replayed" : "not a dead job",
    });
    return replayed;
  }

  async payload(
    id: string,
    operator: string,
    reason: string,
  ): Promise<unknown> {
    if (reason.trim().length < 10)
      throw new Error("Say why the payload is read: ten characters at least.");
    if (!operator.trim()) throw new Error("Name who reads the payload.");
    const payload = await this.queue.payloadOf(id);
    if (payload === undefined)
      throw new Error(
        `Job ${id} is not a dead job: there is no payload to read.`,
      );
    await this.queue.records.append(
      "payload_access",
      { jobUid: id, operator, reason: reason.slice(0, 1_000) },
      { job_uid_s: id, operator_s: operator },
    );
    this.logger.audit("payload.read", {
      by: operator,
      installation: `${this.service}-queue`,
      job: id,
      reason: "privileged payload access",
    });
    return redactCredentials(payload);
  }
}

export type CliOutput = {
  table: (rows: unknown) => void;
  info: (line: string) => void;
  error: (line: string) => void;
};

export const DEAD_LETTERS_USAGE =
  "Usage: dead-letters list | replay <id> | payload <id> <reason>";

/**
 * `dead-letters list | replay <id> | payload <id> <reason…>`, who acts said in
 * `operator` (`DATALAYER_OPERATOR`): the exit code.
 */
export async function runDeadLettersCli(
  letters: SolrDeadLetters,
  argv: readonly string[],
  operator: string,
  out: CliOutput = {
    error: (line) => console.error(line),
    info: (line) => console.info(line),
    table: (rows) => console.table(rows),
  },
): Promise<number> {
  const [command, id, ...rest] = argv;
  if (!operator.trim()) {
    out.error(
      "DATALAYER_OPERATOR is required: the name kept with every replay and payload read.",
    );
    return 1;
  }
  if (command === "list") {
    out.table(await letters.list());
    return 0;
  }
  if (command === "replay" && id) {
    out.info(
      (await letters.replay(id, operator))
        ? `Job ${id} is back to work.`
        : `Job ${id} is not a dead job.`,
    );
    return 0;
  }
  if (command === "payload" && id) {
    out.info(
      JSON.stringify(
        await letters.payload(id, operator, rest.join(" ")),
        null,
        2,
      ),
    );
    return 0;
  }
  out.error(DEAD_LETTERS_USAGE);
  return 1;
}
