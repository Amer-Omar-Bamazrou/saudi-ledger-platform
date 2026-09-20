/**
 * BATCH 1C — ISSUE 1: AN OPENING RECEIVABLE IS COLLECTIBLE, AND COLLECTING IT
 * MINTS NOTHING.
 *
 * Decision pack §16.13 / §16.14; known-issues file, "AN OPENING RECEIVABLE
 * CANNOT BE COLLECTED THROUGH D-4". Until this suite went green the D-4
 * allocation validator, the review queue's settlement candidates and the web
 * allocation target filter all defined "issued" as "has an invoice hash" — a
 * proxy that was true of every invoice until the migration created one that
 * is in the books without ever having been issued as a tax document.
 *
 * The suite builds a small migration through the product's own staging and
 * commit path, then collects the opening receivables through EVERY collection
 * path the product has (invoice pay, receipt + partial/full allocation, the
 * review queue's settle-against-invoice, bank statement matching) and asserts,
 * on every path, the thing Issue 1 is about: the receivable moves in the
 * books and NO ZATCA artefact appears — no hash, ICV, QR, issuance time,
 * e-invoice document, archive entry, VAT-return movement; the approval and
 * issuance seams are never invoked.
 *
 * It also pins the two guards that follow from the same fact: an opening
 * item is not a tax invoice, so it cannot be RENDERED as one and cannot be
 * the ORIGINAL of a credit note (fail-closed until §16.14.9's question is
 * answered) — and the Art. 40(9) bad-debt-relief flag, captured on the staged
 * item and carried onto the opening receivable as information only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { migrationService } from "../services/migration.service";
import { migrationStagingService } from "../services/migrationStaging.service";
import { migrationValidationService } from "../services/migrationValidation.service";
import { migrationCommitService } from "../services/migrationCommit.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { paymentsService } from "../services/payments.service";
import { transactionsService } from "../services/transactions.service";
import { statementMatchingService } from "../services/statementMatching.service";
import { reportsService } from "../services/reports.service";
import { customerStatementService } from "../services/customerStatement.service";
import { invoicesRepository } from "../repositories/invoices.repository";
import { approvalService } from "../services/approval";
import { buildInvoiceDocModel } from "../services/invoiceDocument/invoiceDocument.service";
import * as enqueueModule from "../services/einvoice/outbox/enqueue";
import * as zatcaModule from "../services/accounting/zatca";
import { createApproved } from "./helpers/createApproved";
import { INVOICE_ISSUED_OR_OPENING_TEXT } from "../repositories/receivableInBooks";

// The issuance seams, wrapped so the suite can prove they were NOT called on a
// collection (and WERE called on an ordinary approval — the planted positive).
vi.mock("../services/einvoice/outbox/enqueue", async (orig) => {
  const m = await orig<typeof import("../services/einvoice/outbox/enqueue")>();
  return { ...m, enqueueEInvoice: vi.fn(m.enqueueEInvoice) };
});
vi.mock("../services/accounting/zatca", async (orig) => {
  const m = await orig<typeof import("../services/accounting/zatca")>();
  return { ...m, computeInvoiceHash: vi.fn(m.computeInvoiceHash), generateZatcaQr: vi.fn(m.generateZatcaQr) };
});

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "b1c-collect";
const EMAIL = "b1c-collect@test.local";

describeMaybe("Batch 1C — Issue 1: opening receivables collect through D-4 and mint no ZATCA artefact", () => {
  let orgId = "", companyId = "", companyBId = "";
  let userId = 0;
  let bankA = 0, bankB = 0;

  const tenant = (company: string) => async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId: company, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  };
  const inTenant = <T,>(fn: () => Promise<T>) => tenant(companyId)(fn);
  const inB = <T,>(fn: () => Promise<T>) => tenant(companyBId)(fn);

  const cleanup = async () => {
    if (process.env.KEEP_1C_FIXTURE === "1") return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      for (const t of [
        "statement_match_reversals", "statement_matches", "payment_allocation_reversals", "payment_allocations", "customer_refunds", "migration_deposit_reversals", "payments",
        "migration_advances", "migration_open_items", "migration_parties", "migration_chart_rows", "einvoice_archive", "einvoice_documents",
        "invoice_items", "invoices", "bills", "transactions", "journal_entry_lines", "journal_entries", "migration_batches", "period_locks", "audit_logs",
        "organization_memberships", "bank_accounts", "customers", "vendors", "categories", "companies",
      ]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('B1C Collect','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start) VALUES ($1,'B1C Collect Co','1010868391','399999999999913',1) RETURNING id`, [orgId])).rows[0].id;
    companyBId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start) VALUES ($1,'B1C Collect Co B','1010868392','399999999999933',1) RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','B1C',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    bankA = (await inTenant(() => bankAccountsService.create({ name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bankB = (await inB(() => bankAccountsService.create({ name: "B Main", bankName: "ANB", currency: "SAR" }))).id;
  });
  afterAll(cleanup);

  type Chart = NonNullable<Parameters<typeof migrationService.importChart>[1]["rows"]>;
  // Dr 30,000 + 25,000 = Cr 7,000 + 48,000 — balanced, no VAT balance (so R9 skips), one bank.
  const CHART: Chart = [
    { sourceCode: "1100", sourceName: "Riyad Bank", sourceType: "asset", openingDebit: 30000, sourceRole: "bank", evidenceNote: "Riyad statement 30 Jun 2026, closing 30,000.00" },
    { sourceCode: "1200", sourceName: "Trade debtors", sourceType: "asset", openingDebit: 25000, sourceRole: "receivable" },
    { sourceCode: "2100", sourceName: "Trade creditors", sourceType: "liability", openingCredit: 7000, sourceRole: "payable" },
    { sourceCode: "3100", sourceName: "Share capital", sourceType: "equity", openingCredit: 48000 },
  ];
  const PARTIES = [
    { partyType: "customer" as const, sourceId: "C1", name: "Alpha Trading Est.", taxNumber: "300000000000003" },
    { partyType: "customer" as const, sourceId: "C2", name: "Beta Logistics" },
    { partyType: "vendor" as const, sourceId: "V1", name: "Delta Supplies" },
  ];
  type Items = Parameters<typeof migrationStagingService.importOpenItems>[1]["rows"];
  const ITEMS: NonNullable<Items> = [
    // Art. 40(9): relief WAS claimed on this one in the previous system — captured, nothing acts on it.
    { itemType: "ar", sourceId: "SI-1001", partySourceId: "C1", documentNumber: "INV-1001", issueDate: "2026-05-10", dueDate: "2026-06-09", originalAmount: 10000, outstandingAmount: 10000, historicalVat: { category: "S", rate: 15, taxableAmount: 8695.65, amount: 1304.35, reportedPeriod: "2026-Q2", badDebtReliefClaimed: true } },
    // Known NOT claimed, and nothing else known about the historical VAT.
    { itemType: "ar", sourceId: "SI-1002", partySourceId: "C1", documentNumber: "INV-1002", issueDate: "2026-06-01", dueDate: "2026-07-01", originalAmount: 8000, outstandingAmount: 8000, historicalVat: { badDebtReliefClaimed: false } },
    // An item staged the way every migration before the flag existed was staged.
    { itemType: "ar", sourceId: "SI-1003", partySourceId: "C2", documentNumber: "INV-1003", issueDate: "2026-06-10", dueDate: "2026-07-10", originalAmount: 4000, outstandingAmount: 4000 },
    // Historical VAT known, the relief question not answered.
    { itemType: "ar", sourceId: "SI-1004", partySourceId: "C2", documentNumber: "INV-1004", issueDate: "2026-06-20", dueDate: "2026-07-20", originalAmount: 3000, outstandingAmount: 3000, historicalVat: { category: "S", rate: 15, taxableAmount: 2608.7, amount: 391.3, reportedPeriod: "2026-Q2" } },
    { itemType: "ap", sourceId: "PI-77", partySourceId: "V1", documentNumber: "BILL-77", issueDate: "2026-04-15", dueDate: "2026-05-15", originalAmount: 7000, outstandingAmount: 7000 },
  ];

  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string, message?: RegExp) => {
    let err: any;
    try { await p; } catch (e) { err = e; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err.statusCode ?? err.status, err.message).toBe(status);
    if (code) expect(err.body?.code ?? err.payload?.code ?? err.code).toBe(code);
    if (message) expect(err.message).toMatch(message);
    return err;
  };

  /** Map a chart the way the operator would (system codes, one bank, capital created). */
  const mapChart = async (batchId: number, chart: Chart, bank: number, run: typeof inTenant) => {
    await run(() => migrationService.importChart(batchId, { rows: chart }, userId));
    const out = await run(() => migrationService.getChart(batchId));
    const d = async (code: string, body: Parameters<typeof migrationService.decideChartRow>[2]) => {
      const row = out.rows.find((r) => r.sourceCode === code);
      if (row) await run(() => migrationService.decideChartRow(batchId, row.id, body, userId));
    };
    await d("1100", { decision: "map_to_bank", targetBankAccountId: bank });
    await d("1200", { decision: "map_to_system", targetSystemCode: "AR" });
    await d("2100", { decision: "map_to_system", targetSystemCode: "AP" });
    await d("3100", { decision: "create" });
    await d("3150", { decision: "create" });
  };
  const commitBatch = async (o: { chart: Chart; parties: typeof PARTIES; items: NonNullable<Items>; bank: number; run: typeof inTenant }) => {
    const b = await o.run(() => migrationService.createBatch({ sourceSystem: "PreviousERP", cutoverDate: "2026-07-01" }, userId));
    await mapChart(b.id, o.chart, o.bank, o.run);
    await o.run(() => migrationStagingService.importParties(b.id, { rows: o.parties }, userId));
    await o.run(() => migrationStagingService.importOpenItems(b.id, { rows: o.items }, userId));
    const v = await o.run(() => migrationValidationService.validate(b.id, userId));
    expect(v.ok, JSON.stringify(v.checks?.filter((c: { status: string }) => c.status === "fail") ?? v)).toBe(true);
    const out = await o.run(() => migrationCommitService.commit(b.id, userId));
    expect(out.status).toBe("committed");
    return b.id;
  };

  const invoiceRow = async (number: string, company = companyId) =>
    (await pool.query(`SELECT id, customer_id, status, paid_amount::numeric AS paid, credited_amount::numeric AS credited, total::numeric AS total, vat_amount::numeric AS vat, invoice_hash, previous_hash, icv, qr_code, issued_at, is_opening, reversed_at, notes, migration_open_item_id FROM invoices WHERE company_id = $1 AND invoice_number = $2`, [company, number])).rows[0];
  /** Every ZATCA-shaped artefact a collection must not create, counted for the company. */
  const artefacts = async (company = companyId) => (await pool.query(
    `SELECT (SELECT count(*) FROM einvoice_documents WHERE company_id = $1)::int AS einvoice_documents,
            (SELECT count(*) FROM einvoice_archive WHERE company_id = $1)::int AS einvoice_archive,
            (SELECT count(*) FROM invoices WHERE company_id = $1 AND is_opening AND (invoice_hash IS NOT NULL OR previous_hash IS NOT NULL OR icv IS NOT NULL OR qr_code IS NOT NULL OR issued_at IS NOT NULL OR vat_amount::numeric <> 0))::int AS opening_rows_with_artefacts,
            (SELECT count(*) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.company_id = $1 AND i.is_opening)::int AS opening_items`, [company])).rows[0];
  const seams = () => ({
    enqueue: vi.mocked(enqueueModule.enqueueEInvoice).mock.calls.length,
    hash: vi.mocked(zatcaModule.computeInvoiceHash).mock.calls.length,
    qr: vi.mocked(zatcaModule.generateZatcaQr).mock.calls.length,
    approve: approveSpy.mock.calls.length,
  });
  const arByCustomerInGl = async (customerId: number) => Number((await pool.query(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount),0)::numeric AS v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.company_id = $1 AND c.system_code = 'AR' AND e.status IN ('posted','reversed') AND l.customer_id = $2`, [companyId, customerId])).rows[0].v);
  const vatReturns = async () => ({ q2: await inTenant(() => reportsService.vatReturn("2026-04", "2026-06")), jul: await inTenant(() => reportsService.vatReturn("2026-07", "2026-07")) });
  const statementRow = async (bankAccountId: number, row: { date: string; description: string; amount: number; type: "credit" | "debit" }, run = inTenant) => {
    await run(() => transactionsService.upload({ rows: [{ ...row, currency: "SAR" }], autoCategrize: false, bankAccountId } as never));
    const { rows } = await pool.query(`SELECT id FROM transactions WHERE description = $1 AND bank_account_id = $2 ORDER BY id DESC LIMIT 1`, [row.description, bankAccountId]);
    return Number(rows[0].id);
  };
  const openCandidates = async (run = inTenant) => (await run(() => invoicesRepository.openForSettlement())).map((r) => r.inv.invoiceNumber).sort();

  let approveSpy: ReturnType<typeof vi.spyOn>;
  let batchId = 0;
  let alphaId = 0, betaId = 0;
  const ids: Record<string, number> = {};
  let arBefore = 0;

  it("🔴 fixture — a balanced migration commits through the product; the four opening receivables carry no artefact; the Art. 40(9) flag survives staging → validation → commit as TRUE / FALSE / NULL and items without it stay valid", async () => {
    approveSpy = vi.spyOn(approvalService, "approve");
    // Staging refuses a value that is not a boolean: the flag is three-valued, never free text.
    const b0 = await inTenant(() => migrationService.createBatch({ sourceSystem: "PreviousERP", cutoverDate: "2026-07-01" }, userId));
    await inTenant(() => migrationStagingService.importParties(b0.id, { rows: PARTIES }, userId));
    await expectRefusal(inTenant(() => migrationStagingService.importOpenItems(b0.id, { rows: [{ ...ITEMS[0], historicalVat: { ...ITEMS[0].historicalVat, badDebtReliefClaimed: "yes" as never } }] }, userId)), 400, undefined, /badDebtReliefClaimed/);
    // The staged rows echo the flag exactly as staged, and an item without it reads null.
    const staged = await inTenant(() => migrationStagingService.importOpenItems(b0.id, { rows: ITEMS }, userId));
    const s = (sid: string) => staged.rows.find((r) => r.sourceId === sid)!;
    expect(s("SI-1001").historicalVat).toEqual({ category: "S", rate: 15, taxableAmount: 8695.65, amount: 1304.35, reportedPeriod: "2026-Q2", badDebtReliefClaimed: true });
    expect(s("SI-1002").historicalVat).toEqual({ category: null, rate: null, taxableAmount: null, amount: null, reportedPeriod: null, badDebtReliefClaimed: false });
    expect(s("SI-1003").historicalVat).toBeNull();
    expect(s("SI-1004").historicalVat).toMatchObject({ category: "S", badDebtReliefClaimed: null });
    expect(staged.rows.every((r) => r.problems.length === 0)).toBe(true);
    await inTenant(() => migrationService.discardBatch(b0.id, userId));

    batchId = await commitBatch({ chart: CHART, parties: PARTIES, items: ITEMS, bank: bankA, run: inTenant });
    for (const n of ["INV-1001", "INV-1002", "INV-1003", "INV-1004"]) {
      const row = await invoiceRow(n);
      expect(row, n).toBeTruthy();
      ids[n] = row.id;
      expect([row.status, Number(row.paid), Number(row.vat), row.invoice_hash, row.icv, row.qr_code, row.issued_at, row.is_opening, row.reversed_at]).toEqual(["sent", 0, 0, null, null, null, null, true, null]);
    }
    ids["BILL-77"] = (await pool.query(`SELECT id FROM bills WHERE company_id = $1 AND bill_number = 'BILL-77'`, [companyId])).rows[0].id;
    alphaId = (await invoiceRow("INV-1001")).customer_id;
    betaId = (await invoiceRow("INV-1003")).customer_id;
    expect(alphaId).not.toBe(betaId);
    expect(await artefacts()).toEqual({ einvoice_documents: 0, einvoice_archive: 0, opening_rows_with_artefacts: 0, opening_items: 0 });

    // The flag reached the committed staging row (frozen from here) and the opening receivable itself, as provenance text — and a receivable that never had it carries nothing.
    const flags = (await pool.query(`SELECT i.invoice_number, o.historical_vat -> 'badDebtReliefClaimed' AS flag, i.notes FROM invoices i JOIN migration_open_items o ON o.id = i.migration_open_item_id WHERE i.company_id = $1 ORDER BY i.invoice_number`, [companyId])).rows;
    expect(flags.map((f) => [f.invoice_number, f.flag])).toEqual([["INV-1001", true], ["INV-1002", false], ["INV-1003", null], ["INV-1004", null]]);
    expect(flags[0].notes).toMatch(/VAT bad-debt relief claimed in the previous system: yes/);
    expect(flags[1].notes).toMatch(/VAT bad-debt relief claimed in the previous system: no/);
    expect(flags[2].notes).not.toMatch(/bad-debt/);
    expect(flags[3].notes).not.toMatch(/bad-debt/);
    // The flag is the migration's content: it is inside the validated content hash, so changing it after validation re-opens the batch like any other staged fact.
    const staged2 = await inTenant(() => migrationStagingService.getOpenItems(batchId));
    expect(staged2.rows.find((r) => r.sourceId === "SI-1001")!.historicalVat).toMatchObject({ badDebtReliefClaimed: true });
    // Walk defect 2026-09-20: after the commit every item read as "document number already exists" — the number was
    // taken by the row the item itself became. A committed batch's items carry no problem.
    expect(staged2.rows.map((r) => [r.documentNumber, r.problems])).toEqual(staged2.rows.map((r) => [r.documentNumber, []]));

    arBefore = Number((await inTenant(() => reportsService.arAging())).total);
    expect(arBefore).toBe(25000);
    // Before any collection: all four opening receivables are settlement candidates for the review queue.
    expect(await openCandidates()).toEqual(["INV-1001", "INV-1002", "INV-1003", "INV-1004"]);
  });

  it("🔴 invoice pay — a full receipt against an opening receivable settles it: paid, out of ageing, the customer's AR in the GL and on the statement at zero; no hash, ICV, QR, issuance time, e-invoice document, archive entry or VAT-return movement; the approval and issuance seams never run", async () => {
    const before = { artefacts: await artefacts(), seams: seams(), vat: await vatReturns(), je: (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE company_id = $1`, [companyId])).rows[0].n };
    const out = await inTenant(() => invoicesService.pay(ids["INV-1003"], { amount: 4000, paidAt: "2026-07-15", bankAccountId: bankA }, userId));
    expect(out).toMatchObject({ status: "paid", paidAmount: 4000, isOpening: true, invoiceHash: null, icv: null, qrCode: null });
    const row = await invoiceRow("INV-1003");
    expect([row.status, Number(row.paid), row.invoice_hash, row.previous_hash, row.icv, row.qr_code, row.issued_at, Number(row.vat)]).toEqual(["paid", 4000, null, null, null, null, null, 0]);
    // The receipt posted (Dr bank / Cr AR by customer) — one journal, and nothing else.
    expect((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE company_id = $1`, [companyId])).rows[0].n).toBe(before.je + 1);
    expect(await arByCustomerInGl(betaId)).toBe(3000); // 4,000 + 3,000 opening − 4,000 collected
    const stmt = await inTenant(() => customerStatementService.statement(betaId, {}));
    expect(stmt.current.receivable).toBe(3000);
    const aging = await inTenant(() => reportsService.arAging());
    expect(Number(aging.total)).toBe(arBefore - 4000);
    expect(aging.items.map((i: { invoiceNumber: string }) => i.invoiceNumber)).not.toContain("INV-1003");
    expect(aging.items.map((i: { invoiceNumber: string }) => i.invoiceNumber)).toContain("INV-1004");
    // Nothing ZATCA-shaped moved.
    expect(await artefacts()).toEqual(before.artefacts);
    expect(seams()).toEqual(before.seams);
    expect(await vatReturns()).toEqual(before.vat);
    // The settled item leaves the settlement candidates; the others stay.
    expect(await openCandidates()).toEqual(["INV-1001", "INV-1002", "INV-1004"]);
  });

  it("🔴 receipt + allocation — a partial allocation leaves the opening receivable open for the balance, a second one settles it; the D-4 controls (over-allocation, party mismatch, one active allocation per source and invoice) hold on an opening item exactly as on an issued one; still no artefact", async () => {
    const before = { artefacts: await artefacts(), seams: seams(), vat: await vatReturns() };
    const p1 = await inTenant(() => paymentsService.receive({ customerId: alphaId, amount: 6000, paidAt: "2026-07-16", bankAccountId: bankA, allocations: [{ invoiceId: ids["INV-1001"], amount: 6000 }] }, userId));
    expect(p1.allocations.map((a) => [a.invoiceId, Number(a.amount)])).toEqual([[ids["INV-1001"], 6000]]);
    let row = await invoiceRow("INV-1001");
    expect([row.status, Number(row.paid), row.invoice_hash, row.icv, row.qr_code]).toEqual(["sent", 6000, null, null, null]);
    expect(await arByCustomerInGl(alphaId)).toBe(12000); // 18,000 opening − 6,000
    // D-4 controls, unchanged: a fully applied receipt has nothing left to allocate; over the outstanding; a different customer's receipt.
    await expectRefusal(inTenant(() => paymentsService.allocate(p1.id, { allocations: [{ invoiceId: ids["INV-1001"], amount: 1 }] }, userId)), 422, undefined, /only 0.00 of payment/);
    const p2 = await inTenant(() => paymentsService.receive({ customerId: alphaId, amount: 4500, paidAt: "2026-07-17", bankAccountId: bankA }, userId)); // 500 more than the balance: the excess stays on deposit
    await expectRefusal(inTenant(() => paymentsService.allocate(p2.id, { allocations: [{ invoiceId: ids["INV-1001"], amount: 4000.01 }] }, userId)), 409, undefined, /exceeds its outstanding balance of 4000\.00/);
    const pOther = await inTenant(() => paymentsService.receive({ customerId: betaId, amount: 50, paidAt: "2026-07-17", bankAccountId: bankA }, userId));
    await expectRefusal(inTenant(() => paymentsService.allocate(pOther.id, { allocations: [{ invoiceId: ids["INV-1001"], amount: 50 }] }, userId)), 422, "allocation_party_mismatch");
    // The balance, allocated from the unallocated receipt: settled; the 500 excess is the customer's deposit, not AR.
    const p2b = await inTenant(() => paymentsService.allocate(p2.id, { allocations: [{ invoiceId: ids["INV-1001"], amount: 4000 }] }, userId));
    expect(p2b.allocations.map((a) => [a.invoiceId, Number(a.amount)])).toEqual([[ids["INV-1001"], 4000]]);
    row = await invoiceRow("INV-1001");
    expect([row.status, Number(row.paid), row.invoice_hash, row.previous_hash, row.icv, row.qr_code, row.issued_at]).toEqual(["paid", 10000, null, null, null, null, null]);
    expect(await arByCustomerInGl(alphaId)).toBe(8000);
    expect((await inTenant(() => customerStatementService.statement(alphaId, {}))).current.receivable).toBe(8000);
    // Un-allocating re-opens it (the correction path works on an opening item too), and re-allocating closes it again.
    const alloc = p2b.allocations[0].id;
    await inTenant(() => paymentsService.unallocate(alloc, { reason: "test: allocation correction on an opening item" }, userId));
    expect((await invoiceRow("INV-1001")).status).toBe("sent");
    await inTenant(() => paymentsService.allocate(p2.id, { allocations: [{ invoiceId: ids["INV-1001"], amount: 4000 }] }, userId));
    expect([(await invoiceRow("INV-1001")).status, Number((await invoiceRow("INV-1001")).paid)]).toEqual(["paid", 10000]);
    expect(await artefacts()).toEqual(before.artefacts);
    expect(seams()).toEqual(before.seams);
    expect(await vatReturns()).toEqual(before.vat);
    expect(await openCandidates()).toEqual(["INV-1002", "INV-1004"]);
  });

  it("🔴 review queue — a bank credit that names an opening receivable is SUGGESTED as its settlement and 'Accept & settle' collects it; no artefact", async () => {
    const before = { artefacts: await artefacts(), seams: seams(), vat: await vatReturns() };
    const tx = await statementRow(bankA, { date: "2026-07-18", description: "INCOMING TRANSFER INV-1004", amount: 3000, type: "credit" });
    const pending = await inTenant(() => transactionsService.pendingReview());
    expect(pending.find((p) => p.id === tx)?.suggestion).toMatchObject({ documentKind: "invoice", documentId: ids["INV-1004"], documentNumber: "INV-1004", matchedBy: "number", partial: false, outstanding: 3000 });
    await inTenant(() => transactionsService.settle(tx, { invoiceId: ids["INV-1004"] }, userId));
    const row = await invoiceRow("INV-1004");
    expect([row.status, Number(row.paid), row.invoice_hash, row.icv, row.qr_code, row.issued_at]).toEqual(["paid", 3000, null, null, null, null]);
    expect(await arByCustomerInGl(betaId)).toBe(0);
    expect(await artefacts()).toEqual(before.artefacts);
    expect(seams()).toEqual(before.seams);
    expect(await vatReturns()).toEqual(before.vat);
    expect(await openCandidates()).toEqual(["INV-1002"]);
  });

  it("🔴 bank matching — a receipt allocated to an opening receivable is matched DETERMINISTICALLY to the statement row naming that receivable; apply records the match; no artefact", async () => {
    const before = { artefacts: await artefacts(), seams: seams(), vat: await vatReturns() };
    const p = await inTenant(() => paymentsService.receive({ customerId: alphaId, amount: 8000, paidAt: "2026-07-20", bankAccountId: bankA, allocations: [{ invoiceId: ids["INV-1002"], amount: 8000 }] }, userId));
    const tx = await statementRow(bankA, { date: "2026-07-20", description: "TRANSFER FROM ALPHA TRADING INV-1002", amount: 8000, type: "credit" });
    const c = (await inTenant(() => statementMatchingService.classify({ limit: 500 }))).find((r) => r.transactionId === tx)!;
    expect(c.classification).toBe("DETERMINISTIC");
    expect(c.target).toMatchObject({ kind: "payment", id: p.id, identifiedBy: "invoice INV-1002" });
    const res = await inTenant(() => statementMatchingService.apply({}, userId));
    expect(res.recorded.map((m) => [m.transactionId, m.paymentId, m.method])).toEqual([[tx, p.id, "deterministic"]]);
    const row = await invoiceRow("INV-1002");
    expect([row.status, Number(row.paid), row.invoice_hash, row.icv, row.qr_code, row.issued_at]).toEqual(["paid", 8000, null, null, null, null]);
    expect(await arByCustomerInGl(alphaId)).toBe(0);
    expect(Number((await inTenant(() => reportsService.arAging())).total)).toBe(0);
    expect(await artefacts()).toEqual(before.artefacts);
    expect(seams()).toEqual(before.seams);
    expect(await vatReturns()).toEqual(before.vat);
    expect(await openCandidates()).toEqual([]);
  });

  it("🔴 the planted positive — an ORDINARY invoice still issues through approval (hash, ICV, QR, the seams run), pays the same way, and a DRAFT still cannot be paid; an opening BILL pays as before", async () => {
    const seamsBefore = seams();
    const inv = await inTenant(() => createApproved<{ id: number; invoiceNumber: string; invoiceHash: string | null; icv: number | null; qrCode: string | null }>(invoicesService, { invoiceNumber: "SL-2026-001", date: "2026-07-21", dueDate: "2026-08-20", customerId: alphaId, items: [{ description: "Work", quantity: 1, unitPrice: 1000, vatRate: 15 }] }, userId));
    expect(inv.invoiceHash).toBeTruthy();
    expect(inv.icv).not.toBeNull();
    expect(inv.qrCode).toBeTruthy();
    const after = seams();
    expect(after.approve).toBe(seamsBefore.approve + 1);
    expect(after.hash).toBeGreaterThan(seamsBefore.hash);
    expect(after.qr).toBeGreaterThan(seamsBefore.qr);
    expect(after.enqueue).toBe(seamsBefore.enqueue + 1);
    const paid = await inTenant(() => invoicesService.pay(inv.id, { amount: 1150, paidAt: "2026-07-22", bankAccountId: bankA }, userId));
    expect(paid).toMatchObject({ status: "paid", paidAmount: 1150, isOpening: false });
    // A draft has no receivable — unchanged.
    const draft = await inTenant(() => invoicesService.create({ invoiceNumber: "SL-2026-002", date: "2026-07-21", dueDate: "2026-08-20", customerId: alphaId, items: [{ description: "Work", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId));
    await expectRefusal(inTenant(() => invoicesService.pay(draft.id, { amount: 115, paidAt: "2026-07-22", bankAccountId: bankA }, userId)), 409, undefined, /must be approved before a payment|has not been issued/);
    // An opening bill collects through its own pay path, as it already did.
    const bill = await inTenant(() => billsService.pay(ids["BILL-77"], { amount: 7000, paidAt: "2026-07-22", bankAccountId: bankA }, userId));
    expect(bill).toMatchObject({ status: "paid", paidAmount: 7000 });
  });

  it("🔴 not a tax invoice — an opening receivable cannot be RENDERED as one, and cannot be the ORIGINAL of a credit or debit note (fail-closed, named); the ordinary invoice renders and can be corrected", async () => {
    await expectRefusal(inTenant(() => buildInvoiceDocModel(ids["INV-1001"], "en")), 409, "opening_item_not_a_tax_invoice");
    await expectRefusal(inTenant(() => buildInvoiceDocModel(ids["INV-1002"], "ar")), 409, "opening_item_not_a_tax_invoice");
    const slId = (await invoiceRow("SL-2026-001")).id;
    const model = await inTenant(() => buildInvoiceDocModel(slId, "en"));
    expect(model).toMatchObject({ documentType: "invoice", invoiceNumber: "SL-2026-001" });
    expect(model.qrDataUrl).toBeTruthy();
    const note = (original: number, number: string) => ({ invoiceNumber: number, documentType: "credit_note", originalInvoiceId: original, noteReason: "Goods returned", date: "2026-07-23", dueDate: "2026-07-23", customerId: alphaId, items: [{ description: "Return", quantity: 1, unitPrice: 100, vatRate: 15 }] });
    await expectRefusal(inTenant(() => invoicesService.create(note(ids["INV-1001"], "CN-OPEN-1"), userId)), 409, "note_original_is_opening_item");
    await expectRefusal(inTenant(() => invoicesService.create({ ...note(ids["INV-1002"], "DN-OPEN-1"), documentType: "debit_note" }, userId)), 409, "note_original_is_opening_item");
    const cn = await inTenant(() => invoicesService.create(note(slId, "CN-SL-1"), userId));
    expect(cn).toMatchObject({ documentType: "credit_note", originalInvoiceId: slId, status: "draft" });
    expect((await pool.query(`SELECT count(*)::int n FROM invoices WHERE company_id = $1 AND document_type IN ('credit_note','debit_note')`, [companyId])).rows[0].n).toBe(1);
  });

  it("🔴 a REVERSED opening receivable is history — no path settles it (pay, receipt allocation), it is not a settlement candidate, and a statement row naming it gets no suggestion", async () => {
    const chart: Chart = [
      { sourceCode: "1100", sourceName: "ANB", sourceType: "asset", openingDebit: 1000, sourceRole: "bank", evidenceNote: "ANB statement 30 Jun 2026, closing 1,000.00" },
      { sourceCode: "1200", sourceName: "Trade debtors", sourceType: "asset", openingDebit: 5000, sourceRole: "receivable" },
      { sourceCode: "3150", sourceName: "Owner capital (B)", sourceType: "equity", openingCredit: 6000 },
    ];
    const parties = [{ partyType: "customer" as const, sourceId: "C9", name: "Omega Est." }];
    const items: NonNullable<Items> = [{ itemType: "ar", sourceId: "SI-9001", partySourceId: "C9", documentNumber: "INV-9001", issueDate: "2026-06-01", dueDate: "2026-07-01", originalAmount: 5000, outstandingAmount: 5000 }];
    const b = await commitBatch({ chart, parties, items, bank: bankB, run: inB });
    const live = await invoiceRow("INV-9001", companyBId);
    expect(await openCandidates(inB)).toEqual(["INV-9001"]);
    const rev = await inB(() => migrationCommitService.reverse(b, { reason: "test: the reversed opening receivable must not be collectible" }, userId));
    expect(rev.status).toBe("reversed");
    const row = await invoiceRow("INV-9001", companyBId);
    expect(row.reversed_at).not.toBeNull();
    await expectRefusal(inB(() => invoicesService.pay(live.id, { amount: 5000, paidAt: "2026-07-15", bankAccountId: bankB }, userId)), 409, "opening_item_reversed");
    await expectRefusal(inB(() => paymentsService.receive({ customerId: live.customer_id, amount: 5000, paidAt: "2026-07-15", bankAccountId: bankB, allocations: [{ invoiceId: live.id, amount: 5000 }] }, userId)), 409, "opening_item_reversed");
    expect(await openCandidates(inB)).toEqual([]);
    const tx = await statementRow(bankB, { date: "2026-07-18", description: "INCOMING INV-9001", amount: 5000, type: "credit" }, inB);
    expect((await inB(() => transactionsService.pendingReview())).find((p) => p.id === tx)?.suggestion ?? null).toBeNull();
    expect([Number(row.paid), row.status]).toEqual([0, "sent"]);
    expect(await artefacts(companyBId)).toEqual({ einvoice_documents: 0, einvoice_archive: 0, opening_rows_with_artefacts: 0, opening_items: 0 });
  });

  it("🔴 the ledger invariants cover an opening receivable: `invoice_outstanding_nonnegative` runs over issued OR opening rows (the shared covered-set text), `paid_cache` over every row; the covered set holds every opening row; a planted paid-cache lie on an opening row is visible", async () => {
    // The script's two invoice invariants use the ONE covered-set definition — no hash-only gate remains on them.
    const src = readFileSync(resolve(__dirname, "../scripts/ledgerInvariants.ts"), "utf8");
    const block = (name: string) => { const i = src.indexOf(`fail("${name}`); expect(i, name).toBeGreaterThan(0); return src.slice(i, src.indexOf("`));", i)); };
    expect(block("invoice_outstanding_nonnegative")).toContain("${INVOICE_ISSUED_OR_OPENING_TEXT(\"i\")}");
    expect(block("invoice_outstanding_nonnegative")).not.toMatch(/invoice_hash IS NOT NULL/);
    // paid_cache was never hash-gated (the queue entry believed it was — verified here, not restated): it runs over EVERY invoice row, opening ones included, and must stay that wide.
    expect(block("paid_cache")).not.toMatch(/invoice_hash/);
    expect(block("paid_cache")).toMatch(/FROM invoices i\s+LEFT JOIN/);
    // Runtime: the covered set includes every opening row of this company (live AND reversed — a frozen row must still satisfy the invariants) and the ordinary issued one; the draft and the draft note are out.
    const covered = (await pool.query(`SELECT invoice_number FROM invoices i WHERE i.company_id = ANY($1) AND ${INVOICE_ISSUED_OR_OPENING_TEXT("i")} ORDER BY invoice_number`, [[companyId, companyBId]])).rows.map((r) => r.invoice_number);
    expect(covered).toEqual(["INV-1001", "INV-1002", "INV-1003", "INV-1004", "INV-9001", "SL-2026-001"]); // the draft note CN-SL-1 and the draft SL-2026-002 are outside the books
    // A planted lie on an opening row: paid_amount ≠ Σ active allocations — the invariant's own predicate, evaluated here, must see it (and see nothing before the lie).
    const paidCacheViolations = () => pool.query(`
      SELECT i.invoice_number FROM invoices i
        LEFT JOIN (SELECT invoice_id, sum(amount) v FROM invoice_payments GROUP BY 1) l ON l.invoice_id = i.id
        LEFT JOIN (SELECT a.invoice_id, sum(a.amount) v FROM payment_allocations a LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id WHERE a.payment_id IS NOT NULL AND r.id IS NULL GROUP BY 1) s ON s.invoice_id = i.id
       WHERE i.company_id = $1 AND ${INVOICE_ISSUED_OR_OPENING_TEXT("i")} AND coalesce(i.paid_amount,0) <> coalesce(l.v,0) + coalesce(s.v,0)`, [companyId]);
    expect((await paidCacheViolations()).rows).toEqual([]);
    await pool.query(`UPDATE invoices SET paid_amount = 1 WHERE id = $1`, [ids["INV-1003"]]);
    expect((await paidCacheViolations()).rows.map((r) => r.invoice_number)).toEqual(["INV-1003"]);
    await pool.query(`UPDATE invoices SET paid_amount = 4000 WHERE id = $1`, [ids["INV-1003"]]);
    expect((await paidCacheViolations()).rows).toEqual([]);
  });
});
