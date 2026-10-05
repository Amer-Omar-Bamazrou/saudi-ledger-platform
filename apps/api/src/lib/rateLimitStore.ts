/**
 * C1 — a SHARED rate-limit store, in Postgres.
 *
 * ── The defect this closes ─────────────────────────────────────────────────
 * Every limiter used `MemoryStore`: per-process, so horizontal scaling
 * silently MULTIPLIES every limit. Two instances behind a load balancer turn
 * "5 signups per hour" into 10, four into 20 — and nothing reports it, because
 * each process believes it is enforcing the stated number. The brute-force
 * protection degrades exactly when the deployment grows, which is when it
 * matters most.
 *
 * ── Why Postgres and not Redis ─────────────────────────────────────────────
 * 🔴 The queue entry (C1) framed this correctly: Redis DOES NOT EXIST in this
 * project. Introducing it would add a new service, a new failure domain, and a
 * new deployment dependency to fix a counter. Postgres is already here, is
 * already the thing whose availability the whole API depends on, and gives the
 * atomicity this needs in one statement. A limiter that shares the database's
 * fate is honest; a limiter that adds a second thing that can be down is not.
 *
 * ── The failure posture, stated ────────────────────────────────────────────
 * If the store query fails, `increment` throws and express-rate-limit surfaces
 * the error — the request FAILS rather than passing unlimited. Fail-closed is
 * the right direction for a brute-force guard: a database outage already means
 * the endpoint cannot serve anything useful, so refusing is not a new loss.
 *
 * 🔴 Since the request budget (2026-10-05) the failure is a 503
 * `rate_limit_unavailable`, not a bare 500: a limiter that cannot count is a
 * dependency outage, and the client must be able to tell it from a bug. It is
 * logged on every occurrence and paged at most once per cooldown per process
 * (`reportStoreFailure`), because every request fails the same way at once.
 *
 * ── Scope, so it is not oversold ───────────────────────────────────────────
 * This makes the COUNTER shared. It does not fix IP attribution — that is the
 * other half of C1 (`trust proxy`), handled in `app.ts`. A shared counter keyed
 * on a spoofable IP is still spoofable; the two halves are independent and both
 * are required.
 */
import type { Store, IncrementResponse, Options } from "express-rate-limit";
import { pool } from "@workspace/db";
import { AppError } from "./errors";
import { logger } from "./logger";
import { alerter } from "./alerter";

/**
 * The limiter cannot count, so the request is REFUSED (fail-closed) — 503, a
 * code the client can key on, and never the request's own effect: every
 * limiter runs before its handler, so nothing behind it has executed.
 */
export class RateLimitUnavailableError extends AppError {
  constructor() {
    super(503, "The service is temporarily unavailable. Please try again shortly.", {
      error: "The service is temporarily unavailable. Please try again shortly.",
      code: "rate_limit_unavailable",
    });
  }
}

/** One page per process per cooldown: when the store fails, every request fails with it. */
const STORE_ALERT_COOLDOWN_MS = 5 * 60_000;
let lastStoreAlertAt = 0;

function reportStoreFailure(err: unknown, op: string): never {
  logger.error({ err, op, event: "rate_limit.store_failed" }, "rate-limit store failed; request refused (fail-closed)");
  const now = Date.now();
  if (now - lastStoreAlertAt >= STORE_ALERT_COOLDOWN_MS) {
    lastStoreAlertAt = now;
    void alerter
      .fire({
        key: "rate-limit-store-failed",
        severity: "critical",
        title: "The rate-limit store failed; requests are being refused",
        detail:
          "Every rate-limited request answers 503 rate_limit_unavailable until the counter table " +
          "(rate_limit_hits) can be written again. Usually the database itself is unavailable.",
        context: { op },
      })
      .catch(() => undefined);
  }
  throw new RateLimitUnavailableError();
}

/** Every store constructed in this process — what the test reset hook clears. */
const allStores: PostgresRateLimitStore[] = [];

