import type { WorkQueue } from "@datalayer/agent-runtimes/lib/portable/hosts";

import {
  SolrConflict,
  solrDate,
  term,
  textOf,
  type SolrDoc,
} from "./client.js";
import { documentOf, lockKey, type SolrRecords } from "./records.js";

/**
 * The durable work queue in the service's Solr collection: a job is a
 * document (`type_s:job`), claimed by one worker with optimistic concurrency
 * on its `_version_` (what `FOR UPDATE SKIP LOCKED` was: two workers never
 * both win a job), its lease renewed while worked, retried with backoff,
 * dead after five attempts and taken back when its worker stopped renewing
 * for five minutes. An ingress claim (`type_s:claim`, `ingress:<key>`) keeps
 * a host event from being enqueued twice: claim and job are written under
 * the claim's lock, the job first, so a failure between the two can enqueue
 * a job twice (the turn's own claim answers the second) but never lose one.
 */

const JOB = "job";
export const CLAIM = "claim";
const ATTEMPTS = 5;
const LEASE_EXPIRES_MS = 5 * 60_000;

type Job<T> = Readonly<{
  attempts: number;
  doc: SolrDoc;
  payload: T;
  uid: string;
}>;

export type DeadJob = Readonly<{
  id: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  kind: string;
}>;

export class SolrWorkQueue<T> implements WorkQueue<T> {
  #handler?: (item: T) => Promise<void>;
  #loop?: Promise<void>;
  #stopping = false;

  constructor(
    readonly records: SolrRecords,
    readonly pollIntervalMs = 500,
    /** Well within the five minutes after which a job is taken back. */
    readonly leaseRenewMs = 60_000,
  ) {}

  async enqueue(item: T, idempotencyKey?: string): Promise<boolean> {
    if (!idempotencyKey) {
      await this.#add(item);
      return true;
    }
    const claim = `ingress:${idempotencyKey}`;
    return this.records.locked([lockKey(CLAIM, claim)], async () => {
      if (await this.records.getStored(CLAIM, claim)) return false;
      await this.#add(item);
      await this.records.create(CLAIM, claim, { eventId: claim }, {});
      return true;
    });
  }

  async ready(): Promise<boolean> {
    return this.records.client.ready();
  }

  /** Jobs that failed five times, with their metadata only. */
  async dead(limit = 50): Promise<DeadJob[]> {
    const { docs } = await this.records.client.search({
      fq: [term("type_s", JOB), term("state_s", "dead")],
      rows: limit,
      sort: "uid asc",
    });
    return docs.map((doc) => ({
      attempts: Number(doc.attempts_i ?? 0),
      createdAt: textOf(doc.creation_ts_dt),
      id: textOf(doc.uid),
      kind: textOf(doc.kind_s, "other"),
      lastError:
        typeof doc.last_error_stored === "string"
          ? doc.last_error_stored
          : null,
    }));
  }

  /** Put a dead job back to work, once, by its uid; the replay kept with who asked. */
  async replay(uid: string, operator: string): Promise<boolean> {
    const doc = await this.#deadDoc(uid);
    let replayed = false;
    if (doc) {
      try {
        await this.records.client.add([
          {
            _version_: doc._version_,
            attempts_i: { set: 0 },
            available_dt: { set: solrDate(Date.now()) },
            id: doc.id,
            last_error_stored: { set: null },
            last_update_ts_dt: { set: solrDate(Date.now()) },
            state_s: { set: "ready" },
          },
        ]);
        replayed = true;
      } catch (error) {
        if (!(error instanceof SolrConflict)) throw error;
      }
    }
    await this.records.append(
      "job_replay",
      { jobUid: uid, operator, replayed },
      { job_uid_s: uid, operator_s: operator, replayed_b: replayed },
    );
    return replayed;
  }

  /** A dead job's payload, and only a dead one's. */
  async payloadOf(uid: string): Promise<unknown> {
    const doc = await this.#deadDoc(uid);
    return doc
      ? (JSON.parse(textOf(doc.payload_stored)) as unknown)
      : undefined;
  }

  start(handler: (item: T) => Promise<void>): void {
    if (this.#loop) throw new Error("The Solr work queue has already started.");
    this.#handler = handler;
    this.#stopping = false;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#loop;
    this.#loop = undefined;
    this.#handler = undefined;
  }

  async #add(item: T): Promise<void> {
    const now = new Date();
    await this.records.client.add([
      documentOf(JOB, null, {
        attempts_i: 0,
        available_dt: now,
        kind_s: kindOf(item),
        payload_stored: JSON.stringify(item),
        state_s: "ready",
      }),
    ]);
  }

