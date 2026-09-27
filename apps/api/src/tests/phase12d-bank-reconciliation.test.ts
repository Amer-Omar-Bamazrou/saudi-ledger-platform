/**
 * PHASE 12D — A BANK RECONCILIATION AS OF A DATE, THE LOCK, THE CASH POSITION
 * AND THE EXCEPTIONS (2026-09-23), on real rows.
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §6.
 *
 * One bank, one June, written through the product's own paths:
 *   ledger     06-02 receipt +5,000 · 06-10 supplier payment −1,200 · 06-29 supplier payment −300 (clears 07-02)
 *   statement  06-03 +5,000 · 06-11 −1,200 · 06-30 −25 bank charge (in no ledger) · 07-02 −300
 * As of 06-30: ledger 3,500; the −300 cheque is ledger-only; the −25 charge
 * statement-only; the bank says 3,775 — and 3,500 − (−300) + (−25) = 3,775.
 *
 *  · 🔴 every term asserted, and the cheque outstanding AT 06-30 but not at 07-31 (movement);
 *  · 🔴 NO PLUG: a wrong balance is refused with the difference, nothing recorded;
 *  · 🔴 THE LOCK: through 06-30 no line is imported, un-reconciled or posted to
 *    that bank — posting on 07-05 still works; a new link to clear an item is allowed;
 *  · reopening: the latest only, with a reason, and the lock moves back;
 *  · the cash position and the exceptions, from the same definitions;
 *  · append-only; isolation with presence, absence and movement.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { auditContext } from "../lib/auditContext";
import { errorHandler } from "../middleware/errorHandler";
import { transactionsService } from "../services/transactions.service";
import { paymentsService } from "../services/payments.service";
import { statementMatchingService } from "../services/statementMatching.service";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { bankReconciliationService } from "../services/accounting/bankReconciliation.service";
import { bankReconciliationsService } from "../services/accounting/bankReconciliations.service";
import { bankTransfersService } from "../services/accounting/bankTransfers.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("Phase 12D — bank reconciliation as of a date (real rows)", () => {
  const SLUG = "p12d-rec", SLUG_B = "p12d-rec-other";
  const EMAIL = "p12d-rec@test.local";
  let orgId = "", companyId = "", userId = 0, bankId = 0, vendorId = 0, customerId = 0;
  let orgB = "", companyB = "", bankB = 0;
  let chequeEntry = 0;

  const inTenant = async <T,>(fn: () => Promise<T>, org = orgId, co = companyId): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const slug of [SLUG, SLUG_B]) {
        const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
        for (const t of ["bank_reconciliation_reopenings", "bank_reconciliations", "bank_transfer_reversals", "bank_transfers", "bank_statement_link_reversals", "bank_statement_links",
                         "statement_match_reversals", "statement_matches", "supplier_payment_classifications", "supplier_payments",
                         "payment_allocations", "payments", "transactions", "bank_statements",
                         "journal_entry_lines", "journal_entries", "audit_logs",
                         "organization_memberships", "vendors", "customers", "bank_accounts", "categories", "companies"]) {
          await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
        }
        await client.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
      }
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const pgCode = (e: unknown) => { const x = e as { code?: string; cause?: { code?: string } }; return x?.code && /^[0-9A-Z]{5}$/.test(x.code) ? x.code : x?.cause?.code; };
  const pgMessage = (e: unknown) => { const x = e as { message?: string; cause?: { message?: string } }; return x?.cause?.message ?? x?.message ?? ""; };
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    let err: { statusCode?: number; payload?: { code?: string; difference?: number }; message?: string } | undefined;
    try { await p; } catch (e) { err = e as typeof err; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err!.statusCode, err!.message).toBe(status);
    if (code) expect(err!.payload?.code, err!.message).toBe(code);
    return err!;
  };
  /** What the ONE error boundary answers for an error (the trigger text ↔ mapping pin). */
  const mapped = (err: unknown) => {
    let status = 0; let body: { code?: string } | undefined;
    const res = { headersSent: false, status(c: number) { status = c; return res; }, json(b: { code?: string }) { body = b; return res; } };
    errorHandler(err, { log: { error() {}, warn() {} } } as never, res as never, () => {});
    return { status, code: body?.code };
  };
  const expectLocked = async (p: Promise<unknown>) => {
    let err: unknown;
    try { await p; } catch (e) { err = e; }
    expect(err, "expected the reconciliation lock").toBeTruthy();
    const e = err as { payload?: { code?: string } };
    if (e.payload?.code) expect(e.payload.code).toBe("bank_reconciled_through");
    else { expect(pgCode(err)).toBe("23514"); expect(pgMessage(err)).toMatch(/is reconciled through 2026-06-30/); }
    // 🔴 and the ONE error boundary turns the database's refusal into a 409 the UI keys on
    expect(mapped(err), "the trigger's message and the error-boundary mapping stay in step").toEqual({ status: 409, code: "bank_reconciled_through" });
  };
  const lineByDesc = async (d: string) => (await pool.query(`SELECT * FROM transactions WHERE organization_id = $1 AND description = $2`, [orgId, d])).rows[0];
  const importLines = (rows: Array<{ date: string; description: string; amount: number; type: "debit" | "credit" }>, bank = bankId, org = orgId, co = companyId) =>
    inTenant(() => transactionsService.upload({ rows, bankAccountId: bank, autoCategrize: false } as never, userId), org, co);
  const cashLine = async (entryId: number) =>
    (await pool.query(`SELECT line_id FROM journal_line_bank_identity WHERE journal_entry_id = $1 AND bank_account_id = $2`, [entryId, bankId])).rows[0].line_id as number;
  const position = (asOf: string, statementBalance?: number) => inTenant(() => bankReconciliationsService.position({ bankAccountId: bankId, asOf, statementBalance }));

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P12D Rec','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P12D Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P12D',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    bankId = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Main SNB','SNB') RETURNING id`, [orgId, companyId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Najd Paper') RETURNING id`, [orgId])).rows[0].id;
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Hijaz Trading') RETURNING id`, [orgId])).rows[0].id;
    orgB = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P12D Other','${SLUG_B}') RETURNING id`)).rows[0].id;
    companyB = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P12D Other Co') RETURNING id`, [orgB])).rows[0].id;
    bankB = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Other Bank','ANB') RETURNING id`, [orgB, companyB])).rows[0].id;

    // The ledger side, through the product's own paths.
    await inTenant(() => paymentsService.receive({ customerId, amount: 5000, paidAt: "2026-06-02", bankAccountId: bankId, reference: "RCPT-HIJAZ-602" } as never, userId));
    await inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankId, amount: 1200, paidAt: "2026-06-10", reference: "NAJD-1200", classification: "advance" }, userId));
    const cheque = await inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankId, amount: 300, paidAt: "2026-06-29", reference: "CHQ-300", classification: "advance" }, userId));
    chequeEntry = cheque.journalEntryId as number;
    // The bank's side.
    await importLines([
      { date: "2026-06-03", description: "INWARD RCPT-HIJAZ-602 HIJAZ TRADING", amount: 5000, type: "credit" },
      { date: "2026-06-11", description: "OUTWARD TT NAJD-1200", amount: 1200, type: "debit" },
      { date: "2026-06-30", description: "MONTHLY ACCOUNT FEE", amount: 25, type: "debit" },
      { date: "2026-07-02", description: "CHEQUE 300 PRESENTED", amount: 300, type: "debit" },
    ]);
    // Reconciled through the product's own passes: the receipt (Phase D), the supplier payment (12B), the cheque by hand.
    await inTenant(() => statementMatchingService.apply({ bankAccountId: bankId }, userId));
    await inTenant(() => bankReconciliationService.applyAp({ bankAccountId: bankId }, userId));
    const chequeLine = await lineByDesc("CHEQUE 300 PRESENTED");
    const cl = await cashLine(chequeEntry);
    await inTenant(() => bankReconciliationService.link(chequeLine.id, { lines: [{ journalLineId: cl, amount: 300 }] }, userId));
  }, 180_000);
  afterAll(cleanup);

  it("🔴 the identity, every term: 3,500 − (−300) + (−25) = 3,775 — and the cheque is outstanding AT 06-30, not at 07-31", async () => {
    const p = await position("2026-06-30", 3775);
    expect(p.ledgerBalance, "ledger at 06-30: +5,000 −1,200 −300").toBe(3500);
    expect(p.ledgerOnly.map((i) => i.entryNumber.startsWith("SPAY") && i.signedOutstanding)).toEqual([-300]);
    expect(p.ledgerOnlyTotal).toBe(-300);
    expect(p.statementOnly.map((i) => [i.description, i.signedOutstanding])).toEqual([["MONTHLY ACCOUNT FEE", -25]]);
    expect(p.statementOnlyTotal).toBe(-25);
    expect(p.expectedStatement).toBe(3775);
    expect(p.difference).toBe(0);
    expect(p.balanced).toBe(true);
    // Movement: by 07-31 the cheque has cleared (its statement line is inside the date) — no longer outstanding.
    const july = await position("2026-07-31", 3475);
    expect(july.ledgerOnly).toHaveLength(0);
    expect(july.statementOnly.map((i) => i.description)).toEqual(["MONTHLY ACCOUNT FEE"]);
    expect(july.difference).toBe(0);
    // No balance given ⇒ no difference — NOT a zero that reads as balanced.
    const none = await position("2026-06-30");
    expect(none.difference).toBeNull();
    expect(none.balanced).toBe(false);
  }, 60_000);

  it("🔴 NO PLUG: a balance that does not reconcile is refused with its difference, and nothing is recorded", async () => {
    const err = await expectRefusal(inTenant(() => bankReconciliationsService.complete({ bankAccountId: bankId, asOf: "2026-06-30", statementBalance: 3770 }, userId)), 409, "reconciliation_difference");
    expect(err.payload!.difference).toBe(-5);
    await expectRefusal(inTenant(() => bankReconciliationsService.complete({ bankAccountId: bankId, asOf: "2026-06-30" }, userId)), 422, "statement_balance_required");
    expect(Number((await pool.query(`SELECT count(*) n FROM bank_reconciliations WHERE organization_id = $1`, [orgId])).rows[0].n)).toBe(0);
    const done = await inTenant(() => bankReconciliationsService.complete({ bankAccountId: bankId, asOf: "2026-06-30", statementBalance: 3775, notes: "June" }, userId));
    expect(done).toMatchObject({ asOf: "2026-06-30", statementBalance: 3775, ledgerBalance: 3500, ledgerOnlyTotal: -300, statementOnlyTotal: -25, difference: 0, reopening: null });
    expect((done.snapshot as { statementOnly: unknown[] }).statementOnly).toHaveLength(1);
    await expectRefusal(inTenant(() => bankReconciliationsService.complete({ bankAccountId: bankId, asOf: "2026-06-30", statementBalance: 3775 }, userId)), 409, "already_reconciled_through");
  }, 60_000);

  it("🔴 THE LOCK through 06-30: no import, no un-reconciling, no posting to the bank — but 07-05 posts, and a new link may clear an item", async () => {
    // Import a line inside the reconciled month: refused whole, in words.
    await expectRefusal(importLines([{ date: "2026-06-15", description: "LATE LINE", amount: 10, type: "debit" }]), 409, "bank_reconciled_through");
    // Un-reconcile a June line: refused at the database.
    const najd = await lineByDesc("OUTWARD TT NAJD-1200");
    const link = (await pool.query(`SELECT id FROM bank_statement_links WHERE transaction_id = $1`, [najd.id])).rows[0];
    await expectLocked(inTenant(() => bankReconciliationService.unlink(link.id, { reason: "test" }, userId)));
    // Un-match the Phase D receipt: refused at the database.
    const match = (await pool.query(`SELECT m.id FROM statement_matches m JOIN transactions t ON t.id = m.transaction_id WHERE t.organization_id = $1`, [orgId])).rows[0];
    await expectLocked(inTenant(() => statementMatchingService.unmatch(match.id, { reason: "test" }, userId)));
    // Post a payment dated inside June to this bank: refused at the database.
    const before = Number((await pool.query(`SELECT count(*) n FROM supplier_payments WHERE organization_id = $1`, [orgId])).rows[0].n);
    await expectLocked(inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankId, amount: 50, paidAt: "2026-06-20", classification: "advance" }, userId)));
    expect(Number((await pool.query(`SELECT count(*) n FROM supplier_payments WHERE organization_id = $1`, [orgId])).rows[0].n), "nothing written").toBe(before);
    // Delete a June line: refused at the database.
    await expectLocked(inTenant(() => db.execute(sql`DELETE FROM transactions WHERE id = ${najd.id}`)));
    // MOVEMENT: after the date, posting works — and clearing the June fee with a July journal is a new link, allowed.
    const fee = await inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankId, amount: 25, paidAt: "2026-07-05", reference: "FEE-JUNE", classification: "advance" }, userId));
    const feeLine = await lineByDesc("MONTHLY ACCOUNT FEE");
    const feeCash = await cashLine(fee.journalEntryId as number);
    await inTenant(() => bankReconciliationService.link(feeLine.id, { lines: [{ journalLineId: feeCash, amount: 25 }], reason: "June fee recorded in July" }, userId));
    // The completed June reconciliation still states what it proved.
    const june = (await inTenant(() => bankReconciliationsService.list({ bankAccountId: bankId }))).reconciliations[0]!;
    expect(june.statementOnlyTotal).toBe(-25);
  }, 90_000);

  it("reopening: the latest only, with a reason — and the lock moves back", async () => {
    const july = await inTenant(() => bankReconciliationsService.complete({ bankAccountId: bankId, asOf: "2026-07-31", statementBalance: 3475 }, userId));
    const june = (await inTenant(() => bankReconciliationsService.list({ bankAccountId: bankId }))).reconciliations.find((r) => r.asOf === "2026-06-30")!;
    await expectRefusal(inTenant(() => bankReconciliationsService.reopen(june.id, { reason: "wrong" }, userId)), 409, "not_latest");
    await expectRefusal(inTenant(() => bankReconciliationsService.reopen(july.id, { reason: " " }, userId)), 422, "reason_required");
    const r1 = await inTenant(() => bankReconciliationsService.reopen(july.id, { reason: "July statement re-issued" }, userId));
    expect(r1.reopening).toMatchObject({ reason: "July statement re-issued" });
    expect((await position("2026-07-15")).reconciledThrough).toBe("2026-06-30");
    await inTenant(() => bankReconciliationsService.reopen(june.id, { reason: "June needs a correction" }, userId));
    expect((await position("2026-07-15")).reconciledThrough).toBeNull();
    // The lock is gone: the June line can be un-reconciled now (movement), and re-linked.
    const najd = await lineByDesc("OUTWARD TT NAJD-1200");
    const link = (await pool.query(`SELECT l.id, l.journal_line_id FROM bank_statement_links l WHERE l.transaction_id = $1`, [najd.id])).rows[0];
    await inTenant(() => bankReconciliationService.unlink(link.id, { reason: "test: after reopening" }, userId));
    await inTenant(() => bankReconciliationService.link(najd.id, { lines: [{ journalLineId: link.journal_line_id, amount: 1200 }] }, userId));
  }, 90_000);

  it("the cash position: the ledger from the one definition, the statement beside it, what is open, how far reconciled", async () => {
    await inTenant(() => bankReconciliationsService.complete({ bankAccountId: bankId, asOf: "2026-06-30", statementBalance: 3775 }, userId));
    const cp = await inTenant(() => bankReconciliationsService.cashPosition());
    const mine = cp.banks.find((b) => b.bankAccountId === bankId)!;
    const gl = Number((await pool.query(`SELECT coalesce(sum(v.debit_amount - v.credit_amount),0)::text v FROM journal_line_bank_identity v JOIN journal_entries e ON e.id = v.journal_entry_id
                                          WHERE v.bank_account_id = $1 AND e.status IN ('posted','reversed')`, [bankId])).rows[0].v);
    expect(mine.ledgerBalance, "the same figure the GL gives").toBeCloseTo(gl, 2);
    expect(mine.ledgerBalance).toBeCloseTo(5000 - 1200 - 300 - 25, 2);
    expect(mine.reconciledThrough).toBe("2026-06-30");
    expect(mine.unreconciledLines).toBe(0);
    expect(mine.latestStatement, "no imported statement states a closing balance — NOT a zero").toBeNull();
    expect(cp.banks.some((b) => b.bankAccountId === bankB), "another tenant's bank is absent").toBe(false);
  }, 60_000);

  it("the exceptions: a stale unreconciled line appears, and leaves when it is reconciled; clearing nets; capped lists carry totals", async () => {
    await importLines([{ date: "2026-07-20", description: "UNKNOWN DEBIT 77", amount: 77, type: "debit" }]);
    const x1 = await inTenant(() => bankReconciliationsService.exceptions());
    const stale = x1.lines.items.find((i) => i.description === "UNKNOWN DEBIT 77");
    expect(stale, "older than 30 days and unreconciled").toMatchObject({ kind: "stale", amount: 77, direction: "out" });
    expect(x1.lines.total).toBeGreaterThanOrEqual(x1.lines.items.length);
    expect(x1.transferClearing.nets).toBe(true);
    const pay = await inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankId, amount: 77, paidAt: "2026-07-20", reference: "UNK-77", classification: "advance" }, userId));
    const line = await lineByDesc("UNKNOWN DEBIT 77");
    const payCash = await cashLine(pay.journalEntryId as number);
    await inTenant(() => bankReconciliationService.link(line.id, { lines: [{ journalLineId: payCash, amount: 77 }] }, userId));
    const x2 = await inTenant(() => bankReconciliationsService.exceptions());
    expect(x2.lines.items.some((i) => i.description === "UNKNOWN DEBIT 77"), "reconciled, it leaves the list").toBe(false);
  }, 60_000);

  it("🔴 append-only at the database, and the reconciliation must name its own company's bank", async () => {
    for (const stmt of [`UPDATE bank_reconciliations SET notes = 'x'`, `DELETE FROM bank_reconciliations`, `DELETE FROM bank_reconciliation_reopenings`]) {
      let err: unknown;
      try { await inTenant(() => db.execute(sql.raw(stmt))); } catch (e) { err = e; }
      expect(pgCode(err), stmt).toBe("42501");
    }
    let cross: unknown;
    try {
      await pool.query(`INSERT INTO bank_reconciliations (organization_id, company_id, bank_account_id, as_of, statement_balance, ledger_balance, ledger_only_total, statement_only_total, difference, snapshot)
                        VALUES ($1,$2,$3,'2026-01-31',0,0,0,0,0,'{}')`, [orgId, companyId, bankB]);
    } catch (e) { cross = e; }
    expect(pgCode(cross)).toBe("23514");
    let plug: unknown;
    try {
      await pool.query(`INSERT INTO bank_reconciliations (organization_id, company_id, bank_account_id, as_of, statement_balance, ledger_balance, ledger_only_total, statement_only_total, difference, snapshot)
                        VALUES ($1,$2,$3,'2026-01-31',10,0,0,0,10,'{}')`, [orgId, companyId, bankId]);
    } catch (e) { plug = e; }
    expect(pgCode(plug), "a non-zero difference is not storable").toBe("23514");
  }, 60_000);

  it("🔴 isolation: presence, absence and movement", async () => {
    const mine = await inTenant(() => bankReconciliationsService.list({}));
    expect(mine.reconciliations.length).toBeGreaterThan(0);
    const theirsBefore = await inTenant(() => bankReconciliationsService.list({}), orgB, companyB);
    expect(theirsBefore.reconciliations).toHaveLength(0);
    const theirs = await inTenant(() => bankReconciliationsService.complete({ bankAccountId: bankB, asOf: "2026-06-30", statementBalance: 0 }, userId), orgB, companyB);
    const seen = await inTenant(() => bankReconciliationsService.list({}), orgB, companyB);
    expect(seen.reconciliations.map((r) => r.id)).toEqual([theirs.id]);
    await expectRefusal(inTenant(() => bankReconciliationsService.position({ bankAccountId: bankId, asOf: "2026-06-30" }), orgB, companyB), 422, "reference_not_found");
    // The lock is per bank: the other tenant's June is reconciled, ours still takes July postings.
    await inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankId, amount: 5, paidAt: "2026-07-06", classification: "advance" }, userId));
  }, 60_000);
  it("🔴 the invariants script SEES a reconciliation that moved, a transfer reversed behind its back, and a matched line that lost its match — each planted past the triggers, then removed", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const run = (name: string) => {
      const out = join(mkdtempSync(join(tmpdir(), "p12d-inv-")), `${name}.json`);
      try {
        execFileSync(process.execPath, ["--import", "tsx", "src/scripts/ledgerInvariants.ts", "--json", out], { cwd: join(__dirname, "..", ".."), env: process.env, stdio: "pipe", timeout: 120_000 });
      } catch { /* exit 2 = something somewhere diverges; the report is still written */ }
      expect(existsSync(out)).toBe(true);
      const report = JSON.parse(readFileSync(out, "utf8")) as Record<string, Array<Record<string, unknown>>>;
      const of = (prefix: string) => (Object.entries(report).find(([k]) => k.startsWith(prefix))?.[1] ?? []).filter((r) => r.org === orgId);
      return { moved: of("bank_reconciliation_moved"), transfer: of("bank_transfer_reversal_mismatch"), matched: of("matched_line_not_reconciled") };
    };
    const bankB2 = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Second SNB','SNB') RETURNING id`, [orgId, companyId])).rows[0].id as number;
    const trf = await inTenant(() => bankTransfersService.create({ fromBankAccountId: bankId, toBankAccountId: bankB2, amount: 40, transferDate: "2026-07-25" }, userId));
    const clean = run("clean");
    expect(clean, "nothing violated in this org before the plants").toEqual({ moved: [], transfer: [], matched: [] });

    const june = (await inTenant(() => bankReconciliationsService.list({ bankAccountId: bankId }))).reconciliations.find((r) => r.asOf === "2026-06-30" && !r.reopening)!;
    const leaf = (await pool.query(`SELECT id FROM categories WHERE bank_account_id = $1`, [bankId])).rows[0].id;
    const najd = await lineByDesc("OUTWARD TT NAJD-1200");
    const activeLink = (await pool.query(`SELECT l.id FROM bank_statement_links l WHERE l.transaction_id = $1 AND NOT EXISTS (SELECT 1 FROM bank_statement_link_reversals r WHERE r.link_id = l.id)`, [najd.id])).rows[0].id;
    const cl = await pool.connect();
    let plantedEntry = 0, plantedReversal = 0;
    try {
      await cl.query("BEGIN");
      await cl.query("SET LOCAL session_replication_role = replica");
      // (1) a June cash movement written past the lock
      plantedEntry = (await cl.query(`INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status) VALUES ($1,$2,'PLANT-12D','2026-06-15','planted','posted') RETURNING id`, [orgId, companyId])).rows[0].id;
      await cl.query(`INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount) VALUES ($1,$2,$3,$4,'planted',9,0)`, [orgId, companyId, plantedEntry, leaf]);
      // (2) the transfer's entry reversed behind the transfer
      await cl.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [trf.journalEntryId]);
      // (3) a matched line's only link undone behind the line
      plantedReversal = (await cl.query(`INSERT INTO bank_statement_link_reversals (organization_id, company_id, link_id, reason) VALUES ($1,$2,$3,'planted') RETURNING id`, [orgId, companyId, activeLink])).rows[0].id;
      await cl.query("COMMIT");
    } catch (e) { await cl.query("ROLLBACK"); throw e; } finally { cl.release(); }
    try {
      const planted = run("planted");
      expect(planted.moved.map((r) => r.reconciliation_id), "the instrument sees June's ledger move").toEqual([june.id]);
      expect(planted.transfer.map((r) => r.transfer_id), "the instrument sees the transfer reversed behind it").toEqual([trf.id]);
      expect(planted.matched.map((r) => r.transaction_id), "the instrument sees the matched line lose its match").toEqual([najd.id]);
    } finally {
      const c2 = await pool.connect();
      try {
        await c2.query("BEGIN"); await c2.query("SET LOCAL session_replication_role = replica");
        await c2.query(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [plantedEntry]);
        await c2.query(`DELETE FROM journal_entries WHERE id = $1`, [plantedEntry]);
        await c2.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [trf.journalEntryId]);
        await c2.query(`DELETE FROM bank_statement_link_reversals WHERE id = $1`, [plantedReversal]);
        await c2.query("COMMIT");
      } finally { c2.release(); }
    }
    expect(run("restored"), "and clean again once removed").toEqual({ moved: [], transfer: [], matched: [] });
  }, 400_000);
});
