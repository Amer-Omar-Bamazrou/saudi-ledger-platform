/**
 * PHASE 16 + 17 — THE JOINT AUDIT'S REGRESSIONS, on real rows
 * (docs/product/phase-16-17-tax-treasury-decision-pack.md §13).
 *
 *   A-1  a confident zero: a Zakat or income-tax year with NOTHING in the books
 *        blocks by name (it computed 0 and could be approved); movement — the
 *        blocker leaves the moment the year has a balance;
 *   A-2  concurrency: two remittances of the same WHT month race — exactly ONE
 *        lands, the other is refused (never a 500, never a double payment), and
 *        GL WHT_PAYABLE = the WHT ledger exactly;
 *   A-3  idempotency: a remittance retried with its key returns the first —
 *        one remittance, one journal entry;
 *   A-4  concurrency: two plans for the whole of one bill race — the bill's row
 *        lock lets ONE through; Σ open plans never exceeds what the bill owes;
 *   A-5  period locks: a remittance dated in a closed month is refused (423) and
 *        writes nothing; a Zakat approval whose year-end month is closed posts
 *        TODAY as a change in estimate — never into the closed month, never
 *        silently skipped.
 *
 * Concurrent calls run on SEPARATE tenant connections (separate transactions),
 * so the races are real database races, not interleaved promises on one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { auditContext } from "../lib/auditContext";
import { journalEntriesService } from "../services/journalEntries.service";
import { billsService } from "../services/bills.service";
import { whtService } from "../services/tax/wht.service";
import { taxComputationsService } from "../services/tax/taxComputations.service";
import { zakatClassificationService } from "../services/tax/zakatClassification.service";
import { paymentPlansService } from "../services/treasury/paymentPlans.service";
import { addDays } from "../services/tax/taxComputations.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase16-17-audit] no real DATABASE_URL — skipping.");

describeMaybe("Phase 16 + 17 — the joint audit's regressions", () => {
  const SLUG = "p1617-audit", EMAIL = "p1617-audit@test.local";
  let orgId = "", coZ = "", coF = "", coW = "", coP = "", userId = 0;
  let bankW = 0, bankP = 0, bankZ = 0;
  const ids: Record<string, number> = {};
  let seq = 0;
  const today = businessToday();

  const inCo = async <T,>(co: string, fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const ORGS = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      const { rows } = await c.query(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${ORGS}`);
      await c.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };
  const refusal = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { return e as { statusCode?: number; payload?: { code?: string }; message: string; constraint?: string }; }
    throw new Error("expected a refusal");
  };
  const company = async (name: string, extra: string, cr: string) =>
    (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number${extra ? ", ownership_type" : ""}) VALUES ($1,$2,1,'gregorian','399999999999993',$3${extra ? ",$4" : ""}) RETURNING id`,
      extra ? [orgId, name, cr, extra] : [orgId, name, cr])).rows[0].id as string;
  const bank = async (co: string) => (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Ops','SNB') RETURNING id`, [orgId, co])).rows[0].id as number;
  const leaf = async (b: number) => (await pool.query(`SELECT id FROM categories WHERE bank_account_id = $1`, [b])).rows[0].id as number;
  const post = async (co: string, date: string, lines: [number, number, number][]) =>
    inCo(co, async () => {
      const e = (await journalEntriesService.create({ entryNumber: `AUD-${++seq}`, date, description: `audit ${seq}`,
        lines: lines.map(([accountId, debitAmount, creditAmount]) => ({ accountId, debitAmount, creditAmount })) }, userId)) as { id: number };
      await journalEntriesService.approve(e.id, userId);
    });
  const bill = async (co: string, vendorId: number, date: string, net: number) => {
    const b = await inCo(co, () => billsService.create({ supplierDocumentKind: "tax_invoice", vendorReference: `A-${++seq}`, billNumber: `AUD-B-${seq}`, date, dueDate: addDays(date, 30), vendorId,
      items: [{ description: "Services", quantity: 1, unitPrice: net, vatRate: 0 }] }, userId)) as { id: number };
    return (await inCo(co, () => billsService.approve(b.id, {}, userId)) as { id: number }).id;
  };
  const gl = async (co: string, code: string) => Number((await pool.query(
    `SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::text v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
       JOIN categories c ON c.id = l.account_id WHERE e.company_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [co, code])).rows[0].v);
  const entries = async (co: string) => Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE company_id = $1`, [co])).rows[0].n);

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('P1617 Audit','${SLUG}','approved') RETURNING id`)).rows[0].id;
    coZ = await company("Audit Zakat Co", "SAUDI_GCC", "1010505051");
    await new Promise((r) => setTimeout(r, 15));
    coF = await company("Audit Foreign Co", "FOREIGN", "1010505052");
    await new Promise((r) => setTimeout(r, 15));
    coW = await company("Audit WHT Co", "", "1010505053");
    await new Promise((r) => setTimeout(r, 15));
    coP = await company("Audit Plans Co", "", "1010505054");
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','AUD',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    bankW = await bank(coW); bankP = await bank(coP); bankZ = await bank(coZ);
    ids.capital = (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable) VALUES ($1,'Audit capital','رأس المال','equity',false) RETURNING id`, [orgId])).rows[0].id;
    ids.sales = (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable) VALUES ($1,'Audit sales','مبيعات','income',false) RETURNING id`, [orgId])).rows[0].id;
    ids.nr = (await pool.query(`INSERT INTO vendors (organization_id, name, residency, wht_default_payment_type, country, foreign_tax_id) VALUES ($1,'Audit Consulting Ltd','non_resident','technical_consulting','GB','GB-9') RETURNING id`, [orgId])).rows[0].id;
    ids.res = (await pool.query(`INSERT INTO vendors (organization_id, name, residency) VALUES ($1,'Audit Local Supplier','resident') RETURNING id`, [orgId])).rows[0].id;
  }, 180_000);
  afterAll(cleanup);

  it("🔴 A-1 — a Zakat year with NOTHING in the books blocks by name (no confident zero); approving it is refused; the blocker leaves once the year has a balance", async () => {
    const c = await inCo(coZ, () => taxComputationsService.create({ kind: "zakat", fiscalYearLabel: 2025 }, userId));
    expect(c.live!.blockers.map((b) => b.code)).toEqual(["zakat_no_books"]);
    expect(c.live!.amount).toBeNull();
    const e = await refusal(inCo(coZ, () => taxComputationsService.approve(c.id, c.version!.id, userId)));
    expect([e.statusCode, e.payload?.code]).toEqual([422, "tax_computation_blocked"]);
    expect(await entries(coZ), "nothing posted").toBe(0);
    ids.zakatComp = c.id; ids.zakatV1 = c.version!.id;
    // movement: the year gets books — the no-books blocker leaves (an unclassified account takes its place, by name)
    await post(coZ, "2025-01-05", [[await leaf(bankZ), 100_000, 0], [ids.capital!, 0, 100_000]]);
    await post(coZ, "2025-06-10", [[await leaf(bankZ), 50_000, 0], [ids.sales!, 0, 50_000]]);
    const d = await inCo(coZ, () => taxComputationsService.detail(c.id));
    expect(d.live!.blockers.map((b) => b.code)).toEqual(["zakat_unclassified_accounts"]);
  });

  it("🔴 A-1 — an income-tax year with no income-statement movement blocks by name", async () => {
    const c = await inCo(coF, () => taxComputationsService.create({ kind: "income_tax", fiscalYearLabel: 2025 }, userId));
    expect(c.live!.blockers.map((b) => b.code)).toContain("income_tax_no_books");
    expect(c.live!.amount).toBeNull();
  });

  it("🔴 A-5 — a Zakat approval whose year-end month is CLOSED posts TODAY as a change in estimate — never into the closed month", async () => {
    // classify the one balance-sheet account the year carries (the bank's leaf: cash, current, not deducted)
    const bankLeaf = await leaf(bankZ);
    await inCo(coZ, () => zakatClassificationService.set(bankLeaf, { classification: "current_asset_not_deducted" }, userId));
    const live = await inCo(coZ, () => taxComputationsService.detail(ids.zakatComp!));
    expect(live.live!.blockers).toEqual([]);
    // base 150,000 (equity 100,000 + the year's 50,000; nothing deducted) · 2.5 % × 365 ÷ 354 = 3,866.53
    expect(live.live!.amount).toBe(3_866.53);
    await pool.query(`INSERT INTO period_locks (organization_id, company_id, period, notes) VALUES ($1,$2,'2025-12','closed by the audit')`, [orgId, coZ]);
    const ap = await inCo(coZ, () => taxComputationsService.approve(ids.zakatComp!, ids.zakatV1!, userId));
    expect([ap.version!.status, ap.version!.accruedAmount, ap.version!.accrualDate]).toEqual(["approved", 3_866.53, today]);
    const je = (await pool.query(`SELECT date::date::text AS d FROM journal_entries WHERE id = $1`, [ap.version!.accrualJournalEntryId])).rows[0];
    expect(je.d, "posted in the open period, not the closed year-end").toBe(today);
    expect(await gl(coZ, "ZAKAT_PAYMENT")).toBe(3_866.53);
    const snap = ap.approvedSnapshot as { accrual: { basis: string; date: string } };
    expect([snap.accrual.basis, snap.accrual.date]).toEqual(["change_in_estimate", today]);
  });

  it("🔴 A-5 — a WHT remittance dated in a CLOSED month is refused (423) and writes nothing", async () => {
    const b = await bill(coW, ids.nr!, "2026-07-01", 10_000);
    await inCo(coW, () => billsService.pay(b, { amount: 10_000, paidAt: "2026-07-10", bankAccountId: bankW }, userId));
    expect(await gl(coW, "WHT_PAYABLE")).toBe(500);
    const lock = (await pool.query(`INSERT INTO period_locks (organization_id, company_id, period, notes) VALUES ($1,$2,'2026-08','closed') RETURNING id`, [orgId, coW])).rows[0].id;
    const before = await entries(coW);
    const e = await refusal(inCo(coW, () => whtService.remit("2026-07", { bankAccountId: bankW, paidAt: "2026-08-08" }, userId)));
    expect(e.statusCode).toBe(423);
    expect(await entries(coW)).toBe(before);
    expect((await pool.query(`SELECT count(*)::int n FROM wht_remittances WHERE company_id = $1`, [coW])).rows[0].n).toBe(0);
    await pool.query(`DELETE FROM period_locks WHERE id = $1`, [lock]);
  });

  it("🔴 A-2 — two remittances of the same month RACE: exactly one lands, the other is refused by name; GL WHT_PAYABLE = the WHT ledger, exactly", async () => {
    const before = await entries(coW);
    const results = await Promise.allSettled([
      inCo(coW, () => whtService.remit("2026-07", { bankAccountId: bankW, paidAt: "2026-08-09" }, userId)),
      inCo(coW, () => whtService.remit("2026-07", { bankAccountId: bankW, paidAt: "2026-08-09" }, userId)),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect([ok.length, bad.length]).toEqual([1, 1]);
    const why = bad[0]!.reason as { statusCode?: number; constraint?: string; code?: string; message: string };
    // refused by the service (409 exceeds / nothing to remit) or by the database trigger (wht_remittance_exceeds) — never a silent second payment
    expect(why.message).toMatch(/owes|Nothing is owed|exceeds|remittance/i);
    expect((await pool.query(`SELECT count(*)::int n FROM wht_remittances WHERE company_id = $1`, [coW])).rows[0].n).toBe(1);
    expect(await entries(coW), "one remittance entry, the loser's rolled back").toBe(before + 1);
    expect(await gl(coW, "WHT_PAYABLE")).toBe(0);
    const ov = await inCo(coW, () => whtService.overview());
    expect(ov.reconciliation.reconciles).toBe(true);
  });

  it("🔴 A-3 — a remittance retried with its idempotency key returns the FIRST: one remittance, one journal entry", async () => {
    const b = await bill(coW, ids.nr!, "2026-09-01", 4_000);
    await inCo(coW, () => billsService.pay(b, { amount: 4_000, paidAt: "2026-09-05", bankAccountId: bankW }, userId));
    const before = await entries(coW);
    const first = await inCo(coW, () => whtService.remit("2026-09", { bankAccountId: bankW, paidAt: today, idempotencyKey: "audit-key-1" }, userId));
    const again = await inCo(coW, () => whtService.remit("2026-09", { bankAccountId: bankW, paidAt: today, idempotencyKey: "audit-key-1" }, userId));
    expect([first.replayed, again.replayed, again.remittance.id]).toEqual([false, true, first.remittance.id]);
    expect(await entries(coW)).toBe(before + 1);
    expect((await pool.query(`SELECT count(*)::int n FROM wht_remittances WHERE company_id = $1 AND period = '2026-09'`, [coW])).rows[0].n).toBe(1);
  });

  it("🔴 A-2b — the DATABASE alone holds the race: T1 inserts a remittance and holds the month's lock; T2's insert WAITS on it; after T1 commits, T2 is refused (wht_remittance_exceeds)", async () => {
    // a fresh month, so the deterministic interleaving below is the only actor
    const b = await bill(coW, ids.nr!, addDays(today, -1), 2_000);
    await inCo(coW, () => billsService.pay(b, { amount: 2_000, paidAt: today, bankAccountId: bankW }, userId));
    const period = today.slice(0, 7);
    const je = (await pool.query(`SELECT id FROM journal_entries WHERE company_id = $1 ORDER BY id DESC LIMIT 1`, [coW])).rows[0].id;
    const insert = `INSERT INTO wht_remittances (organization_id, company_id, period, amount, fine_amount, paid_at, bank_account_id, journal_entry_id) VALUES ($1,$2,$3,100,0,$4,$5,$6)`;
    const t1 = await pool.connect(), t2 = await pool.connect();
    try {
      await t1.query("BEGIN"); await t2.query("BEGIN");
      await t1.query(insert, [orgId, coW, period, today, bankW, je]);                // 100 of 100 owed; T1 holds the advisory lock
      let t2Settled = false;
      const p2 = t2.query(insert, [orgId, coW, period, today, bankW, je]).then(() => { t2Settled = true; return null; }, (e: { constraint?: string }) => { t2Settled = true; return e; });
      await new Promise((r) => setTimeout(r, 300));
      expect(t2Settled, "T2 waits on T1's lock — the check and the insert cannot interleave").toBe(false);
      await t1.query("COMMIT");
      const err = await p2;
      expect((err as { constraint?: string } | null)?.constraint).toBe("wht_remittance_exceeds");
      await t2.query("ROLLBACK");
    } finally { t1.release(); t2.release(); }
    expect(Number((await pool.query(`SELECT coalesce(sum(amount),0)::numeric s FROM wht_remittances WHERE company_id = $1 AND period = $2`, [coW, period])).rows[0].s)).toBe(100);
  });

  it("🔴 A-6 — pre-D-3 cash history on the NON-POSTING `CASH` header can be classified: the blocker that names it is a blocker a person can clear (it was a dead end — the page never listed it, the database refused it)", async () => {
    // CLAUDE.md §5: pre-D-3 cash history stays on the CASH header (non-posting) until the per-company cut-over
    // runs — every local company. PLANTED (triggers off) because the posting path can no longer write it.
    const coH = await company("Audit Header Co", "SAUDI_GCC", "1010505055");
    const header = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'CASH'`, [orgId])).rows[0].id as number;
    const c = await pool.connect();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica");
      const je = (await c.query(`INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status, posted_at) VALUES ($1,$2,'AUD-PRE-D3','2025-03-01','pre-D-3 history','posted',now()) RETURNING id`, [orgId, coH])).rows[0].id;
      await c.query(`INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount) VALUES ($1,$2,$3,$4,'Cash and Bank',80000,0), ($1,$2,$3,$5,'Audit capital',0,80000)`, [orgId, coH, je, header, ids.capital]);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }

    const comp = await inCo(coH, () => taxComputationsService.create({ kind: "zakat", fiscalYearLabel: 2025 }, userId));
    const blocker = comp.live!.blockers.find((b) => b.code === "zakat_unclassified_accounts");
    expect(blocker?.accounts?.map((a) => a.key), "the blocker names the header").toEqual([String(header)]);
    // the classification list offers it (it carries this company's history) …
    const listed = (await inCo(coH, () => zakatClassificationService.list())).find((a) => a.accountId === header);
    expect([listed?.suggestion, listed?.classification], "listed, with its cash suggestion").toEqual(["current_asset_not_deducted", null]);
    // … a person confirms it, the database admits it, and the blocker leaves
    await inCo(coH, () => zakatClassificationService.set(header, { classification: "current_asset_not_deducted" }, userId));
    const after = await inCo(coH, () => taxComputationsService.detail(comp.id));
    expect(after.live!.blockers).toEqual([]);
    // base 80,000 (equity; nothing deducted) · 2.5 % × 365 ÷ 354 = 2,062.15
    expect(after.live!.amount).toBe(2_062.15);
  });

  it("🔴 A-4 — two plans for the WHOLE of one bill race: the bill's row lock lets one through; Σ open plans ≤ what the bill owes", async () => {
    const b = await bill(coP, ids.res!, addDays(today, -2), 1_000);
    const results = await Promise.allSettled([
      inCo(coP, () => paymentPlansService.create({ billId: b, plannedDate: addDays(today, 5), amount: 1_000 }, userId)),
      inCo(coP, () => paymentPlansService.create({ billId: b, plannedDate: addDays(today, 6), amount: 1_000 }, userId)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const why = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as { statusCode?: number; payload?: { code?: string } };
    expect([why.statusCode, why.payload?.code]).toEqual([409, "plan_exceeds_outstanding"]);
    const open = (await pool.query(`SELECT coalesce(sum(amount),0)::numeric AS s FROM scheduled_payments WHERE bill_id = $1 AND status IN ('planned','approved')`, [b])).rows[0].s;
    expect(Number(open)).toBe(1_000);
    expect(bankP).toBeGreaterThan(0);
  });
});
