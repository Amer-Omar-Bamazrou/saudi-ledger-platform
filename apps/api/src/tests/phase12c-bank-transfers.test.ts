/**
 * PHASE 12C — TRANSFERS BETWEEN THE BUSINESS'S OWN BANKS (2026-09-23), on real rows.
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §5.
 *
 *  · 🔴 ONE entry, TWO cash lines: the source bank down, the destination up,
 *    both asserted before and after — and nothing else in the books moves
 *    (no P&L, no VAT, no clearing);
 *  · 🔴 the two statement legs RECONCILE to the transfer and post nothing; a
 *    reconciled leg cannot be accepted to move the cash a second time;
 *  · 🔴 one movement is never recorded twice: a near-identical transfer, or a
 *    leg already posted through Transfer clearing, is refused unless
 *    confirmed WITH a reason, which is kept;
 *  · reversal is a superseding record and a mirror in an OPEN period;
 *    refused while reconciled, refused from the generic journal path, and
 *    🔴 at the database: ANY entry a statement line is reconciled to cannot
 *    be reversed;
 *  · closed period, idempotency, append-only, the entry shape at the
 *    database; isolation with presence, absence and movement.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { auditContext } from "../lib/auditContext";
import { errorHandler } from "../middleware/errorHandler";
import { transactionsService } from "../services/transactions.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { bankReconciliationService } from "../services/accounting/bankReconciliation.service";
import { bankTransfersService } from "../services/accounting/bankTransfers.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("Phase 12C — bank-to-bank transfers (real rows)", () => {
  const SLUG = "p12c-trf", SLUG_B = "p12c-trf-other";
  const EMAIL = "p12c-trf@test.local";
  let orgId = "", companyId = "", userId = 0, bankA = 0, bankB = 0, vendorId = 0;
  let orgB = "", companyB = "", otherBank1 = 0, otherBank2 = 0;

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
        for (const t of ["bank_transfer_reversals", "bank_transfers", "bank_statement_link_reversals", "bank_statement_links",
                         "supplier_payment_classifications", "supplier_payments", "transactions", "bank_statements",
                         "cash_line_bank_attributions", "journal_entry_lines", "journal_entries", "period_locks", "audit_logs",
                         "organization_memberships", "vendors", "bank_accounts", "categories", "companies"]) {
          await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
        }
        await client.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
      }
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    let err: { statusCode?: number; status?: number; payload?: { code?: string; duplicates?: unknown[] }; message?: string; code?: string } | undefined;
    try { await p; } catch (e) { err = e as typeof err; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err!.statusCode ?? err!.status, err!.message).toBe(status);
    if (code) expect(err!.payload?.code, err!.message).toBe(code);
    return err!;
  };
  /** Debit − credit on one bank's own GL leaf, over everything in the books. */
  const gl = async (bank: number) => Number((await pool.query(
    `SELECT coalesce(sum(v.debit_amount - v.credit_amount), 0)::text v FROM journal_line_bank_identity v
       JOIN journal_entries e ON e.id = v.journal_entry_id WHERE v.bank_account_id = $1 AND e.status IN ('posted','reversed')`, [bank])).rows[0].v);
  /** Every non-cash line in the org's books — must not move on a transfer. */
  const nonCash = async () => Number((await pool.query(
    `SELECT coalesce(sum(abs(l.debit_amount) + abs(l.credit_amount)), 0)::text v FROM journal_entry_lines l
       JOIN categories c ON c.id = l.account_id WHERE l.organization_id = $1 AND c.liquidity_class IS DISTINCT FROM 'cash'`, [orgId])).rows[0].v);
  const lineByDesc = async (d: string) => (await pool.query(`SELECT * FROM transactions WHERE organization_id = $1 AND description = $2`, [orgId, d])).rows[0];
  const importLines = (bank: number, rows: Array<{ date: string; description: string; amount: number; type: "debit" | "credit" }>, auto = false) =>
    inTenant(() => transactionsService.upload({ rows, bankAccountId: bank, autoCategrize: auto } as never, userId));
  const cashLine = async (entryId: number, bank: number) =>
    (await pool.query(`SELECT line_id FROM journal_line_bank_identity WHERE journal_entry_id = $1 AND bank_account_id = $2`, [entryId, bank])).rows[0].line_id as number;
  /** What the ONE error boundary answers for an error (the trigger text ↔ mapping pin). */
  const mapped = (err: unknown) => {
    let status = 0; let body: { code?: string } | undefined;
    const res = { headersSent: false, status(c: number) { status = c; return res; }, json(b: { code?: string }) { body = b; return res; } };
    errorHandler(err, { log: { error() {}, warn() {} } } as never, res as never, () => {});
    return { status, code: body?.code };
  };
  /** A Postgres error's SQLSTATE, whether or not drizzle wrapped it. */
  const pgCode = (e: unknown) => { const x = e as { code?: string; cause?: { code?: string } }; return x?.code && /^[0-9A-Z]{5}$/.test(x.code) ? x.code : x?.cause?.code; };
  /** The app role flips an entry to 'reversed' directly — below every service check. */
  const flipReversed = (entryId: number) => inTenant(() => db.execute(sql`UPDATE journal_entries SET status = 'reversed' WHERE id = ${entryId}`));
  const transfer = (body: Record<string, unknown>, org = orgId, co = companyId) => inTenant(() => bankTransfersService.create(body, userId), org, co);

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P12C Trf','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P12C Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P12C',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    bankA = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Operating SNB','SNB') RETURNING id`, [orgId, companyId])).rows[0].id;
    bankB = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Payroll Rajhi','Al Rajhi') RETURNING id`, [orgId, companyId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Gulf Office Supply') RETURNING id`, [orgId])).rows[0].id;
    orgB = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P12C Other','${SLUG_B}') RETURNING id`)).rows[0].id;
    companyB = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P12C Other Co') RETURNING id`, [orgB])).rows[0].id;
    otherBank1 = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Other One','Alinma') RETURNING id`, [orgB, companyB])).rows[0].id;
    otherBank2 = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Other Two','ANB') RETURNING id`, [orgB, companyB])).rows[0].id;
  }, 120_000);
  afterAll(cleanup);

  it("🔴 ONE entry, two cash lines: the source bank down, the destination up — and nothing else moves", async () => {
    const [a0, b0, n0] = [await gl(bankA), await gl(bankB), await nonCash()];
    const t = await transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 25000, transferDate: "2026-07-01", reference: "PAYROLL-JUL" });
    expect(t).toMatchObject({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 25000, transferDate: "2026-07-01", reversal: null, reconciledLines: 0 });
    const lines = (await pool.query(`SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1`, [t.journalEntryId])).rows;
    expect(lines, "exactly two lines").toHaveLength(2);
    expect(await gl(bankA), "the source bank moved DOWN by the amount").toBeCloseTo(a0 - 25000, 2);
    expect(await gl(bankB), "the destination bank moved UP by the amount").toBeCloseTo(b0 + 25000, 2);
    expect(await nonCash(), "no P&L, VAT or clearing line anywhere").toBeCloseTo(n0, 2);
  }, 60_000);

  it("🔴 both statement legs RECONCILE to the transfer, post nothing, and cannot be accepted to move the cash again", async () => {
    const t = await transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 4800, transferDate: "2026-07-05", reference: "TOPUP-0705" });
    await importLines(bankA, [{ date: "2026-07-05", description: "TFR TO RAJHI TOPUP-0705", amount: 4800, type: "debit" }]);
    await importLines(bankB, [{ date: "2026-07-06", description: "TFR FROM SNB TOPUP-0705", amount: 4800, type: "credit" }]);
    const out = await lineByDesc("TFR TO RAJHI TOPUP-0705");
    const inn = await lineByDesc("TFR FROM SNB TOPUP-0705");
    const [a0, b0, entries0] = [await gl(bankA), await gl(bankB), Number((await pool.query(`SELECT count(*) n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n)];

    // The transfer is OFFERED on each bank, labelled as what it is.
    const detail = await inTenant(() => bankReconciliationService.line(out.id));
    const offered = detail.candidates.find((c: { journalEntryId: number }) => c.journalEntryId === t.journalEntryId);
    expect(offered, "the transfer's source cash line is a candidate for the source leg").toBeTruthy();
    expect(offered!.sourceKind).toBe("bank_transfer");

    const [outCash, inCash] = [await cashLine(t.journalEntryId, bankA), await cashLine(t.journalEntryId, bankB)];
    await inTenant(() => bankReconciliationService.link(out.id, { lines: [{ journalLineId: outCash, amount: 4800 }] }, userId));
    await inTenant(() => bankReconciliationService.link(inn.id, { lines: [{ journalLineId: inCash, amount: 4800 }] }, userId));
    const methods = (await pool.query(`SELECT method FROM bank_statement_links WHERE transaction_id = ANY($1)`, [[out.id, inn.id]])).rows.map((r) => r.method);
    expect(methods).toEqual(["transfer", "transfer"]);
    expect((await inTenant(() => bankTransfersService.getById(t.id))).reconciledLines).toBe(2);

    await expectRefusal(inTenant(() => transactionsService.acceptPending([out.id, inn.id])), 409, "line_reconciled");
    await inTenant(() => transactionsService.acceptPending());
    expect(await gl(bankA), "reconciling posts nothing; the bank moved once").toBeCloseTo(a0, 2);
    expect(await gl(bankB)).toBeCloseTo(b0, 2);
    expect(Number((await pool.query(`SELECT count(*) n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n)).toBe(entries0);

    // 🔴 reversal is refused while reconciled — by the transfer, the generic path, and the database.
    await expectRefusal(inTenant(() => bankTransfersService.reverse(t.id, { reason: "wrong" }, userId)), 409, "transfer_reconciled");
    await expectRefusal(inTenant(() => journalEntriesService.reverse(t.journalEntryId, { reason: "generic" })), 409);
    await expectRefusal(inTenant(() => journalEntriesService.reverse(t.journalEntryId, { reason: "owner" }, { document: "bank_transfer" })), 409);
    let dbErr: unknown;
    try { await flipReversed(t.journalEntryId); } catch (e) { dbErr = e; }
    expect(pgCode(dbErr), "the database refuses reversing an entry a statement line is reconciled to").toBe("23514");
    expect(mapped(dbErr), "the trigger's message and the error-boundary mapping stay in step").toEqual({ status: 409, code: "entry_reconciled" });
  }, 90_000);

  it("🔴 the database refuses reversing ANY entry a statement line is reconciled to — a supplier payment too", async () => {
    const sp = await inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankA, amount: 640, paidAt: "2026-07-08", reference: "GOS-640", classification: "advance" }, userId));
    await importLines(bankA, [{ date: "2026-07-08", description: "PAYMENT GOS-640", amount: 640, type: "debit" }]);
    const leg = await lineByDesc("PAYMENT GOS-640");
    const entryId = sp.journalEntryId as number;
    const spCash = await cashLine(entryId, bankA);
    await inTenant(() => bankReconciliationService.link(leg.id, { lines: [{ journalLineId: spCash, amount: 640 }] }, userId));
    await expectRefusal(inTenant(() => journalEntriesService.reverse(entryId, { reason: "test" })), 409);
    let err: unknown;
    try { await flipReversed(entryId); } catch (e) { err = e; }
    expect(pgCode(err)).toBe("23514");
    expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [entryId])).rows[0].status).toBe("posted");
    // MOVEMENT: undone, the same reversal goes through.
    const link = (await pool.query(`SELECT id FROM bank_statement_links WHERE transaction_id = $1`, [leg.id])).rows[0];
    await inTenant(() => bankReconciliationService.unlink(link.id, { reason: "test: undo before reversing" }, userId));
    await inTenant(() => journalEntriesService.reverse(entryId, { reason: "test" }));
    expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [entryId])).rows[0].status).toBe("reversed");
  }, 60_000);

  it("🔴 one movement is never recorded twice — a near-identical transfer needs a confirmation WITH a reason, which is kept", async () => {
    await transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 1111, transferDate: "2026-07-10" });
    const e1 = await expectRefusal(transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 1111, transferDate: "2026-07-12" }), 409, "possible_duplicate_transfer");
    expect(e1.payload!.duplicates).toHaveLength(1);
    await expectRefusal(transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 1111, transferDate: "2026-07-12", confirmDuplicate: true }), 409, "possible_duplicate_transfer");
    const t2 = await transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 1111, transferDate: "2026-07-12", confirmDuplicate: true, duplicateConfirmationReason: "second payroll top-up, same amount" });
    expect(t2.duplicateConfirmationReason).toBe("second payroll top-up, same amount");
    // Absence: a different amount, or outside the window, is not a duplicate.
    const t3 = await transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 1111, transferDate: "2026-07-25" });
    expect(t3.duplicateConfirmationReason).toBeNull();
  }, 60_000);

  it("🔴 a leg already posted through Transfer clearing is a possible duplicate of a transfer recorded afterwards", async () => {
    // The real categorizer marks an "own account" narrative a transfer; the person declares it own_account and accepts it.
    await importLines(bankA, [{ date: "2026-07-15", description: "OWN ACCOUNT TRANSFER 7715", amount: 7715, type: "debit" }], true);
    const leg = await lineByDesc("OWN ACCOUNT TRANSFER 7715");
    expect(leg.kind, "classified by the product's own categorizer").toBe("transfer");
    await inTenant(() => transactionsService.update(leg.id, { transferDirection: "own_account" } as never));
    await inTenant(() => transactionsService.acceptPending([leg.id]));
    expect((await lineByDesc(leg.description)).journal_entry_id, "the leg posted through clearing").not.toBeNull();
    const err = await expectRefusal(transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 7715, transferDate: "2026-07-15" }), 409, "possible_duplicate_transfer");
    expect((err.payload!.duplicates as Array<{ kind: string; id: number }>)[0]).toMatchObject({ kind: "clearing_leg", id: leg.id });
  }, 60_000);

  it("🔴 the open leg of a RECORDED transfer is never ACCEPTED — named, it is refused in words; in bulk, it stays pending; the bank moves once", async () => {
    // Found by the independent 12E review: nothing at acceptance looked at recorded transfers.
    const t = await transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 6060, transferDate: "2026-07-16", reference: "TOPUP-6060" });
    // The product's own categorizer reads the narrative as an own-account transfer; the person declares it so.
    await importLines(bankA, [{ date: "2026-07-16", description: "OWN ACCOUNT TRANSFER 6060", amount: 6060, type: "debit" }], true);
    const leg = await lineByDesc("OWN ACCOUNT TRANSFER 6060");
    expect(leg.kind).toBe("transfer");
    await inTenant(() => transactionsService.update(leg.id, { transferDirection: "own_account" } as never));
    const a0 = await gl(bankA);
    const err = await expectRefusal(inTenant(() => transactionsService.acceptPending([leg.id])), 409, "line_is_recorded_transfer_leg");
    expect(err.message).toMatch(/Reconciliation Workbench/);
    await inTenant(() => transactionsService.acceptPending());
    expect((await lineByDesc(leg.description)).review_status, "bulk acceptance leaves it pending").toBe("pending_review");
    expect(await gl(bankA), "the bank moved once — by the transfer").toBeCloseTo(a0, 2);
    // MOVEMENT: reconciled to the transfer, it is answered — and a leg of a DIFFERENT amount still accepts as before.
    const cl = await cashLine(t.journalEntryId, bankA);
    await inTenant(() => bankReconciliationService.link(leg.id, { lines: [{ journalLineId: cl, amount: 6060 }] }, userId));
    expect((await lineByDesc(leg.description)).kind).toBe("matched");
    await importLines(bankA, [{ date: "2026-07-16", description: "OWN ACCOUNT TRANSFER 6061", amount: 6061, type: "debit" }], true);
    const other = await lineByDesc("OWN ACCOUNT TRANSFER 6061");
    await inTenant(() => transactionsService.update(other.id, { transferDirection: "own_account" } as never));
    await inTenant(() => transactionsService.acceptPending([other.id]));
    expect((await lineByDesc(other.description)).journal_entry_id, "not a recorded transfer's leg: it posts through clearing").not.toBeNull();
  }, 90_000);

  it("🔴 a statement line's OWN posting is not reversed behind the line — the generic path refuses, the line's own path (delete) still reverses it", async () => {
    await importLines(bankA, [{ date: "2026-07-18", description: "OWN POSTING 1818", amount: 18.18, type: "debit" }]);
    const row = await lineByDesc("OWN POSTING 1818");
    const charges = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'BANK_CHARGES'`, [orgId])).rows[0].id;
    await inTenant(() => transactionsService.update(row.id, { categoryId: charges } as never));
    await inTenant(() => transactionsService.acceptPending([row.id]));
    const entryId = (await lineByDesc(row.description)).journal_entry_id as number;
    expect(entryId).not.toBeNull();
    await expectRefusal(inTenant(() => journalEntriesService.reverse(entryId, { reason: "generic" })), 409);
    expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [entryId])).rows[0].status).toBe("posted");
    // MOVEMENT: the line's own path reverses its entry.
    await inTenant(() => transactionsService.remove(row.id));
    expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [entryId])).rows[0].status).toBe("reversed");
  }, 60_000);

  it("reversal: a reason, a mirror in an OPEN period, a superseding record — and both banks back where they were", async () => {
    const [a0, b0] = [await gl(bankA), await gl(bankB)];
    const t = await transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 333.33, transferDate: "2026-07-20" });
    await expectRefusal(inTenant(() => bankTransfersService.reverse(t.id, { reason: "  " }, userId)), 422, "reason_required");
    const r = await inTenant(() => bankTransfersService.reverse(t.id, { reason: "keyed the wrong account", date: "2026-07-21" }, userId));
    expect(r.reversal).toMatchObject({ reason: "keyed the wrong account" });
    const mirror = (await pool.query(`SELECT reversal_of, date::date::text d, reversal_reason FROM journal_entries WHERE id = $1`, [r.reversal!.reversalJournalEntryId])).rows[0];
    expect(mirror).toMatchObject({ reversal_of: t.journalEntryId, d: "2026-07-21", reversal_reason: "keyed the wrong account" });
    expect(await gl(bankA)).toBeCloseTo(a0, 2);
    expect(await gl(bankB)).toBeCloseTo(b0, 2);
    await expectRefusal(inTenant(() => bankTransfersService.reverse(t.id, { reason: "again" }, userId)), 409, "transfer_already_reversed");
    // A reversed transfer is no longer a possible duplicate.
    const again = await transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 333.33, transferDate: "2026-07-20" });
    expect(again.duplicateConfirmationReason).toBeNull();
  }, 60_000);

  it("refusals: the same bank, a closed month (423, nothing written), and a retried key is the SAME transfer", async () => {
    await expectRefusal(transfer({ fromBankAccountId: bankA, toBankAccountId: bankA, amount: 10 }), 422, "transfer_same_bank");
    await expectRefusal(transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 0 }), 422, "amount_invalid");
    await pool.query(`INSERT INTO period_locks (organization_id, company_id, period) VALUES ($1,$2,'2026-05') ON CONFLICT DO NOTHING`, [orgId, companyId]);
    const before = Number((await pool.query(`SELECT count(*) n FROM bank_transfers WHERE organization_id = $1`, [orgId])).rows[0].n);
    await expectRefusal(transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 50, transferDate: "2026-05-15" }), 423);
    expect(Number((await pool.query(`SELECT count(*) n FROM bank_transfers WHERE organization_id = $1`, [orgId])).rows[0].n)).toBe(before);

    const k1 = await transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 90, transferDate: "2026-07-28", idempotencyKey: "p12c-key-1" });
    const k2 = await transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 90, transferDate: "2026-07-28", idempotencyKey: "p12c-key-1" });
    expect(k2.id).toBe(k1.id);
    expect(Number((await pool.query(`SELECT count(*) n FROM bank_transfers WHERE idempotency_key = 'p12c-key-1'`)).rows[0].n)).toBe(1);
  }, 60_000);

  it("the database: append-only for the app role, and a transfer row must name an entry of exactly its two cash lines", async () => {
    const t = await transfer({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 12, transferDate: "2026-07-29" });
    for (const stmt of [`UPDATE bank_transfers SET amount = 13 WHERE id = ${t.id}`, `DELETE FROM bank_transfers WHERE id = ${t.id}`]) {
      let err: unknown;
      try { await inTenant(() => db.execute(sql.raw(stmt))); } catch (e) { err = e; }
      expect(pgCode(err), stmt).toBe("42501");
    }
    // An entry that is not this shape (a supplier payment's) is refused at INSERT.
    const sp = await inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankA, amount: 12, paidAt: "2026-07-29", classification: "advance" }, userId));
    let shapeErr: unknown;
    try {
      await pool.query(`INSERT INTO bank_transfers (organization_id, company_id, from_bank_account_id, to_bank_account_id, amount, transfer_date, journal_entry_id)
                        VALUES ($1,$2,$3,$4,12,'2026-07-29',$5)`, [orgId, companyId, bankA, bankB, sp.journalEntryId]);
    } catch (e) { shapeErr = e; }
    expect(pgCode(shapeErr)).toBe("23514");
    // And one naming another company's bank is refused (FK checks run outside RLS).
    let crossErr: unknown;
    try {
      await pool.query(`INSERT INTO bank_transfers (organization_id, company_id, from_bank_account_id, to_bank_account_id, amount, transfer_date, journal_entry_id)
                        VALUES ($1,$2,$3,$4,12,'2026-07-29',$5)`, [orgId, companyId, otherBank1, bankB, t.journalEntryId]);
    } catch (e) { crossErr = e; }
    expect(pgCode(crossErr)).toBe("23514");
  }, 60_000);

  it("🔴 isolation: presence, absence and movement — another org neither sees our transfers nor can name our banks", async () => {
    const mine = await inTenant(() => bankTransfersService.list({}));
    expect(mine.total).toBeGreaterThan(0);
    // Movement: the other org records its OWN transfer, and sees exactly that.
    const theirs = await transfer({ fromBankAccountId: otherBank1, toBankAccountId: otherBank2, amount: 70, transferDate: "2026-07-02" }, orgB, companyB);
    const seen = await inTenant(() => bankTransfersService.list({}), orgB, companyB);
    expect(seen.transfers.map((x) => x.id)).toEqual([theirs.id]);
    expect(seen.transfers.some((x) => mine.transfers.some((m) => m.id === x.id)), "none of ours").toBe(false);
    await expectRefusal(inTenant(() => bankTransfersService.getById(mine.transfers[0]!.id), orgB, companyB), 404);
    await expectRefusal(transfer({ fromBankAccountId: bankA, toBankAccountId: otherBank2, amount: 5 }, orgB, companyB), 422, "reference_not_found");
  }, 60_000);
});
