import type { Clock } from "@datalayer/agent-runtimes/lib/portable/hosts";

/**
 * Discord's rate limits: per-route buckets read from
 * the `X-RateLimit-*` headers, the global limit, `retry_after` honoured on a
 * 429, and the invalid-request budget — 401, 403 and 429 (except a 429 of
 * the `shared` scope, which Discord does not count) — that bans an IP for a
 * while at 10,000 in ten minutes. Never one call per model token: the worker
 * edits at a bounded cadence on top of this.
 */

/** Discord's ban threshold, and where the service warns before it. */
export const INVALID_REQUEST_LIMIT = 10_000;
export const INVALID_REQUEST_WARNING = 8_000;
const TEN_MINUTES = 10 * 60 * 1000;

export type RateLimitObservation = Readonly<{
  route: string;
  status: number;
  headers: Headers;
  /** `retry_after` from a 429's body, in seconds. */
  retryAfter?: number;
}>;

export class DiscordRateLimiter {
  /** When each route may be called again (its bucket was spent), in ms. */
  readonly #routeOpensAt = new Map<string, number>();
  #globalOpensAt = 0;
  #invalid: number[] = [];
  /** 429s seen, by scope: what the metrics report. */
  readonly limited = { global: 0, shared: 0, user: 0 };

  constructor(
    readonly clock: Clock,
    readonly warn: (fields: Record<string, unknown>) => void = () => {},
  ) {}

  /** Wait until the route's bucket and the global limit allow a call. */
  async before(route: string): Promise<void> {
    const opensAt = Math.max(
      this.#routeOpensAt.get(route) ?? 0,
      this.#globalOpensAt,
    );
    const wait = opensAt - this.clock.now();
    if (wait > 0) await this.clock.sleep(wait);
  }

  /**
   * Read a response's limits. Answers how long to wait before a retry when
   * it was a 429, else `undefined`.
   */
  after(observed: RateLimitObservation): number | undefined {
    const now = this.clock.now();
    const remaining = observed.headers.get("x-ratelimit-remaining");
    const resetAfter = Number(observed.headers.get("x-ratelimit-reset-after"));
    if (remaining === "0" && Number.isFinite(resetAfter))
      this.#routeOpensAt.set(observed.route, now + resetAfter * 1000);
    const scope = observed.headers.get("x-ratelimit-scope") ?? "user";
    if (
      observed.status === 401 ||
      observed.status === 403 ||
      (observed.status === 429 && scope !== "shared")
    )
      this.#countInvalid(now);
    if (observed.status !== 429) return undefined;
    const seconds =
      observed.retryAfter ??
      Number(observed.headers.get("retry-after") ?? Number.NaN);
    const wait = Math.ceil((Number.isFinite(seconds) ? seconds : 1) * 1000);
    if (observed.headers.get("x-ratelimit-global") === "true") {
      this.limited.global += 1;
      this.#globalOpensAt = now + wait;
    } else {
      this.limited[scope === "shared" ? "shared" : "user"] += 1;
      this.#routeOpensAt.set(observed.route, now + wait);
    }
    return wait;
  }

  /** Invalid requests in the last ten minutes. */
  invalidRequests(): number {
    const since = this.clock.now() - TEN_MINUTES;
    this.#invalid = this.#invalid.filter((at) => at > since);
    return this.#invalid.length;
  }

  #countInvalid(now: number): void {
    this.#invalid.push(now);
    const count = this.invalidRequests();
    if (count === INVALID_REQUEST_WARNING)
      this.warn({ invalidRequests: count, limit: INVALID_REQUEST_LIMIT });
  }
}
