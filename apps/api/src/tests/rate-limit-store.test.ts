/**
 * C1 — the rate-limit counter is SHARED, not per-process.
 *
 * The defect: every limiter used `MemoryStore`, so two API instances behind a
 * load balancer each enforced the stated maximum independently — "5 signups
 * per hour" became 10, and nothing reported it. The limits degraded exactly
 * as the deployment grew.
 *
 * The test therefore does the one thing a unit test of a counter usually does
 * NOT do: it builds TWO independent store objects, as two processes would,
 * and proves a hit counted by one is seen by the other. Asserting a single
 * store's arithmetic would pass just as happily with MemoryStore — the
 * oracle has to be the sharing, not the counting.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { PostgresRateLimitStore } from "../lib/rateLimitStore";
import type { Options } from "express-rate-limit";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[rate-limit-store] no real DATABASE_URL — skipping.");

/** Build a store as a fresh "process" would, with a known window. */
const makeStore = (prefix: string, windowMs = 60_000) => {
  const store = new PostgresRateLimitStore(prefix);
  store.init({ windowMs } as Options);
  return store;
};

describeMaybe("C1 — a hit counted by one instance is seen by the others", () => {
  const PREFIX = "test-shared";
  const KEY = "203.0.113.7";

  beforeEach(async () => {
    await makeStore(PREFIX).resetAll();
  });

  afterAll(async () => {
    await makeStore(PREFIX).resetAll();
    await pool.end();
  });

  it("🔴 THE PROPERTY: two separate store instances share one counter", async () => {
    // Two independently-constructed stores, as two app instances would build.
    //
    // 🔴 Honest scope: under `NODE_ENV=test` the store namespaces by PID (see
    // the constructor — it is how parallel vitest forks stop contending for
    // one production budget), so both objects here share this process's
    // namespace. What this proves is that the counter lives in POSTGRES and
    // not in either object — with MemoryStore, `instanceB` returns 1 because
    // it has its own map. What it does NOT prove is cross-PROCESS sharing;
    // that is asserted structurally by `localKeys === false` below and holds
    // in production, where no PID suffix is applied.
    const instanceA = makeStore(PREFIX);
    const instanceB = makeStore(PREFIX);

    const first = await instanceA.increment(KEY);
    expect(first.totalHits).toBe(1);

    // 🔴 With MemoryStore this returns 1 — each process starts its own count,
    // which is precisely how "max 5" became "max 10" on two instances.
    const second = await instanceB.increment(KEY);
    expect(second.totalHits, "instance B must SEE instance A's hit").toBe(2);

    const third = await instanceA.increment(KEY);
    expect(third.totalHits).toBe(3);
  });

  it("keys are namespaced per limiter — signup's budget is not login's", async () => {
    const signup = makeStore(`${PREFIX}-signup`);
    const login = makeStore(`${PREFIX}-login`);
    await signup.increment(KEY);
    await signup.increment(KEY);
    const loginFirst = await login.increment(KEY);
    expect(loginFirst.totalHits, "a different limiter must start from zero").toBe(1);
    await signup.resetAll();
    await login.resetAll();
  });

  it("the window expires: a hit after `windowMs` starts a new count", async () => {
    // A 1 ms window is expired by the time the second call runs.
    const store = makeStore(`${PREFIX}-expiry`, 1);
    await store.increment(KEY);
    await new Promise((r) => setTimeout(r, 25));
    const afterExpiry = await store.increment(KEY);
    expect(afterExpiry.totalHits, "an expired window resets rather than accumulating forever").toBe(1);
    await store.resetAll();
  });

  it("resetKey clears one client without clearing the others", async () => {
    const store = makeStore(PREFIX);
    await store.increment("client-a");
    await store.increment("client-b");
    await store.resetKey("client-a");
    expect((await store.increment("client-a")).totalHits).toBe(1);
    expect((await store.increment("client-b")).totalHits, "client-b's count survived").toBe(2);
  });

  it("decrement gives a hit back (the successful-request refund path)", async () => {
    const store = makeStore(PREFIX);
    await store.increment(KEY);
    await store.increment(KEY);
    await store.decrement(KEY);
    expect((await store.increment(KEY)).totalHits).toBe(2);
  });

  it("🔴 declares itself SHARED so the library's double-count check is right", () => {
    // `localKeys: true` (MemoryStore's posture) tells express-rate-limit that
    // counts do not cross instances. Getting this backwards would make the
    // library's misconfiguration detection lie about a correct setup.
    expect(new PostgresRateLimitStore("x").localKeys).toBe(false);
  });
});
