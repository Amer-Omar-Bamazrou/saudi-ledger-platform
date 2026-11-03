/**
 * 🔴 Phase 18 R-11a — DR-14 (owner, 2026-11-01; register §11.82, §11.111): "flags only (self-approval; pairs
 * first). A flag never blocks an act. No new approval framework."
 *
 *  - SELF-APPROVAL: each of the ten approvals — the engine's eight (journal entry, bill, invoice, payroll run,
 *    quotation, purchase order, budget version, tax computation version) and the two outside it (WHT treaty relief,
 *    payment plan) — records ONE `self_approval` flag when the approver is the record's maker, and none when another
 *    person approves.
 *  - THE FIVE PAIRS: approve → pay a bill; post → reverse a journal entry (the generic reverse); complete → reopen a
 *    bank reconciliation; commit → reverse a migration; remit → file a WHT month. Each flagged at the second act when
 *    one person did both, and not when two people did.
 *  - A flag never blocks, and a refused act leaves none (an approval refused by a closed month).
 *  - The store: append-only for every role (UPDATE, DELETE, TRUNCATE refused, the owner included), and a flag
 *    naming anyone but the declared actor is refused.
 *  - The reader: GET /control-flags answers the approvers (admin, accountant) with the flags and their total, and
 *    refuses a bookkeeper and a viewer.
 *
 * The acts run in-process inside real tenant transactions, the acting user as the declared actor (T1b), as the
 * request runs them; the reader is read over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3221";
process.env.SESSION_SECRET ??= "r11a-dr14-control-flags-000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, db, beginTenantConnection } from "@workspace/db";
import { sql } from "drizzle-orm";
import { businessDateShift, businessToday } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";
import { replica } from "./helpers/replica";
import { auditContext } from "../lib/auditContext";
import { journalEntriesService } from "../services/journalEntries.service";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { payrollService } from "../services/payroll.service";
import { quotationsService } from "../services/quotations.service";
import { purchaseOrdersService } from "../services/purchaseOrders.service";
import { budgetsService } from "../services/budgets.service";
import { taxComputationsService } from "../services/tax/taxComputations.service";
import { zakatClassificationService } from "../services/tax/zakatClassification.service";
import { whtService } from "../services/tax/wht.service";
import { paymentPlansService } from "../services/treasury/paymentPlans.service";
import { bankReconciliationsService } from "../services/accounting/bankReconciliations.service";
import { bankTransfersService } from "../services/accounting/bankTransfers.service";
import { migrationService } from "../services/migration.service";
import { migrationStagingService } from "../services/migrationStaging.service";
import { migrationValidationService } from "../services/migrationValidation.service";
import { migrationCommitService } from "../services/migrationCommit.service";
import { periodLocksService } from "../services/periodLocks.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "R11aFlagsPw123!";
const DATE = "2026-10-01";

type Flag = { kind: string; actor_user_id: number; entity_type: string; entity_id: string; company_id: string };

describeMaybe("Phase 18 R-11a (DR-14) — control flags: self-approval and the five pairs, never blocking", () => {
  const h = g04Harness("r11aflags");
  let orgId = "";
  const co: Record<"A" | "Z1" | "Z2" | "M1" | "M2", string> = {} as never;
  let U = 0; // admin
  let V = 0; // accountant
  let B = 0; // bookkeeper
  let W = 0; // viewer
  let customerId = 0;
  let vendorId = 0;
  let nrVendor = 0;
  let bankA = 0;
  let expense = 0;
  let income = 0;
  let seq = 0;
  const as = (company: string, uid: number) => <T,>(fn: () => Promise<T>) => h.inTenant(orgId, company, uid, fn);
  const A = (uid: number) => as(co.A, uid);

  /** The flags of this organisation; none while the store does not exist (main before R-11a). */
  const flags = async (where: Partial<Flag> = {}): Promise<Flag[]> => {
    const exists = (await pool.query(`SELECT to_regclass('public.control_flags') IS NOT NULL AS e`)).rows[0].e;
    if (!exists) return [];
    const rows = (await pool.query(`SELECT kind, actor_user_id, entity_type, entity_id, company_id::text FROM control_flags WHERE organization_id = $1 ORDER BY id`, [orgId])).rows as Flag[];
    return rows.filter((r) => Object.entries(where).every(([k, v]) => String((r as Record<string, unknown>)[k]) === String(v)));
  };
  const expectFlag = async (kind: string, entityType: string, entityId: number | string, actor: number) => {
    const got = await flags({ kind, entity_type: entityType, entity_id: String(entityId) });
    expect(got, `${kind} on ${entityType} ${entityId}: one flag`).toHaveLength(1);
    expect(got[0]!.actor_user_id, "the flag names the person who did both").toBe(actor);
  };
  const expectNoFlag = async (kind: string, entityType: string, entityId: number | string) =>
    expect(await flags({ kind, entity_type: entityType, entity_id: String(entityId) }), `${kind} on ${entityType} ${entityId}: none (two people)`).toHaveLength(0);

  // ── fixtures, through the product's own services ──────────────────────────
  const journal = (uid: number) => A(uid)(async () => (await journalEntriesService.create({ entryNumber: `R11A-${++seq}`, date: DATE, description: "R-11a accrual", lines: [
    { accountId: expense, accountName: "Other Expenses", debitAmount: 100, creditAmount: 0 },
    { accountId: income, accountName: "Other Income", debitAmount: 0, creditAmount: 100 },
  ] }, uid) as { id: number }).id);
  const bill = (uid: number, vendor = vendorId, total = 1000, date = DATE) => A(uid)(async () => (await billsService.create(
    { billNumber: `R11A-B-${++seq}`, date, vendorId: vendor, items: [{ description: "Supply", quantity: 1, unitPrice: total, vatRate: 0 }] } as never, uid) as { id: number }).id);
  const approveBill = (id: number, uid: number) => A(uid)(() => billsService.approve(id, {}, uid));

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    co.A = await h.mkCompany(orgId, "R11a A", "319191919191503");
    co.Z1 = await h.mkCompany(orgId, "R11a Z1", "319191919191603");
    co.Z2 = await h.mkCompany(orgId, "R11a Z2", "319191919191703");
    co.M1 = await h.mkCompany(orgId, "R11a M1", "319191919191803");
    co.M2 = await h.mkCompany(orgId, "R11a M2", "319191919191903");
    U = await h.mkUser("admin", PW, orgId, "admin");
    V = await h.mkUser("accountant", PW, orgId, "accountant");
    B = await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    W = await h.mkUser("viewer", PW, orgId, "viewer");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'R11a Customer') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, residency) VALUES ($1,'R11a Supplier','resident') RETURNING id`, [orgId])).rows[0].id;
    nrVendor = (await pool.query(`INSERT INTO vendors (organization_id, name, residency, wht_default_payment_type, country, foreign_tax_id) VALUES ($1,'R11a London Consulting','non_resident','technical_consulting','GB','GB-R11A') RETURNING id`, [orgId])).rows[0].id;
    bankA = (await A(U)(() => bankAccountsService.create({ name: "R11a Bank A", bankName: "SNB", currency: "SAR" }))).id as number;
    const cat = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;
    expense = await cat("OTHER_EXPENSES");
    income = await cat("OTHER_INCOME");
    await h.start();
    for (const k of ["admin", "accountant", "bookkeeper", "viewer"]) expect(await h.login(k, h.email(k), PW), `login ${k}`).toBe(200);
  }, 180_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  describe("SELF-APPROVAL — each of the ten approvals", () => {
    it("🔴 journal entry: made and approved by one person → flagged; approved by another → not", async () => {
      const own = await journal(U);
      await A(U)(() => journalEntriesService.approve(own, U));
      await expectFlag("self_approval", "journal_entry", own, U);
      const other = await journal(U);
      await A(V)(() => journalEntriesService.approve(other, V));
      await expectNoFlag("self_approval", "journal_entry", other);
    });

    it("🔴 bill", async () => {
      const own = await bill(U);
      await approveBill(own, U);
      await expectFlag("self_approval", "bill", own, U);
      const other = await bill(U);
      await approveBill(other, V);
      await expectNoFlag("self_approval", "bill", other);
    });

    it("🔴 invoice", async () => {
      const make = (uid: number) => A(uid)(async () => (await invoicesService.create({ invoiceNumber: `R11A-I-${++seq}`, date: DATE, dueDate: "2026-10-31", customerId,
        items: [{ description: "Work", quantity: 1, unitPrice: 1000, vatRate: 15 }] } as never, uid) as { id: number }).id);
      const own = await make(U);
      await A(U)(() => invoicesService.approve(own, U));
      await expectFlag("self_approval", "invoice", own, U);
      const other = await make(U);
      await A(V)(() => invoicesService.approve(other, V));
      await expectNoFlag("self_approval", "invoice", other);
    });

    it("🔴 payroll run", async () => {
      await pool.query(`INSERT INTO employees (organization_id, company_id, employee_number, name, nationality, basic_salary, status, gosi_regime) VALUES ($1,$2,'R11A-E1','R11a Employee','EG','5000.00','active','law_1421h')`, [orgId, co.A]);
      const own = (await A(U)(() => payrollService.create({ period: "2026-08" } as never, U)) as { id: number }).id;
      await A(U)(() => payrollService.approve(own, U));
      await expectFlag("self_approval", "payroll_run", own, U);
      const other = (await A(U)(() => payrollService.create({ period: "2026-09" } as never, U)) as { id: number }).id;
      await A(V)(() => payrollService.approve(other, V));
      await expectNoFlag("self_approval", "payroll_run", other);
    });

    it("🔴 quotation and purchase order", async () => {
      const q = (uid: number) => A(uid)(async () => (await quotationsService.create({ date: DATE, customerId, items: [{ description: "Offer", quantity: 2, unitPrice: 500, vatRate: 15 }] } as never, uid) as { id: number }).id);
      const po = (uid: number) => A(uid)(async () => (await purchaseOrdersService.create({ date: DATE, vendorId, items: [{ description: "Order", quantity: 10, unitPrice: 30, vatRate: 15 }] } as never, uid) as { id: number }).id);
      const ownQ = await q(U);
      await A(U)(() => quotationsService.approve(ownQ, U));
      await expectFlag("self_approval", "quotation", ownQ, U);
      const otherQ = await q(U);
      await A(V)(() => quotationsService.approve(otherQ, V));
      await expectNoFlag("self_approval", "quotation", otherQ);
      const ownPo = await po(U);
      await A(U)(() => purchaseOrdersService.approve(ownPo, U));
      await expectFlag("self_approval", "purchase_order", ownPo, U);
      const otherPo = await po(U);
      await A(V)(() => purchaseOrdersService.approve(otherPo, V));
      await expectNoFlag("self_approval", "purchase_order", otherPo);
    });

    it("🔴 budget version", async () => {
      const sales = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'SALES'`, [orgId])).rows[0].id;
      const draft = async (year: number) => {
        const b = await A(U)(() => budgetsService.create({ name: `R11a Budget ${year}`, fiscalYearLabel: year } as never, U)) as { id: number; version: { id: number } };
        await A(U)(() => budgetsService.replaceLines(b.id, b.version.id, { lines: [{ accountId: sales, periods: Array(12).fill(1000) }] } as never));
        await A(U)(() => budgetsService.submit(b.id, b.version.id, U));
        return b;
      };
      const own = await draft(2026);
      await A(U)(() => budgetsService.approve(own.id, own.version.id, U));
      await expectFlag("self_approval", "budget_version", own.version.id, U);
      const other = await draft(2027);
      await A(V)(() => budgetsService.approve(other.id, other.version.id, V));
      await expectNoFlag("self_approval", "budget_version", other.version.id);
    });

    it("🔴 tax computation version (Zakat)", async () => {
      const computation = async (company: string) => {
        await pool.query(`UPDATE companies SET ownership_type = 'SAUDI_GCC', foreign_ownership_pct = 0 WHERE id = $1`, [company]);
        const asset = (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable, liquidity_class) VALUES ($1,$2,'أصل','asset',false,'current') RETURNING id`, [orgId, `R11a Asset ${company.slice(0, 8)}`])).rows[0].id as number;
        const equity = (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable) VALUES ($1,$2,'رأس المال','equity',false) RETURNING id`, [orgId, `R11a Capital ${company.slice(0, 8)}`])).rows[0].id as number;
        const je = await as(company, U)(async () => (await journalEntriesService.create({ entryNumber: `R11A-Z-${++seq}`, date: "2025-01-01", description: "Capital", lines: [
          { accountId: asset, accountName: "Asset", debitAmount: 1000, creditAmount: 0 },
          { accountId: equity, accountName: "Capital", debitAmount: 0, creditAmount: 1000 },
        ] }, U) as { id: number }).id);
        await as(company, V)(() => journalEntriesService.approve(je, V));
        await as(company, U)(() => zakatClassificationService.set(asset, { classification: "current_asset_not_deducted", basisNote: "R-11a" } as never, U));
        const c = await as(company, U)(() => taxComputationsService.create({ kind: "zakat", fiscalYearLabel: 2025 } as never, U)) as { id: number; version: { id: number } };
        await as(company, U)(() => taxComputationsService.submit(c.id, c.version.id, U));
        return c;
      };
      const own = await computation(co.Z1);
      await as(co.Z1, U)(() => taxComputationsService.approve(own.id, own.version.id, U));
      await expectFlag("self_approval", "tax_computation_version", own.version.id, U);
      const other = await computation(co.Z2);
      await as(co.Z2, V)(() => taxComputationsService.approve(other.id, other.version.id, V));
      await expectNoFlag("self_approval", "tax_computation_version", other.version.id);
    });

    it("🔴 WHT treaty relief (outside the engine)", async () => {
      const relief = async (name: string) => {
        const vendor = (await pool.query(`INSERT INTO vendors (organization_id, name, residency, wht_default_payment_type, country, foreign_tax_id) VALUES ($1,$2,'non_resident','royalty','GB',$3) RETURNING id`, [orgId, name, `GB-${name}`])).rows[0].id;
        return (await A(U)(() => whtService.createRelief({ vendorId: vendor, paymentType: "royalty", reducedRate: 0.05, treatyCountry: "AE", zatcaApprovalReference: `Z-${name}`, residencyCertificateReference: `R-${name}`, validFrom: "2026-01-01", validTo: "2026-12-31" }, U)) as { id: number }).id;
      };
      const own = await relief("R11A-L1");
      await A(U)(() => whtService.approveRelief(own, U));
      await expectFlag("self_approval", "wht_treaty_relief", own, U);
      const other = await relief("R11A-L2");
      await A(V)(() => whtService.approveRelief(other, V));
      await expectNoFlag("self_approval", "wht_treaty_relief", other);
    });

    it("🔴 payment plan (outside the engine)", async () => {
      const plan = async () => {
        const b = await bill(V);
        await approveBill(b, V);
        return (await A(U)(() => paymentPlansService.create({ billId: b, amount: 1000, plannedDate: businessDateShift(businessToday(), 30), bankAccountId: bankA } as never, U)) as { id: number }).id;
      };
      const own = await plan();
      await A(U)(() => paymentPlansService.approve(own, U));
      await expectFlag("self_approval", "scheduled_payment", own, U);
      const other = await plan();
      await A(V)(() => paymentPlansService.approve(other, V));
      await expectNoFlag("self_approval", "scheduled_payment", other);
    });

    // Added after the proof commit (register §11.114), from the full suite: a flag never blocks its act.
    it("🔴 a flag never blocks its act: an approval on a connection with no declared actor goes through, unflagged", async () => {
      const entry = await journal(U);
      // as many suites (and any script) run: an audit context naming the user, a connection declaring no actor
      const conn = await beginTenantConnection({ organizationId: orgId, companyId: co.A, role: "authenticated" });
      try {
        await conn.run(() => auditContext.run({ userId: U, organizationId: orgId, ipAddress: null }, () => journalEntriesService.approve(entry, U)));
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      }
      expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [entry])).rows[0].status, "the approval went through").toBe("posted");
      await expectNoFlag("self_approval", "journal_entry", entry);
    });

    it("control: a refused approval leaves no flag (the flag is written after the act, in its transaction)", async () => {
      // the draft is made while July is open; the month then closes, and the same person's approval is refused
      const entry = await A(U)(async () => (await journalEntriesService.create({ entryNumber: `R11A-${++seq}`, date: "2026-07-15", description: "R-11a in a month that closes", lines: [
        { accountId: expense, accountName: "Other Expenses", debitAmount: 100, creditAmount: 0 },
        { accountId: income, accountName: "Other Income", debitAmount: 0, creditAmount: 100 },
      ] }, U) as { id: number }).id);
      await A(U)(() => periodLocksService.lock({ period: "2026-07", userId: U } as never));
      const err = await A(U)(() => journalEntriesService.approve(entry, U)).then(() => null, (e: unknown) => e);
      expect(err, "the closed month refuses the approval").not.toBeNull();
      expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [entry])).rows[0].status).toBe("draft");
      await expectNoFlag("self_approval", "journal_entry", entry);
    });
  });

  describe("THE FIVE PAIRS — flagged at the second act when one person did both", () => {
    it("🔴 approve → pay a bill", async () => {
      const one = await bill(V);
      await approveBill(one, U);
      await A(U)(() => billsService.pay(one, { amount: 1000, paidAt: "2026-10-10", bankAccountId: bankA }, U));
      await expectFlag("pair_approve_pay", "bill", one, U);
      const two = await bill(V);
      await approveBill(two, U);
      await A(V)(() => billsService.pay(two, { amount: 1000, paidAt: "2026-10-10", bankAccountId: bankA }, V));
      await expectNoFlag("pair_approve_pay", "bill", two);
    });

    it("🔴 post → reverse a journal entry (the generic reverse)", async () => {
      const one = await journal(V);
      await A(U)(() => journalEntriesService.approve(one, U));
      await A(U)(() => journalEntriesService.reverse(one, { reason: "R-11a pair" }));
      await expectFlag("pair_post_reverse", "journal_entry", one, U);
      const two = await journal(U);
      await A(V)(() => journalEntriesService.approve(two, V));
      await A(U)(() => journalEntriesService.reverse(two, { reason: "R-11a pair" }));
      await expectNoFlag("pair_post_reverse", "journal_entry", two);
    });

    // Added after the proof commit (register §11.112), for two mutants that would otherwise survive.
    it("control: an expense's approval pays it in the same act — one act, not the approve → pay pair (its payment is made)", async () => {
      const exp = await A(V)(async () => (await billsService.create({ date: DATE, vendorId, vendorReference: `R11A-EXP-${++seq}`, supplierDocumentKind: "tax_invoice",
        subtotal: 200, vatAmount: 0, total: 200, items: [], recordedAsExpense: true, expensePaidFromBankAccountId: bankA, expensePaidAt: DATE } as never, V) as { id: number }).id);
      await approveBill(exp, U);
      expect(Number((await pool.query(`SELECT count(*)::int n FROM bill_payments WHERE bill_id = $1`, [exp])).rows[0].n), "the approval paid it").toBe(1);
      await expectNoFlag("pair_approve_pay", "bill", exp);
    });

    it("control: a document's own reversal (a bank transfer reversed as a transfer) is not the post → reverse pair", async () => {
      const bankB = (await A(U)(() => bankAccountsService.create({ name: `R11a Bank B ${++seq}`, bankName: "SNB", currency: "SAR" }))).id as number;
      const t = await A(U)(() => bankTransfersService.create({ fromBankAccountId: bankA, toBankAccountId: bankB, amount: 100, transferDate: "2026-10-05" }, U)) as { id: number; journalEntryId: number };
      await A(U)(() => bankTransfersService.reverse(t.id, { reason: "keyed the wrong account" }, U));
      expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [t.journalEntryId])).rows[0].status, "the transfer's entry was reversed").toBe("reversed");
      await expectNoFlag("pair_post_reverse", "journal_entry", t.journalEntryId);
    });

    it("🔴 complete → reopen a bank reconciliation", async () => {
      const recon = async (completer: number, reopener: number) => {
        const bank = (await A(U)(() => bankAccountsService.create({ name: `R11a Recon ${++seq}`, bankName: "SNB", currency: "SAR" }))).id as number;
        const rec = await A(completer)(() => bankReconciliationsService.complete({ bankAccountId: bank, asOf: "2026-10-31", statementBalance: 0 }, completer)) as { id: number };
        await A(reopener)(() => bankReconciliationsService.reopen(rec.id, { reason: "Statement re-issued" }, reopener));
        return rec.id;
      };
      await expectFlag("pair_complete_reopen", "bank_reconciliation", await recon(U, U), U);
      await expectNoFlag("pair_complete_reopen", "bank_reconciliation", await recon(U, V));
    });

    it("🔴 commit → reverse a migration", async () => {
      // each batch creates its own capital account: accounts are the ORGANISATION's, so two batches need two codes
      const migrate = async (company: string, committer: number, reverser: number, capitalCode: string) => {
        const run = as(company, committer);
        const bank = (await run(() => bankAccountsService.create({ name: `R11a Mig ${++seq}`, bankName: "SNB", currency: "SAR" }))).id as number;
        const b = await run(() => migrationService.createBatch({ sourceSystem: "PreviousERP", cutoverDate: "2026-07-01" } as never, committer)) as { id: number };
        await run(() => migrationService.importChart(b.id, { rows: [
          { sourceCode: "1100", sourceName: "Bank", sourceType: "asset", openingDebit: 900, sourceRole: "bank", evidenceNote: "Statement at the opening date" },
          { sourceCode: "1200", sourceName: "Debtors", sourceType: "asset", openingDebit: 100, sourceRole: "receivable" },
          { sourceCode: capitalCode, sourceName: `Capital ${seq}`, sourceType: "equity", openingCredit: 1000 },
        ] } as never, committer));
        const chart = await run(() => migrationService.getChart(b.id)) as { rows: Array<{ id: number; sourceCode: string }> };
        const row = (c: string) => chart.rows.find((r) => r.sourceCode === c)!.id;
        await run(() => migrationService.decideChartRow(b.id, row("1100"), { decision: "map_to_bank", targetBankAccountId: bank } as never, committer));
        await run(() => migrationService.decideChartRow(b.id, row("1200"), { decision: "map_to_system", targetSystemCode: "AR" } as never, committer));
        await run(() => migrationService.decideChartRow(b.id, row(capitalCode), { decision: "create" } as never, committer));
        await run(() => migrationStagingService.importParties(b.id, { rows: [{ partyType: "customer", sourceId: `C${seq}`, name: `R11a Opening Customer ${seq}` }] } as never, committer));
        await run(() => migrationStagingService.importOpenItems(b.id, { rows: [{ itemType: "ar", sourceId: `S${seq}`, partySourceId: `C${seq}`, documentNumber: `INV-R11A-${seq}`, issueDate: "2026-06-01", dueDate: "2026-06-30", originalAmount: 100, outstandingAmount: 100 }] } as never, committer));
        const val = await run(() => migrationValidationService.validate(b.id, committer)) as { ok: boolean; checks: unknown[] };
        expect(val.ok, JSON.stringify(val.checks)).toBe(true);
        await run(() => migrationCommitService.commit(b.id, committer));
        await as(company, reverser)(() => migrationCommitService.reverse(b.id, { reason: "the opening was loaded twice" }, reverser));
        return b.id;
      };
      await expectFlag("pair_commit_reverse", "migration_batch", await migrate(co.M1, U, U, "3911"), U);
      await expectNoFlag("pair_commit_reverse", "migration_batch", await migrate(co.M2, U, V, "3912"));
    });

    it("🔴 remit → file a WHT month", async () => {
      const withhold = async (paidAt: string) => {
        const b = await bill(V, nrVendor, 10_000, paidAt.slice(0, 8) + "01");
        await approveBill(b, V);
        await A(V)(() => billsService.pay(b, { amount: 10_000, paidAt, bankAccountId: bankA }, V));
      };
      await withhold("2026-10-10");
      await A(U)(() => whtService.remit("2026-10", { bankAccountId: bankA, paidAt: "2026-11-02" }, U));
      await A(U)(() => whtService.fileReturn("2026-10", { filedOn: businessToday(), zatcaReference: "ZATCA-R11A-10" }, U));
      await expectFlag("pair_remit_file", "wht_return", "2026-10", U);
      await withhold("2026-09-10");
      await A(U)(() => whtService.remit("2026-09", { bankAccountId: bankA, paidAt: "2026-10-05" }, U));
      await A(V)(() => whtService.fileReturn("2026-09", { filedOn: "2026-10-10", zatcaReference: "ZATCA-R11A-09" }, V));
      await expectNoFlag("pair_remit_file", "wht_return", "2026-09");
    });
  });

  describe("THE STORE and THE READER", () => {
    it("🔴 append-only for every role, the owner included: UPDATE, DELETE and TRUNCATE refused", async () => {
      expect((await flags()).length, "flags exist to refuse changes to").toBeGreaterThan(0);
      for (const stmt of [
        `UPDATE control_flags SET kind = 'self_approval' WHERE organization_id = '${orgId}'`,
        `DELETE FROM control_flags WHERE organization_id = '${orgId}'`,
        `TRUNCATE control_flags`,
      ]) {
        const err = await pool.query(stmt).then(() => null, (e: Error) => e.message);
        expect(err, stmt).toMatch(/append-only/);
      }
    });

    it("🔴 a flag naming anyone but the declared actor is refused", async () => {
      const err = await A(U)(() => db.execute(sql`INSERT INTO control_flags (kind, actor_user_id, entity_type, entity_id, first_act, second_act) VALUES ('self_approval', ${V}, 'journal_entry', '1', 'created', 'approved')`))
        .then(() => null, (e: Error) => String((e as { cause?: Error }).cause?.message ?? e.message));
      expect(err).toMatch(/declared actor/);
    });

    // Added after the proof commit (register §11.113): the store's one exit is its company's removal.
    it("🔴 a flag leaves only with its company: refused on its own; deleting the company takes it", async () => {
      const gone = await h.mkCompany(orgId, "R11a Gone", "319191919192003");
      const q = await as(gone, U)(async () => (await quotationsService.create({ date: DATE, customerId, items: [{ description: "Offer", quantity: 1, unitPrice: 100, vatRate: 15 }] } as never, U) as { id: number }).id);
      await as(gone, U)(() => quotationsService.approve(q, U));
      expect(await flags({ company_id: gone }), "the company has its flag").toHaveLength(1);
      const alone = await pool.query(`DELETE FROM control_flags WHERE company_id = $1`, [gone]).then(() => null, (e: Error) => e.message);
      expect(alone, "never on its own").toMatch(/append-only/);
      // the company's own documents first (their keys do not cascade); then the company, whose removal takes its flags
      await replica(pool).query(`DELETE FROM quotation_items WHERE quotation_id = $1`, [q]);
      await replica(pool).query(`DELETE FROM quotations WHERE id = $1`, [q]);
      await pool.query(`DELETE FROM companies WHERE id = $1`, [gone]);
      expect(await flags({ company_id: gone }), "gone with its company").toHaveLength(0);
    });

    it("🔴 GET /control-flags: the approvers read the flags and their total; a bookkeeper and a viewer are refused", async () => {
      const all = await flags({ company_id: co.A });
      const admin = await h.api("admin", "GET", "/control-flags?limit=200");
      expect(admin.status, JSON.stringify(admin.body)).toBe(200);
      expect(admin.body.total).toBe(all.length);
      expect(admin.body.items.length).toBe(all.length);
      const mine = admin.body.items.find((f: { kind: string; actorUserId: number }) => f.kind === "self_approval" && f.actorUserId === U);
      expect(mine, "a self-approval flag, with the person's name").toBeTruthy();
      expect(mine.actorName).toBeTruthy();
      expect((await h.api("accountant", "GET", "/control-flags")).status).toBe(200);
      expect((await h.api("bookkeeper", "GET", "/control-flags")).status).toBe(403);
      expect((await h.api("viewer", "GET", "/control-flags")).status).toBe(403);
      void B; void W;
    });
  });
});
