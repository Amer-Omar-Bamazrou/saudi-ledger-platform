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
 * ── Scope, so it is not oversold ───────────────────────────────────────────
 * This makes the COUNTER shared. It does not fix IP attribution — that is the
 * other half of C1 (`trust proxy`), handled in `app.ts`. A shared counter keyed
 * on a spoofable IP is still spoofable; the two halves are independent and both
 * are required.
 */
import type { Store, IncrementResponse, Options } from "express-rate-limit";
import { pool } from "@workspace/db";

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
  }

  /** express-rate-limit calls this once with the resolved options. */
  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private key(key: string): string {
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
   */
  async increment(key: string): Promise<IncrementResponse> {
    const { rows } = await pool.query<{ hits: number; expires_at: Date }>(
      `INSERT INTO rate_limit_hits (key, hits, expires_at)
            VALUES ($1, 1, now() + ($2 || ' milliseconds')::interval)
       ON CONFLICT (key) DO UPDATE
            SET hits = CASE WHEN rate_limit_hits.expires_at < now() THEN 1
                            ELSE rate_limit_hits.hits + 1 END,
                expires_at = CASE WHEN rate_limit_hits.expires_at < now()
                            THEN now() + ($2 || ' milliseconds')::interval
                            ELSE rate_limit_hits.expires_at END
         RETURNING hits, expires_at`,
      [this.key(key), String(this.windowMs)],
    );
    const row = rows[0]!;
    return { totalHits: Number(row.hits), resetTime: new Date(row.expires_at) };
  }

  async decrement(key: string): Promise<void> {
    await pool.query(
      `UPDATE rate_limit_hits SET hits = GREATEST(hits - 1, 0) WHERE key = $1 AND expires_at >= now()`,
      [this.key(key)],
    );
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