  async #deadDoc(uid: string): Promise<SolrDoc | undefined> {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(uid)) return undefined;
    const { docs } = await this.records.client.search({
      fq: [term("type_s", JOB), term("uid", uid), term("state_s", "dead")],
      rows: 1,
    });
    return docs[0] ? this.records.client.get(docs[0].id) : undefined;
  }

  async #run(): Promise<void> {
    let lastReclaim = 0;
    while (!this.#stopping) {
      let job: Job<T> | undefined;
      try {
        if (Date.now() - lastReclaim > 30_000) {
          await this.#reclaimAbandoned();
          lastReclaim = Date.now();
        }
        job = await this.#claim();
      } catch {
        job = undefined; // Solr away: poll again
      }
      if (!job) {
        await delay(this.pollIntervalMs);
        continue;
      }
      const claimed = job;
      const lease = setInterval(() => {
        void this.#renew(claimed.doc.id).catch(() => undefined); // the next renewal, or the reclaim, decides
      }, this.leaseRenewMs);
      lease.unref();
      try {
        await this.#handler?.(claimed.payload);
        await this.records.client.deleteIds([claimed.doc.id]);
      } catch (error) {
        await this.#fail(claimed, error).catch(() => undefined); // its lease runs out: taken back
      } finally {
        clearInterval(lease);
      }
    }
  }

  async #claim(): Promise<Job<T> | undefined> {
    const { docs } = await this.records.client.search({
      fq: [
        term("type_s", JOB),
        term("state_s", "ready"),
        "available_dt:[* TO NOW]",
      ],
      rows: 10,
      sort: "uid asc",
    });
    for (const doc of docs) {
      const attempts = Number(doc.attempts_i ?? 0) + 1;
      try {
        await this.records.client.add([
          {
            _version_: doc._version_,
            attempts_i: { set: attempts },
            id: doc.id,
            locked_dt: { set: solrDate(Date.now()) },
            state_s: { set: "processing" },
          },
        ]);
      } catch (error) {
        if (error instanceof SolrConflict) continue; // another worker's
        throw error;
      }
      return {
        attempts,
        doc,
        payload: JSON.parse(textOf(doc.payload_stored)) as T,
        uid: textOf(doc.uid),
      };
    }
    return undefined;
  }

  async #renew(id: string): Promise<void> {
    const doc = await this.records.client.get(id);
    if (doc?.state_s !== "processing") return;
    await this.records.client.add([
      {
        _version_: doc._version_,
        id,
        locked_dt: { set: solrDate(Date.now()) },
      },
    ]);
  }

  async #fail(job: Job<T>, error: unknown): Promise<void> {
    const message = (
      error instanceof Error ? error.message : "Unknown worker failure"
    ).slice(0, 2_000);
    const doc = await this.records.client.get(job.doc.id);
    if (doc?.state_s !== "processing") return;
    const dead = job.attempts >= ATTEMPTS;
    await this.records.client.add([
      {
        _version_: doc._version_,
        available_dt: dead
          ? undefined
          : {
              set: solrDate(
                Date.now() + Math.min(300, 2 ** job.attempts) * 1_000,
              ),
            },
        id: doc.id,
        last_error_stored: { set: message },
        locked_dt: { set: null },
        state_s: { set: dead ? "dead" : "ready" },
      },
    ]);
  }

  async #reclaimAbandoned(): Promise<void> {
    const { docs } = await this.records.client.search({
      fq: [
        term("type_s", JOB),
        term("state_s", "processing"),
        `locked_dt:[* TO ${solrDate(Date.now() - LEASE_EXPIRES_MS)}]`,
      ],
      rows: 50,
    });
    for (const doc of docs) {
      try {
        await this.records.client.add([
          {
            _version_: doc._version_,
            available_dt: { set: solrDate(Date.now()) },
            id: doc.id,
            last_error_stored: { set: "Worker lease expired" },
            locked_dt: { set: null },
            state_s: { set: "ready" },
          },
        ]);
      } catch (error) {
        if (!(error instanceof SolrConflict)) throw error; // renewed meanwhile: still its worker's
      }
    }
  }
}

function kindOf(item: unknown): string {
  if (item && typeof item === "object") {
    if ("delivery" in item) return "delivery";
    if ("prompt" in item) return "prompt";
  }
  return "other";
}

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
