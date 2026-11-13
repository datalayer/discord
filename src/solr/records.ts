import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

import {
  SolrConflict,
  solrDate,
  term,
  textOf,
  type SolrClient,
  type SolrDoc,
  type SolrValue,
  type SolrWrite,
} from "./client.js";
import { ulid } from "./ulid.js";

/**
 * Records kept in the service's Solr collection, the way the platform's
 * services keep theirs: one document per object, `type_s` its kind, `uid` a
 * ULID minted here, `id` made by Solr, `creation_ts_dt` and
 * `last_update_ts_dt`, the fields searched on as dynamic fields (`_s`, `_i`,
 * `_b`, `_dt`, `_l`) and the object itself, whole, in `record_stored`
 * (stored, never indexed: an indexed string refuses a term over 32766
 * bytes).
 *
 * A keyed record carries its natural key in `key_s` (an installation's
 * workspace, a thread): what a primary key or a unique constraint was in
 * Postgres. Solr's only unique field is `id`, which it makes, so it cannot
 * refuse a second document under the same `key_s` by itself. Every write of
 * a keyed record therefore runs under a lock on its key (`locked`): one of
 * a fixed set of lock documents (`type_s:lock`, a stripe per hash of the
 * key), taken and given back with optimistic concurrency on its
 * `_version_`, held for a lease (`leaseMs`) so a process that dies holding
 * one stops holding it. Under the lock, a write reads the key's document,
 * writes it back under that `_version_` and commits softly, so the next
 * holder's search sees it: a create-if-absent, an increment and a
 * read-modify-write are as safe as Postgres' were, as long as one holder's
 * work fits in its lease (a few requests; the lease is 15 seconds).
 *
 * The lock documents are made once, at first start: two processes starting
 * together for the first time can each make one per stripe; both keep the
 * oldest (the smallest uid) and delete the other, and a holder whose lock
 * document was deleted finds the kept one before its next take.
 */

export type Fields = Readonly<Record<string, SolrValue | Date | undefined>>;

export type Stored<T> = Readonly<{
  id: string;
  uid: string;
  version: string;
  record: T;
  doc: SolrDoc;
}>;

export type FindOptions = Readonly<{
  /** Raw filter queries besides the fields' exact values (a date range). */
  where?: readonly string[];
  sort?: string;
  rows?: number;
}>;

export type RecordsOptions = Readonly<{
  stripes?: number;
  leaseMs?: number;
  /** How long a take waits for a lock before it fails. */
  waitMs?: number;
}>;

const LOCK = "lock";
const PAGE = 500;

export class SolrRecords {
  readonly stripes: number;
  readonly leaseMs: number;
  readonly waitMs: number;
  readonly #held = new AsyncLocalStorage<ReadonlySet<number>>();
  readonly #lockIds = new Map<number, string>();
  #initialized?: Promise<void>;

  constructor(
    readonly client: SolrClient,
    options: RecordsOptions = {},
  ) {
    this.stripes = options.stripes ?? 32;
    this.leaseMs = options.leaseMs ?? 15_000;
    this.waitMs = options.waitMs ?? 30_000;
  }

