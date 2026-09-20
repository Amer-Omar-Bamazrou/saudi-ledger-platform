/**
 * BATCH 1C — PHASE 3: the COMMIT (one transaction), the gates R1–R10 against
 * the posted ledger, the refusal of an unbalanced position (A5 — there is no
 * balancing account and no clearing; R6 is a blocking gate with a planted
 * positive), the REVERSAL and the corrected re-run, atomicity under injected failures,
 * post-commit immutability, isolation, and R7 (no VAT / e-invoice / ZATCA
 * event from a migration record).
 *
 * The fixture is the Phase 2 mid-year business: Dr 142,500 = Cr 142,500 as
 * at 2026-06-30 (cutover 2026-07-01), AR 34,500 over two customers, AP
 * 11,500 over two suppliers, deposits 5,000, two banks, VAT 6,000 / 1,500,
 * YTD income 40,000 / expense 33,500. Every figure below is asserted.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { beginTenantConnection, pool, db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { auditContext } from "../lib/auditContext";
import { migrationService } from "../services/migration.service";
import { migrationStagingService } from "../services/migrationStaging.service";
import { migrationValidationService } from "../services/migrationValidation.service";
import { migrationCommitService } from "../services/migrationCommit.service";
import { readStagedContent } from "../services/migrationStaging.service";
import { contentHashOf, computeOpeningPosition } from "../services/migrationValidation.service";
import { migrationRepository } from "../repositories/migration.repository";
import { periodLocksRepository } from "../repositories/periodLocks.repository";
import { bankAccountsService } from "../services/bankAccounts.service";
import { customersService } from "../services/customers.service";
import { vendorsService } from "../services/vendors.service";
import { customerStatementService } from "../services/customerStatement.service";
import { reportsService } from "../services/reports.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { invoicesService } from "../services/invoices.service";
import { postJournalEntry } from "../services/accounting/glPosting";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "b1c-commit";
const SLUG_OTHER = "b1c-commit-other";
const EMAIL = "b1c-commit@test.local";

describeMaybe("Batch 1C — Phase 3: commit, R1–R10, OBE, reversal, atomicity", () => {
  let orgId = "", companyId = "", company2Id = "", otherOrgId = "", otherCompanyId = "";
  let userId = 0;
  let bank1 = 0, bank2 = 0, bankC2 = 0;
  let existingAlpha = 0, existingVendor = 0;

  const tenant = (org: string, company: string) => async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: company, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  };
  const inTenant = <T,>(fn: () => Promise<T>) => tenant(orgId, companyId)(fn);
  const inCompany2 = <T,>(fn: () => Promise<T>) => tenant(orgId, company2Id)(fn);
  const inOther = <T,>(fn: () => Promise<T>) => tenant(otherOrgId, otherCompanyId)(fn);

  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const slug of [SLUG, SLUG_OTHER]) {
        const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
        for (const t of [
          "payment_allocations", "payments", "migration_advances", "migration_open_items", "migration_parties", "migration_chart_rows",
          "invoice_items", "invoices", "bills", "journal_entry_lines", "journal_entries", "migration_batches", "period_locks", "audit_logs", "organization_memberships",
          "bank_accounts", "customers", "vendors", "categories", "companies",
        ]) {
          await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
        }
        await client.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
      }
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
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('B1C Commit','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start) VALUES ($1,'B1C Commit Co','1010868381','399999999999923',1) RETURNING id`, [orgId])).rows[0].id;
    company2Id = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start) VALUES ($1,'B1C Commit Co 2','1010868382','399999999999903',1) RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('B1C Commit Other','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start) VALUES ($1,'B1C Commit Other Co','1010868383','399999999999893',1) RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','B1C',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    bank1 = (await inTenant(() => bankAccountsService.create({ name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bank2 = (await inTenant(() => bankAccountsService.create({ name: "ANB Ops", bankName: "ANB", currency: "SAR" }))).id;
    bankC2 = (await inCompany2(() => bankAccountsService.create({ name: "Co2 Main", bankName: "ANB", currency: "SAR" }))).id;
    existingAlpha = (await inTenant(() => customersService.create({ name: "Alpha Trading Est.", taxNumber: "300000000000003" }))).id;
    existingVendor = (await inTenant(() => vendorsService.create({ name: "Delta Supplies" }))).id;
  });
  afterAll(cleanup);

  type Chart = Parameters<typeof migrationService.importChart>[1]["rows"];
  const CHART: NonNullable<Chart> = [
    { sourceCode: "1100", sourceName: "Riyad Bank", sourceType: "asset", openingDebit: 50000, sourceRole: "bank", evidenceNote: "Riyad statement 30 Jun 2026, closing 50,000.00" },
    { sourceCode: "1110", sourceName: "ANB", sourceType: "asset", openingDebit: 20000, sourceRole: "bank", evidenceNote: "ANB statement 30 Jun 2026, closing 20,000.00" },
    { sourceCode: "1200", sourceName: "Trade debtors", sourceType: "asset", openingDebit: 34500, sourceRole: "receivable" },
    { sourceCode: "1300", sourceName: "Input VAT", sourceType: "asset", openingDebit: 1500, sourceRole: "vat_input" },
    { sourceCode: "1400", sourceName: "Prepaid expenses", sourceType: "asset", openingDebit: 3000 },
    { sourceCode: "2100", sourceName: "Trade creditors", sourceType: "liability", openingCredit: 11500, sourceRole: "payable" },
    { sourceCode: "2200", sourceName: "Output VAT", sourceType: "liability", openingCredit: 6000, sourceRole: "vat_output" },
    { sourceCode: "2300", sourceName: "Customer advances", sourceType: "liability", openingCredit: 5000, sourceRole: "customer_deposits" },
    { sourceCode: "3100", sourceName: "Share capital", sourceType: "equity", openingCredit: 60000 },
    { sourceCode: "3200", sourceName: "Retained earnings b/f", sourceType: "equity", openingCredit: 20000, sourceRole: "retained_earnings" },
    { sourceCode: "4100", sourceName: "Sales", sourceType: "income", openingCredit: 40000 },
    { sourceCode: "5100", sourceName: "Purchases", sourceType: "expense", openingDebit: 25000 },
    { sourceCode: "5200", sourceName: "Rent", sourceType: "expense", openingDebit: 8500 },
  ];
  const PARTIES = [
    { partyType: "customer" as const, sourceId: "C1", name: "Alpha Trading Est.", taxNumber: "300000000000003" },
    { partyType: "customer" as const, sourceId: "C2", name: "Beta Logistics" },
    { partyType: "customer" as const, sourceId: "C3", name: "Gamma Co" },
    { partyType: "vendor" as const, sourceId: "V1", name: "Delta Supplies" },
    { partyType: "vendor" as const, sourceId: "V2", name: "Epsilon Ltd" },
  ];
  const ITEMS = [
    { itemType: "ar" as const, sourceId: "SI-1001", partySourceId: "C1", documentNumber: "INV-1001", issueDate: "2026-05-10", dueDate: "2026-06-09", originalAmount: 10000, outstandingAmount: 10000, historicalVat: { category: "S", rate: 15, taxableAmount: 8695.65, amount: 1304.35, reportedPeriod: "2026-Q2" } },
    { itemType: "ar" as const, sourceId: "SI-1002", partySourceId: "C1", documentNumber: "INV-1002", issueDate: "2026-06-01", dueDate: "2026-07-01", originalAmount: 8000, outstandingAmount: 4500 },
    { itemType: "ar" as const, sourceId: "BAL-C2", partySourceId: "C2", documentNumber: "OPEN-C2", issueDate: "2026-06-30", dueDate: "2026-06-30", originalAmount: 20000, outstandingAmount: 20000, compositionUnknown: true },
    { itemType: "ap" as const, sourceId: "PI-77", partySourceId: "V1", documentNumber: "BILL-77", issueDate: "2026-04-15", dueDate: "2026-05-15", originalAmount: 7000, outstandingAmount: 7000 },
    { itemType: "ap" as const, sourceId: "PI-78", partySourceId: "V2", documentNumber: "BILL-78", issueDate: "2026-06-20", dueDate: "2026-07-20", originalAmount: 9000, outstandingAmount: 4500 },
  ];
  const ADVANCES = [
    { sourceId: "ADV-1", partySourceId: "C3", bankSourceCode: "1100", amount: 3000, receivedAt: "2026-06-01", vatPosition: "invoiced" as const, advanceInvoiceNumber: "ADV-INV-9", advanceInvoiceDate: "2026-06-01", advanceInvoiceTime: "10:00:00", vatCategory: "S", vatRate: 15, vatAmount: 391.3 },
    { sourceId: "ADV-2", partySourceId: "C3", bankSourceCode: "1110", amount: 2000, receivedAt: "2026-06-15", vatPosition: "unknown" as const },
  ];
  const VAT_POSITION = { returnReference: "VAT-2026-Q2-ACK-7781", periodStart: "2026-04-01", periodEnd: "2026-06-30", outputVatPayable: 6000, inputVatReceivable: 1500 };

  const create = (cutoverDate = "2026-07-01", run = inTenant) => run(() => migrationService.createBatch({ sourceSystem: "PreviousERP", cutoverDate }, userId));
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string, message?: RegExp) => {
    let err: any;
    try { await p; } catch (e) { err = e; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err.statusCode ?? err.status, err.message).toBe(status);
    if (code) expect(err.body?.code ?? err.payload?.code ?? err.code).toBe(code);
    if (message) expect(err.message).toMatch(message);
    return err;
  };
  /** Map the chart as the operator would; `mergeInto` names existing categories for codes that already exist (a re-run after a reversal). */
  const mapChart = async (batchId: number, chart: NonNullable<Chart>, opts: { banks?: [number, number]; mergeInto?: Record<string, number>; run?: typeof inTenant } = {}) => {
    const run = opts.run ?? inTenant;
    const [b1, b2] = opts.banks ?? [bank1, bank2];
    await run(() => migrationService.importChart(batchId, { rows: chart }, userId));
    const out = await run(() => migrationService.getChart(batchId));
    const rowOf = (code: string) => out.rows.find((r) => r.sourceCode === code);
    const d = async (code: string, body: Parameters<typeof migrationService.decideChartRow>[2]) => { if (rowOf(code)) await run(() => migrationService.decideChartRow(batchId, rowOf(code)!.id, body, userId)); };
    const createOrMerge = (code: string) => (opts.mergeInto?.[code] ? { decision: "merge_into" as const, targetCategoryId: opts.mergeInto[code] } : { decision: "create" as const });
    await d("1100", { decision: "map_to_bank", targetBankAccountId: b1 });
    await d("1110", { decision: "map_to_bank", targetBankAccountId: b2 });
    await d("1200", { decision: "map_to_system", targetSystemCode: "AR" });
    await d("1300", { decision: "map_to_system", targetSystemCode: "VAT_INPUT" });
    await d("1400", createOrMerge("1400"));
    await d("2100", { decision: "map_to_system", targetSystemCode: "AP" });
    await d("2200", { decision: "map_to_system", targetSystemCode: "VAT_OUTPUT" });
    await d("2300", { decision: "map_to_system", targetSystemCode: "CUSTOMER_DEPOSITS" });
    await d("3100", createOrMerge("3100"));
    await d("3200", { decision: "map_to_system", targetSystemCode: "RETAINED_EARNINGS" });
    await d("4100", { decision: "map_to_system", targetSystemCode: "SALES" });
    await d("5100", { decision: "map_to_system", targetSystemCode: "PURCHASES" });
    await d("5200", createOrMerge("5200"));
    await d("6100", createOrMerge("6100"));
  };
  const stageAll = async (batchId: number, o: { chart?: NonNullable<Chart>; items?: typeof ITEMS; advances?: typeof ADVANCES; mergeInto?: Record<string, number>; decideParties?: boolean } = {}) => {
    await mapChart(batchId, o.chart ?? CHART, { mergeInto: o.mergeInto });
    const parties = await inTenant(() => migrationStagingService.importParties(batchId, { rows: PARTIES }, userId));
    const p = (sid: string) => parties.rows.find((r) => r.sourceId === sid)!;
    if (o.decideParties !== false) {
      await inTenant(() => migrationStagingService.decideParty(batchId, p("C1").id, { decision: "use_existing", existingId: existingAlpha }, userId));
      await inTenant(() => migrationStagingService.decideParty(batchId, p("V1").id, { decision: "use_existing", existingId: existingVendor }, userId));
    }
    await inTenant(() => migrationStagingService.importOpenItems(batchId, { rows: o.items ?? ITEMS }, userId));
    await inTenant(() => migrationStagingService.importAdvances(batchId, { rows: o.advances ?? ADVANCES }, userId));
    await inTenant(() => migrationService.updateBatch(batchId, { vatPosition: VAT_POSITION }, userId));
  };
  const check = (v: { checks: { id: string; status: string; detail: string; expected: unknown; actual: unknown }[] }, id: string) => v.checks.find((c) => c.id === id)!;
  const ledgerAt = async (date: string, run = inTenant) => run(() => migrationRepository.ledgerBalancesUpTo(date));
  const sysBal = (ledger: { systemCode: string | null; balance: number }[], code: string) => ledger.filter((l) => l.systemCode === code).reduce((s, l) => s + l.balance, 0);
  const counts = async () => (await pool.query(
    `SELECT (SELECT count(*) FROM journal_entries WHERE company_id = $1)::int je, (SELECT count(*) FROM invoices WHERE company_id = $1)::int inv, (SELECT count(*) FROM bills WHERE company_id = $1)::int bil,
            (SELECT count(*) FROM payments WHERE company_id = $1)::int pay, (SELECT count(*) FROM customers WHERE organization_id = $2)::int cus, (SELECT count(*) FROM vendors WHERE organization_id = $2)::int ven,
            (SELECT count(*) FROM categories WHERE organization_id = $2)::int cat, (SELECT count(*) FROM period_locks WHERE company_id = $1)::int locks,
            (SELECT count(*) FROM bank_accounts WHERE company_id = $1 AND opening_journal_entry_id IS NOT NULL)::int banks`, [companyId, orgId])).rows[0];

  let committedId = 0;
  let openingJeId = 0;

  it("🔴 1/4–11/14/17–19 — a full migration commits in one transaction: the opening journal through the seam, subledger records, master data with source identity, bank opening state, the locked opening month, and R1–R10 all passing on the posted ledger", async () => {
    const b = await create();
    await stageAll(b.id);
    // Not validated → refused; validated → committed.
    await expectRefusal(inTenant(() => migrationCommitService.commit(b.id, userId)), 409, "migration_not_validated");
    expect((await inTenant(() => migrationValidationService.validate(b.id, userId))).ok).toBe(true);
    const before = await counts();
    const out = await inTenant(() => migrationCommitService.commit(b.id, userId));
    committedId = b.id;
    expect(out.status).toBe("committed");
    expect(out.openingJournalEntryId).not.toBeNull();
    openingJeId = out.openingJournalEntryId!;
    expect(out.periodLockId).not.toBeNull();
    const rec = out.reconciliation as { checks: { id: string; status: string; detail: string; expected: unknown; actual: unknown }[]; figures: Record<string, number> };
    for (const c of rec.checks) expect(c.status, `${c.id}: ${c.detail}`).toBe("pass");
    expect(rec.checks.map((c) => c.id)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"]);
    expect(rec.figures).toEqual({ assets: 109000, liabilities: 22500, equity: 80000, ytdIncome: 40000, ytdExpense: 33500, ytdResult: 6500, ar: 34500, ap: 11500, deposits: 5000, vatOutput: 6000, vatInput: 1500, journalDebit: 142500, journalCredit: 142500 });
    // What the commit created, counted.
    const after = await counts();
    expect(after).toEqual({ ...before, je: before.je + 1, inv: before.inv + 3, bil: before.bil + 2, pay: before.pay + 2, cus: before.cus + 2, ven: before.ven + 1, cat: before.cat + 3, locks: before.locks + 1, banks: 2 });

    // 10 — THE OPENING JOURNAL: one entry, through the seam, dated cutover − 1, balanced, with the party on every control line.
    const je = (await pool.query(`SELECT * FROM journal_entries WHERE id = $1`, [openingJeId])).rows[0];
    expect(je).toMatchObject({ entry_number: `MIG-${b.id}-OPEN`, date: "2026-06-30", status: "posted", source: "opening", migration_batch_id: b.id, reversal_of: null });
    const lines = (await pool.query(`SELECT l.account_name, l.debit_amount::numeric AS dr, l.credit_amount::numeric AS cr, l.party_type, l.customer_id, l.vendor_id, c.system_code, c.account_code, c.bank_account_id FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.id`, [openingJeId])).rows;
    expect(lines.length).toBe(15);
    const byCode = (code: string) => lines.filter((l) => l.system_code === code);
    expect(byCode("AR").map((l) => [l.party_type, Number(l.dr), Number(l.cr)])).toEqual([["customer", 14500, 0], ["customer", 20000, 0]]);
    expect(byCode("AP").map((l) => [l.party_type, Number(l.dr), Number(l.cr)])).toEqual([["vendor", 0, 7000], ["vendor", 0, 4500]]);
    expect(byCode("CUSTOMER_DEPOSITS").map((l) => [l.party_type, Number(l.cr)])).toEqual([["customer", 5000]]);
    // A5: every line lands on a NAMED account — a system code, a created/merged account code, or a bank leaf. No balancing line exists (R6, blocking).
    expect(lines.every((l) => l.system_code != null || l.account_code != null || l.bank_account_id != null)).toBe(true);
    expect(check(rec, "R6")).toMatchObject({ status: "pass", actual: 0 });
    expect(lines.filter((l) => l.bank_account_id != null).map((l) => [l.bank_account_id, Number(l.dr)])).toEqual([[bank1, 50000], [bank2, 20000]]);
    expect(lines.filter((l) => l.account_code != null).map((l) => [l.account_code, Number(l.dr), Number(l.cr)]).sort()).toEqual([["1400", 3000, 0], ["3100", 0, 60000], ["5200", 8500, 0]]);
    expect(byCode("RETAINED_EARNINGS").map((l) => Number(l.cr))).toEqual([20000]);
    expect(byCode("SALES").map((l) => Number(l.cr))).toEqual([40000]);
    expect(byCode("PURCHASES").map((l) => Number(l.dr))).toEqual([25000]);
    expect(lines.reduce((s, l) => s + Number(l.dr), 0)).toBe(142500);
    expect(lines.reduce((s, l) => s + Number(l.cr), 0)).toBe(142500);

    // 4/5/6/7/8/9 — the ledger read back agrees with the source, per figure.
    const ledger = await ledgerAt("2026-06-30");
    expect(sysBal(ledger, "AR")).toBe(34500);
    expect(sysBal(ledger, "AP")).toBe(-11500);
    expect(sysBal(ledger, "CUSTOMER_DEPOSITS")).toBe(-5000);
    expect(sysBal(ledger, "VAT_OUTPUT")).toBe(-6000);
    expect(sysBal(ledger, "VAT_INPUT")).toBe(1500);
    expect(sysBal(ledger, "SALES")).toBe(-40000);
    expect(sysBal(ledger, "PURCHASES")).toBe(25000);
    expect(ledger.find((l) => l.bankAccountId === bank1)!.balance).toBe(50000);
    expect(ledger.find((l) => l.bankAccountId === bank2)!.balance).toBe(20000);
    // And nothing sits on the day AFTER: a date filter from the cutover shows the post-migration result alone (A2, both views).
    expect((await ledgerAt("2026-06-29")).length).toBe(0);

    // 17 — source identity on the master records: created ones carry it; the existing ones chosen gained it.
    const cust = (await pool.query(`SELECT name, source_system, source_id FROM customers WHERE organization_id = $1 ORDER BY id`, [orgId])).rows;
    expect(cust).toEqual([
      { name: "Alpha Trading Est.", source_system: "PreviousERP", source_id: "C1" },
      { name: "Beta Logistics", source_system: "PreviousERP", source_id: "C2" },
      { name: "Gamma Co", source_system: "PreviousERP", source_id: "C3" },
    ]);
    const vend = (await pool.query(`SELECT name, source_system, source_id FROM vendors WHERE organization_id = $1 ORDER BY id`, [orgId])).rows;
    expect(vend).toEqual([{ name: "Delta Supplies", source_system: "PreviousERP", source_id: "V1" }, { name: "Epsilon Ltd", source_system: "PreviousERP", source_id: "V2" }]);
    await expect(pool.query(`INSERT INTO customers (organization_id, name, source_system, source_id) VALUES ($1,'dup','PreviousERP','C1')`, [orgId])).rejects.toThrow(/customers_source_identity_unq/);
    // Created accounts keep the old code.
    const cats = (await pool.query(`SELECT name, account_code, type, is_posting, description FROM categories WHERE organization_id = $1 AND account_code IS NOT NULL ORDER BY account_code`, [orgId])).rows;
    expect(cats.map((c) => [c.account_code, c.name, c.type, c.is_posting])).toEqual([["1400", "Prepaid expenses", "asset", true], ["3100", "Share capital", "equity", true], ["5200", "Rent", "expense", true]]);

    // 18/19 — the opening items are subledger records, not documents: original number and dates, outstanding as the total, no VAT, no ICV, no hash, no QR, no lines, no e-invoice document.
    const inv = (await pool.query(`SELECT invoice_number, date, due_date, status, total::numeric AS total, subtotal::numeric AS subtotal, vat_amount::numeric AS vat, icv, invoice_hash, qr_code, issued_at, is_opening, migration_open_item_id, customer_id FROM invoices WHERE company_id = $1 ORDER BY invoice_number`, [companyId])).rows;
    expect(inv.map((i) => [i.invoice_number, i.date, i.due_date, i.status, Number(i.total), Number(i.vat), i.icv, i.invoice_hash, i.qr_code, i.issued_at, i.is_opening, i.migration_open_item_id != null])).toEqual([
      ["INV-1001", "2026-05-10", "2026-06-09", "sent", 10000, 0, null, null, null, null, true, true],
      ["INV-1002", "2026-06-01", "2026-07-01", "sent", 4500, 0, null, null, null, null, true, true],
      ["OPEN-C2", "2026-06-30", "2026-06-30", "sent", 20000, 0, null, null, null, null, true, true],
    ]);
    expect((await pool.query(`SELECT count(*)::int n FROM invoice_items WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM einvoice_documents WHERE company_id = $1`, [companyId])).rows[0].n).toBe(0);
    const bills = (await pool.query(`SELECT bill_number, date, due_date, status, total::numeric AS total, vat_amount::numeric AS vat, is_opening FROM bills WHERE company_id = $1 ORDER BY bill_number`, [companyId])).rows;
    expect(bills.map((x) => [x.bill_number, x.date, x.status, Number(x.total), Number(x.vat), x.is_opening])).toEqual([["BILL-77", "2026-04-15", "approved", 7000, 0, true], ["BILL-78", "2026-06-20", "approved", 4500, 0, true]]);
    // The VAT return for the months the items were issued in does NOT see them (R7 — a VAT event the migration must never create).
    const vat = await inTenant(() => reportsService.vatReturn("2026-04", "2026-06"));
    expect(vat.salesSection).toMatchObject({ box1_standardRatedDomesticSales: 0, box2_zeroRatedDomesticSales: 0, box5_totalSales: 0 });
    expect(vat.purchasesSection).toMatchObject({ box10_zeroRatedPurchases: 0 });
    // Deposits: payments rows whose deposit line is inside the opening journal, carrying the advance-invoice reference.
    const pays = (await pool.query(`SELECT amount::numeric AS amount, paid_at::text AS paid_at, source, journal_entry_id, migration_advance_id, reference, bank_account_id FROM payments WHERE company_id = $1 ORDER BY paid_at`, [companyId])).rows;
    expect(pays.map((p) => [Number(p.amount), p.paid_at, p.source, p.journal_entry_id, p.migration_advance_id != null, p.reference, p.bank_account_id])).toEqual([
      [3000, "2026-06-01", "opening", openingJeId, true, "advance invoice ADV-INV-9", bank1],
      [2000, "2026-06-15", "opening", openingJeId, true, "advance ADV-2 (VAT position unknown)", bank2],
    ]);
    // The staged advance keeps the full reference the later invoice needs (Guideline §8).
    const adv = (await pool.query(`SELECT advance_invoice_number, advance_invoice_date::text AS advance_invoice_date, advance_invoice_time, vat_category, vat_rate::numeric AS rate, vat_position, resolved_payment_id FROM migration_advances WHERE batch_id = $1 ORDER BY source_id`, [b.id])).rows;
    expect(adv[0]).toMatchObject({ advance_invoice_number: "ADV-INV-9", advance_invoice_date: "2026-06-01", advance_invoice_time: "10:00:00", vat_category: "S", vat_position: "invoiced" });
    expect(adv[0].resolved_payment_id).not.toBeNull();
    expect(Number(adv[0].rate)).toBe(15);
    // The subledger works: the customer statement sees the opening receivable and the deposit as positions.
    const alphaStmt = await inTenant(() => customerStatementService.statement(existingAlpha, {}));
    expect(alphaStmt.current).toMatchObject({ receivable: 14500, depositBalance: 0 });
    const gammaId = cust.length ? (await pool.query(`SELECT id FROM customers WHERE organization_id = $1 AND source_id = 'C3'`, [orgId])).rows[0].id : 0;
    const gammaStmt = await inTenant(() => customerStatementService.statement(gammaId, {}));
    expect(gammaStmt.current).toMatchObject({ receivable: 0, depositBalance: 5000, netPosition: -5000 });
    // 7 — banks: the opening balance is the posted figure and read-only (G2 closed).
    const banks = (await pool.query(`SELECT id, opening_balance::numeric AS ob, opening_journal_entry_id FROM bank_accounts WHERE company_id = $1 ORDER BY id`, [companyId])).rows;
    expect(banks.map((x) => [x.id, Number(x.ob), x.opening_journal_entry_id])).toEqual([[bank1, 50000, openingJeId], [bank2, 20000, openingJeId]]);
    await expectRefusal(inTenant(() => bankAccountsService.update(bank1, { openingBalance: 49000 })), 422, "opening_balance_posted");
    expect((await inTenant(() => bankAccountsService.update(bank1, { notes: "still editable" }))).notes).toBe("still editable");
    // 14 — the opening month is locked in the migration's name: nothing else posts into it; the day after is open.
    const lock = (await pool.query(`SELECT period, notes FROM period_locks WHERE id = $1`, [out.periodLockId])).rows[0];
    expect(lock).toEqual({ period: "2026-06", notes: `Opening balances — migration batch ${b.id} from PreviousERP` });
    await expectRefusal(inTenant(() => postJournalEntry({ entryNumber: "X-1", date: "2026-06-15", description: "late", lines: [{ systemCode: "SUSPENSE", accountName: "Suspense", debitAmount: 1, creditAmount: 0 }, { systemCode: "SALES", accountName: "Sales", debitAmount: 0, creditAmount: 1 }] })), 423);
    const later = await inTenant(() => postJournalEntry({ entryNumber: "X-2", date: "2026-07-01", description: "first live entry", lines: [{ systemCode: "SUSPENSE", accountName: "Suspense", debitAmount: 1, creditAmount: 0 }, { systemCode: "SALES", accountName: "Sales", debitAmount: 0, creditAmount: 1 }] }));
    expect(later.source).toBeNull();
    await pool.query(`DELETE FROM journal_entries WHERE id = $1`, [later.id]);
    // The stored reconciliation is what the API returns.
    const stored = await inTenant(() => migrationService.getBatch(b.id));
    expect(stored.status).toBe("committed");
    expect((stored.reconciliation as { checks: unknown[] }).checks).toHaveLength(10);
  });

  it("2 — duplicate replay: committing again returns the same batch with ONE opening journal; a second batch cannot be started while one is committed", async () => {
    const again = await inTenant(() => migrationCommitService.commit(committedId, userId));
    expect(again.status).toBe("committed");
    expect(again.openingJournalEntryId).toBe(openingJeId);
    expect((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE migration_batch_id = $1`, [committedId])).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT count(*)::int n FROM invoices WHERE company_id = $1`, [companyId])).rows[0].n).toBe(3);
    await expectRefusal(create(), 409, "migration_already_committed");
  });

  it("15 — after commit nothing about the migration or what it created can be edited: staging, batch, opening items, bank opening balance", async () => {
    await expect(pool.query(`UPDATE migration_open_items SET outstanding_amount = 1 WHERE batch_id = $1`, [committedId])).rejects.toThrow(/staging rows are immutable/);
    await expect(pool.query(`UPDATE migration_batches SET cutover_date = '2026-08-01' WHERE id = $1`, [committedId])).rejects.toThrow(/cannot be modified/);
    await expect(pool.query(`UPDATE migration_batches SET status = 'draft' WHERE id = $1`, [committedId])).rejects.toThrow(/cannot be modified/);
    await expectRefusal(inTenant(() => migrationStagingService.importParties(committedId, { rows: PARTIES }, userId)), 409, "migration_batch_immutable");
    await expectRefusal(inTenant(() => migrationService.discardBatch(committedId, userId)), 409, "migration_batch_immutable");
    const invId = (await pool.query(`SELECT id FROM invoices WHERE company_id = $1 AND invoice_number = 'INV-1001'`, [companyId])).rows[0].id;
    await expectRefusal(inTenant(() => invoicesService.update(invId, { total: 1 })), 409);
    await expectRefusal(inTenant(() => invoicesService.approve(invId, userId)), 409);
    await expectRefusal(inTenant(() => invoicesService.deleteDraft(invId)), 409);
    // Receipts stay append-only: only a migrated deposit can ever be deleted, and only by the reversal.
    const ordinaryPay = (await pool.query(`INSERT INTO payments (organization_id, company_id, direction, party_type, customer_id, bank_account_id, amount, paid_at, source, journal_entry_id) VALUES ($1,$2,'in','customer',$3,$4,10,'2026-07-05','manual',$5) RETURNING id`, [orgId, companyId, existingAlpha, bank1, openingJeId])).rows[0].id;
    await expect(inTenant(() => db.execute(sql`DELETE FROM payments WHERE id = ${ordinaryPay}`))).rejects.toMatchObject({ cause: { constraint: "payments_append_only" } });
    await pool.query(`DELETE FROM payments WHERE id = $1`, [ordinaryPay]); // the owner (fixtures) may
    // A raw attempt to give an opening item VAT or an ICV is refused by the row itself.
    await expect(pool.query(`UPDATE invoices SET vat_amount = 15 WHERE id = $1`, [invId])).rejects.toThrow(/invoices_opening_no_vat_chk/);
    await expect(pool.query(`UPDATE invoices SET icv = 1 WHERE id = $1`, [invId])).rejects.toThrow(/invoices_opening_no_vat_chk/);
  });

  it("16 — isolation: the sibling company sees nothing of this migration and commits its OWN (one committed batch per COMPANY, not per organisation); the other org sees nothing", async () => {
    await expectRefusal(inCompany2(() => migrationCommitService.commit(committedId, userId)), 404);
    await expectRefusal(inOther(() => migrationService.getBatch(committedId)), 404);
    await expectRefusal(inCompany2(() => migrationCommitService.reversalPreview(committedId)), 404);
    // Company 2's own small migration: one bank, one receivable, capital. Account codes are organisation-wide
    // (categories are, like master data), so its "3100" merges into the account company 1's migration created.
    const b = await create("2026-07-01", inCompany2);
    const existing3100 = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND account_code = '3100'`, [orgId])).rows[0].id;
    await mapChart(b.id, [
      { sourceCode: "1100", sourceName: "Co2 bank", sourceType: "asset", openingDebit: 900, sourceRole: "bank", evidenceNote: "stmt" },
      { sourceCode: "1200", sourceName: "Debtors", sourceType: "asset", openingDebit: 100, sourceRole: "receivable" },
      { sourceCode: "3100", sourceName: "Capital", sourceType: "equity", openingCredit: 1000 },
    ], { banks: [bankC2, bankC2], run: inCompany2, mergeInto: { "3100": existing3100 } });
    await inCompany2(() => migrationStagingService.importParties(b.id, { rows: [{ partyType: "customer", sourceId: "C1", name: "Co2 customer" }] }, userId));
    await inCompany2(() => migrationStagingService.importOpenItems(b.id, { rows: [{ itemType: "ar", sourceId: "S1", partySourceId: "C1", documentNumber: "INV-1001", issueDate: "2026-06-01", dueDate: "2026-06-30", originalAmount: 100, outstandingAmount: 100 }] }, userId));
    expect((await inCompany2(() => migrationValidationService.validate(b.id, userId))).ok).toBe(true);
    const out = await inCompany2(() => migrationCommitService.commit(b.id, userId));
    expect(out.status).toBe("committed");
    // Both companies of the org hold a committed migration; the ledgers do not mix; the same invoice number lives in each company; the source id C1 resolved to a DIFFERENT customer.
    expect((await pool.query(`SELECT count(*)::int n FROM migration_batches WHERE organization_id = $1 AND status = 'committed'`, [orgId])).rows[0].n).toBe(2);
    expect(sysBal(await ledgerAt("2026-06-30", inCompany2), "AR")).toBe(100);
    expect(sysBal(await ledgerAt("2026-06-30"), "AR")).toBe(34500);
    expect((await pool.query(`SELECT company_id, total::numeric AS t FROM invoices WHERE organization_id = $1 AND invoice_number = 'INV-1001' ORDER BY total`, [orgId])).rows.map((r) => [r.company_id, Number(r.t)])).toEqual([[company2Id, 100], [companyId, 10000]]);
    expect((await pool.query(`SELECT count(*)::int n FROM customers WHERE organization_id = $1 AND source_id = 'C1'`, [orgId])).rows[0].n).toBe(1);
    // ↑ one org-wide identity space: company 2's "C1" of the SAME source system resolved to the existing Alpha record (identity is per organisation, as master data is).
    await inCompany2(() => migrationCommitService.reverse(b.id, { reason: "isolation fixture teardown" }, userId));
  });

  it("🔴 3 — atomicity: a failure at three different points inside the commit leaves NOTHING behind and the batch recoverable", async () => {
    // A fresh company-1 batch needs the committed one reversed first — done in test 20 below; here a separate fixture company is cheaper: reuse company 2 (its batch was reversed).
    const b = await create("2026-07-01", inCompany2);
    const co2Counts = async () => (await pool.query(
      `SELECT (SELECT count(*) FROM journal_entries WHERE company_id = $1 AND status <> 'reversed' AND source IS DISTINCT FROM 'opening_reversal')::int je, (SELECT count(*) FROM invoices WHERE company_id = $1)::int inv,
              (SELECT count(*) FROM payments WHERE company_id = $1)::int pay, (SELECT count(*) FROM customers WHERE organization_id = $2)::int cus,
              (SELECT count(*) FROM categories WHERE organization_id = $2)::int cat, (SELECT count(*) FROM period_locks WHERE company_id = $1)::int locks,
              (SELECT count(*) FROM bank_accounts WHERE company_id = $1 AND opening_journal_entry_id IS NOT NULL)::int banks`, [company2Id, orgId])).rows[0];
    const existingCo2 = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND account_code = '3100'`, [orgId])).rows[0].id;
    await mapChart(b.id, [
      { sourceCode: "1100", sourceName: "Co2 bank", sourceType: "asset", openingDebit: 900, sourceRole: "bank", evidenceNote: "stmt" },
      { sourceCode: "1200", sourceName: "Debtors", sourceType: "asset", openingDebit: 100, sourceRole: "receivable" },
      { sourceCode: "2300", sourceName: "Advances", sourceType: "liability", openingCredit: 50, sourceRole: "customer_deposits" },
      { sourceCode: "3100", sourceName: "Capital", sourceType: "equity", openingCredit: 950 },
      { sourceCode: "6100", sourceName: "New expense", sourceType: "expense", openingDebit: 0 },
    ], { banks: [bankC2, bankC2], run: inCompany2, mergeInto: { "3100": existingCo2 } });
    await inCompany2(() => migrationStagingService.importParties(b.id, { rows: [{ partyType: "customer", sourceId: "C7", name: "Atomic customer" }] }, userId));
    await inCompany2(() => migrationStagingService.importOpenItems(b.id, { rows: [{ itemType: "ar", sourceId: "S1", partySourceId: "C7", documentNumber: "INV-A1", issueDate: "2026-06-01", dueDate: "2026-06-30", originalAmount: 100, outstandingAmount: 100 }] }, userId));
    await inCompany2(() => migrationStagingService.importAdvances(b.id, { rows: [{ sourceId: "A1", partySourceId: "C7", bankSourceCode: "1100", amount: 50, receivedAt: "2026-06-10", vatPosition: "unknown" }] }, userId));
    const v0 = await inCompany2(() => migrationValidationService.validate(b.id, userId));
    expect(v0.checks.filter((c) => c.status === "fail").map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
    const before = await co2Counts();
    const state = async () => (await pool.query(`SELECT status, opening_journal_entry_id, period_lock_id FROM migration_batches WHERE id = $1`, [b.id])).rows[0];

    // (a) after the customer, the created account, the opening invoice and the opening journal — the deposit insert fails.
    const payFail = vi.spyOn(migrationRepository, "insertPayment").mockRejectedValueOnce(new Error("injected: deposit insert failed"));
    await expect(inCompany2(() => migrationCommitService.commit(b.id, userId))).rejects.toThrow(/injected: deposit insert failed/);
    payFail.mockRestore();
    expect(await co2Counts()).toEqual(before);
    expect(await state()).toEqual({ status: "validated", opening_journal_entry_id: null, period_lock_id: null });
    expect((await pool.query(`SELECT resolved_customer_id FROM migration_parties WHERE batch_id = $1`, [b.id])).rows[0].resolved_customer_id).toBeNull();
    // (b) after everything is written — the period lock fails.
    const lockFail = vi.spyOn(periodLocksRepository, "insert").mockRejectedValueOnce(new Error("injected: lock failed"));
    await expect(inCompany2(() => migrationCommitService.commit(b.id, userId))).rejects.toThrow(/injected: lock failed/);
    lockFail.mockRestore();
    expect(await co2Counts()).toEqual(before);
    expect(await state()).toEqual({ status: "validated", opening_journal_entry_id: null, period_lock_id: null });
    // (c) everything is written and locked — a reconciliation gate FAILS (the AR party read-back is made to disagree).
    const glFail = vi.spyOn(migrationRepository, "ledgerPartyBalancesUpTo").mockResolvedValueOnce([]);
    const err = await expectRefusal(inCompany2(() => migrationCommitService.commit(b.id, userId)), 409, "migration_reconciliation_failed");
    glFail.mockRestore();
    expect(err.message).toMatch(/R2 — /);
    expect(err.message).toMatch(/Nothing was committed/);
    expect(await co2Counts()).toEqual(before);
    expect(await state()).toEqual({ status: "validated", opening_journal_entry_id: null, period_lock_id: null });
    // Still recoverable: the same batch commits cleanly afterwards.
    const ok = await inCompany2(() => migrationCommitService.commit(b.id, userId));
    expect(ok.status).toBe("committed");
    expect(await co2Counts()).toEqual({ ...before, je: before.je + 1, inv: before.inv + 1, pay: before.pay + 1, cus: before.cus + 1, cat: before.cat + 1, locks: before.locks + 1, banks: 1 });
    await inCompany2(() => migrationCommitService.reverse(b.id, { reason: "atomicity fixture teardown" }, userId));
  });

  it("🔴 20 — the reversal walk-through: blocked while anything touched what the commit created; then the mirror through the seam, the items removed, banks display-only, the month reopened, master data kept — and the corrected re-run commits on the same source ids", async () => {
    // A receipt allocated to an opening invoice blocks the reversal — named.
    const invId = (await pool.query(`SELECT id FROM invoices WHERE company_id = $1 AND invoice_number = 'INV-1001'`, [companyId])).rows[0].id;
    await pool.query(`UPDATE invoices SET paid_amount = 100 WHERE id = $1`, [invId]);
    const blocked = await inTenant(() => migrationCommitService.reversalPreview(committedId));
    expect(blocked.blockers).toEqual([expect.stringMatching(/invoice INV-1001 \(allocations 0, credit notes 0, paid 100(\.00)?, credited 0(\.00)?\)/)]);
    await expectRefusal(inTenant(() => migrationCommitService.reverse(committedId, { reason: "opening AR was wrong by 5,000" }, userId)), 422, "migration_reversal_blocked", /INV-1001/);
    await pool.query(`UPDATE invoices SET paid_amount = 0 WHERE id = $1`, [invId]);
    // A month closed by someone ELSE since the migration blocks too.
    await pool.query(`DELETE FROM period_locks WHERE id = (SELECT period_lock_id FROM migration_batches WHERE id = $1)`, [committedId]);
    const foreign = (await pool.query(`INSERT INTO period_locks (organization_id, company_id, period, notes) VALUES ($1,$2,'2026-06','closed by the accountant') RETURNING id`, [orgId, companyId])).rows[0].id;
    expect((await inTenant(() => migrationCommitService.reversalPreview(committedId))).blockers).toEqual([expect.stringMatching(/2026-06 was closed by someone else/)]);
    await pool.query(`DELETE FROM period_locks WHERE id = $1`, [foreign]);
    const own = (await pool.query(`INSERT INTO period_locks (organization_id, company_id, period, notes) VALUES ($1,$2,'2026-06','restored') RETURNING id`, [orgId, companyId])).rows[0].id;
    await pool.query(`UPDATE migration_batches SET period_lock_id = $2 WHERE id = $1`, [committedId, own]);
    const preview = await inTenant(() => migrationCommitService.reversalPreview(committedId));
    expect(preview.blockers).toEqual([]);
    expect(preview.wouldReverse).toMatchObject({ openingJournalEntryId: openingJeId, periodLock: { id: own, period: "2026-06" }, keeps: { customers: 3, vendors: 2, accountsCreated: 3 } });
    expect(preview.wouldReverse.invoices.map((i) => i.number)).toEqual(["INV-1001", "INV-1002", "OPEN-C2"]);
    expect(preview.wouldReverse.deposits.map((d) => d.amount)).toEqual([3000, 2000]);
    await expectRefusal(inTenant(() => migrationCommitService.reverse(committedId, { reason: "short" }, userId)), 400);

    const before = await counts();
    const out = await inTenant(() => migrationCommitService.reverse(committedId, { reason: "opening AR was wrong by 5,000 — Beta's balance was 15,000, not 20,000" }, userId)) as Awaited<ReturnType<typeof migrationCommitService.reverse>> & { removed: { invoices: number; bills: number; deposits: number }; reversalJournalEntryId: number };
    expect(out.status).toBe("reversed");
    expect(out.removed).toEqual({ invoices: 3, bills: 2, deposits: 2 });
    // The mirror: through the seam, dated the opening date, source opening_reversal, reversal_of set; the opening entry marked reversed; both in the books, netting to zero.
    const mirror = (await pool.query(`SELECT * FROM journal_entries WHERE id = $1`, [out.reversalJournalEntryId])).rows[0];
    expect(mirror).toMatchObject({ entry_number: `MIG-${committedId}-OPEN-REV`, date: "2026-06-30", status: "posted", source: "opening_reversal", reversal_of: openingJeId, migration_batch_id: committedId });
    expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [openingJeId])).rows[0].status).toBe("reversed");
    const mirrorLines = (await pool.query(`SELECT count(*)::int n, sum(debit_amount::numeric) dr, sum(credit_amount::numeric) cr, count(customer_id)::int cust, count(vendor_id)::int vend FROM journal_entry_lines WHERE journal_entry_id = $1`, [out.reversalJournalEntryId])).rows[0];
    expect([mirrorLines.n, Number(mirrorLines.dr), Number(mirrorLines.cr), mirrorLines.cust, mirrorLines.vend]).toEqual([15, 142500, 142500, 3, 2]);
    const ledger = await ledgerAt("2026-06-30");
    expect(ledger.every((l) => Math.abs(l.balance) < 0.005)).toBe(true);
    expect(sysBal(ledger, "AR")).toBe(0);
    // Items and deposits removed, staging unlinked but kept (immutable), banks display-only, lock lifted, master data kept with identity.
    const after = await counts();
    expect(after).toEqual({ ...before, je: before.je + 1, inv: 0, bil: 0, pay: 0, locks: before.locks - 1, banks: 0 });
    expect((await pool.query(`SELECT count(*)::int n FROM migration_open_items WHERE batch_id = $1 AND resolved_invoice_id IS NULL AND resolved_bill_id IS NULL`, [committedId])).rows[0].n).toBe(5);
    expect((await pool.query(`SELECT count(*)::int n FROM migration_open_items WHERE batch_id = $1`, [committedId])).rows[0].n).toBe(5);
    await expect(pool.query(`UPDATE migration_open_items SET outstanding_amount = 1 WHERE batch_id = $1`, [committedId])).rejects.toThrow(/staging rows are immutable/);
    expect((await pool.query(`SELECT opening_balance::numeric AS ob, opening_journal_entry_id FROM bank_accounts WHERE id = $1`, [bank1])).rows[0]).toEqual({ ob: "50000.00", opening_journal_entry_id: null });
    expect((await inTenant(() => bankAccountsService.update(bank1, { openingBalance: 0 }))).openingBalance).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM customers WHERE organization_id = $1 AND source_system = 'PreviousERP' AND source_id IN ('C1','C2','C3')`, [orgId])).rows[0].n).toBe(3);
    const batchRow = (await pool.query(`SELECT status, reversal_reason, reversed_by, period_lock_id FROM migration_batches WHERE id = $1`, [committedId])).rows[0];
    expect(batchRow).toMatchObject({ status: "reversed", reversed_by: userId, period_lock_id: null });
    expect(batchRow.reversal_reason).toMatch(/Beta's balance was 15,000/);
    // Reversing twice is idempotent; committing a reversed batch is refused.
    expect((await inTenant(() => migrationCommitService.reverse(committedId, { reason: "again, idempotent" }, userId))).status).toBe("reversed");
    await expectRefusal(inTenant(() => migrationCommitService.commit(committedId, userId)), 409, "migration_batch_reversed");

    // ── THE CORRECTED RE-RUN: same source ids, corrected figures, resolved to the SAME records. ──
    const b2 = await create();
    const corrected: NonNullable<Chart> = CHART.map((r) => r.sourceCode === "1200" ? { ...r, openingDebit: 29500 } : r.sourceCode === "4100" ? { ...r, openingCredit: 35000 } : r);
    const created = Object.fromEntries((await pool.query(`SELECT account_code, id FROM categories WHERE organization_id = $1 AND account_code IS NOT NULL`, [orgId])).rows.map((r) => [r.account_code, r.id])) as Record<string, number>;
    // `create` for a code that already exists is refused — the code IS that account.
    await inTenant(() => migrationService.importChart(b2.id, { rows: corrected }, userId));
    const row1400 = (await inTenant(() => migrationService.getChart(b2.id))).rows.find((r) => r.sourceCode === "1400")!;
    await expectRefusal(inTenant(() => migrationService.decideChartRow(b2.id, row1400.id, { decision: "create" }, userId)), 422, "mapping_target_refused", /already exists as Prepaid expenses/);
    await stageAll(b2.id, { chart: corrected, items: ITEMS.map((i) => i.sourceId === "BAL-C2" ? { ...i, originalAmount: 15000, outstandingAmount: 15000 } : i), mergeInto: created, decideParties: false });
    // Parties resolved by SOURCE ID before anyone decides: use_existing, pre-decided, no likely-duplicate question.
    const parties = await inTenant(() => migrationStagingService.getParties(b2.id));
    expect(parties.rows.map((p) => [p.sourceId, p.decision, p.existingId != null, p.candidates.map((c) => c.reason)])).toEqual([
      ["C1", "use_existing", true, ["source_id"]], ["C2", "use_existing", true, ["source_id"]], ["C3", "use_existing", true, ["source_id"]], ["V1", "use_existing", true, ["source_id"]], ["V2", "use_existing", true, ["source_id"]],
    ]);
    expect(parties.summary.undecided).toBe(0);
    const v2 = await inTenant(() => migrationValidationService.validate(b2.id, userId));
    expect(v2.checks.filter((c) => c.status === "fail").map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
    expect(check(v2, "AR_CONTROL")).toMatchObject({ status: "pass", expected: 29500, actual: 29500 });
    const beforeRerun = await counts();
    const out2 = await inTenant(() => migrationCommitService.commit(b2.id, userId));
    expect(out2.status).toBe("committed");
    const rec2 = out2.reconciliation as { checks: { id: string; status: string; detail: string }[]; figures: Record<string, number> };
    for (const c of rec2.checks) expect(c.status, `${c.id}: ${c.detail}`).toBe("pass");
    expect(rec2.figures).toMatchObject({ ar: 29500, ytdIncome: 35000, ytdResult: 1500, journalDebit: 137500 });
    // No duplicate master data, no duplicate accounts; the original numbers are back; the same Beta record now shows 15,000.
    const afterRerun = await counts();
    expect(afterRerun).toEqual({ ...beforeRerun, je: beforeRerun.je + 1, inv: 3, bil: 2, pay: 2, locks: beforeRerun.locks + 1, banks: 2 });
    expect(afterRerun.cus).toBe(beforeRerun.cus);
    expect(afterRerun.ven).toBe(beforeRerun.ven);
    expect(afterRerun.cat).toBe(beforeRerun.cat);
    const betaId = (await pool.query(`SELECT id FROM customers WHERE organization_id = $1 AND source_id = 'C2'`, [orgId])).rows[0].id;
    expect((await inTenant(() => customerStatementService.statement(betaId, {}))).current.receivable).toBe(15000);
    expect((await pool.query(`SELECT count(*)::int n FROM migration_batches WHERE company_id = $1 AND status = 'committed'`, [companyId])).rows[0].n).toBe(1);
    committedId = b2.id;
  });

  it("🔴 12/13 (A5) — an opening position that does not balance is REFUSED, by validation AND by the commit boundary; a former declaration is not a path; classified into named accounts it commits with every line on a named account; R6 is BLOCKING and sees a planted unnamed line; clear-obe and opening_clearing do not exist", async () => {
    // Company 1 holds the corrected migration; this case runs in company 2 (its earlier batches are reversed).
    const b = await create("2026-07-01", inCompany2);
    // Spreadsheet books: bank 900, debtors 100, and NOTHING on the equity side — Dr 1,000, Cr 0.
    const spreadsheet = [
      { sourceCode: "1100", sourceName: "Co2 bank", sourceType: "asset" as const, openingDebit: 900, sourceRole: "bank", evidenceNote: "stmt" },
      { sourceCode: "1200", sourceName: "Debtors", sourceType: "asset" as const, openingDebit: 100, sourceRole: "receivable" },
    ];
    await mapChart(b.id, spreadsheet, { banks: [bankC2, bankC2], run: inCompany2 });
    await inCompany2(() => migrationStagingService.importParties(b.id, { rows: [{ partyType: "customer", sourceId: "C9", name: "Residual customer" }] }, userId));
    await inCompany2(() => migrationStagingService.importOpenItems(b.id, { rows: [{ itemType: "ar", sourceId: "S9", partySourceId: "C9", documentNumber: "INV-R1", issueDate: "2026-06-01", dueDate: "2026-06-30", originalAmount: 100, outstandingAmount: 100 }] }, userId));

    // 1. Unbalanced → validation FAILS, names the amount and side, tells the operator to classify — and never offers a declaration.
    const unbalanced = await inCompany2(() => migrationValidationService.validate(b.id, userId));
    expect(unbalanced.ok).toBe(false);
    expect(unbalanced.status).toBe("draft");
    expect(check(unbalanced, "CHART_BALANCED")).toMatchObject({ status: "fail", expected: 1000, actual: 0 });
    expect(check(unbalanced, "CHART_BALANCED").detail).toMatch(/1000\.00 on the debit side is unexplained.*blocked until the difference is classified.*nothing is classified for you/i);
    expect(check(unbalanced, "CHART_BALANCED").detail).not.toMatch(/declar|opening balance equity|OBE/i);
    expect((await inCompany2(() => migrationValidationService.getOpeningPosition(b.id))).totals.difference).toBe(-1000);
    await expectRefusal(inCompany2(() => migrationCommitService.commit(b.id, userId)), 409, "migration_not_validated");

    // 2. The former declaration is NOT a path: a caller that still sends it changes nothing — the batch stays unbalanced and refused.
    await inCompany2(() => migrationService.updateBatch(b.id, { obeResidualReason: "The books were kept in a spreadsheet with no capital figure; the 1,000.00 net assets are the owner's equity." } as never, userId));
    expect((await pool.query(`SELECT to_jsonb(m) ? 'obe_residual_reason' AS has FROM migration_batches m WHERE id = $1`, [b.id])).rows[0].has).toBe(false); // the column is gone
    expect((await inCompany2(() => migrationValidationService.validate(b.id, userId))).ok).toBe(false);

    // 3. The COMMIT boundary refuses on its own, even when validation is bypassed by a raw write (a planted "validated" state with the true hash).
    const content = await inCompany2(() => readStagedContent(b as never));
    const batchRow = (await inCompany2(() => migrationService.requireBatch(b.id)));
    const hash = contentHashOf(await inCompany2(() => readStagedContent(batchRow)));
    await pool.query(`UPDATE migration_batches SET status = 'validated', content_hash = $2, validated_at = now() WHERE id = $1`, [b.id, hash]);
    const openingJournals = async () => (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE company_id = $1 AND source = 'opening'`, [company2Id])).rows[0].n as number;
    const journalsBefore = await openingJournals();
    await expectRefusal(inCompany2(() => migrationCommitService.commit(b.id, userId)), 409, "migration_unbalanced", /1000\.00 on the debit side is unexplained.*Classify the difference into named accounts/);
    expect(await openingJournals()).toBe(journalsBefore); // nothing posted
    expect((await pool.query(`SELECT status FROM migration_batches WHERE id = $1`, [b.id])).rows[0].status).toBe("validated"); // the planted state is still there — the refusal was the commit's own
    void content;

    // 4. Classified: the operator adds the row that carries the difference — the owner's capital, a CREATED equity account — and it commits on named accounts only.
    const classified = [...spreadsheet, { sourceCode: "3000", sourceName: "Owner's capital", sourceType: "equity" as const, openingCredit: 1000, evidenceNote: "owner's statement of capital contributed" }];
    await mapChart(b.id, classified, { banks: [bankC2, bankC2], run: inCompany2 });
    const cap = (await inCompany2(() => migrationService.getChart(b.id))).rows.find((r) => r.sourceCode === "3000")!;
    await inCompany2(() => migrationService.decideChartRow(b.id, cap.id, { decision: "create" }, userId));
    await inCompany2(() => migrationStagingService.importParties(b.id, { rows: [{ partyType: "customer", sourceId: "C9", name: "Residual customer" }] }, userId));
    await inCompany2(() => migrationStagingService.importOpenItems(b.id, { rows: [{ itemType: "ar", sourceId: "S9", partySourceId: "C9", documentNumber: "INV-R1", issueDate: "2026-06-01", dueDate: "2026-06-30", originalAmount: 100, outstandingAmount: 100 }] }, userId));
    const balanced = await inCompany2(() => migrationValidationService.validate(b.id, userId));
    expect(balanced.ok, balanced.checks.filter((c) => c.status === "fail").map((c) => `${c.id}: ${c.detail}`).join(" | ")).toBe(true);
    expect(check(balanced, "CHART_BALANCED")).toMatchObject({ status: "pass", expected: 1000, actual: 1000 });
    expect((await inCompany2(() => migrationValidationService.getOpeningPosition(b.id))).totals.difference).toBe(0);
    const out = await inCompany2(() => migrationCommitService.commit(b.id, userId));
    expect(out.status).toBe("committed");
    const rec = out.reconciliation as { checks: { id: string; status: string; detail: string; expected: unknown; actual: unknown }[]; figures: Record<string, number> };
    for (const c of rec.checks) expect(c.status, `${c.id}: ${c.detail}`).toBe("pass");
    expect(check(rec, "R6")).toMatchObject({ status: "pass", expected: 0, actual: 0 });
    expect(check(rec, "R6").detail).toMatch(/3 line\(s\), all on named accounts; Dr 1000\.00 = Cr 1000\.00/);
    expect(rec.figures).toMatchObject({ assets: 1000, liabilities: 0, equity: 1000 });
    expect(rec.figures).not.toHaveProperty("openingBalanceEquity");
    const capLine = (await pool.query(`SELECT c.account_code, c.type, l.credit_amount::numeric AS cr FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = $1 AND c.account_code = '3000'`, [out.openingJournalEntryId])).rows;
    expect(capLine).toEqual([{ account_code: "3000", type: "equity", cr: "1000.00" }]);
    expect(sysBal(await ledgerAt("2026-06-30", inCompany2), "RETAINED_EARNINGS")).toBe(0); // NOT forced into retained earnings — the operator named capital

    // 5. R6 is BLOCKING and sees an unnamed line: plant a balanced pair on SUSPENSE (an account the staged content never named) and re-run the gates.
    const suspense = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'SUSPENSE'`, [orgId])).rows[0].id;
    const planted = await pool.query(
      `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount) VALUES ($1,$2,$3,$4,'planted',5,0), ($1,$2,$3,$4,'planted',0,5) RETURNING id`,
      [orgId, company2Id, out.openingJournalEntryId, suspense],
    );
    const b2row = await inCompany2(() => migrationService.requireBatch(b.id));
    const content2 = await inCompany2(() => readStagedContent(b2row));
    const position2 = await inCompany2(() => computeOpeningPosition(b2row, content2));
    const replay = await inCompany2(() => migrationCommitService.reconcile(b2row, content2, position2, out.openingJournalEntryId!, { invoiceIds: [], billIds: [], paymentIds: [], customersCreated: 0, vendorsCreated: 0, accountsCreated: 0 }));
    expect(check(replay, "R6")).toMatchObject({ status: "fail", actual: 2 });
    expect(check(replay, "R6").detail).toMatch(/planted.*not an account the staged content named/);
    expect(check(replay, "R5").status).toBe("pass"); // the pair balances — only R6 sees that it is on the wrong account, which is the point of R6
    await pool.query(`DELETE FROM journal_entry_lines WHERE id = ANY($1::int[])`, [planted.rows.map((r) => r.id)]);
    expect(check(await inCompany2(async () => migrationCommitService.reconcile(b2row, content2, position2, out.openingJournalEntryId!, { invoiceIds: [], billIds: [], paymentIds: [], customersCreated: 0, vendorsCreated: 0, accountsCreated: 0 })), "R6").status).toBe("pass");

    // 6/7. No clearing exists — not as a method, not as a journal source, not as a row anywhere.
    expect((migrationCommitService as Record<string, unknown>).clearObe).toBeUndefined();
    await expect(inCompany2(() => postJournalEntry({ entryNumber: "B1C-CLR-X", date: "2026-07-01", description: "no such thing", source: "opening_clearing" as never, lines: [
      { systemCode: "SUSPENSE", accountName: "Suspense", debitAmount: 1, creditAmount: 0 },
      { systemCode: "RETAINED_EARNINGS", accountName: "Retained earnings", debitAmount: 0, creditAmount: 1 },
    ] }))).rejects.toSatisfy((e: unknown) => /journal_entries_source_chk/.test(String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message)));
    expect((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE source = 'opening_clearing'`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM categories WHERE system_code = 'OPENING_BALANCE_EQUITY'`)).rows[0].n).toBe(0);
    expect((await inCompany2(() => migrationCommitService.reversalPreview(b.id))).blockers).toEqual([]);
    const rev = await inCompany2(() => migrationCommitService.reverse(b.id, { reason: "classified-position fixture teardown" }, userId));
    expect(rev.status).toBe("reversed");
    expect(sysBal(await ledgerAt("2026-06-30", inCompany2), "RETAINED_EARNINGS")).toBe(0);
  });

  it("the ledger must be EMPTY before the opening date: a company with history cannot receive an opening position on top of it — a reversed migration's own netted pair is not history", async () => {
    // Company 2 carries reversed migrations (opening + mirror, netting to zero): not history.
    const b = await create("2026-07-01", inCompany2);
    await mapChart(b.id, [{ sourceCode: "1100", sourceName: "Co2 bank", sourceType: "asset", openingDebit: 0, sourceRole: "bank", evidenceNote: "stmt" }], { banks: [bankC2, bankC2], run: inCompany2 });
    expect(check(await inCompany2(() => migrationValidationService.validate(b.id, userId)), "LEDGER_EMPTY").status).toBe("pass");
    // An ORDINARY entry before the opening date is history.
    const prior = await inCompany2(() => postJournalEntry({ entryNumber: "H-1", date: "2026-06-15", description: "history", lines: [{ systemCode: "SUSPENSE", accountName: "Suspense", debitAmount: 7, creditAmount: 0 }, { systemCode: "SALES", accountName: "Sales", debitAmount: 0, creditAmount: 7 }] }));
    const v = await inCompany2(() => migrationValidationService.validate(b.id, userId));
    expect(check(v, "LEDGER_EMPTY")).toMatchObject({ status: "fail", actual: 2 });
    expect(check(v, "LEDGER_EMPTY").detail).toMatch(/2 line\(s\) \(Dr 7\.00 \/ Cr 7\.00\) already sit on or before 2026-06-30 — this company has history in Saudi Ledger/);
    await pool.query(`DELETE FROM journal_entries WHERE id = $1`, [prior.id]);
    await inCompany2(() => migrationService.discardBatch(b.id, userId));
  });
});
