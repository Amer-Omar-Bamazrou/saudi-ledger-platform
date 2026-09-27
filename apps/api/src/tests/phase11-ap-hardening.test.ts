/**
 * PHASE 11 PART 2 — THE POST-BUILD AUDIT'S FINDINGS, EACH PROVEN CLOSED ON REAL
 * ROWS (2026-09-23). Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §17.
 *
 * The first build of the AP subledger was correct inside the files it touched
 * and wrong at its EDGES — the places another path reads what it wrote:
 *
 *  1. 🔴 the legacy pay path read `total − paid_amount`, so a bill an advance
 *     had settled could be paid again in full (Dr AP twice for one debt);
 *  2. 🔴 reversing a CREDIT-NOTE application posted Dr SUPPLIER_ADVANCES / Cr
 *     AP — an advance no payment explained — because the reversal path assumed
 *     every allocation came from a payment;
 *  3. 🔴 one request naming the same bill twice over-settled it (each line was
 *     checked against the stored balance, not against its siblings);
 *  4. 🔴 eight readers kept `total − paid_amount` or summed a credit note
 *     positively: vendor balances, the Bills headline and overdue count, bank-
 *     match candidates, the overdue finding, the migration-reversal guard, the
 *     AP invariant — now ONE definition (repositories/billPosition);
 *  5. `source` was client-writable (migration provenance a caller could forge),
 *     and an idempotency key was stored but never honoured;
 *  6. the supplier statement had no window, no opening balance and no GL tie.
 *
 * Each test asserts PRESENCE, ABSENCE and MOVEMENT, so none can pass on empty
 * data — and the invariants test carries a planted positive, so its silence is
 * known to be the silence of an instrument that can see.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { vendorsService } from "../services/vendors.service";
import { reportsService } from "../services/reports.service";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { supplierCreditNotesService } from "../services/accounting/supplierCreditNotes.service";
import { supplierStatementService } from "../services/accounting/supplierStatement.service";
import { postJournalEntry } from "../services/accounting/glPosting";
import { billsRepository } from "../repositories/bills.repository";
import { findingsRepository } from "../repositories/findings.repository";
import { migrationRepository } from "../repositories/migration.repository";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("Phase 11 Part 2 — the AP subledger's edges, hardened (real rows)", () => {
  const SLUG = "p11-aphard";
  const EMAIL = "p11-aphard@test.local";
  let orgId = "", companyId = "", userId = 0, vendorId = 0, bankId = 0;
  let billA = 0, billB = 0, billC = 0, advanceId = 0, noteId = 0;

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
      await client.query("SET LOCAL session_replication_role = replica");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      for (const t of ["supplier_refunds", "supplier_payment_allocation_reversals", "supplier_payment_allocations",
                       "supplier_payment_classifications", "supplier_payments",
                       "bill_payments", "bill_items", "bills", "journal_entry_lines", "journal_entries",
                       "period_locks", "findings", "finding_runs", "audit_logs",
                       "organization_memberships", "vendors", "bank_accounts", "categories", "companies"]) {
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
  /** Debit − credit on a system account, over the books, for this org. */
  const gl = async (code: string) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [orgId, code])).rows[0].v);
  const entryCount = async () =>
    Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n);
  const approvedBill = async (billNumber: string, date: string, dueDate: string, net: number) => {
    const draft = await inTenant(() => billsService.create({
      billNumber, date, dueDate, vendorId,
      items: [{ description: "Supply", quantity: 1, unitPrice: net, vatRate: 15 }],
    }, userId));
    return (await inTenant(() => billsService.approve(draft.id, {}, userId))).id;
  };
  const owes = (id: number) => inTenant(() => billsRepository.outstandingOf(id));

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P11 AP Hardening','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P11 Hard Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P11H',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Hardening Supplies') RETURNING id`, [orgId])).rows[0].id;
    bankId = (await pool.query(
      `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Hard Bank','Riyad') RETURNING id`,
      [orgId, companyId])).rows[0].id;

    billA = await approvedBill("HB-A", "2026-07-01", "2026-07-31", 1_000);   // 1,150
    billB = await approvedBill("HB-B", "2026-07-02", "2026-08-01", 2_000);   // 2,300
    billC = await approvedBill("HB-C", "2026-07-03", "2026-08-02", 400);     // 460 — never touched
    const adv = await inTenant(() => supplierPaymentsService.create({
      vendorId, bankAccountId: bankId, amount: 1_000, paidAt: "2026-07-05", classification: "advance",
    }, userId));
    advanceId = adv.id;
  }, 180_000);
  afterAll(cleanup);

  it("🔴 1 — the legacy pay path reads what the bill OWES, not total − paid: a bill an advance settled cannot be paid again in full", async () => {
    await inTenant(() => supplierPaymentsService.allocate(advanceId, { allocations: [{ billId: billA, amount: 1_000 }], date: "2026-07-06" }, userId));
    expect(await owes(billA)).toBe(150);
    const apBefore = await gl("AP");

    // Before the fix this was accepted: 1,150 ≤ total − paid_amount = 1,150.
    await expectRefusal(inTenant(() => billsService.pay(billA, { amount: 1_150, paidAt: "2026-07-07", bankAccountId: bankId }, userId)), 409);
    expect(await gl("AP"), "a refused payment moves nothing").toBe(apBefore);

    // What it actually owes is accepted, and settles it.
    const paid = await inTenant(() => billsService.pay(billA, { amount: 150, paidAt: "2026-07-07", bankAccountId: bankId }, userId));
    expect(paid.status).toBe("paid");
    expect(paid.outstanding, "the pay response reads the balance back through billPosition").toBe(0);
    expect(await owes(billA)).toBe(0);
    expect(await gl("AP"), "AP moved by exactly the 150 paid").toBeCloseTo(apBefore + 150, 2);
  }, 90_000);

  it("🔴 3 — one request may not name a bill twice (it was checked twice against the same stored balance)", async () => {
    const before = await entryCount();
    await expectRefusal(inTenant(() => supplierPaymentsService.create({
      vendorId, bankAccountId: bankId, amount: 2_300, paidAt: "2026-07-08",
      allocations: [{ billId: billC, amount: 460 }, { billId: billC, amount: 460 }],
    }, userId)), 422, "allocation_duplicate_bill");
    expect(await entryCount(), "nothing posted").toBe(before);
    expect(await owes(billC), "and the bill still owes all of it").toBe(460);
  }, 60_000);

  it("🔴 dates: money cannot be applied or come back before it was paid", async () => {
    const p = await inTenant(() => supplierPaymentsService.create({
      vendorId, bankAccountId: bankId, amount: 100, paidAt: "2026-07-10", classification: "advance",
    }, userId));
    await expectRefusal(inTenant(() => supplierPaymentsService.allocate(p.id, { allocations: [{ billId: billB, amount: 50 }], date: "2026-07-09" }, userId)), 422, "date_before_payment");
    await expectRefusal(inTenant(() => supplierPaymentsService.refund(p.id, { amount: 50, reason: "x", bankAccountId: bankId, refundedAt: "2026-07-01" }, userId)), 422, "date_before_payment");
    // the same acts on or after the payment date are accepted (the refusal is the date, not the act)
    const refunded = await inTenant(() => supplierPaymentsService.refund(p.id, { amount: 100, reason: "Not needed", bankAccountId: bankId, refundedAt: "2026-07-10" }, userId));
    expect(refunded.amount).toBe(100);
  }, 60_000);

  it("🔴 5 — a replayed request is the SAME payment, and `source` is never the caller's to state", async () => {
    const before = await entryCount();
    const body = { vendorId, bankAccountId: bankId, amount: 75, paidAt: "2026-07-11", idempotencyKey: "p11-hard-key-1", source: "opening" };
    const first = await inTenant(() => supplierPaymentsService.create({ ...body }, userId));
    const again = await inTenant(() => supplierPaymentsService.create({ ...body }, userId));
    expect(again.id).toBe(first.id);
    expect(await entryCount(), "ONE journal entry for two identical requests").toBe(before + 1);
    // 🔴 migration provenance cannot be forged through the manual path
    expect(first.source).toBe("manual");
    const { rows } = await pool.query(`SELECT count(*)::int n FROM supplier_payments WHERE organization_id = $1 AND source = 'opening'`, [orgId]);
    expect(rows[0].n).toBe(0);
  }, 60_000);

  it("🔴 2 — undoing a CREDIT-NOTE application posts NOTHING (its application posted nothing) — no phantom advance, AP unmoved", async () => {
    const draft = await inTenant(() => billsService.create({
      billNumber: "HB-CN", date: "2026-07-15", vendorId, documentType: "credit_note", creditNoteAgainstBillId: billB,
      items: [{ description: "Returned", quantity: 1, unitPrice: 200, vatRate: 15 }],
    }, userId));
    noteId = (await inTenant(() => billsService.approve(draft.id, {}, userId))).id;
    const applied = await inTenant(() => supplierCreditNotesService.apply(noteId, { allocations: [{ billId: billB, amount: 230 }] }, userId));
    const appId = applied.applications[0]!.id;
    expect(await owes(billB)).toBe(2_070);

    const [entries, ap, advances] = [await entryCount(), await gl("AP"), await gl("SUPPLIER_ADVANCES")];
    const rev = await inTenant(() => supplierPaymentsService.reverseAllocation(appId, { reason: "Applied to the wrong bill" }, userId));

    // ABSENCE — nothing posted, and in particular no advance appeared
    expect(rev.journalEntryId).toBeNull();
    expect(await entryCount()).toBe(entries);
    expect(await gl("SUPPLIER_ADVANCES"), "the first build posted Dr SUPPLIER_ADVANCES here").toBe(advances);
    expect(await gl("AP")).toBe(ap);
    // MOVEMENT — the bill owes the note's amount again, and the note has it to give again
    expect(await owes(billB)).toBe(2_300);
    expect((await inTenant(() => supplierCreditNotesService.getById(noteId))).availableAmount).toBe(230);
    // the superseding row exists, with a null entry, and a second correction is refused
    const { rows } = await pool.query(`SELECT journal_entry_id FROM supplier_payment_allocation_reversals WHERE allocation_id = $1`, [appId]);
    expect(rows).toEqual([{ journal_entry_id: null }]);
    await expectRefusal(inTenant(() => supplierPaymentsService.reverseAllocation(appId, { reason: "again" }, userId)), 409, "allocation_already_reversed");
  }, 90_000);

  it("🔴 2b — the DATABASE refuses a reversal whose journal entry does not follow what it reverses", async () => {
    // a PAYMENT allocation (the advance → bill A) reversed with NO mirror entry
    const { rows: [payAlloc] } = await pool.query(
      `SELECT id FROM supplier_payment_allocations WHERE organization_id = $1 AND supplier_payment_id = $2 LIMIT 1`, [orgId, advanceId]);
    await expect(pool.query(
      `INSERT INTO supplier_payment_allocation_reversals (organization_id, company_id, allocation_id, reason, journal_entry_id) VALUES ($1,$2,$3,'x',NULL)`,
      [orgId, companyId, payAlloc.id])).rejects.toThrow(/must carry the mirror entry/);
    // a NOTE application reversed WITH an entry
    const reapplied = await inTenant(() => supplierCreditNotesService.apply(noteId, { allocations: [{ billId: billB, amount: 100 }] }, userId));
    const liveApp = reapplied.applications.find((a) => !a.reversed)!;
    const { rows: [anyEntry] } = await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 LIMIT 1`, [orgId]);
    await expect(pool.query(
      `INSERT INTO supplier_payment_allocation_reversals (organization_id, company_id, allocation_id, reason, journal_entry_id) VALUES ($1,$2,$3,'x',$4)`,
      [orgId, companyId, liveApp.id, anyEntry.id])).rejects.toThrow(/posts nothing either/);
  }, 60_000);

  it("🔴 4 — every reader agrees about what a bill owes and signs a credit note (the list, settlement candidates, the finding, the ageing, the vendor balance)", async () => {
    // Bill A settled (0), bill B owes 2,300 − 100 applied = 2,200, bill C 460, the note 0.
    const list = await inTenant(() => billsService.list({ vendorId }));
    const by = new Map(list.items.map((b) => [b.id, b]));
    expect(by.get(billA)!.outstanding).toBe(0);
    expect(by.get(billB)!.outstanding).toBe(2_200);
    expect(by.get(billC)!.outstanding).toBe(460);
    expect(by.get(noteId)!.outstanding, "a credit note owes nothing").toBe(0);
    expect(list.totals.outstanding, "the headline sums what is OWED — the note is not added").toBeCloseTo(2_660, 2);

    // bank-match candidates: never a credit note, never a settled bill
    const open = (await inTenant(() => billsRepository.openForSettlement())).map((r) => r.bill.id);
    expect(open).toEqual(expect.arrayContaining([billB, billC]));
    expect(open).not.toContain(billA);
    expect(open).not.toContain(noteId);

    // the overdue finding: B and C are past due (Aug), A is settled, the note is never overdue
    const overdue = (await inTenant(() => findingsRepository.overduePayables())).map((f) => f.facts.billId);
    expect(overdue).toEqual(expect.arrayContaining([billB, billC]));
    expect(overdue).not.toContain(billA);
    expect(overdue).not.toContain(noteId);
    const bFinding = (await inTenant(() => findingsRepository.overduePayables())).find((f) => f.facts.billId === billB)!;
    expect(bFinding.facts.outstanding).toBe(2_200);

    // the ageing: same figures, the note not a row
    const aging = await inTenant(() => reportsService.apAging());
    const agedIds = aging.items.map((i: { id: number }) => i.id);
    expect(agedIds).toEqual(expect.arrayContaining([billB, billC]));
    expect(agedIds).not.toContain(billA);
    expect(agedIds).not.toContain(noteId);

    // 🔴 the vendor balance IS the AP control balance for the vendor — signed
    // (the note reduces what was billed) and net of subledger payments.
    const v = await inTenant(() => vendorsService.getById(vendorId));
    expect(v.totalBilled).toBeCloseTo(1_150 + 2_300 + 460 - 230, 2);
    expect(v.balance).toBeCloseTo(-(await gl("AP")), 2);
    expect(v.balance, "non-zero, so the equality is not vacuous").toBeGreaterThan(0);
  }, 90_000);

  it("🔴 the migration-reversal guard sees a bill settled through the subledger — and stays silent on one nothing touched", async () => {
    const touched = await inTenant(() => migrationRepository.touchesSinceCommit([], [billA, billB], []));
    expect(touched.join("\n")).toMatch(/bill HB-A \(allocations 1/);
    expect(touched.join("\n")).toMatch(/bill HB-B \(allocations \d+, supplier notes 1/);
    // the planted negative: an untouched bill reports nothing, so the above is not "reports everything"
    expect(await inTenant(() => migrationRepository.touchesSinceCommit([], [billC], []))).toEqual([]);
  }, 60_000);

  it("🔴 6 — the statement WINDOW is deterministic: a window's opening is the previous window's closing, and it ties to the GL", async () => {
    const early = await inTenant(() => supplierStatementService.statement(vendorId, { to: "2026-07-05" }));
    const late = await inTenant(() => supplierStatementService.statement(vendorId, { from: "2026-07-06" }));
    const whole = await inTenant(() => supplierStatementService.statement(vendorId));

    expect(late.opening).toEqual(early.closing);
    expect(late.closing).toEqual(whole.closing);
    expect(early.closing.net, "non-zero — bills and an advance precede the cut").not.toBe(0);
    expect(late.lines.every((l) => l.date >= "2026-07-06")).toBe(true);
    expect(early.lines.every((l) => l.date <= "2026-07-05")).toBe(true);
    expect(early.lines.length + late.lines.length).toBe(whole.lines.length);

    // the self-check and the GL tie hold over the whole stream, whatever the window
    expect(whole.reconciliation.agrees).toBe(true);
    expect(whole.gl.agrees).toBe(true);
    expect(whole.gl.components.ap.fromGl).toBeCloseTo(-(await gl("AP")), 2);
    expect(whole.gl.components.advances.fromGl).toBeCloseTo(await gl("SUPPLIER_ADVANCES"), 2);

    await expectRefusal(inTenant(() => supplierStatementService.statement(vendorId, { from: "2026-08-01", to: "2026-07-01" })), 422, "window_inverted");
  }, 60_000);

  it("🔴 the ledger invariants script reconciles this org's AP and on-account assets — and SEES a planted break", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p11-inv-"));
    const run = (name: string) => {
      const out = join(dir, `${name}.json`);
      try {
        execFileSync(process.execPath, ["--import", "tsx", "src/scripts/ledgerInvariants.ts", "--json", out], {
          cwd: join(__dirname, "..", ".."), env: process.env, stdio: "pipe", timeout: 120_000,
        });
      } catch { /* exit 2 = some org somewhere diverges; the report is still written */ }
      expect(existsSync(out), "the script wrote its report").toBe(true);
      const report = JSON.parse(readFileSync(out, "utf8")) as Record<string, { org: string }[]>;
      const mine = (key: string) => (Object.entries(report).find(([k]) => k.startsWith(key))?.[1] ?? []).filter((r) => r.org === orgId);
      return { ap: mine("ap_gl_vs_subledger_by_vendor"), onAccount: mine("ap_on_account_gl_vs_subledger") };
    };

    const clean = run("clean");
    expect(clean.ap, "AP subledger = AP GL for this org (credit note, subledger payments, legacy pay)").toEqual([]);
    expect(clean.onAccount, "on-account subledger = the three asset accounts").toEqual([]);

    // PLANTED: 5.00 on SUPPLIER_ADVANCES for this vendor that no payment explains
    await inTenant(() => postJournalEntry({
      entryNumber: "P11-PLANTED-1", date: "2026-07-20", description: "planted — no payment explains this",
      lines: [
        { systemCode: "SUPPLIER_ADVANCES", accountName: "Supplier advances", description: "planted", debitAmount: 5, creditAmount: 0, party: { type: "vendor", vendorId } },
        { bankAccountId: bankId, description: "planted", debitAmount: 0, creditAmount: 5 },
      ],
    }));
    const planted = run("planted");
    expect(planted.onAccount.length, "the instrument can see a break of exactly this shape").toBe(1);
  }, 300_000);
});