/** TEST-ONLY: clear every limiter's namespace in this process (see `__resetRateLimitsForTests`). */
export async function resetAllRateLimitStores(): Promise<void> {
  await Promise.all(allStores.map((s) => s.resetAll()));
}

/** One counted bucket: its (unprefixed) key and its window. */
export interface BucketIncrement {
  key: string;
  windowMs: number;
}

/** The count after this hit, and how long its window has left — on the DATABASE's clock. */
export interface BucketCount {
  totalHits: number;
  msLeft: number;
}

export class PostgresRateLimitStore implements Store {
  private windowMs = 60_000;

  /**
   * 🔴 `localKeys: false` tells express-rate-limit that keys counted here are
   * SHARED across instances — that is the whole point of this store, and the
   * library uses the flag for its double-counting misconfiguration check.
   */
  readonly localKeys = false;

  /** Namespace, so three limiters can share one table without colliding. */
  readonly prefix: string;

  constructor(prefix: string) {
    /**
     * 🔴 TEST ISOLATION, and why it is at the STORE and not the limit.
     *
     * Making the counter shared did exactly what it should: parallel vitest
     * forks stopped having private budgets and began contending for one — nine
     * login calls across the suite against a max of 10. The wrong fixes are
     * both tempting: raising `max` in tests deletes the abuse protection
     * `signup.test.ts` exists to prove (documented in `__resetRateLimitsForTests`),
     * and resetting more often just narrows the race.
     *
     * The honest framing: in PRODUCTION one IP is one client, and the shared
     * budget is the point. In TESTS every fork is the same loopback IP but a
     * DIFFERENT logical client, so the key namespace — not the limit — is what
     * is wrong. Each test process therefore gets its own namespace, which
     * keeps the production limits, the production store, and the production
     * code path exactly as they ship.
     */
    const suffix = process.env.NODE_ENV === "test" ? `:p${process.pid}` : "";
    this.prefix = `${prefix}${suffix}:`;
    allStores.push(this);
  }

  /** express-rate-limit calls this once with the resolved options. */
  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  /** The stored key for a client key — public so a test can read or plant a count. */
  key(key: string): string {
    return `${this.prefix}${key}`;
  }

  /**
   * One atomic statement: expire-or-start the window, add 1, return the count.
   *
   * The UPSERT resets `hits` to 1 and re-stamps `expires_at` when the stored
   * window has passed, so an expired row is reused rather than needing a
   * separate sweep. `xmax = 0` is not needed — the RETURNING gives the post-
   * increment value either way, and concurrent callers serialise on the row
   * lock, which is precisely the guarantee MemoryStore could not give across
   * processes.
   *
   * 🔴 The reset time is computed on the DATABASE's clock (`msLeft`), then
   * placed on this process's clock: `Retry-After` is "reset − now", and two
   * different clocks in that subtraction turn any skew between the app and the
   * database into a wrong wait.
   */
  async increment(key: string): Promise<IncrementResponse> {
    const [count] = await this.incrementMany([{ key, windowMs: this.windowMs }]);
    return { totalHits: count!.totalHits, resetTime: new Date(Date.now() + count!.msLeft) };
  }

