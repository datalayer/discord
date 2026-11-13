/**
 * The service's one Solr collection, over HTTP: searches, real-time gets by
 * id, adds (optimistic concurrency with `_version_`), atomic updates and
 * deletes, each write committed softly so the next search sees it, as the
 * platform's services do (`softCommit=true`).
 *
 * Solr makes every document's `id` (the configset's UUID update processor);
 * a document is ours by its `uid`, a ULID minted here (`ulid.ts`).
 *
 * A timeout, a refused connection or a 5xx is asked again, three times; a
 * 4xx is the request itself and is answered at once, a 409 as
 * `SolrConflict` (a `_version_` that is no longer the document's).
 */

export type SolrSettings = Readonly<{
  /** Solr's base URL, `.../solr`. */
  url: string;
  collection: string;
  username: string;
  password: string;
}>;

export type SolrValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | Readonly<Record<string, unknown>>;

/** A stored document, as Solr answers it. */
export type SolrDoc = Readonly<Record<string, unknown>> & {
  readonly id: string;
  /**
   * Kept as its digits: a version is a 64-bit number, past what a
   * JavaScript number holds exactly, and a conditional write must send it
   * back unchanged.
   */
  readonly _version_: string;
};

/** A document to write: no `id` for a new one, Solr makes it. */
export type SolrWrite = Readonly<Record<string, SolrValue | undefined>>;

export type SolrSearch = Readonly<{
  /** The main query; `*:*` when only filters say what is wanted. */
  q?: string;
  /** Filter queries: exact terms are best given as `term(field, value)`. */
  fq?: readonly string[];
  sort?: string;
  rows?: number;
  start?: number;
  fl?: string;
}>;

export class SolrError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SolrError";
  }
}

/** A write refused because the document changed since it was read (HTTP 409). */
export class SolrConflict extends SolrError {
  constructor(message: string) {
    super(message, 409);
    this.name = "SolrConflict";
  }
}

/** A filter on one field's exact value: no escaping to get wrong. */
export function term(field: string, value: string | number | boolean): string {
  return `{!term f=${field}}${String(value)}`;
}

/** A stored field's text: a string field's value, else the fallback. */
export function textOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** A Solr date: an ISO instant. */
export function solrDate(value: Date | string | number): string {
  return new Date(value).toISOString();
}

type Fetch = typeof globalThis.fetch;

const ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;

export class SolrClient {
  readonly #base: string;
  readonly #authorization: string;

  constructor(
    readonly settings: SolrSettings,
    readonly fetchImpl: Fetch = globalThis.fetch,
  ) {
    if (!/^[a-z][a-z0-9_-]*$/.test(settings.collection))
      throw new Error(`Not a Solr collection name: ${settings.collection}`);
    this.#base = `${settings.url.replace(/\/+$/, "")}/${settings.collection}`;
    this.#authorization = `Basic ${Buffer.from(
      `${settings.username}:${settings.password}`,
    ).toString("base64")}`;
  }

  get collection(): string {
    return this.settings.collection;
  }

  async search(
    search: SolrSearch,
  ): Promise<{ docs: SolrDoc[]; numFound: number }> {
    const params = new URLSearchParams({
      q: search.q ?? "*:*",
      rows: String(search.rows ?? 100),
      wt: "json",
    });
    for (const filter of search.fq ?? []) params.append("fq", filter);
    if (search.sort) params.set("sort", search.sort);
    if (search.start) params.set("start", String(search.start));
    params.set("fl", search.fl ?? "*,_version_");
    const answer = (await this.#request("select", params)) as {
      response: { docs: SolrDoc[]; numFound: number };
    };
    return answer.response;
  }

  /** The document as it is now, committed or not (real-time get). */
  async get(id: string): Promise<SolrDoc | undefined> {
    const params = new URLSearchParams({ id, fl: "*,_version_", wt: "json" });
    const answer = (await this.#request("get", params)) as {
      doc: SolrDoc | null;
    };
    return answer.doc ?? undefined;
  }

  /**
   * Write documents, whole or as atomic updates. A `_version_` on one makes
   * the write conditional: `-1` "must not exist", a positive one "must still
   * be this version" (`SolrConflict` otherwise).
   */
  async add(docs: readonly SolrWrite[], commit = true): Promise<void> {
    if (docs.length === 0) return;
    await this.#update(docs.map(withoutUndefined), commit);
  }

  async deleteIds(ids: readonly string[], commit = true): Promise<void> {
    if (ids.length === 0) return;
    await this.#update({ delete: ids }, commit);
  }

  async deleteWhere(query: string, commit = true): Promise<void> {
    await this.#update({ delete: { query } }, commit);
  }

  /** Whether the collection answers a search now: what readiness reports. */
  async ready(): Promise<boolean> {
    try {
      await this.search({ rows: 0 });
      return true;
    } catch {
      return false;
    }
  }

  async #update(body: unknown, commit: boolean): Promise<void> {
    const params = new URLSearchParams({ wt: "json" });
    if (commit) params.set("softCommit", "true");
    await this.#request("update", params, body);
  }

  async #request(
    path: string,
    params: URLSearchParams,
    body?: unknown,
  ): Promise<unknown> {
    let last: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(
          `${this.#base}/${path}?${params.toString()}`,
          {
            body: body === undefined ? undefined : JSON.stringify(body),
            headers: {
              authorization: this.#authorization,
              ...(body === undefined
                ? {}
                : { "content-type": "application/json" }),
            },
            method: body === undefined ? "GET" : "POST",
            signal: AbortSignal.timeout(TIMEOUT_MS),
          },
        );
      } catch (error) {
        last = error;
        await pause(attempt);
        continue;
      }
      if (response.ok) return parseKeepingVersions(await response.text());
      const message = await reasonOf(response);
      if (response.status === 409) throw new SolrConflict(message);
      if (
        response.status < 500 &&
        response.status !== 404 &&
        response.status !== 429
      )
        throw new SolrError(message, response.status);
      last = new SolrError(message, response.status);
      await pause(attempt);
    }
    throw new SolrError(
      `Solr ${this.settings.collection}/${path} failed after ${ATTEMPTS} attempts: ${
        last instanceof Error ? last.message : String(last)
      }`,
      last instanceof SolrError ? last.status : 503,
    );
  }
}

/** JSON, each `_version_` kept as a string of its digits. */
export function parseKeepingVersions(text: string): unknown {
  return JSON.parse(
    text.replace(/"_version_":\s*(-?\d+)/g, '"_version_":"$1"'),
  );
}

function withoutUndefined(doc: SolrWrite): Record<string, SolrValue> {
  const kept: Record<string, SolrValue> = {};
  for (const [field, value] of Object.entries(doc))
    if (value !== undefined) kept[field] = value;
  return kept;
}

async function reasonOf(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { msg?: string } };
    if (parsed.error?.msg)
      return `HTTP ${response.status}: ${parsed.error.msg}`;
  } catch {
    // not JSON: the status says enough
  }
  return `HTTP ${response.status}`;
}

const pause = async (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