  /** Make the lock documents when there are none yet: once, before the first lock. */
  async init(): Promise<void> {
    this.#initialized ??= this.#makeLocks().catch((error: unknown) => {
      this.#initialized = undefined;
      throw error;
    });
    return this.#initialized;
  }

  // -- reads ---------------------------------------------------------------

  async get<T>(kind: string, key: string): Promise<T | undefined> {
    return (await this.getStored<T>(kind, key))?.record;
  }

  async getStored<T>(
    kind: string,
    key: string,
  ): Promise<Stored<T> | undefined> {
    const { docs } = await this.client.search({
      fq: [term("type_s", kind), term("key_s", key)],
      rows: 1,
      sort: "uid asc",
    });
    return docs[0] ? storedOf<T>(docs[0]) : undefined;
  }

  /** The records of a kind whose fields have these exact values, oldest first by default. */
  async find<T>(
    kind: string,
    fields: Fields = {},
    options: FindOptions = {},
  ): Promise<T[]> {
    return (await this.findStored<T>(kind, fields, options)).map(
      (one) => one.record,
    );
  }

  async findStored<T>(
    kind: string,
    fields: Fields = {},
    options: FindOptions = {},
  ): Promise<Stored<T>[]> {
    const fq = filtersOf(kind, fields, options.where);
    const wanted = options.rows ?? Number.POSITIVE_INFINITY;
    const found: Stored<T>[] = [];
    for (let start = 0; found.length < wanted; start += PAGE) {
      const { docs, numFound } = await this.client.search({
        fq,
        rows: Math.min(PAGE, wanted - found.length),
        sort: options.sort ?? "uid asc",
        start,
      });
      found.push(...docs.map((doc) => storedOf<T>(doc)));
      if (docs.length === 0 || start + docs.length >= numFound) break;
    }
    return found;
  }

  async count(
    kind: string,
    fields: Fields = {},
    where?: readonly string[],
  ): Promise<number> {
    const { numFound } = await this.client.search({
      fq: filtersOf(kind, fields, where),
      rows: 0,
    });
    return numFound;
  }

  // -- keyed writes, each under its key's lock -------------------------------

  /** Keep a record under its key: the one there is replaced, or a first one made. */
  async put<T>(
    kind: string,
    key: string,
    record: T,
    fields: Fields = {},
  ): Promise<void> {
    await this.update<T>(kind, key, () => ({ record, fields }));
  }

  /**
   * Read, change and write one keyed record under its lock. `change` answers
   * the record to keep (and its searched fields), `undefined` to keep it as
   * it is, or `null` to delete it; `update` answers what is kept after.
   */
  async update<T>(
    kind: string,
    key: string,
    change: (
      before: T | undefined,
    ) =>
      | { record: T; fields?: Fields }
      | undefined
      | null
      | Promise<{ record: T; fields?: Fields } | undefined | null>,
  ): Promise<T | undefined> {
    return this.locked([lockKey(kind, key)], async () => {
      const all = await this.findStored<T>(kind, { key_s: key });
      const before = all[0];
      // Duplicates never come from these writes; one left by a lost lease
      // goes with the next write of its key.
      await this.client.deleteIds(
        all.slice(1).map((one) => one.id),
        false,
      );
      const next = await change(before?.record);
      if (next === undefined) return before?.record;
      if (next === null) {
        if (before) await this.client.deleteIds([before.id]);
        return undefined;
      }
      await this.client.add([
        documentOf(kind, next.record, { ...next.fields, key_s: key }, before),
      ]);
      return next.record;
    });
  }

  /** Make a keyed record only when its key has none: `false` when it had one. */
  async create<T>(
    kind: string,
    key: string,
    record: T,
    fields: Fields = {},
  ): Promise<boolean> {
    let created = false;
    await this.update<T>(kind, key, (before) => {
      if (before !== undefined) return undefined;
      created = true;
      return { record, fields };
    });
    return created;
  }

  async remove(kind: string, key: string): Promise<void> {
    await this.update(kind, key, () => null);
  }

  // -- unkeyed writes ----------------------------------------------------------

  /** A new record with no natural key (a history entry, an audit line): its uid. */
  async append<T>(
    kind: string,
    record: T,
    fields: Fields = {},
  ): Promise<string> {
    const doc = documentOf(kind, record, fields);
    await this.client.add([doc]);
    return textOf(doc.uid);
  }

  /** Delete the records of a kind whose fields have these values. */
  async removeWhere(
    kind: string,
    fields: Fields = {},
    where?: readonly string[],
  ): Promise<void> {
    const filters = filtersOf(kind, fields, where);
    await this.client.deleteWhere(
      filters.map((one) => `(_query_:${quoteLocal(one)})`).join(" AND "),
    );
  }

  /** Write a stored record back whole, only if it is still the version read. */
  async replace<T>(
    stored: Stored<T>,
    kind: string,
    record: T,
    fields: Fields = {},
  ): Promise<void> {
    await this.client.add([documentOf(kind, record, fields, stored)]);
  }

  // -- locks ---------------------------------------------------------------

  /**
   * Run `work` holding the locks of these keys, taken in a stable order (two
   * holders never wait on each other) and given back after. Re-entrant: a
   * write under a lock the caller already holds takes nothing more.
   */
  async locked<R>(keys: readonly string[], work: () => Promise<R>): Promise<R> {
    const held = this.#held.getStore() ?? new Set<number>();
    const wanted = [...new Set(keys.map((key) => this.#stripeOf(key)))]
      .filter((stripe) => !held.has(stripe))
      .sort((a, b) => a - b);
    if (wanted.length === 0) return work();
    await this.init();
    const taken: Array<{ stripe: number; token: string }> = [];
    try {
      for (const stripe of wanted)
        taken.push({ stripe, token: await this.#take(stripe) });
      return await this.#held.run(new Set([...held, ...wanted]), work);
    } finally {
      for (const { stripe, token } of taken.reverse())
        await this.#give(stripe, token).catch(() => undefined); // the lease ends it
    }
  }

  #stripeOf(key: string): number {
    return (
      createHash("sha256").update(key).digest().readUInt32BE(0) % this.stripes
    );
  }

  async #take(stripe: number): Promise<string> {
    const token = randomUUID();
    const deadline = Date.now() + this.waitMs;
    for (let attempt = 0; Date.now() < deadline; attempt += 1) {
      const lock = await this.#lockDoc(stripe);
      const now = Date.now();
      const until = Number(lock.until_l ?? 0);
      if (!lock.holder_s || until <= now) {
        try {
          await this.client.add(
            [
              {
                _version_: lock._version_,
                holder_s: { set: token },
                id: lock.id,
                until_l: { set: now + this.leaseMs },
              },
            ],
            false,
          );
          return token;
        } catch (error) {
          if (!(error instanceof SolrConflict)) throw error;
        }
      }
      await sleep(
        Math.min(250, 10 * 2 ** Math.min(attempt, 5)) * (0.5 + Math.random()),
      );
    }
    throw new Error(
      `A lock of ${this.client.collection} stayed held for ${this.waitMs} ms.`,
    );
  }

  async #give(stripe: number, token: string): Promise<void> {
    const id = this.#lockIds.get(stripe);
    if (!id) return;
    const lock = await this.client.get(id);
    if (!lock || lock.holder_s !== token) return; // lost with its lease
    await this.client.add(
      [
        {
          _version_: lock._version_,
          holder_s: { set: null },
          id,
          until_l: { set: 0 },
        },
      ],
      false,
    );
  }

  /** The stripe's lock document, as it is now; found again when the one known was deleted. */
  async #lockDoc(stripe: number): Promise<SolrDoc> {
    const known = this.#lockIds.get(stripe);
    const doc = known ? await this.client.get(known) : undefined;
    if (doc) return doc;
    this.#lockIds.delete(stripe);
    const { docs } = await this.client.search({
      fq: [term("type_s", LOCK), term("stripe_i", stripe)],
      rows: 1,
      sort: "uid asc",
    });
    const found = docs[0] ? await this.client.get(docs[0].id) : undefined;
    if (!found) {
      this.#initialized = undefined;
      await this.init();
      return this.#lockDoc(stripe);
    }
    this.#lockIds.set(stripe, found.id);
    return found;
  }

  async #makeLocks(): Promise<void> {
    const existing = await this.client.search({
      fq: [term("type_s", LOCK)],
      fl: "id,uid,stripe_i",
      rows: this.stripes * 4,
    });
    const have = new Set(existing.docs.map((doc) => Number(doc.stripe_i)));
    const missing: SolrWrite[] = [];
    for (let stripe = 0; stripe < this.stripes; stripe += 1)
      if (!have.has(stripe))
        missing.push({
          creation_ts_dt: solrDate(Date.now()),
          stripe_i: stripe,
          type_s: LOCK,
          uid: ulid(),
        });
    await this.client.add(missing);
    const all = await this.client.search({
      fq: [term("type_s", LOCK)],
      fl: "id,uid,stripe_i",
      rows: this.stripes * 4,
      sort: "uid asc",
    });
    const extra: string[] = [];
    for (const doc of all.docs) {
      const stripe = Number(doc.stripe_i);
      if (stripe >= this.stripes) continue;
      if (this.#lockIds.has(stripe) && this.#lockIds.get(stripe) !== doc.id)
        extra.push(doc.id);
      else this.#lockIds.set(stripe, doc.id);
    }
    await this.client.deleteIds(extra);
  }
}

