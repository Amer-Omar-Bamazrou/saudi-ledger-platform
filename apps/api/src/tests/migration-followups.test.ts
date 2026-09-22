/**
 * MIGRATION FOLLOW-UPS (2026-09-22) — on the accountant's answers 3, 4 and 5
 * and Batch 1C's A4. Record: batch-1c pack §17.
 *
 *   A. the previous solution's e-invoicing identity travels with an opening
 *      receivable (UUID + status), never invented, recorded once afterwards;
 *   B. an item-level correction (100,000 → 90,000): the original stays,
 *      reversed by its batch and carrying the entry; a replacement with a new
 *      number; the other side RETAINED EARNINGS; nothing deleted; audit;
 *   C. a migrated bad-debt relief is a structured fact the Art. 40(9)
 *      recovery reads;
 *   D. a credit note against an opening item is gated on the identity and
 *      names the previous system's NUMBER in its billing reference.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { migrationService } from "../services/migration.service";
import { migrationStagingService } from "../services/migrationStaging.service";
import { migrationValidationService } from "../services/migrationValidation.service";
import { migrationCommitService } from "../services/migrationCommit.service";
import { migrationCorrectionService } from "../services/migrationCorrection.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { invoicesService } from "../services/invoices.service";
import { paymentsService } from "../services/payments.service";
import { badDebtService } from "../services/badDebt.service";
import { loadEInvoiceInput } from "../services/einvoice/einvoiceInput.loader";
import { buildInvoiceXml } from "../services/einvoice/ubl/buildInvoiceXml";
import { createApproved } from "./helpers/createApproved";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "mig-fu";
const EMAIL = "mig-fu@test.local";
const UUID_A = "6f9619ff-8b86-4d11-b42d-00c04fc964ff";

describeMaybe("Migration follow-ups — identity, item-level correction to retained earnings, migrated relief, credit notes through Fatoora (real rows)", () => {
  let orgId = "", companyId = "", userId = 0, bank = 0, batchId = 0;
  const items: Record<string, number> = {};
  const invoiceOf: Record<string, number> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stagingRefusals: any[] = [];

  const inTenant = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  };
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      for (const t of [
        "payment_classifications", "customer_refunds", "payment_allocation_reversals", "payment_allocations", "migration_deposit_reversals", "payments", "migration_advances", "migration_open_items", "migration_parties", "migration_chart_rows",
        "invoice_items", "einvoice_documents", "invoices", "bills", "journal_entry_lines", "journal_entries", "migration_batches", "period_locks", "audit_logs", "organization_memberships",
        "bank_accounts", "customers", "vendors", "categories", "companies",
      ]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let err: any;
    try { await p; } catch (e) { err = e; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err.statusCode ?? err.status, err.message).toBe(status);
    if (code) expect(err.payload?.code ?? err.body?.code ?? err.code).toBe(code);
    return { ...err, body: err.payload ?? err.body ?? {} };
  };
  const gl = async (code: string, party?: { customerId?: number; vendorId?: number }) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed') ${party?.customerId ? "AND l.customer_id = $3" : party?.vendorId ? "AND l.vendor_id = $3" : ""}`,
      party?.customerId ? [orgId, code, party.customerId] : party?.vendorId ? [orgId, code, party.vendorId] : [orgId, code])).rows[0].v);
  const inv = async (id: number) => (await pool.query(`SELECT * FROM invoices WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Mig FU','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number) VALUES ($1,'Mig FU Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','Mig FU',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    bank = (await inTenant(() => bankAccountsService.create({ name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" }))).id;

    // one migration: bank 1,000 · AR 100,000 + 20,000 + 11,500 · AP 5,000 · capital balances the rest
    const b = await inTenant(() => migrationService.createBatch({ sourceSystem: "PreviousERP", cutoverDate: "2026-07-01" }, userId));
    batchId = b.id;
    await inTenant(() => migrationService.importChart(batchId, { rows: [
      { sourceCode: "1100", sourceName: "Bank", sourceType: "asset", openingDebit: 1000, sourceRole: "bank", evidenceNote: "stmt" },
      { sourceCode: "1200", sourceName: "Debtors", sourceType: "asset", openingDebit: 131500, sourceRole: "receivable" },
      { sourceCode: "2100", sourceName: "Creditors", sourceType: "liability", openingCredit: 5000, sourceRole: "payable" },
      { sourceCode: "3100", sourceName: "Capital", sourceType: "equity", openingCredit: 127500 },
    ] }, userId));
    const chart = await inTenant(() => migrationService.getChart(batchId));
    const row = (code: string) => chart.rows.find((r) => r.sourceCode === code)!;
    await inTenant(() => migrationService.decideChartRow(batchId, row("1100").id, { decision: "map_to_bank", targetBankAccountId: bank }, userId));
    await inTenant(() => migrationService.decideChartRow(batchId, row("1200").id, { decision: "map_to_system", targetSystemCode: "AR" }, userId));
    await inTenant(() => migrationService.decideChartRow(batchId, row("2100").id, { decision: "map_to_system", targetSystemCode: "AP" }, userId));
    await inTenant(() => migrationService.decideChartRow(batchId, row("3100").id, { decision: "create" }, userId));
    await inTenant(() => migrationStagingService.importParties(batchId, { rows: [
      { partyType: "customer", sourceId: "C1", name: "Beta Logistics Co.", taxNumber: "311987654321003", address: "4321 Prince Sultan Street, Al Rawdah", city: "Jeddah" },
      { partyType: "vendor", sourceId: "V1", name: "Gamma Supplies" },
    ] }, userId));
    // staging refusals (on the DRAFT batch, before the real rows): a cleared document without its UUID; identity on a payable; an unknown status
    for (const bad of [
      { itemType: "ar", sourceId: "X1", partySourceId: "C1", documentNumber: "OLD-X", issueDate: "2026-05-10", dueDate: "2026-06-09", originalAmount: 10, outstandingAmount: 10, einvoicingStatus: "cleared" },
      { itemType: "ap", sourceId: "X2", partySourceId: "V1", documentNumber: "B-X", issueDate: "2026-05-10", dueDate: "2026-06-09", originalAmount: 10, outstandingAmount: 10, einvoicingStatus: "pre_einvoicing" },
      { itemType: "ar", sourceId: "X3", partySourceId: "C1", documentNumber: "OLD-X3", issueDate: "2026-05-10", dueDate: "2026-06-09", originalAmount: 10, outstandingAmount: 10, einvoicingStatus: "signed" },
    ] as const) {
      stagingRefusals.push(await expectRefusal(inTenant(() => migrationStagingService.importOpenItems(batchId, { rows: [bad as never] }, userId)), 400));
    }
    await inTenant(() => migrationStagingService.importOpenItems(batchId, { rows: [
      // a cleared standard invoice with its UUID; a pre-e-invoicing one; one whose identity the migration did NOT state; a payable
      { itemType: "ar", sourceId: "S1", partySourceId: "C1", documentNumber: "OLD-1001", issueDate: "2026-05-10", dueDate: "2026-06-09", originalAmount: 100000, outstandingAmount: 100000, einvoicingStatus: "cleared", sourceUuid: UUID_A, historicalVat: { category: "S", rate: 15 } },
      { itemType: "ar", sourceId: "S2", partySourceId: "C1", documentNumber: "OLD-0900", issueDate: "2021-03-01", dueDate: "2021-03-31", originalAmount: 20000, outstandingAmount: 20000, einvoicingStatus: "pre_einvoicing", historicalVat: { category: "S", rate: 15 } },
      { itemType: "ar", sourceId: "S3", partySourceId: "C1", documentNumber: "OLD-1002", issueDate: "2024-11-01", dueDate: "2024-12-01", originalAmount: 11500, outstandingAmount: 11500, historicalVat: { category: "S", rate: 15, badDebtReliefClaimed: true, badDebtReliefClaimedOn: "2025-12-15", badDebtReliefVatAmount: 1500 } },
      { itemType: "ap", sourceId: "P1", partySourceId: "V1", documentNumber: "BILL-77", issueDate: "2026-06-01", dueDate: "2026-06-30", originalAmount: 5000, outstandingAmount: 5000 },
    ] }, userId));
    const v = await inTenant(() => migrationValidationService.validate(batchId, userId));
    expect(v.ok, JSON.stringify(v.checks.filter((c) => c.status === "fail"))).toBe(true);
    await inTenant(() => migrationCommitService.commit(batchId, userId));
    const staged = await inTenant(() => migrationStagingService.getOpenItems(batchId));
    for (const r of staged.rows) { items[r.sourceId] = r.id; if (r.itemType === "ar") invoiceOf[r.sourceId] = r.resolvedId!; }
  }, 120_000);
  afterAll(cleanup);

  // ── A: identity ────────────────────────────────────────────────────────
  it("🔴 A: the previous solution's identity is captured at staging (UUID only with cleared/reported; AR only; never for a payable), lands on the opening receivable at commit, and the read shows the live row", async () => {
    const staged = await inTenant(() => migrationStagingService.getOpenItems(batchId));
    const s1 = staged.rows.find((r) => r.sourceId === "S1")!;
    expect([s1.einvoicingStatus, s1.sourceUuid]).toEqual(["cleared", UUID_A]);
    expect(s1.liveDocumentId).toBe(invoiceOf.S1);
    expect(s1.liveOutstanding).toBe(100_000);
    expect(s1.liveIdentityRecorded).toBe(true);
    expect(s1.corrections).toBe(0);
    const row = await inv(invoiceOf.S1!);
    expect([row.opening_einvoicing_status, row.opening_source_uuid]).toEqual(["cleared", UUID_A]);
    const s3 = staged.rows.find((r) => r.sourceId === "S3")!;
    expect(s3.einvoicingStatus).toBeNull();
    expect(s3.liveIdentityRecorded).toBe(false);
    // staging refusals (captured on the draft batch in beforeAll — a committed batch refuses every import by state, which would prove nothing here)
    expect(stagingRefusals).toHaveLength(3);
    for (const r of stagingRefusals) expect(r.body?.code ?? r.code, r.message).not.toBe("migration_already_committed");
  });

  it("🔴 D: a credit note against an opening item is REFUSED by name while its identity is unstated; recorded ONCE (never changed), the note is allowed and its billing reference is the previous system's NUMBER; a pre-e-invoicing original needs only its number", async () => {
    // S3: identity not stated → refused, explaining what to record
    const s3CustomerId = (await inv(invoiceOf.S3!)).customer_id;
    const refused = await expectRefusal(inTenant(() => invoicesService.create({ invoiceNumber: "CN-S3-1", date: "2026-07-05", customerId: s3CustomerId, documentType: "credit_note", originalInvoiceId: invoiceOf.S3, noteReason: "Goods returned", items: [{ description: "Return", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId)), 409, "opening_item_einvoicing_identity_missing");
    expect(refused.body.error).toMatch(/OLD-1002/);
    expect(refused.body.error).toMatch(/Fatoora/);
    // a cleared status without the UUID is refused; then recorded; then immutable
    await expectRefusal(inTenant(() => migrationCorrectionService.recordIdentity(items.S3!, { einvoicingStatus: "reported" }, userId)), 400);
    const rec = await inTenant(() => migrationCorrectionService.recordIdentity(items.S3!, { einvoicingStatus: "reported", sourceUuid: "0b1c2d3e-4f50-4a6b-9c7d-0e1f2a3b4c5d" }, userId));
    expect(rec.einvoicingStatus).toBe("reported");
    await expectRefusal(inTenant(() => migrationCorrectionService.recordIdentity(items.S3!, { einvoicingStatus: "pre_einvoicing" }, userId)), 409, "opening_identity_already_recorded");
    // the trigger, too: a raw change of a recorded identity is refused by the database
    await expect(pool.query(`UPDATE invoices SET opening_einvoicing_status = 'cleared' WHERE id = $1`, [invoiceOf.S3])).rejects.toThrow(/recorded once/);
    // now the note: allowed, its reference = OLD-1002 (the staging number), Model C accounting, the return moves in the note's period
    const custId = (await inv(invoiceOf.S3!)).customer_id;
    const cn = await inTenant(() => createApproved<Awaited<ReturnType<typeof invoicesService.getById>>>(invoicesService, { invoiceNumber: "CN-S3-2", date: "2026-07-05", customerId: custId, documentType: "credit_note", originalInvoiceId: invoiceOf.S3, noteReason: "Goods returned", items: [{ description: "Return", quantity: 1, unitPrice: 1000, vatRate: 15 }] }, userId));
    expect(cn.status).toBe("sent");
    expect(cn.icv).not.toBeNull();
    const input = await inTenant(() => loadEInvoiceInput(cn.id, null));
    expect(input.billingReference).toEqual({ invoiceNumber: "OLD-1002" });
    expect(buildInvoiceXml(input)).toMatch(/<cac:BillingReference>\s*<cac:InvoiceDocumentReference>\s*<cbc:ID>OLD-1002<\/cbc:ID>/);
    expect(Number((await inv(invoiceOf.S3!)).credited_amount)).toBe(1150);
    // S2 (pre-e-invoicing): number only, allowed
    const cn2 = await inTenant(() => createApproved<Awaited<ReturnType<typeof invoicesService.getById>>>(invoicesService, { invoiceNumber: "CN-S2-1", date: "2026-07-05", customerId: custId, documentType: "credit_note", originalInvoiceId: invoiceOf.S2, noteReason: "Price adjustment", items: [{ description: "Adj", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId));
    expect((await inTenant(() => loadEInvoiceInput(cn2.id, null))).billingReference).toEqual({ invoiceNumber: "OLD-0900" });
  });

  // ── B: the correction ───────────────────────────────────────────────────
  it("🔴 B: 100,000 → 90,000 — the original stays (reversed by its batch, frozen, carrying the entry), a replacement OPEN-<batch>-<seq> for 90,000 links to it, ONE entry Dr Retained earnings 10,000 / Cr AR (customer) 10,000; the read shows the live row; a payable mirrors; refused when touched, when unchanged, when dated into a locked month", async () => {
    const custId = (await inv(invoiceOf.S1!)).customer_id;
    const arBefore = await gl("AR", { customerId: custId });
    const reBefore = await gl("RETAINED_EARNINGS");
    const out = await inTenant(() => migrationCorrectionService.correctOpenItem(items.S1!, { correctOutstanding: 90_000, reason: "transfer error: the previous system's invoice was 90,000", date: "2026-07-10" }, userId));
    expect(out.original).toEqual({ id: invoiceOf.S1, number: "OLD-1001", total: 100_000 });
    expect(out.replacement.number).toMatch(new RegExp(`^OPEN-${batchId}-\\d+$`));
    expect(out.replacement.total).toBe(90_000);
    expect(out.delta).toBe(-10_000);
    // the entry: retained earnings on the other side, nothing else
    const lines = (await pool.query(`SELECT c.system_code, l.debit_amount::text AS d, l.credit_amount::text AS c, l.customer_id FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id WHERE e.id = $1 ORDER BY l.id`, [out.journalEntryId])).rows;
    expect(lines.map((l) => [l.system_code, l.d, l.c, l.customer_id])).toEqual([["AR", "0.00", "10000.00", custId], ["RETAINED_EARNINGS", "10000.00", "0.00", null]]);
    expect((await pool.query(`SELECT source, date::text AS date, migration_batch_id FROM journal_entries WHERE id = $1`, [out.journalEntryId])).rows[0]).toEqual({ source: "opening_correction", date: "2026-07-10", migration_batch_id: batchId });
    expect(await gl("AR", { customerId: custId })).toBe(arBefore - 10_000);
    expect(await gl("RETAINED_EARNINGS")).toBe(reBefore + 10_000);
    // the original: preserved, reversed by its own batch, carrying the entry, FROZEN
    const orig = await inv(invoiceOf.S1!);
    expect([orig.total, orig.invoice_number, orig.reversed_by_migration_batch_id, orig.opening_correction_journal_entry_id]).toEqual(["100000.00", "OLD-1001", batchId, out.journalEntryId]);
    expect(orig.reversed_at).not.toBeNull();
    await expect(pool.query(`UPDATE invoices SET notes = 'x' WHERE id = $1`, [invoiceOf.S1])).rejects.toThrow(/frozen/);
    // the replacement: live, linked, the identity carried
    const rep = await inv(out.replacement.id);
    expect([rep.replaces_invoice_id, rep.migration_open_item_id, rep.is_opening, rep.opening_einvoicing_status, rep.opening_source_uuid, rep.reversed_at]).toEqual([invoiceOf.S1, items.S1, true, "cleared", UUID_A, null]);
    expect(rep.notes).toMatch(/replaces OLD-1001/);
    const staged = await inTenant(() => migrationStagingService.getOpenItems(batchId));
    const s1 = staged.rows.find((r) => r.sourceId === "S1")!;
    expect([s1.liveDocumentId, s1.liveDocumentNumber, s1.liveOutstanding, s1.corrections]).toEqual([out.replacement.id, out.replacement.number, 90_000, 1]);
    // the customer's receivable reads 90,000 for this item (the reversed original is out, the replacement in)
    expect(Number((await pool.query(`SELECT coalesce(sum(total::numeric),0)::text v FROM invoices WHERE migration_open_item_id = $1 AND reversed_at IS NULL`, [items.S1])).rows[0].v)).toBe(90_000);
    // a second correction chains on the replacement
    const out2 = await inTenant(() => migrationCorrectionService.correctOpenItem(items.S1!, { correctOutstanding: 95_000, reason: "re-checked against the source ledger", date: "2026-07-11" }, userId));
    expect(out2.original.number).toBe(out.replacement.number);
    expect(out2.delta).toBe(5_000);
    expect(await gl("AR", { customerId: custId })).toBe(arBefore - 5_000);
    expect(await gl("RETAINED_EARNINGS")).toBe(reBefore + 5_000);
    // refusals: unchanged; touched (S3 has a credit note); a payable mirrors; audit rows
    await expectRefusal(inTenant(() => migrationCorrectionService.correctOpenItem(items.S1!, { correctOutstanding: 95_000, reason: "same" }, userId)), 409, "opening_correction_no_change");
    await expectRefusal(inTenant(() => migrationCorrectionService.correctOpenItem(items.S3!, { correctOutstanding: 9_000, reason: "x" }, userId)), 409, "opening_item_partly_settled");
    const vendorId = (await pool.query(`SELECT vendor_id FROM bills WHERE migration_open_item_id = $1`, [items.P1])).rows[0].vendor_id;
    const apBefore = await gl("AP", { vendorId });
    const ap = await inTenant(() => migrationCorrectionService.correctOpenItem(items.P1!, { correctOutstanding: 4_000, reason: "supplier statement shows 4,000" }, userId));
    expect(ap.delta).toBe(-1_000);
    const apLines = (await pool.query(`SELECT c.system_code, l.debit_amount::text AS d, l.credit_amount::text AS c FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id WHERE e.id = $1 ORDER BY l.id`, [ap.journalEntryId])).rows;
    expect(apLines.map((l) => [l.system_code, l.d, l.c])).toEqual([["AP", "1000.00", "0.00"], ["RETAINED_EARNINGS", "0.00", "1000.00"]]);
    expect(await gl("AP", { vendorId })).toBe(apBefore + 1_000); // AP is a credit balance: debit-minus-credit rises by 1,000
    const audit = (await pool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action IN ('opening_item_correct','opening_identity_record')`, [orgId])).rows.map((r) => r.action).sort();
    expect(audit).toEqual(["opening_identity_record", "opening_item_correct", "opening_item_correct", "opening_item_correct"]);
    // dated before the opening: refused; a locked month: fails closed by name (nothing written), then reopened
    await expectRefusal(inTenant(() => migrationCorrectionService.correctOpenItem(items.S1!, { correctOutstanding: 96_000, reason: "x", date: "2026-06-15" }, userId)), 422, "opening_correction_before_opening");
    await pool.query(`INSERT INTO period_locks (organization_id, company_id, period, locked_by) VALUES ($1, $2, '2026-07', $3)`, [orgId, companyId, userId]);
    const rowsBefore = (await pool.query(`SELECT count(*)::int n FROM invoices WHERE migration_open_item_id = $1`, [items.S1])).rows[0].n;
    await expectRefusal(inTenant(() => migrationCorrectionService.correctOpenItem(items.S1!, { correctOutstanding: 96_000, reason: "x", date: "2026-07-15" }, userId)), 423, "period_closed");
    expect((await pool.query(`SELECT count(*)::int n FROM invoices WHERE migration_open_item_id = $1`, [items.S1])).rows[0].n).toBe(rowsBefore);
    await pool.query(`DELETE FROM period_locks WHERE organization_id = $1`, [orgId]);
    // nothing deleted: every row ever created is still there
    expect((await pool.query(`SELECT count(*)::int n FROM invoices WHERE migration_open_item_id = $1`, [items.S1])).rows[0].n).toBe(3);
    // every journal balances
    expect((await pool.query(`SELECT e.entry_number FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id WHERE e.organization_id = $1 GROUP BY e.id HAVING sum(l.debit_amount) <> sum(l.credit_amount)`, [orgId])).rows).toEqual([]);
  });

  // ── C: the migrated relief ──────────────────────────────────────────────
  it("🔴 C: a migrated bad-debt relief is a structured fact on the opening receivable (source migrated, date and VAT when recorded), never the notes — and the Art. 40(9) recovery reads it: allocate the receipt, then the recovery invoice for the VAT leg", async () => {
    const row = await inv(invoiceOf.S3!);
    expect([row.bad_debt_relief_source, row.bad_debt_relief_claimed_on, row.bad_debt_relief_vat_amount]).toEqual(["migrated", "2025-12-15", "1500.00"]);
    const view = await inTenant(() => invoicesService.getById(invoiceOf.S3!));
    expect(view.badDebtRelief).toMatchObject({ source: "migrated", claimedOn: "2025-12-15", vatAmount: 1500 });
    // the write-off act stays refused on a migrated item
    await expectRefusal(inTenant(() => badDebtService.writeOffWithRelief(invoiceOf.S3!, { claimedOn: "2026-07-20", certificateRef: "x" }, userId)), 409, "opening_item_relief_is_migration_fact");
    // money arrives: allocated to the open item (outstanding after the note: 11,500 − 1,150 = 10,350); the recovery invoice declares the VAT (rate from the migration's historical VAT: 15)
    const rcpt = await inTenant(() => paymentsService.receive({ customerId: row.customer_id, amount: 4_600, paidAt: "2026-07-20", bankAccountId: bank, allocations: [{ invoiceId: invoiceOf.S3!, amount: 4_600 }] }, userId));
    const vatBefore = await gl("VAT_OUTPUT");
    const draft = await inTenant(() => badDebtService.createRecovery(invoiceOf.S3!, { paymentId: rcpt.id, amount: 4_600 }, userId));
    expect([draft.subtotal, draft.vatAmount, draft.total].map(Number)).toEqual([4_000, 600, 4_600]);
    const rec = await inTenant(() => invoicesService.approve(draft.id, userId));
    expect(rec.status).toBe("sent");
    expect(await gl("VAT_OUTPUT")).toBe(vatBefore - 600); // debit-minus-credit falls by the VAT credited
    const input = await inTenant(() => loadEInvoiceInput(rec.id, null));
    expect(input.billingReference).toEqual({ invoiceNumber: "OLD-1002" });
    expect(input.supplyDate).toBe("2026-07-20");
  });
});