  /**
   * Several buckets counted in ONE statement — the request budget's user,
   * organization and class buckets together (measured: three keys in one
   * statement cost what one does; three statements cost three times as much).
   *
   * Atomic per row, like `increment`: concurrent callers serialise on each
   * row's lock, so N concurrent hits produce N distinct counts and exactly the
   * ones past the limit see a count past it. Rows are written in KEY ORDER, so
   * two statements touching the same keys always lock them in the same order
   * and cannot deadlock. Duplicate keys are refused here: one INSERT … ON
   * CONFLICT cannot touch a row twice.
   */
  async incrementMany(buckets: BucketIncrement[]): Promise<BucketCount[]> {
    const keys = buckets.map((b) => this.key(b.key));
    if (new Set(keys).size !== keys.length) throw new Error("incrementMany: duplicate bucket key");
    let rows: { key: string; hits: number; ms_left: string }[] = [];
    try {
      ({ rows } = await pool.query<{ key: string; hits: number; ms_left: string }>(
        `INSERT INTO rate_limit_hits (key, hits, expires_at)
              SELECT b.key, 1, now() + b.window_ms * interval '1 millisecond'
                FROM unnest($1::text[], $2::int[]) AS b(key, window_ms)
               ORDER BY b.key
         ON CONFLICT (key) DO UPDATE
              SET hits = CASE WHEN rate_limit_hits.expires_at < now() THEN 1
                              ELSE rate_limit_hits.hits + 1 END,
                  expires_at = CASE WHEN rate_limit_hits.expires_at < now()
                              THEN EXCLUDED.expires_at
                              ELSE rate_limit_hits.expires_at END
           RETURNING key, hits,
                     GREATEST(0, ceil(EXTRACT(EPOCH FROM (expires_at - now())) * 1000))::text AS ms_left`,
        [keys, buckets.map((b) => b.windowMs)],
      ));
    } catch (err) {
      reportStoreFailure(err, "increment");
    }
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return keys.map((k) => {
      const r = byKey.get(k)!;
      return { totalHits: Number(r.hits), msLeft: Number(r.ms_left) };
    });
  }

  /**
   * The refund for `skipSuccessfulRequests` (the per-account login limiter).
   *
   * 🔴 It NEVER rejects. express-rate-limit calls it from a response `finish`
   * listener with no catch, so a rejection here is an unhandled rejection —
   * which terminates the process (this API installs no handler for one). A
   * failed refund leaves a successful login counted as a failure: the
   * conservative direction, and logged.
   */
  async decrement(key: string): Promise<void> {
    try {
      await pool.query(
        `UPDATE rate_limit_hits SET hits = GREATEST(hits - 1, 0) WHERE key = $1 AND expires_at >= now()`,
        [this.key(key)],
      );
    } catch (err) {
      logger.warn({ err, event: "rate_limit.refund_failed" }, "rate-limit refund failed; the hit stays counted");
    }
  }

  async resetKey(key: string): Promise<void> {
    await pool.query(`DELETE FROM rate_limit_hits WHERE key = $1`, [this.key(key)]);
  }

  /** Used by the test hook; also drops rows whose window has passed. */
  async resetAll(): Promise<void> {
    await pool.query(`DELETE FROM rate_limit_hits WHERE key LIKE $1 OR expires_at < now()`, [
      `${this.prefix}%`,
    ]);
  }
}

/**
 * The sweep (job `rate-limit-sweep`). An expired row is harmless — the next hit
 * on its key restarts it — but a key that never returns is never reused, and
 * the keys an anonymous caller chooses (an IP, an email typed at the login
 * form) are unbounded. Nothing deleted them before this: migration 0050 built
 * the expiry index "for the periodic sweep", and no sweep existed.
 *
 * Bounded batches, so one pass never holds a long lock on the hottest table.
 * Deleting an expired row cannot change any limiter's answer — so the outer
 * DELETE re-checks expiry (a hit may revive a row between the two reads), and
 * rows a request is counting right now are SKIPPED rather than waited on: the
 * sweep locks in no particular order and the counter locks in key order, and
 * a deadlock between them would refuse a real request.
 */
export async function sweepExpiredRateLimits(batchSize = 5_000, maxBatches = 20): Promise<{ deleted: number }> {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const { rowCount } = await pool.query(
      `DELETE FROM rate_limit_hits
        WHERE key IN (SELECT key FROM rate_limit_hits WHERE expires_at < now() LIMIT $1 FOR UPDATE SKIP LOCKED)
          AND expires_at < now()`,
      [batchSize],
    );
    deleted += rowCount ?? 0;
    if ((rowCount ?? 0) < batchSize) break;
  }
  return { deleted };
}
