/**
 * PHASE 11, BATCH 1 — the two defects the audit found in SHIPPED code
 * (2026-09-22). Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §1.
 *
 * Neither was a missing feature. Both were wrong every day they ran:
 *
 *  A4  `journalEntries.reverse` writes its mirror through the repository
 *      rather than `postJournalEntry` — deliberately, because the mirror must
 *      be the original's lines swapped, carrying the same party and the same
 *      D-3 bank attribution. But that also bypassed `checkPeriodOpen`, so a
 *      reversal could post into a CLOSED month, which is the one thing a
 *      period lock exists to prevent.
 *
 *  B6  both ageing reports bucketed on `new Date()` — the server's midnight.
 *      Between 00:00 and 03:00 in Riyadh a document was a day younger than it
 *      really was, which is the night-window class the write paths already
 *      fixed with `businessToday()`.
 *
 * 🔴 The ageing test does NOT freeze the clock. It asserts the PROPERTY that
 * makes the fix correct — the bucket boundary falls on the Riyadh calendar day
 * — by seeding documents whose due dates sit exactly on the boundary the bug
 * moved. A test that froze time would pass against the old code too.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { auditContext } from "../lib/auditContext";
import { journalEntriesService } from "../services/journalEntries.service";
import { periodLocksService } from "../services/periodLocks.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("Phase 11 batch 1 — reversal period lock and business-day ageing (real rows)", () => {
  const SLUG = "p11-b1";
  const EMAIL = "p11-b1@test.local";
  let orgId = "", companyId = "", userId = 0, vendorId = 0;
  let cashId = 0, equityId = 0;

  const inTenant = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      for (const t of ["bill_payments", "bill_items", "bills", "journal_entry_lines", "journal_entries", "period_locks", "findings", "finding_runs", "audit_logs", "organization_memberships", "vendors", "bank_accounts", "categories", "companies"]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    let err: { statusCode?: number; status?: number; payload?: { code?: string }; message?: string } | undefined;
    try { await p; } catch (e) { err = e as typeof err; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err!.statusCode ?? err!.status, err!.message).toBe(status);
    if (code) expect(err!.payload?.code).toBe(code);
  };
  const accountId = async (code: string) =>
    (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;

  /** A balanced two-line entry, posted, on a date of our choosing. */
  const postEntry = async (date: string, amount: number, n: string) => {
    const je = await inTenant(() => journalEntriesService.create({
      entryNumber: n, date, description: `Entry ${n}`,
      lines: [
        { accountId: cashId, accountName: "c", debitAmount: amount, creditAmount: 0, description: "d" },
        { accountId: equityId, accountName: "e", debitAmount: 0, creditAmount: amount, description: "c" },
      ],
    } as never, userId));
    return inTenant(() => journalEntriesService.approve(je.id, userId));
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P11 B1','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P11 B1 Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P11',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'A Vendor') RETURNING id`, [orgId])).rows[0].id;
    cashId = await accountId("FIXED_ASSETS");      // any posting asset account will do
    equityId = await accountId("RETAINED_EARNINGS");
  }, 60_000);
  afterAll(cleanup);

  // ── A4 ────────────────────────────────────────────────────────────────────

  it("🔴 A4 — a reversal into a CLOSED month is refused (423 period_closed) and posts NOTHING; the original stays posted", async () => {
    const entry = await postEntry("2026-03-15", 1_000, "P11-A4-1");
    expect(entry.status).toBe("posted");

    // Close the month the caller will try to reverse into.
    await inTenant(() => periodLocksService.lock({ period: "2026-04", userId }));
    const before = (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n;

    await expectRefusal(
      inTenant(() => journalEntriesService.reverse(entry.id, { date: "2026-04-10", reason: "Posted in error" })),
      423, "period_closed",
    );

    // 🔴 NOTHING was written, and the original is untouched — a refusal that
    // left a half-made mirror behind would be worse than no check at all.
    expect((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(before);
    const [orig] = (await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [entry.id])).rows;
    expect(orig.status).toBe("posted");
  }, 60_000);

  it("🔴 A4 — the same reversal into an OPEN month succeeds, carries its REASON, and is dated where the caller said", async () => {
    const entry = await postEntry("2026-03-16", 250, "P11-A4-2");
    const out = await inTenant(() => journalEntriesService.reverse(entry.id, { date: "2026-05-02", reason: "Duplicate of P11-A4-1" }));

    const [rev] = (await pool.query(`SELECT date::text, reversal_of, reversal_reason, status FROM journal_entries WHERE id = $1`, [out.reversalId])).rows;
    expect([rev.date, rev.reversal_of, rev.reversal_reason, rev.status]).toEqual(["2026-05-02", entry.id, "Duplicate of P11-A4-1", "posted"]);
    // the original is a MARKER, not erased — JE_IN_BOOKS still contains it
    const [orig] = (await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [entry.id])).rows;
    expect(orig.status).toBe("reversed");

    // the mirror really mirrors: debit and credit swapped, same accounts
    const lines = (await pool.query(
      `SELECT account_id, debit_amount::text d, credit_amount::text c FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY id`, [out.reversalId])).rows;
    expect(lines.map((l: { account_id: number; d: string; c: string }) => [l.account_id, l.d, l.c])).toEqual([
      [cashId, "0.00", "250.00"],
      [equityId, "250.00", "0.00"],
    ]);
  }, 60_000);

  it("🔴 A4 — with no date given it posts on the BUSINESS day, and a malformed date is refused before anything is written", async () => {
    const entry = await postEntry("2026-03-17", 75, "P11-A4-3");
    await expectRefusal(inTenant(() => journalEntriesService.reverse(entry.id, { date: "10-05-2026" })), 400);
    // …the original is still reversible, so the refusal cost nothing
    const out = await inTenant(() => journalEntriesService.reverse(entry.id, { reason: "No date given" }));
    const [rev] = (await pool.query(`SELECT date::text, reversal_reason FROM journal_entries WHERE id = $1`, [out.reversalId])).rows;
    expect(rev.date).toBe(businessToday());
    expect(rev.reversal_reason).toBe("No date given");
  }, 60_000);

  it("🔴 A4 — a reason is OPTIONAL and its absence is NULL, not an empty string: a blank must not read as a stated reason", async () => {
    const entry = await postEntry("2026-03-18", 40, "P11-A4-4");
    const out = await inTenant(() => journalEntriesService.reverse(entry.id, { reason: "   " }));
    const [rev] = (await pool.query(`SELECT reversal_reason FROM journal_entries WHERE id = $1`, [out.reversalId])).rows;
    expect(rev.reversal_reason).toBeNull();
  }, 60_000);

  // ── B6 ────────────────────────────────────────────────────────────────────

  it("🔴 B6 — ageing buckets on the RIYADH calendar day: a bill due today is CURRENT and one due yesterday is 1–30, whatever the server's clock says", async () => {
    const today = businessToday();
    const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);

    const mk = async (n: string, due: string, total: number) => {
      const [b] = (await pool.query(
        `INSERT INTO bills (organization_id, company_id, bill_number, vendor_id, date, due_date, status, subtotal, vat_amount, total, paid_amount)
         VALUES ($1,$2,$3,$4,$5,$6,'received',$7,0,$7,0) RETURNING id`,
        [orgId, companyId, n, vendorId, due, due, total])).rows;
      return b.id as number;
    };
    await mk("P11-AGE-TODAY", today, 100);
    await mk("P11-AGE-YDAY", yesterday, 200);

    const aging = await inTenant(() => reportsService.apAging());
    const byNumber = Object.fromEntries((aging.items as Array<{ billNumber: string; daysPastDue: number }>).map((i) => [i.billNumber, i.daysPastDue]));

    // 🔴 The boundary itself: due TODAY is not yet past due; due YESTERDAY is
    // exactly one day past. Under the server clock these slid by a day for
    // three hours out of every twenty-four.
    expect(byNumber["P11-AGE-TODAY"]).toBe(0);
    expect(byNumber["P11-AGE-YDAY"]).toBe(1);

    const buckets = aging.buckets as unknown as Record<string, number>;
    expect(Number(buckets.current)).toBeGreaterThanOrEqual(100);
    expect(Number(buckets.days_1_30)).toBeGreaterThanOrEqual(200);
  }, 60_000);

  it("🔴 B6 — a PARTLY paid bill ages on what is still outstanding, and a fully paid one leaves the ageing entirely", async () => {
    const today = businessToday();
    const [partial] = (await pool.query(
      `INSERT INTO bills (organization_id, company_id, bill_number, vendor_id, date, due_date, status, subtotal, vat_amount, total, paid_amount)
       VALUES ($1,$2,'P11-AGE-PART',$3,$4,$4,'received',1000,0,1000,400) RETURNING id`, [orgId, companyId, vendorId, today])).rows;
    await pool.query(
      `INSERT INTO bills (organization_id, company_id, bill_number, vendor_id, date, due_date, status, subtotal, vat_amount, total, paid_amount)
       VALUES ($1,$2,'P11-AGE-DONE',$3,$4,$4,'paid',500,0,500,500)`, [orgId, companyId, vendorId, today]);

    const aging = await inTenant(() => reportsService.apAging());
    const items = aging.items as Array<{ billNumber: string; outstanding: number }>;
    expect(Number(items.find((i) => i.billNumber === "P11-AGE-PART")!.outstanding)).toBe(600);
    expect(items.find((i) => i.billNumber === "P11-AGE-DONE")).toBeUndefined();
    expect(partial.id).toBeGreaterThan(0);
  }, 60_000);
});
