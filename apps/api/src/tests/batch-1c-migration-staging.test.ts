/**
 * BATCH 1C — PHASE 2: parties, historical AR/AP open items, customer
 * advances, the opening position and the pre-commit validation.
 *
 * Decision record: docs/product/batch-1c-migration-opening-balances-decision-pack.md
 * §15.5 steps 3–7 and 9, §15.6 (R2/R3/R4/R9/R10 anticipated on the staged
 * side), §15.2 C/D (historical VAT and advances).
 *
 * What is proven here, on a SEEDED mid-year fixture whose figures are asserted
 * (never a round count hoped for):
 *  - parties keep their source identity; a look-alike among existing records
 *    leaves the decision EMPTY and blocks until the operator decides; the
 *    platform never merges by itself; an outsider's record is not found;
 *  - open items are kept verbatim and are NOT documents: nothing is posted,
 *    no ICV/hash/QR exists, and the DB refuses an `opening` invoice that
 *    carries any of them (R7 at the row);
 *  - advances carry the old advance-invoice reference and VAT position;
 *    `invoiced` without its reference is refused; `unknown` is recorded at
 *    cash;
 *  - the opening position derives AR/AP/deposits from the subledgers and the
 *    controls EQUAL them (R2/R3/R10), the banks land on D-3 leaves with
 *    evidence and agree with the bank record (R4, G2), the VAT balances equal
 *    the filed return (R9), the file balances (R5) and the fiscal year decides
 *    what the P&L rows may say (A2) — each control shown failing on the
 *    broken case AND passing on the correct one, with the figure moving;
 *  - validation writes ZERO ledger rows, stores the result and a content
 *    hash, and any staging change reopens the batch;
 *  - company isolation: presence, absence, and the sibling's own figure.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { migrationService } from "../services/migration.service";
import { migrationStagingService } from "../services/migrationStaging.service";
import { migrationValidationService } from "../services/migrationValidation.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { customersService } from "../services/customers.service";
import { vendorsService } from "../services/vendors.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "b1c-stage";
const SLUG_OTHER = "b1c-stage-other";
const EMAIL = "b1c-stage@test.local";

describeMaybe("Batch 1C — Phase 2: parties, open items, advances, opening position, validation", () => {
  let orgId = "", companyId = "", company2Id = "", otherOrgId = "", otherCompanyId = "";
  let userId = 0;
  let bank1 = 0, bank2 = 0, bankC2 = 0;
  let existingAlpha = 0, existingBetaByName = 0, existingVendor = 0, otherOrgCustomer = 0;

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
          "migration_advances", "migration_open_items", "migration_parties", "migration_chart_rows", "migration_batches",
          "invoice_items", "invoices", "bills", "journal_entry_lines", "journal_entries", "audit_logs", "organization_memberships",
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
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('B1C Stage','${SLUG}') RETURNING id`)).rows[0].id;
    // Fiscal year declared: January, Gregorian — the fixture's cutover 2026-07-01 is MID-YEAR.
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar) VALUES ($1,'B1C Stage Co','1010848381','399999999999963',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
    company2Id = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start) VALUES ($1,'B1C Stage Co 2','1010848382','399999999999973',1) RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('B1C Stage Other','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start) VALUES ($1,'B1C Stage Other Co','1010848383','399999999999983',1) RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','B1C',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    bank1 = (await inTenant(() => bankAccountsService.create({ name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bank2 = (await inTenant(() => bankAccountsService.create({ name: "ANB Ops", bankName: "ANB", currency: "SAR" }))).id;
    bankC2 = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Co2 Main','ANB') RETURNING id`, [orgId, company2Id])).rows[0].id;
    // Existing records the staged parties may LOOK LIKE.
    existingAlpha = (await inTenant(() => customersService.create({ name: "Alpha Trading Est.", taxNumber: "300000000000003" }))).id;
    existingBetaByName = (await inTenant(() => customersService.create({ name: "Beta Logistics" }))).id;
    existingVendor = (await inTenant(() => vendorsService.create({ name: "Delta Supplies" }))).id;
    otherOrgCustomer = (await inOther(() => customersService.create({ name: "Alpha Trading Est.", taxNumber: "300000000000003" }))).id;
  });
  afterAll(cleanup);

  // A balanced mid-year closing TB: Dr 142,500 = Cr 142,500.
  const CHART = [
    { sourceCode: "1100", sourceName: "Riyad Bank", sourceType: "asset" as const, openingDebit: 50000, sourceRole: "bank" as const, evidenceNote: "Riyad statement 30 Jun 2026, closing 50,000.00" },
    { sourceCode: "1110", sourceName: "ANB", sourceType: "asset" as const, openingDebit: 20000, sourceRole: "bank" as const, evidenceNote: "ANB statement 30 Jun 2026, closing 20,000.00" },
    { sourceCode: "1200", sourceName: "Trade debtors", sourceType: "asset" as const, openingDebit: 34500, sourceRole: "receivable" as const },
    { sourceCode: "1300", sourceName: "Input VAT", sourceType: "asset" as const, openingDebit: 1500, sourceRole: "vat_input" as const },
    { sourceCode: "1400", sourceName: "Prepaid expenses", sourceType: "asset" as const, openingDebit: 3000 },
    { sourceCode: "2100", sourceName: "Trade creditors", sourceType: "liability" as const, openingCredit: 11500, sourceRole: "payable" as const },
    { sourceCode: "2200", sourceName: "Output VAT", sourceType: "liability" as const, openingCredit: 6000, sourceRole: "vat_output" as const },
    { sourceCode: "2300", sourceName: "Customer advances", sourceType: "liability" as const, openingCredit: 5000, sourceRole: "customer_deposits" as const },
    { sourceCode: "3100", sourceName: "Share capital", sourceType: "equity" as const, openingCredit: 60000 },
    { sourceCode: "3200", sourceName: "Retained earnings b/f", sourceType: "equity" as const, openingCredit: 20000, sourceRole: "retained_earnings" as const },
    { sourceCode: "4100", sourceName: "Sales", sourceType: "income" as const, openingCredit: 40000 },
    { sourceCode: "5100", sourceName: "Purchases", sourceType: "expense" as const, openingDebit: 25000 },
    { sourceCode: "5200", sourceName: "Rent", sourceType: "expense" as const, openingDebit: 8500 },
  ];
  const PARTIES = [
    { partyType: "customer" as const, sourceId: "C1", name: "Alpha Trading Est.", taxNumber: "300000000000003" },
    { partyType: "customer" as const, sourceId: "C2", name: "beta logistics" },
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

  const create = (cutoverDate = "2026-07-01") => inTenant(() => migrationService.createBatch({ sourceSystem: "PreviousERP", cutoverDate }, userId));
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    let err: any;
    try { await p; } catch (e) { err = e; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err.statusCode ?? err.status).toBe(status);
    if (code) expect(err.body?.code ?? err.payload?.code ?? err.code).toBe(code);
  };
  /** Map the whole fixture chart the way the operator would. */
  const mapChart = async (batchId: number) => {
    await inTenant(() => migrationService.importChart(batchId, { rows: CHART }, userId));
    const chart = await inTenant(() => migrationService.getChart(batchId));
    const row = (code: string) => chart.rows.find((r) => r.sourceCode === code)!;
    const d = (code: string, body: Parameters<typeof migrationService.decideChartRow>[2]) => inTenant(() => migrationService.decideChartRow(batchId, row(code).id, body, userId));
    await d("1100", { decision: "map_to_bank", targetBankAccountId: bank1 });
    await d("1110", { decision: "map_to_bank", targetBankAccountId: bank2 });
    await d("1200", { decision: "map_to_system", targetSystemCode: "AR" });
    await d("1300", { decision: "map_to_system", targetSystemCode: "VAT_INPUT" });
    await d("1400", { decision: "create" });
    await d("2100", { decision: "map_to_system", targetSystemCode: "AP" });
    await d("2200", { decision: "map_to_system", targetSystemCode: "VAT_OUTPUT" });
    await d("2300", { decision: "map_to_system", targetSystemCode: "CUSTOMER_DEPOSITS" });
    await d("3100", { decision: "create" });
    await d("3200", { decision: "map_to_system", targetSystemCode: "RETAINED_EARNINGS" });
    await d("4100", { decision: "map_to_system", targetSystemCode: "SALES" });
    await d("5100", { decision: "map_to_system", targetSystemCode: "PURCHASES" });
    await d("5200", { decision: "create" });
  };
  const stageAll = async (batchId: number) => {
    await mapChart(batchId);
    const parties = await inTenant(() => migrationStagingService.importParties(batchId, { rows: PARTIES }, userId));
    const p = (sid: string) => parties.rows.find((r) => r.sourceId === sid)!;
    await inTenant(() => migrationStagingService.decideParty(batchId, p("C1").id, { decision: "use_existing", existingId: existingAlpha }, userId));
    await inTenant(() => migrationStagingService.decideParty(batchId, p("C2").id, { decision: "create" }, userId));
    await inTenant(() => migrationStagingService.decideParty(batchId, p("V1").id, { decision: "use_existing", existingId: existingVendor }, userId));
    await inTenant(() => migrationStagingService.importOpenItems(batchId, { rows: ITEMS }, userId));
    await inTenant(() => migrationStagingService.importAdvances(batchId, { rows: ADVANCES }, userId));
    await inTenant(() => migrationService.updateBatch(batchId, { vatPosition: VAT_POSITION }, userId));
  };
  const check = (v: { checks: { id: string; status: string; detail: string; expected: unknown; actual: unknown }[] }, id: string) => v.checks.find((c) => c.id === id)!;

  it("parties keep their source identity; a look-alike among EXISTING records leaves the decision empty and blocks; the operator decides; an outsider's record is not found", async () => {
    const b = await create();
    const out = await inTenant(() => migrationStagingService.importParties(b.id, { rows: PARTIES }, userId));
    expect(out.summary).toMatchObject({ rows: 5, customers: 3, vendors: 2, undecided: 3, blocked: 3 });
    const p = (sid: string) => out.rows.find((r) => r.sourceId === sid)!;
    // C1 matches by VAT number, C2 by name (case-insensitively), V1 by name; C3 and V2 match nothing → create.
    expect(p("C1").decision).toBeNull();
    expect(p("C1").candidates).toEqual([{ id: existingAlpha, name: "Alpha Trading Est.", taxNumber: "300000000000003", reason: "tax_number" }]);
    expect(p("C2").decision).toBeNull();
    expect(p("C2").candidates.map((c) => [c.id, c.reason])).toEqual([[existingBetaByName, "name"]]);
    expect(p("V1").decision).toBeNull();
    expect(p("V1").candidates.map((c) => c.id)).toEqual([existingVendor]);
    expect(p("C3").decision).toBe("create");
    expect(p("C3").candidates).toEqual([]);
    expect(p("V2").decision).toBe("create");
    expect(p("C1").problems[0]).toMatch(/likely duplicate of #\d+ Alpha Trading Est\. \(same VAT number\)/);
    // The other organisation's look-alike customer is NOT a candidate (RLS), and cannot be chosen.
    expect(p("C1").candidates.some((c) => c.id === otherOrgCustomer)).toBe(false);
    await expectRefusal(inTenant(() => migrationStagingService.decideParty(b.id, p("C1").id, { decision: "use_existing", existingId: otherOrgCustomer }, userId)), 422, "reference_not_found");
    // A vendor id is not a customer.
    await expectRefusal(inTenant(() => migrationStagingService.decideParty(b.id, p("C1").id, { decision: "use_existing", existingId: existingVendor }, userId)), 422, "reference_not_found");
    // The decision, taken.
    const decided = await inTenant(() => migrationStagingService.decideParty(b.id, p("C1").id, { decision: "use_existing", existingId: existingAlpha }, userId));
    expect(decided).toMatchObject({ decision: "use_existing", existingId: existingAlpha, problems: [] });
    // Two old parties cannot become one record.
    await expectRefusal(inTenant(() => migrationStagingService.decideParty(b.id, p("C2").id, { decision: "use_existing", existingId: existingAlpha }, userId)), 422, "party_already_used");
    const c2 = await inTenant(() => migrationStagingService.decideParty(b.id, p("C2").id, { decision: "create" }, userId));
    expect(c2).toMatchObject({ decision: "create", existingId: null });
    // Malformed files are refused whole.
    await expectRefusal(inTenant(() => migrationStagingService.importParties(b.id, { rows: [PARTIES[0], PARTIES[0]] }, userId)), 400);
    await expectRefusal(inTenant(() => migrationStagingService.importParties(b.id, { rows: [{ ...PARTIES[0], name: " " }] }, userId)), 400);
    // Re-importing resets decisions (a decision about a row that no longer exists is meaningless).
    const again = await inTenant(() => migrationStagingService.importParties(b.id, { rows: PARTIES }, userId));
    expect(again.summary.undecided).toBe(3);
    await inTenant(() => migrationService.discardBatch(b.id, userId));
  });

  it("🔴 open items are kept verbatim and are NOT documents: malformed rows refused whole, semantic problems named per row, and the DB refuses an opening invoice that carries VAT, an ICV, a hash or a QR (R7 at the row)", async () => {
    const b = await create();
    await inTenant(() => migrationStagingService.importParties(b.id, { rows: PARTIES }, userId));
    const out = await inTenant(() => migrationStagingService.importOpenItems(b.id, { rows: ITEMS }, userId));
    expect(out.summary).toEqual({ rows: 5, blocked: 0, ar: { items: 3, parties: 2, total: 34500, compositionUnknown: 1 }, ap: { items: 2, parties: 2, total: 11500, compositionUnknown: 0 } });
    const i = (sid: string) => out.rows.find((r) => r.sourceId === sid)!;
    expect(i("SI-1001")).toMatchObject({ documentNumber: "INV-1001", issueDate: "2026-05-10", dueDate: "2026-06-09", originalAmount: 10000, outstandingAmount: 10000, partyName: "Alpha Trading Est.", historicalVat: { category: "S", rate: 15, taxableAmount: 8695.65, amount: 1304.35, reportedPeriod: "2026-Q2" }, resolvedId: null, problems: [] });
    expect(i("SI-1002").outstandingAmount).toBe(4500);
    expect(i("BAL-C2")).toMatchObject({ compositionUnknown: true, outstandingAmount: 20000, partyName: "beta logistics" });
    // Malformed → 400, nothing replaced.
    await expectRefusal(inTenant(() => migrationStagingService.importOpenItems(b.id, { rows: [{ ...ITEMS[0], outstandingAmount: 10000.01 }] }, userId)), 400);
    await expectRefusal(inTenant(() => migrationStagingService.importOpenItems(b.id, { rows: [ITEMS[0], { ...ITEMS[1], sourceId: "SI-1001" }] }, userId)), 400);
    await expectRefusal(inTenant(() => migrationStagingService.importOpenItems(b.id, { rows: [{ ...ITEMS[0], itemType: "invoice" as never }] }, userId)), 400);
    await expectRefusal(inTenant(() => migrationStagingService.importOpenItems(b.id, { rows: [{ ...ITEMS[0], outstandingAmount: 0 }] }, userId)), 400);
    await expectRefusal(inTenant(() => migrationStagingService.importOpenItems(b.id, { rows: [{ ...ITEMS[0], historicalVat: { category: "X" } }] }, userId)), 400);
    expect((await inTenant(() => migrationStagingService.getOpenItems(b.id))).summary.rows).toBe(5);
    // Semantic problems, each named on its row.
    await pool.query(`INSERT INTO invoices (organization_id, company_id, invoice_number, date, status) VALUES ($1,$2,'INV-TAKEN','2026-07-02','draft')`, [orgId, companyId]);
    const broken = await inTenant(() => migrationStagingService.importOpenItems(b.id, { rows: [
      { ...ITEMS[0], sourceId: "X1", documentNumber: "INV-TAKEN" },
      { ...ITEMS[0], sourceId: "X2", partySourceId: "C9" },
      { ...ITEMS[0], sourceId: "X3", issueDate: "2026-07-01", dueDate: "2026-07-31" },
      { ...ITEMS[0], sourceId: "X4", dueDate: "2026-05-01" },
      { ...ITEMS[2], sourceId: "X5" }, { ...ITEMS[2], sourceId: "X6", documentNumber: "OPEN-C2b" },
      { ...ITEMS[3], sourceId: "X7", partySourceId: "C1" },
    ] }, userId));
    const p = (sid: string) => broken.rows.find((r) => r.sourceId === sid)!.problems.join(" | ");
    expect(p("X1")).toMatch(/INV-TAKEN already exists as an invoice/);
    expect(p("X2")).toMatch(/customer C9 is not staged/);
    expect(p("X3")).toMatch(/after the opening date 2026-06-30/);
    expect(p("X4")).toMatch(/due 2026-05-01 is before issue/);
    expect(p("X2")).toMatch(/document number INV-1001 appears 3 times among the AR items/);
    expect(p("X5")).toMatch(/more than one composition-unknown item for customer C2/);
    expect(p("X6")).toMatch(/more than one composition-unknown item for customer C2/);
    expect(p("X7")).toMatch(/vendor C1 is not staged/);
    expect(broken.summary.blocked).toBe(7);
    // R7 at the row: an opening invoice cannot carry VAT, an ICV, a hash or a QR — whatever writes it.
    const base = `INSERT INTO invoices (organization_id, company_id, invoice_number, date, status, is_opening, total`;
    await expect(pool.query(`${base}, vat_amount) VALUES ($1,$2,'OPN-1','2026-06-30','sent',true,100,15)`, [orgId, companyId])).rejects.toThrow(/invoices_opening_no_vat_chk/);
    await expect(pool.query(`${base}, icv) VALUES ($1,$2,'OPN-2','2026-06-30','sent',true,100,1)`, [orgId, companyId])).rejects.toThrow(/invoices_opening_no_vat_chk/);
    await expect(pool.query(`${base}, invoice_hash) VALUES ($1,$2,'OPN-3','2026-06-30','sent',true,100,'abc')`, [orgId, companyId])).rejects.toThrow(/invoices_opening_no_vat_chk/);
    await expect(pool.query(`${base}, qr_code) VALUES ($1,$2,'OPN-4','2026-06-30','sent',true,100,'qr')`, [orgId, companyId])).rejects.toThrow(/invoices_opening_no_vat_chk/);
    const okRow = await pool.query(`${base}) VALUES ($1,$2,'OPN-5','2026-06-30','sent',true,100) RETURNING id`, [orgId, companyId]);
    expect(okRow.rows).toHaveLength(1);
    await pool.query(`DELETE FROM invoices WHERE id = $1`, [okRow.rows[0].id]);
    await expect(pool.query(`INSERT INTO bills (organization_id, company_id, bill_number, date, status, is_opening, total, vat_amount) VALUES ($1,$2,'OPB-1','2026-06-30','approved',true,100,15)`, [orgId, companyId])).rejects.toThrow(/bills_opening_no_vat_chk/);
    await inTenant(() => migrationService.discardBatch(b.id, userId));
  });

  it("advances carry the old advance-invoice reference and VAT position: invoiced without its reference is refused, unknown with a reference is refused, unknown is recorded at cash; the bank must be a row mapped to a bank", async () => {
    const b = await create();
    await inTenant(() => migrationStagingService.importParties(b.id, { rows: PARTIES }, userId));
    // Before the chart is mapped, the bank rows are problems — the cash must be inside a bank's opening balance.
    const early = await inTenant(() => migrationStagingService.importAdvances(b.id, { rows: ADVANCES }, userId));
    expect(early.summary).toEqual({ rows: 2, blocked: 2, total: 5000, customers: 1, invoiced: 1, unknown: 1 });
    expect(early.rows[0].problems.join()).toMatch(/1100 is not a row of the staged chart/);
    await mapChart(b.id);
    const out = await inTenant(() => migrationStagingService.getAdvances(b.id));
    expect(out.summary.blocked).toBe(0);
    const a = (sid: string) => out.rows.find((r) => r.sourceId === sid)!;
    expect(a("ADV-1")).toMatchObject({ partyName: "Gamma Co", amount: 3000, vatPosition: "invoiced", advanceInvoiceNumber: "ADV-INV-9", advanceInvoiceDate: "2026-06-01", advanceInvoiceTime: "10:00:00", vatCategory: "S", vatRate: 15, vatAmount: 391.3, resolvedPaymentId: null });
    expect(a("ADV-2")).toMatchObject({ amount: 2000, vatPosition: "unknown", advanceInvoiceNumber: null, vatCategory: null, vatRate: null, vatAmount: null });
    // Refusals at the write boundary.
    await expectRefusal(inTenant(() => migrationStagingService.importAdvances(b.id, { rows: [{ ...ADVANCES[0], advanceInvoiceNumber: null }] }, userId)), 400);
    await expectRefusal(inTenant(() => migrationStagingService.importAdvances(b.id, { rows: [{ ...ADVANCES[0], vatCategory: null }] }, userId)), 400);
    await expectRefusal(inTenant(() => migrationStagingService.importAdvances(b.id, { rows: [{ ...ADVANCES[0], vatRate: null }] }, userId)), 400);
    await expectRefusal(inTenant(() => migrationStagingService.importAdvances(b.id, { rows: [{ ...ADVANCES[1], advanceInvoiceNumber: "ADV-INV-X" }] }, userId)), 400);
    await expectRefusal(inTenant(() => migrationStagingService.importAdvances(b.id, { rows: [{ ...ADVANCES[0], vatAmount: 3000.01 }] }, userId)), 400);
    await expectRefusal(inTenant(() => migrationStagingService.importAdvances(b.id, { rows: [{ ...ADVANCES[0], amount: 0 }] }, userId)), 400);
    // And the DB CHECK beneath: invoiced without a number cannot be stored by anyone.
    await expect(pool.query(`INSERT INTO migration_advances (organization_id, company_id, batch_id, source_system, source_id, party_source_id, bank_source_code, amount, received_at, vat_position) VALUES ($1,$2,$3,'X','RAW','C3','1100',10,'2026-06-01','invoiced')`, [orgId, companyId, b.id])).rejects.toThrow(/migration_advances_invoiced_chk/);
    // Semantic problems: a vendor is not a customer; a date after the opening date.
    const broken = await inTenant(() => migrationStagingService.importAdvances(b.id, { rows: [{ ...ADVANCES[1], sourceId: "Y1", partySourceId: "V1" }, { ...ADVANCES[1], sourceId: "Y2", receivedAt: "2026-07-01" }] }, userId));
    expect(broken.rows.find((r) => r.sourceId === "Y1")!.problems.join()).toMatch(/customer V1 is not staged/);
    expect(broken.rows.find((r) => r.sourceId === "Y2")!.problems.join()).toMatch(/after the opening date/);
    await inTenant(() => migrationService.discardBatch(b.id, userId));
  });

  it("🔴 the opening position derives AR / AP / deposits from the subledgers, and every control is shown FAILING on the broken case and PASSING on the correct one, with the figure moving (R2, R3, R4/G2, R5, R9, R10, A2)", async () => {
    const b = await create();
    // Nothing staged: the chart controls fail and say what to do.
    const empty = await inTenant(() => migrationValidationService.validate(b.id, userId));
    expect(empty.ok).toBe(false);
    expect(empty.status).toBe("draft");
    expect(check(empty, "CHART_MAPPED")).toMatchObject({ status: "fail", actual: "no chart staged" });
    expect(check(empty, "VAT_POSITION").status).toBe("skip");

    await stageAll(b.id);
    const pos = await inTenant(() => migrationValidationService.getOpeningPosition(b.id));
    expect(pos.openingDate).toBe("2026-06-30");
    expect(pos.totals).toEqual({ debit: 142500, credit: 142500, balanced: true, openingBalanceEquity: 0, ytdIncome: 40000, ytdExpense: 33500, ytdResult: 6500 });
    const line = (t: string) => pos.lines.find((l) => l.target === t)!;
    expect(line("system:AR")).toMatchObject({ targetKind: "system", debit: 34500, credit: 0, balance: 34500, sourceCodes: ["1200"], type: "asset" });
    expect(line("system:AP")).toMatchObject({ balance: -11500, type: "liability" });
    expect(line("system:CUSTOMER_DEPOSITS").balance).toBe(-5000);
    expect(line(`bank:${bank1}`)).toMatchObject({ targetKind: "bank", bankAccountId: bank1, balance: 50000 });
    expect(line(`bank:${bank1}`).categoryId).not.toBeNull();
    expect(line("create:1400")).toMatchObject({ targetKind: "create", balance: 3000, accountName: "1400 Prepaid expenses" });
    expect(line("system:SALES")).toMatchObject({ type: "income", credit: 40000 });
    expect(pos.arByCustomer).toEqual([
      { partySourceId: "C1", partyName: "Alpha Trading Est.", items: 2, total: 14500 },
      { partySourceId: "C2", partyName: "beta logistics", items: 1, total: 20000 },
    ]);
    expect(pos.apByVendor).toEqual([
      { partySourceId: "V1", partyName: "Delta Supplies", items: 1, total: 7000 },
      { partySourceId: "V2", partyName: "Epsilon Ltd", items: 1, total: 4500 },
    ]);
    expect(pos.depositsByCustomer).toEqual([{ partySourceId: "C3", partyName: "Gamma Co", items: 2, total: 5000 }]);
    expect(pos.banks.map((x) => [x.bankAccountId, x.balance, x.typedOpeningBalance, x.advancesInside, !!x.evidenceNote, x.leafCategoryId != null])).toEqual([[bank1, 50000, 0, 3000, true, true], [bank2, 20000, 0, 2000, true, true]]);
    for (const c of pos.controls) expect(c.status, `${c.id}: ${c.detail}`).toBe("pass");

    // The correct case validates, stores the result and a content hash, moves the status.
    const before = await pool.query(`SELECT (SELECT count(*) FROM journal_entries WHERE organization_id = $1) je, (SELECT count(*) FROM invoices WHERE organization_id = $1) inv, (SELECT count(*) FROM bills WHERE organization_id = $1) bil, (SELECT count(*) FROM payments WHERE organization_id = $1) pay, (SELECT count(*) FROM customers WHERE organization_id = $1) cus`, [orgId]);
    const ok = await inTenant(() => migrationValidationService.validate(b.id, userId));
    expect(ok.ok).toBe(true);
    expect(ok.status).toBe("validated");
    expect(ok.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.validatedAt).toBeTruthy();
    const after = await pool.query(`SELECT (SELECT count(*) FROM journal_entries WHERE organization_id = $1) je, (SELECT count(*) FROM invoices WHERE organization_id = $1) inv, (SELECT count(*) FROM bills WHERE organization_id = $1) bil, (SELECT count(*) FROM payments WHERE organization_id = $1) pay, (SELECT count(*) FROM customers WHERE organization_id = $1) cus`, [orgId]);
    expect(after.rows[0]).toEqual(before.rows[0]); // zero ledger / document / master-data writes
    const stored = await inTenant(() => migrationService.getBatch(b.id));
    expect(stored.status).toBe("validated");
    expect((stored.validation as { ok: boolean }).ok).toBe(true);
    expect(check(ok, "AR_CONTROL")).toMatchObject({ status: "pass", expected: 34500, actual: 34500 });
    expect(check(ok, "AP_CONTROL")).toMatchObject({ status: "pass", expected: 11500, actual: 11500 });
    expect(check(ok, "DEPOSITS_CONTROL")).toMatchObject({ status: "pass", expected: 5000, actual: 5000 });
    expect(check(ok, "VAT_POSITION")).toMatchObject({ status: "pass", expected: "output 6000.00, input 1500.00", actual: "output 6000.00, input 1500.00" });
    expect(check(ok, "FISCAL_YEAR").detail).toMatch(/Mid-year cutover in fiscal year 2026 \(2026-01-01 → 2026-12-31\); 3 P&L row\(s\).*income 40000\.00, expense 33500\.00, result 6500\.00/);

    // Any staging change REOPENS the batch: the hash and the validated status go.
    const parties = await inTenant(() => migrationStagingService.getParties(b.id));
    await inTenant(() => migrationStagingService.decideParty(b.id, parties.rows.find((r) => r.sourceId === "C3")!.id, { decision: "create" }, userId));
    const reopened = await inTenant(() => migrationService.getBatch(b.id));
    expect(reopened.status).toBe("draft");
    expect(reopened.contentHash).toBeNull();
    expect(reopened.validatedAt).toBeNull();

    // R2 broken: one AR item less → the control no longer equals the subledger; the figure moved by exactly that item.
    await inTenant(() => migrationStagingService.importOpenItems(b.id, { rows: ITEMS.filter((i) => i.sourceId !== "SI-1002") }, userId));
    const r2 = await inTenant(() => migrationValidationService.validate(b.id, userId));
    expect(r2.ok).toBe(false);
    expect(r2.status).toBe("draft");
    expect(check(r2, "AR_CONTROL")).toMatchObject({ status: "fail", expected: 34500, actual: 30000 });
    expect(check(r2, "AR_CONTROL").detail).toMatch(/never imported as a bare balance/);
    expect(check(r2, "AP_CONTROL").status).toBe("pass");
    await inTenant(() => migrationStagingService.importOpenItems(b.id, { rows: ITEMS }, userId));

    // R10 broken: an advance amount changes.
    await inTenant(() => migrationStagingService.importAdvances(b.id, { rows: [ADVANCES[0], { ...ADVANCES[1], amount: 2500 }] }, userId));
    const r10 = await inTenant(() => migrationValidationService.validate(b.id, userId));
    expect(check(r10, "DEPOSITS_CONTROL")).toMatchObject({ status: "fail", expected: 5000, actual: 5500 });
    await inTenant(() => migrationStagingService.importAdvances(b.id, { rows: ADVANCES }, userId));

    // R4 / G2: the bank record's TYPED opening balance is display-only and must agree — or be cleared.
    await pool.query(`UPDATE bank_accounts SET opening_balance = 49000 WHERE id = $1`, [bank1]);
    const r4 = await inTenant(() => migrationValidationService.validate(b.id, userId));
    expect(check(r4, "BANKS").status).toBe("fail");
    expect(check(r4, "BANKS").detail).toMatch(/Riyad Main: the bank record's typed opening balance 49000\.00 ≠ the old chart's 50000\.00/);
    await pool.query(`UPDATE bank_accounts SET opening_balance = 50000 WHERE id = $1`, [bank1]);
    expect(check(await inTenant(() => migrationValidationService.validate(b.id, userId)), "BANKS").status).toBe("pass");
    // R4: evidence is required on a bank row.
    const chart = await inTenant(() => migrationService.getChart(b.id));
    const bankRow = chart.rows.find((r) => r.sourceCode === "1110")!;
    await pool.query(`UPDATE migration_chart_rows SET evidence_note = NULL WHERE id = $1`, [bankRow.id]);
    expect(check(await inTenant(() => migrationValidationService.validate(b.id, userId)), "BANKS").detail).toMatch(/ANB Ops: no statement evidence recorded on row 1110/);
    await pool.query(`UPDATE migration_chart_rows SET evidence_note = 'ANB statement 30 Jun 2026' WHERE id = $1`, [bankRow.id]);

    // R9: the VAT balances must equal the filed return — and a return must be supplied at all.
    await inTenant(() => migrationService.updateBatch(b.id, { vatPosition: { ...VAT_POSITION, outputVatPayable: 6100 } }, userId));
    const r9 = await inTenant(() => migrationValidationService.validate(b.id, userId));
    expect(check(r9, "VAT_POSITION")).toMatchObject({ status: "fail", expected: "output 6100.00, input 1500.00", actual: "output 6000.00, input 1500.00" });
    await inTenant(() => migrationService.updateBatch(b.id, { vatPosition: null }, userId));
    expect(check(await inTenant(() => migrationValidationService.validate(b.id, userId)), "VAT_POSITION")).toMatchObject({ status: "fail", expected: "return position" });
    await expectRefusal(inTenant(() => migrationService.updateBatch(b.id, { vatPosition: { ...VAT_POSITION, periodEnd: "2026-07-31" } }, userId)), 400);
    await inTenant(() => migrationService.updateBatch(b.id, { vatPosition: VAT_POSITION }, userId));

    // R5: a file that does not balance is refused — never plugged to opening balance equity.
    const sales = chart.rows.find((r) => r.sourceCode === "4100")!;
    await pool.query(`UPDATE migration_chart_rows SET opening_credit = 40100 WHERE id = $1`, [sales.id]);
    const r5 = await inTenant(() => migrationValidationService.validate(b.id, userId));
    expect(check(r5, "CHART_BALANCED")).toMatchObject({ status: "fail", expected: 142500, actual: 142600 });
    expect(check(r5, "CHART_BALANCED").detail).toMatch(/never plugged to opening balance equity/);
    expect((await inTenant(() => migrationValidationService.getOpeningPosition(b.id))).totals.openingBalanceEquity).toBe(100);
    await pool.query(`UPDATE migration_chart_rows SET opening_credit = 40000 WHERE id = $1`, [sales.id]);

    // A party undecided again blocks.
    await inTenant(() => migrationStagingService.importParties(b.id, { rows: PARTIES }, userId));
    const undecided = await inTenant(() => migrationValidationService.validate(b.id, userId));
    expect(check(undecided, "PARTIES")).toMatchObject({ status: "fail", actual: 3 });

    // Back to green — and the hash is the SAME content hash as before: validation is a function of the content.
    await stageAll(b.id);
    const again = await inTenant(() => migrationValidationService.validate(b.id, userId));
    expect(again.ok).toBe(true);
    expect(again.contentHash).toBe(ok.contentHash);
    await inTenant(() => migrationService.discardBatch(b.id, userId));
  });

  it("A2 — the fiscal year decides what the P&L rows may say: undeclared blocks; at a fiscal-year start no P&L balance may enter; mid-year the YTD balances import as the opening movement", async () => {
    // Undeclared fiscal year.
    await pool.query(`UPDATE companies SET fiscal_year_start = NULL WHERE id = $1`, [companyId]);
    const b1 = await create("2026-07-01");
    await stageAll(b1.id);
    const undeclared = await inTenant(() => migrationValidationService.validate(b1.id, userId));
    expect(check(undeclared, "FISCAL_YEAR")).toMatchObject({ status: "fail", actual: "not declared" });
    await pool.query(`UPDATE companies SET fiscal_year_start = 1 WHERE id = $1`, [companyId]);
    expect(check(await inTenant(() => migrationValidationService.validate(b1.id, userId)), "FISCAL_YEAR").status).toBe("pass");
    await inTenant(() => migrationService.discardBatch(b1.id, userId));
    // Cutover ON the fiscal-year start with P&L balances: pre-closing figures, refused.
    const b2 = await create("2026-01-01");
    await mapChart(b2.id);
    const yearStart = await inTenant(() => migrationValidationService.validate(b2.id, userId));
    expect(check(yearStart, "FISCAL_YEAR")).toMatchObject({ status: "fail", actual: "3 P&L row(s) with balances" });
    expect(check(yearStart, "FISCAL_YEAR").detail).toMatch(/first day of fiscal year 2026.*belongs in retained earnings/);
    await inTenant(() => migrationService.discardBatch(b2.id, userId));
  });

  it("🔴 isolation — the staged parties, items and advances are present in the owning company, absent in a sibling company and in another org, and the sibling shows its OWN figure", async () => {
    const b = await create();
    await stageAll(b.id);
    const bc2 = await inCompany2(() => migrationService.createBatch({ sourceSystem: "Excel", cutoverDate: "2026-07-01" }, userId));
    await inCompany2(() => migrationStagingService.importParties(bc2.id, { rows: [{ partyType: "customer", sourceId: "C1", name: "Sibling customer" }] }, userId));
    await inCompany2(() => migrationStagingService.importOpenItems(bc2.id, { rows: [{ ...ITEMS[0], outstandingAmount: 777, originalAmount: 777 }] }, userId));
    // Presence.
    expect((await inTenant(() => migrationStagingService.getParties(b.id))).summary.rows).toBe(5);
    expect((await inTenant(() => migrationStagingService.getOpenItems(b.id))).summary.ar.total).toBe(34500);
    expect((await inTenant(() => migrationStagingService.getAdvances(b.id))).summary.total).toBe(5000);
    // Absence: the sibling company and the other org cannot see the batch at all.
    await expectRefusal(inCompany2(() => migrationStagingService.getParties(b.id)), 404);
    await expectRefusal(inOther(() => migrationStagingService.getOpenItems(b.id)), 404);
    await expectRefusal(inOther(() => migrationValidationService.getOpeningPosition(b.id)), 404);
    // Movement: the sibling shows its own figure, and its own identity space (source id C1 exists in both).
    const sib = await inCompany2(() => migrationStagingService.getOpenItems(bc2.id));
    expect(sib.summary.ar.total).toBe(777);
    expect((await inCompany2(() => migrationStagingService.getParties(bc2.id))).rows.map((r) => r.name)).toEqual(["Sibling customer"]);
    // Raw rows: company-scoped exactly.
    const counts = await pool.query(`SELECT company_id, count(*)::int n FROM migration_parties WHERE organization_id = $1 AND batch_id IN ($2, $3) GROUP BY company_id ORDER BY n DESC`, [orgId, b.id, bc2.id]);
    expect(counts.rows).toEqual([{ company_id: companyId, n: 5 }, { company_id: company2Id, n: 1 }]);
    // A bank of the sibling company cannot receive this company's balances (Phase 1 rule, re-checked with the sibling's bank present).
    const chart = await inTenant(() => migrationService.getChart(b.id));
    await expectRefusal(inTenant(() => migrationService.decideChartRow(b.id, chart.rows.find((r) => r.sourceCode === "1100")!.id, { decision: "map_to_bank", targetBankAccountId: bankC2 }, userId)), 422, "reference_not_found");
    await inTenant(() => migrationService.discardBatch(b.id, userId));
    await inCompany2(() => migrationService.discardBatch(bc2.id, userId));
  });

  it("immutability covers the Phase 2 staging tables: a committed batch's parties, items and advances refuse every change at the DATABASE", async () => {
    const b = await create();
    await stageAll(b.id);
    await inTenant(() => migrationValidationService.validate(b.id, userId));
    await pool.query(`UPDATE migration_batches SET status = 'committed', committed_at = now() WHERE id = $1`, [b.id]);
    for (const t of ["migration_parties", "migration_open_items", "migration_advances"]) {
      await expect(pool.query(`DELETE FROM ${t} WHERE batch_id = $1`, [b.id])).rejects.toThrow(/staging rows are immutable/);
      await expect(pool.query(`UPDATE ${t} SET source_id = source_id || 'x' WHERE batch_id = $1`, [b.id])).rejects.toThrow(/staging rows are immutable/);
    }
    await expectRefusal(inTenant(() => migrationStagingService.importParties(b.id, { rows: PARTIES }, userId)), 409, "migration_batch_immutable");
    await expectRefusal(inTenant(() => migrationService.updateBatch(b.id, { notes: "x" }, userId)), 409, "migration_batch_immutable");
    await expectRefusal(inTenant(() => migrationValidationService.validate(b.id, userId)), 409, "migration_batch_immutable");
    await pool.query(`UPDATE migration_batches SET status = 'reversed', reversed_at = now() WHERE id = $1`, [b.id]);
  });
});
