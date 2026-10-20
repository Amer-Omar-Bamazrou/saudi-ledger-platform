/**
 * 🔴 The forced-race helpers count a waiter only inside its OWN holder's wait
 * tree (test-only; `helpers/g08rRace.ts` `lockWaitersOn`).
 *
 * Every forced race sends its second act only once the first is SEEN waiting
 * on the row its holder locked. Counted database-wide by statement prefix, a
 * parallel file's matching waiter satisfied that check before the first act
 * had queued; the second act then queued first and won (2026-10-20:
 * `g08-invoice-approval-race` and `phase18-g08r-b-onboarded` run side by side,
 * 2 failing runs of 3 — the product's answer was correct, but the race the
 * test asked for was not the one that ran).
 *
 * Planted here, on two category rows of this suite's own organization:
 *  - a FOREIGN holder with a waiter whose statement matches: the database-wide
 *    count sees it (so the absence below is not vacuous); ours does not;
 *  - our own waiter, then a second queued behind it: counted 1, then 2 (the
 *    row-lock queue a two-act race builds), while the foreign count stays 1;
 *  - a different statement is not counted (the statement match is kept).
 * Every transaction is rolled back; nothing is written. DB-backed; skips on
 * the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { lockWaiters, lockWaitersOn, until } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const STATEMENT = `update "categories"`;

type Client = { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; release: () => void };

describeMaybe("g08rRace — a waiter is counted only inside its own holder's wait tree", () => {
  const h = g04Harness("g08rscope");
  let ours = 0;
  let theirs = 0;

  beforeAll(async () => {
    await h.cleanup();
    const orgId = await h.mkOrg("org");
    const row = async (name: string) => (await pool.query(
      `INSERT INTO categories (organization_id, name, name_ar, type, is_posting) VALUES ($1,$2,$2,'expense',true) RETURNING id`, [orgId, name],
    )).rows[0].id as number;
    ours = await row("G08R scope — ours");
    theirs = await row("G08R scope — theirs");
  });

  afterAll(async () => {
    await h.cleanup();
  });

  it("🔴 a matching waiter in ANOTHER session's tree is never counted; our own are, one by one; another statement is not", async () => {
    // In blocking order: each session's blocker comes before it, so the rollbacks below unwind in order.
    const sessions: Client[] = [];
    const pending: Promise<unknown>[] = [];
    const session = async () => {
      const c = (await pool.connect()) as unknown as Client;
      sessions.push(c);
      await c.query("BEGIN");
      return { c, pid: Number((await c.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid) };
    };
    // A waiter's statement runs once its blocker rolls back, and is itself rolled back.
    const wait = (c: Client, id: number) => pending.push(c.query(`UPDATE "categories" SET name = name WHERE id = $1`, [id]).catch((e: unknown) => e));
    // The count the four invoice-race files used before 2026-10-20: every session in the database.
    const databaseWide = async () => (await pool.query(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND ltrim(query) ILIKE $1`, [`${STATEMENT}%`],
    )).rows.map((r) => Number(r.pid));

    try {
      const foreignHolder = await session();
      await foreignHolder.c.query(`SELECT id FROM categories WHERE id = $1 FOR UPDATE`, [theirs]);
      const foreignWaiter = await session();
      wait(foreignWaiter.c, theirs);
      await until("the foreign waiter did not queue", async () => (await lockWaiters(foreignHolder.pid)) >= 1);

      const holder = await session();
      await holder.c.query(`SELECT id FROM categories WHERE id = $1 FOR UPDATE`, [ours]);
      expect(await databaseWide(), "the planted waiter MATCHES: the database-wide count sees it").toContain(foreignWaiter.pid);
      expect(await lockWaitersOn(holder.pid, STATEMENT), "our holder's count does not").toBe(0);
      expect(await lockWaitersOn(foreignHolder.pid, STATEMENT), "the foreign holder's own count does").toBe(1);

      const first = await session();
      wait(first.c, ours);
      await until("our first waiter did not queue", async () => (await lockWaiters(holder.pid)) >= 1);
      expect(await lockWaitersOn(holder.pid, STATEMENT), "our first waiter is counted").toBe(1);

      const second = await session();
      wait(second.c, ours);
      await until("our second waiter did not queue", async () => (await lockWaiters(holder.pid)) >= 2);
      expect(await lockWaitersOn(holder.pid, STATEMENT), "a second waiter, queued behind the first, is counted too").toBe(2);
      expect(await lockWaitersOn(holder.pid, `delete from "categories"`), "a different statement is not counted").toBe(0);
      expect(await lockWaitersOn(foreignHolder.pid, STATEMENT), "the foreign tree is unchanged").toBe(1);
    } finally {
      for (const c of sessions) await c.query("ROLLBACK").catch(() => undefined);
      await Promise.allSettled(pending);
      for (const c of sessions) c.release();
    }
  }, 60_000);
});