/** The lock key of a keyed record. */
export function lockKey(kind: string, key: string): string {
  return `${kind}\u0000${key}`;
}

export function storedOf<T>(doc: SolrDoc): Stored<T> {
  const raw = doc.record_stored;
  return {
    doc,
    id: doc.id,
    record: (typeof raw === "string" ? JSON.parse(raw) : undefined) as T,
    uid: textOf(doc.uid),
    version: doc._version_,
  };
}

/**
 * The document of a record: a new one (a new uid, no id: Solr makes it), or
 * the one read written back under its id and `_version_`, its uid and
 * creation kept.
 */
export function documentOf<T>(
  kind: string,
  record: T,
  fields: Fields,
  before?: Stored<unknown>,
): SolrWrite {
  const now = solrDate(Date.now());
  const doc: Record<string, SolrValue | undefined> = {};
  for (const [field, value] of Object.entries(fields))
    doc[field] = value instanceof Date ? solrDate(value) : value;
  return {
    ...doc,
    _version_: before ? before.version : undefined,
    creation_ts_dt: before ? textOf(before.doc.creation_ts_dt, now) : now,
    id: before?.id,
    last_update_ts_dt: now,
    record_stored: JSON.stringify(record),
    type_s: kind,
    uid: before?.uid ?? ulid(),
  };
}

function filtersOf(
  kind: string,
  fields: Fields,
  where: readonly string[] = [],
): string[] {
  const filters = [term("type_s", kind)];
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === null || value === "")
      filters.push(`(*:* -${field}:[* TO *])`);
    else if (value instanceof Date) filters.push(term(field, solrDate(value)));
    else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      filters.push(term(field, value));
    else throw new Error(`A filter on ${field} is one value.`);
  }
  return [...filters, ...where];
}

function quoteLocal(filter: string): string {
  return `"${filter.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
