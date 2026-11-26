/**
 * 🔴 19B review follow-up, item 5 (owner, 2026-11-24) — THE CANARY SWEEP. "The review finds fields by name": a field the
 * class table never names, a nested copy, a free-text echo would pass it. So: plant a UNIQUE value in every protected
 * field, call EVERY GET route as a viewer and as a bookkeeper, and assert no canary appears ANYWHERE in a response the
 * role may not read it in — nested fields and free text included (the raw response text is scanned, not the JSON's
 * named fields).
 *
 *  - Which role may read a canary is the MATRIX's answer (`field.<class>.read` on its resource), so the same sweep runs
 *    for S2a's classes now and — primed with S2b's and S2c's planned removals — for theirs (`SWEEP_MATRICES`). S2b's
 *    are primed (S2B_REMOVALS), with a supplier paid with tax withheld so the withholding-tax routes carry its
 *    address (D9 d).
 *  - 🔴 NOT VACUOUS: every canary must be FOUND by the admin on at least one route (a canary nobody can see proves no
 *    withholding), and the sweep must have exercised a floor of routes; the routes it could not fill (a path
 *    parameter it has no record for) are counted and printed — the frame beside the result.
 *  - Payroll is run over TWO employees: a one-employee run's totals are that person's pay, which v4 §5.4 accepts and
 *    names; two keep the totals from equalling a canary.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3244";
process.env.SESSION_SECRET ??= "field-class-canary-sweep-000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX, S2B_REMOVALS, S2C_REMOVALS, fieldGrantAction, type PermissionRow, type ProtectedFieldClass } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { CONTRACT } from "../lib/fieldClasses/contractShapes.generated";
import { OUTSIDE_CONTRACT_ROUTES } from "../lib/fieldClasses/outsideContract";
import { EXPORTABLE_REPORTS } from "../services/reporting/reportExport.service";
import { approveHeldIbans } from "./helpers/approveHeldIbans";
import { g04Harness } from "./helpers/g04Harness";
import { writeFileSync } from "node:fs";
import { __setDefaultDenyForTests } from "../lib/fieldClasses/defaultDeny";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "field-class-canary-sweep-password";
const h = g04Harness("canary");

function saIban(bban: string): string {
  const n = BigInt(`${bban}281000`);
  return `SA${String(98n - (n % 97n)).padStart(2, "0")}${bban}`;
}

/** Every planted value, with the class and resource that protect it. `also`: other forms of the same secret. */
type Canary = { what: string; value: string; cls: ProtectedFieldClass; resource: string; also?: string[] };
const EMP_IBAN = saIban("60000000771234509876");
const SUP_IBAN = saIban("70000000881234598765");
const CANARIES: Canary[] = [
  // S2a — employees and payroll
  { what: "employee national ID", value: "1093771456", cls: "identity", resource: "employees" },
  { what: "employee GOSI number", value: "GOSI-CANARY-77104", cls: "identity", resource: "employees" },
  { what: "employee IBAN", value: EMP_IBAN, cls: "bank_account", resource: "employees", also: [EMP_IBAN.slice(0, -4)] },
  { what: "employee basic salary", value: "9137.43", cls: "compensation", resource: "employees" },
  { what: "employee housing allowance", value: "2861.19", cls: "compensation", resource: "employees" },
  { what: "employee notes", value: "CANARY-EMP-NOTE-51203", cls: "compensation", resource: "employees" },
  // S2b — customers and suppliers (every role reads them until S2b's removals)
  { what: "customer national ID", value: "1084215573", cls: "identity", resource: "customers" },
  { what: "customer phone", value: "+966500071399", cls: "contact", resource: "customers" },
  { what: "customer email", value: "canary.customer.88@example.sa", cls: "contact", resource: "customers" },
  { what: "customer address", value: "CANARY-STREET-77120", cls: "contact", resource: "customers" },
  { what: "customer street (printed on the invoice)", value: "CANARY-CUST-STREET-55121", cls: "contact", resource: "customers" },
  { what: "supplier phone", value: "+966500082411", cls: "contact", resource: "vendors" },
  { what: "supplier email", value: "canary.supplier.41@example.sa", cls: "contact", resource: "vendors" },
  { what: "supplier address (on the withholding-tax return)", value: "CANARY-SUPP-ADDR-66120", cls: "contact", resource: "vendors" },
  { what: "supplier IBAN", value: SUP_IBAN, cls: "bank_account", resource: "vendors", also: [SUP_IBAN.slice(0, -4)] },
  // S2c — the bank's own text
  { what: "bank line text", value: "CANARY-BANKTEXT-33917", cls: "bank_narrative", resource: "journal_entries" },
];

/** The matrices the sweep runs under: today's (S2a's classes switched on). S2b and S2c add their planned removals. */
const S2B_PENDING = new Set(S2B_REMOVALS.map((r) => `${r.role}:${r.resource}:${r.action}`));
const S2C_PENDING = new Set(S2C_REMOVALS.map((r) => `${r.role}:${r.resource}:${r.action}`));
const SWEEP_MATRICES: Array<{ name: string; rows: PermissionRow[] }> = [
  // Restated for the S2b and S2c removals: the matrix itself lacks S2a's, S2b's and S2c's removals; the filters below are
  // now the identity and stay, so the sweep keeps naming both sets.
  { name: "the current matrix (S2a + S2b + S2c)", rows: PERMISSION_MATRIX.filter((r) => !S2B_PENDING.has(`${r.role}:${r.resource}:${r.action}`) && !S2C_PENDING.has(`${r.role}:${r.resource}:${r.action}`)) },
];

const ROLES_SWEPT = ["viewer", "bookkeeper"] as const;
// not JSON (a file: a PDF, an image, a stream) or not a read (logout); the LLM routes are reached by their own suite
const SKIP = [/\/logout/, /\/llm\//, /\/pdf/, /\/document(\/|$)/, /\/stream/, /\/download/, /\/logo$/];

describeDb("19B — the canary sweep: no protected value reaches a role that may not read it, on any GET route", () => {
  let orgId = "";
  const ids: Record<string, number | string> = {};
  /** `pathFor`: a route whose record is the caller's own (a delivered copy) is called with that caller's id. */
  const routes: { key: string; path: string; pathFor?: (who: string) => string }[] = [];
  const pathOf = (r: { path: string; pathFor?: (who: string) => string }, who: string) => r.pathFor?.(who) ?? r.path;
  const unresolved: string[] = [];

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    ids.org = orgId;
    await h.mkCompany(orgId, "Canary Co", "319191919191973");
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) await h.mkUser(role, PW, orgId, role);
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) expect(await h.login(role, h.email(role), PW)).toBe(200);
    const ok = async (who: string, method: string, path: string, body?: unknown) => {
      const r = await h.api(who, method, path, body);
      expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
      return r.body;
    };
    const c = (what: string) => CANARIES.find((x) => x.what === what)!.value;
    // employees: the canaried one and an ordinary one (two, so the run's totals are no one's pay)
    ids.emp = (await ok("accountant", "POST", "/employees", {
      employeeNumber: "CAN-E1", name: "Canary Employee", jobTitle: "Clerk", department: "Finance", nationality: "SA", gosiRegime: "law_1421h", gosiRegimeBasis: "certificate",
      nationalId: c("employee national ID"), gosiNumber: c("employee GOSI number"), iban: EMP_IBAN,
      basicSalary: Number(c("employee basic salary")), housingAllowance: Number(c("employee housing allowance")), transportAllowance: 400,
      notes: c("employee notes"), joiningDate: "2025-01-01",
    })).id;
    await ok("accountant", "POST", "/employees", { employeeNumber: "CAN-E2", name: "Ordinary Employee", jobTitle: "Driver", department: "Ops", nationality: "SA", gosiRegime: "law_1421h", gosiRegimeBasis: "certificate", nationalId: "1022334455", basicSalary: 4000, housingAllowance: 1000, transportAllowance: 300, joiningDate: "2025-01-01" });
    ids.run = (await ok("accountant", "POST", "/payroll", { period: "2026-10" })).id;
    // customers and suppliers
    ids.cust = (await ok("accountant", "POST", "/customers", { name: "Canary Customer", nationalId: c("customer national ID"), phone: c("customer phone"), email: c("customer email"), address: c("customer address"), street: c("customer street (printed on the invoice)"), city: "Riyadh" })).id;
    ids.vendor = (await ok("accountant", "POST", "/vendors", { name: "Canary Supplier", residency: "resident", phone: c("supplier phone"), email: c("supplier email"), iban: SUP_IBAN })).id;
    expect(await approveHeldIbans(h, "admin")).toBe(2); // the employee's and the supplier's IBANs, held at entry (S3)
    // documents that name them: a draft invoice to the canary customer, a draft bill from the canary supplier
    ids.inv = (await ok("accountant", "POST", "/invoices", { date: "2026-10-05", customerId: ids.cust, items: [{ description: "Services", quantity: 1, unitPrice: 1000, vatRate: 15 }] })).id;
    ids.bill = (await ok("accountant", "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: "CAN-R-1", billNumber: "CAN-B-1", date: "2026-10-06", dueDate: "2026-10-06", vendorId: ids.vendor, items: [{ description: "Supplies", quantity: 1, unitPrice: 500, vatRate: 15 }] })).id;
    // the bank's own text: a bank row posted from a transaction
    const acct = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
    ids.bank = (await ok("admin", "POST", "/bank-accounts", { name: "Canary Ops", bankName: "SNB", currency: "SAR" })).id;
    ids.txn = (await ok("admin", "POST", "/transactions", { date: "2026-10-10", description: c("bank line text"), amount: 120, currency: "SAR", type: "debit", categoryId: await acct("RENT_UTILITIES"), bankAccountId: ids.bank })).id;
    // 19B S2b (D9 d): a non-resident supplier with an address, paid with tax withheld — so the withholding-tax return,
    // schedule, annual return, beneficiary statement and the withholding itself all name its address
    ids.overseas = (await ok("accountant", "POST", "/vendors", { name: "Canary Overseas", residency: "non_resident", whtDefaultPaymentType: "technical_consulting", country: "GB", address: c("supplier address (on the withholding-tax return)"), city: "London" })).id;
    const wBill = await ok("admin", "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: "CAN-R-W", billNumber: "CAN-B-W", date: "2026-10-12", dueDate: "2026-10-12", vendorId: ids.overseas, items: [{ description: "Consulting", quantity: 1, unitPrice: 10_000, vatRate: 0 }] });
    await ok("admin", "POST", `/bills/${wBill.id}/approve`, {});
    await ok("admin", "POST", `/bills/${wBill.id}/pay`, { amount: 10_000, paidAt: "2026-10-12", bankAccountId: ids.bank });
    ids.wht = (await pool.query(`SELECT id FROM wht_withholdings WHERE bill_id = $1`, [wBill.id])).rows[0].id;
    ids.je = (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND source_type = 'bank_transaction' LIMIT 1`, [orgId])).rows[0].id;

    // ── 🔴 THE 38 ROUTES THE SWEEP USED TO SKIP (owner, 2026-11-26): one record each, made here, so every GET route
    //    is called with a real id. Through the product's own paths wherever one exists over JSON; the two that have
    //    none (a captured document is a file upload; an operator is not an organization's member) are rows.
    const sales = await acct("SALES");
    const bankOf = async (name: string) => (await ok("admin", "POST", "/bank-accounts", { name, bankName: "SNB", currency: "SAR" })).id as number;
    // group A — assets, banking, budgets, capture, period locks, orders, schedules, tax, products, invitations, operator
    const assetCategory = await ok("admin", "POST", "/asset-categories", { name: "Canary class", defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" });
    ids.asset = (await ok("admin", "POST", "/assets", { name: "Canary asset", categoryId: assetCategory.id, acquisitionDate: "2026-10-01", cost: 1000 })).id;
    const statementBank = await bankOf("Canary Statements");
    const uploaded = await ok("admin", "POST", "/transactions/upload", { rows: [{ date: "2026-10-20", description: "SWEEP STATEMENT LINE", amount: 400, type: "credit", currency: "SAR" }], bankAccountId: statementBank, autoCategrize: false, statement: { fileName: "sweep.csv", fileSha256: "c".repeat(64) } });
    ids.statement = uploaded.statement.id;
    ids.statementLine = (await pool.query(`SELECT id FROM transactions WHERE organization_id = $1 AND description = 'SWEEP STATEMENT LINE'`, [orgId])).rows[0].id;
    // a reconciliation locks its bank through its date, so it gets a bank of its own
    ids.reconciliation = (await ok("admin", "POST", "/bank-reconciliations", { bankAccountId: await bankOf("Canary Reconciled"), asOf: "2026-10-25", statementBalance: 0 })).id;
    ids.transfer = (await ok("admin", "POST", "/bank-transfers", { fromBankAccountId: await bankOf("Canary From"), toBankAccountId: await bankOf("Canary To"), amount: 1, transferDate: "2026-10-21", idempotencyKey: "canary-sweep-transfer" })).id;
    const budget = await ok("admin", "POST", "/budgets", { name: "Canary budget", fiscalYearLabel: 2026 });
    await ok("admin", "PUT", `/budgets/${budget.id}/versions/${budget.version.id}/lines`, { lines: [{ accountId: sales, periods: Array(12).fill(1000) }] });
    ids.budget = budget.id;
    ids.capture = (await pool.query(
      `INSERT INTO captured_documents (organization_id, company_id, content_type, byte_size, sha256, source)
       SELECT $1, c.id, 'application/pdf', 10, $2, 'upload' FROM companies c WHERE c.organization_id = $1 RETURNING id`,
      [orgId, "c".repeat(32)],
    )).rows[0].id;
    const po = await ok("admin", "POST", "/purchase-orders", { vendorId: ids.vendor, date: "2026-10-07", items: [{ description: "Stock", quantity: 4, unitPrice: 250, vatRate: 15 }] });
    await ok("admin", "POST", `/purchase-orders/${po.id}/approve`, {});
    await ok("admin", "POST", `/purchase-orders/${po.id}/convert`, { date: "2026-10-08", notes: "sweep", billNumber: "CAN-B-PO", vendorReference: "CAN-R-PO" });
    ids.po = po.id;
    const quotation = await ok("admin", "POST", "/quotations", { customerId: ids.cust, date: "2026-10-07", items: [{ description: "Consulting", quantity: 10, unitPrice: 100, vatRate: 15 }] });
    await ok("admin", "POST", `/quotations/${quotation.id}/approve`, {});
    await ok("admin", "POST", `/quotations/${quotation.id}/convert`, { date: "2026-10-08", notes: "sweep" });
    ids.quotation = quotation.id;
    ids.schedule = (await ok("admin", "POST", "/recognition-schedules", { kind: "accrual", reference: "CAN-RS", description: "Canary accrual", totalAmount: 300, periods: 3, startPeriod: "2026-10", expenseAccountId: await acct("RENT_UTILITIES"), balanceAccountId: await acct("ACCRUED_LIABILITIES") })).id;
    ids.recurring = (await ok("admin", "POST", "/recurring", { entity: "invoice", template: { customerId: ids.cust, items: [{ description: "Monthly service", quantity: 1, unitPrice: 1000, vatRate: 15 }] }, frequency: "monthly", dayOfMonth: 5, startsOn: "2026-12-05", autoIssue: false })).id;
    ids.computation = (await ok("admin", "POST", "/tax/computations", { kind: "income_tax", fiscalYearLabel: 2025 })).id;
    ids.product = (await ok("admin", "POST", "/products", { name: "Canary product", code: "CAN-P1", type: "product", unitPrice: 10, currency: "SAR" })).id;
    const invitation = await ok("admin", "POST", `/orgs/${orgId}/invitations`, { email: h.email("invited"), role: "viewer" });
    ids.invitation = new URL(invitation.link).searchParams.get("token")!;
    // the operator surface: an account with no membership anywhere, made an operator (the database's own rule)
    const operatorId = await h.mkUser("operator", PW, null);
    await pool.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [operatorId]);
    expect(await h.login("operator", h.email("operator"), PW)).toBe(200);
    // group B — receipts and their allocations, credit-note applications, a statement match, a refund; supplier
    // payments and notes; a saved report and each role's own delivered copy; the opening-balance batch
    const walkIn = (await ok("admin", "POST", "/customers", { name: "Sweep Walk-in" })).id as number;
    const issued = async (unitPrice: number, extra: Record<string, unknown> = {}) => {
      const d = await ok("admin", "POST", "/invoices", { date: "2026-10-15", dueDate: "2026-10-31", customerId: walkIn, items: [{ description: "Sweep", quantity: 1, unitPrice, vatRate: 15 }], ...extra });
      await ok("admin", "POST", `/invoices/${d.id}/submit`);
      await ok("admin", "POST", `/invoices/${d.id}/approve`);
      return d.id as number;
    };
    ids.payment = (await ok("admin", "POST", "/payments", { customerId: walkIn, amount: 500, paidAt: "2026-10-16", bankAccountId: ids.bank, classification: "unknown" })).id;
    const allocated = await issued(1000);
    const receipt = await ok("admin", "POST", "/payments", { customerId: walkIn, amount: 1150, paidAt: "2026-10-17", bankAccountId: ids.bank, allocations: [{ invoiceId: allocated, amount: 1150 }] });
    ids.allocation = (await pool.query(`SELECT id FROM payment_allocations WHERE invoice_id = $1 AND payment_id = $2`, [allocated, receipt.id])).rows[0].id;
    const original = await issued(1000);
    await ok("admin", "POST", `/invoices/${original}/pay`, { amount: 1150, bankAccountId: ids.bank, paidAt: "2026-10-18" });
    ids.creditNote = await issued(10, { documentType: "credit_note", originalInvoiceId: original, noteReason: "Price correction" });
    await ok("admin", "POST", `/payments/credit-notes/${ids.creditNote}/apply`, { allocations: [{ invoiceId: await issued(200), amount: 1 }] });
    const matchBank = await bankOf("Canary Matching");
    const toMatch = await ok("admin", "POST", "/payments", { customerId: walkIn, amount: 800, bankAccountId: matchBank, paidAt: "2026-10-19", method: "transfer", reference: "SWEEP-DEP-800", allocations: [] });
    await ok("admin", "POST", "/transactions/upload", { bankAccountId: matchBank, rows: [{ date: "2026-10-20", description: "SWEEP INCOMING 800", amount: 800, type: "credit", currency: "SAR" }] });
    const matchLine = (await pool.query(`SELECT id FROM transactions WHERE organization_id = $1 AND description = 'SWEEP INCOMING 800'`, [orgId])).rows[0].id;
    ids.match = (await ok("admin", "POST", "/payments/matching/override", { transactionId: matchLine, paymentId: toMatch.id, reason: "Bank advice confirms this receipt" })).id;
    const deposit = await ok("admin", "POST", "/payments", { customerId: walkIn, amount: 50, bankAccountId: ids.bank, paidAt: "2026-10-19" });
    ids.refund = (await ok("admin", "POST", "/payments/refunds", { customerId: walkIn, origin: "deposit", paymentId: deposit.id, amount: 10, bankAccountId: ids.bank, reason: "returned" })).id;
    const lessor = (await ok("admin", "POST", "/vendors", { name: "Sweep Lessor", residency: "resident" })).id as number;
    ids.supplierPayment = (await ok("admin", "POST", "/supplier-payments", { vendorId: lessor, bankAccountId: ids.bank, amount: 1000, paidAt: "2026-10-10", classification: "security_deposit" })).id;
    await ok("admin", "POST", `/supplier-payments/${ids.supplierPayment}/forfeitures`, { forfeitedOn: "2026-10-15", amount: 400, classification: "not_consideration", reason: "The supplier keeps it under clause 9: the lease ended early" });
    const lessorBill = await ok("admin", "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: "SWEEP-SUP-1", billNumber: "SWEEP-B-1", date: "2026-10-11", dueDate: "2026-10-31", vendorId: lessor, items: [{ description: "Supplies", quantity: 1, unitPrice: 1000, vatRate: 0 }] });
    await ok("admin", "POST", `/bills/${lessorBill.id}/approve`, {});
    const note = await ok("admin", "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: "SWEEP-SUP-CN-1", billNumber: "SWEEP-CN-1", date: "2026-10-13", vendorId: lessor, documentType: "credit_note", creditNoteAgainstBillId: lessorBill.id, items: [{ description: "Returned supplies", quantity: 1, unitPrice: 500, vatRate: 0 }] });
    await ok("admin", "POST", `/bills/${note.id}/approve`, {});
    ids.supplierNote = note.id;
    // a saved report shared with every role, scheduled to every role: each then opens ITS OWN delivered copy — journal
    // lines, so the bank's own text (a canary) is in the copies of the roles that may read it and in no other
    const definition = await ok("accountant", "POST", "/report-definitions", { name: "Sweep lines", dataset: "journal_lines", columns: [], period: { kind: "fixed", from: "2026-10-01", to: "2026-10-31" }, filters: {}, sort: null, groupBy: "accountId" });
    await ok("accountant", "PUT", `/report-definitions/${definition.id}/share`, { roles: ["admin", "accountant", "bookkeeper", "viewer"] });
    ids.definition = definition.id;
    const members = (await pool.query(`SELECT u.id FROM users u JOIN organization_memberships m ON m.user_id = u.id WHERE m.organization_id = $1 ORDER BY u.id`, [orgId])).rows.map((r) => r.id as number);
    await ok("accountant", "POST", "/report-schedules", { definitionId: definition.id, cadence: "daily", recipientUserIds: members });
    const delivered = await (await import("../services/reporting/reportSchedules.job")).reportSchedulesJob.runOnce(new Date("2026-11-02T09:00:00Z"), orgId);
    expect([delivered.delivered, delivered.refused, delivered.failed]).toEqual([4, 0, 0]);
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) ids[`delivery:${role}`] = (await ok(role, "GET", "/report-deliveries")).items[0].id;
    // the opening-balance batch, committed (its reversal preview needs that): cut over on 1 July, before anything above
    const openingBank = (await ok("admin", "POST", "/bank-accounts", { name: "Canary Opening", bankName: "Riyad Bank", currency: "SAR", balance: 0, openingBalance: 0 })).id;
    const batch = await ok("admin", "POST", "/migration/batches", { sourceSystem: "PreviousERP", cutoverDate: "2026-07-01" });
    const chart = await ok("admin", "PUT", `/migration/batches/${batch.id}/chart`, { rows: [
      { sourceCode: "1100", sourceName: "Riyad Bank", sourceType: "asset", openingDebit: 1150, sourceRole: "bank", evidenceNote: "statement 30 Jun" },
      { sourceCode: "1200", sourceName: "Debtors", sourceType: "asset", openingDebit: 1000, sourceRole: "receivable" },
      { sourceCode: "2300", sourceName: "Advances", sourceType: "liability", openingCredit: 150, sourceRole: "customer_deposits" },
      { sourceCode: "3100", sourceName: "Capital", sourceType: "equity", openingCredit: 2000 },
    ] });
    const chartRow = (code: string) => (chart.rows as { id: number; sourceCode: string }[]).find((r) => r.sourceCode === code)!.id;
    await ok("admin", "PATCH", `/migration/batches/${batch.id}/chart/${chartRow("1100")}`, { decision: "map_to_bank", targetBankAccountId: openingBank });
    await ok("admin", "PATCH", `/migration/batches/${batch.id}/chart/${chartRow("1200")}`, { decision: "map_to_system", targetSystemCode: "AR" });
    await ok("admin", "PATCH", `/migration/batches/${batch.id}/chart/${chartRow("2300")}`, { decision: "map_to_system", targetSystemCode: "CUSTOMER_DEPOSITS" });
    await ok("admin", "PATCH", `/migration/batches/${batch.id}/chart/${chartRow("3100")}`, { decision: "create" });
    await ok("admin", "PUT", `/migration/batches/${batch.id}/parties`, { rows: [{ partyType: "customer", sourceId: "C1", name: "Sweep Opening Customer" }] });
    await ok("admin", "PUT", `/migration/batches/${batch.id}/open-items`, { rows: [{ itemType: "ar", sourceId: "SI-1", partySourceId: "C1", documentNumber: "SWEEP-OPEN-1", issueDate: "2026-06-01", dueDate: "2026-06-30", originalAmount: 1000, outstandingAmount: 1000 }] });
    await ok("admin", "PUT", `/migration/batches/${batch.id}/advances`, { rows: [{ sourceId: "ADV-1", partySourceId: "C1", bankSourceCode: "1100", amount: 150, receivedAt: "2026-06-10", vatPosition: "unknown" }] });
    const validated = await ok("admin", "POST", `/migration/batches/${batch.id}/validate`);
    expect(validated.ok, JSON.stringify(validated.checks)).toBe(true);
    expect((await ok("admin", "POST", `/migration/batches/${batch.id}/commit`)).status).toBe("committed");
    ids.batch = batch.id;
    // October's withholding return, recorded as filed (its correction pack answers only then)
    await ok("admin", "POST", "/tax/wht/returns/2026-10/file", { filedOn: "2026-11-05", zatcaReference: "SWEEP-ZATCA-REF-1" });
    ids.sales = sales;
    // a closed month's history: a month nothing here posts into, closed last
    await ok("admin", "POST", "/period-locks", { period: "2026-03" });

    // every GET route: the contract's and those outside it, each path parameter filled from the planted records
    const fill: Array<[RegExp, Record<string, () => number | string>]> = [
      [/^\/employees\//, { id: () => ids.emp! }],
      [/^\/payroll\//, { id: () => ids.run! }],
      [/^\/customers\//, { id: () => ids.cust! }],
      [/^\/vendors\//, { id: () => ids.vendor! }],
      [/^\/supplier-statements\//, { vendorId: () => ids.vendor! }],
      [/^\/journal-entries\//, { id: () => ids.je! }],
      [/^\/transactions\//, { id: () => ids.txn! }],
      [/^\/bank-accounts\//, { id: () => ids.bank! }],
      [/^\/orgs\//, { orgId: () => orgId }],
      [/^\/invoices\//, { id: () => ids.inv! }],
      [/^\/bills\//, { id: () => ids.bill! }],
      [/^\/tax\/wht\/beneficiaries\//, { vendorId: () => ids.overseas! }],
      [/^\/tax\/wht\/returns\//, { period: () => "2026-10" }],
      [/^\/tax\/wht\/withholdings\//, { id: () => ids.wht! }],
      // the 38 (2026-11-26)
      [/^\/assets\//, { id: () => ids.asset! }],
      [/^\/bank-reconciliation\/lines\//, { id: () => ids.statementLine! }],
      [/^\/bank-reconciliations\//, { id: () => ids.reconciliation! }],
      [/^\/bank-statements\//, { id: () => ids.statement! }],
      [/^\/bank-transfers\//, { id: () => ids.transfer! }],
      [/^\/budgets\//, { id: () => ids.budget! }],
      [/^\/capture\//, { id: () => ids.capture! }],
      [/^\/period-locks\//, { period: () => "2026-03" }],
      [/^\/purchase-orders\//, { id: () => ids.po! }],
      [/^\/quotations\//, { id: () => ids.quotation! }],
      [/^\/recognition-schedules\//, { id: () => ids.schedule! }],
      [/^\/recurring\//, { id: () => ids.recurring! }],
      [/^\/tax\/computations\//, { id: () => ids.computation! }],
      [/^\/products\//, { id: () => ids.product! }],
      [/^\/invitations\//, { token: () => ids.invitation! }],
      [/^\/operator\/applications\//, { orgId: () => orgId }],
      [/^\/payments\/allocations\//, { id: () => ids.allocation! }],
      [/^\/payments\/credit-notes\//, { id: () => ids.creditNote! }],
      [/^\/payments\/matching\//, { id: () => ids.match! }],
      [/^\/payments\/refunds\//, { id: () => ids.refund! }],
      [/^\/payments\//, { id: () => ids.payment! }],
      [/^\/supplier-credit-notes\//, { id: () => ids.supplierNote! }],
      [/^\/supplier-payments\//, { id: () => ids.supplierPayment! }],
      [/^\/migration\/batches\//, { id: () => ids.batch! }],
      [/^\/report-definitions\//, { id: () => ids.definition! }],
    ];
    // 🔴 the query a route cannot answer without (2026-11-26): without it the route answered 400 and its body was never
    // read — counted as swept, and measuring nothing
    const months = "from=2026-01&to=2026-12";
    const REQUIRED: Record<string, () => string> = {
      "/analytics/trend": () => months, "/analytics/pnl-trend": () => months, "/analytics/receivables-bridge": () => months, "/analytics/cash": () => months,
      "/analytics/decomposition": () => "dimension=category&from=2026-01-01&to=2026-12-31",
      "/bank-reconciliations/position": () => `bankAccountId=${ids.bank}`,
      "/reports/account-statement": () => `account_id=${ids.sales}`,
      "/tax/wht/exceptions": () => "kind=undeclared",
      "/tax/wht/preview": () => `vendorId=${ids.overseas}&amount=100`,
    };
    const keys = [
      ...CONTRACT.operations.filter((op) => op.method === "GET").map((op) => op.path),
      ...Object.keys(OUTSIDE_CONTRACT_ROUTES).filter((k) => k.startsWith("GET ")).map((k) => k.slice(4)),
    ];
    for (const key of [...new Set(keys)]) {
      if (SKIP.some((re) => re.test(key))) continue;
      // every report export, as CSV (a PDF needs the renderer CI does not have): exports carry addresses and bank text
      if (key === "/reports/export/{report}") {
        // each with the parameter it cannot answer without (2026-11-26: three of these used to answer 400, unread)
        const needs: Record<string, string> = { "budget-vs-actual": `&budget_id=${ids.budget}`, "wht-return": "&period=2026-10", "tax-computation": `&computation_id=${ids.computation}` };
        for (const report of EXPORTABLE_REPORTS) routes.push({ key: `${key} (${report})`, path: `/reports/export/${report}?format=csv&date_from=2026-01-01&date_to=2026-12-31${needs[report] ?? ""}` });
        continue;
      }
      // a delivered copy opens for its recipient alone: each role is given its own
      if (key === "/report-deliveries/{id}") {
        routes.push({ key, path: `/report-deliveries/${ids["delivery:admin"]}`, pathFor: (who) => `/report-deliveries/${ids[`delivery:${who}`] ?? ids["delivery:admin"]}` });
        continue;
      }
      const params = [...key.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
      const rule = fill.find(([re]) => re.test(key))?.[1];
      if (params.some((p) => !rule?.[p])) { unresolved.push(key); continue; }
      const path = key.replace(/\{(\w+)\}/g, (_, p: string) => String(rule![p]!()));
      routes.push({ key, path: `${path}${path.includes("?") ? "&" : "?"}date_from=2026-01-01&date_to=2026-12-31${REQUIRED[key] ? `&${REQUIRED[key]!()}` : ""}` });
    }
  }, 480_000);
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); await h.stop(); await h.cleanup(); });

  const seen = async (who: string) => {
    const found = new Map<string, string[]>(); // canary → routes it appeared in
    let answered = 0;
    for (const r of routes) {
      const res = await h.api(who, "GET", pathOf(r, who));
      if (res.status < 500) answered++;
      for (const c of CANARIES) for (const v of [c.value, ...(c.also ?? [])]) if (res.text.includes(v)) found.set(c.what, [...(found.get(c.what) ?? []), `${r.key}${v === c.value ? "" : " (partial)"}`]);
    }
    return { found, answered };
  };

  it("🔴 the frame: EVERY GET route is swept — each path parameter filled from a record this sweep created (owner, 2026-11-26: the 38 it used to skip)", () => {
    console.log(`[CANARY-SWEEP] ${routes.length} GET routes swept; ${unresolved.length} not filled: ${unresolved.join(", ")}`);
    expect(unresolved).toEqual([]);
    const swept = new Set(routes.map((r) => r.key));
    const noParam = [...CONTRACT.operations.filter((op) => op.method === "GET").map((op) => op.path), ...Object.keys(OUTSIDE_CONTRACT_ROUTES).filter((k) => k.startsWith("GET ")).map((k) => k.slice(4))]
      .filter((k) => !k.includes("{") && !SKIP.some((re) => re.test(k)));
    expect(noParam.length).toBeGreaterThan(80); // the enumeration itself is not broken
    expect(noParam.filter((k) => !swept.has(k))).toEqual([]);
    // and every route that can serve a planted record's own fields is filled
    for (const k of ["/employees/{id}", "/payroll/{id}", "/customers/{id}", "/vendors/{id}", "/invoices/{id}", "/bills/{id}", "/journal-entries/{id}", "/transactions/{id}"]) expect([k, swept.has(k)]).toEqual([k, true]);
  });

  it("🔴 NOT VACUOUS: the admin finds every canary on at least one route", async () => {
    primePermissionCache(PERMISSION_MATRIX);
    const { found } = await seen("admin");
    expect(CANARIES.filter((c) => !found.has(c.what)).map((c) => c.what)).toEqual([]);
  }, 300_000);

  for (const m of SWEEP_MATRICES) {
    it(`🔴 under ${m.name}: no canary reaches a viewer or a bookkeeper that may not read it — anywhere in any response`, async () => {
      primePermissionCache(m.rows);
      const grants = new Set(m.rows.map((r) => `${r.role}:${r.resource}:${r.action}`));
      const leaks: string[] = [];
      for (const role of ROLES_SWEPT) {
        const { found, answered } = await seen(role);
        expect([role, answered]).toEqual([role, routes.length]); // every route answered (a 5xx would hide a body)
        for (const c of CANARIES) {
          const mayRead = grants.has(`${role}:${c.resource}:${fieldGrantAction(c.cls, "read")}`);
          if (!mayRead && found.has(c.what)) leaks.push(`${role} — ${c.what} (${c.cls} on ${c.resource}): ${found.get(c.what)!.join("; ")}`);
        }
      }
      expect(leaks).toEqual([]);
      primePermissionCache(PERMISSION_MATRIX);
    }, 300_000);
  }

  /**
   * 🔴 DEFAULT DENY, ENFORCED (owner, 2026-11-26: on by default; "cover the 38 routes the sweep skipped … and show for
   * each role what they withhold"). The enforcement is asked for (the test lane otherwise answers an unclassified key
   * with a 500 by name), every swept route is called as each role, and what the seam REMOVED is read back from
   * `X-Withheld` — the mechanism itself, not a prediction of it: both what the role's own grants withhold (path, class
   * and level, per route) and anything removed as `unclassified`. With DEFAULT_DENY_DRY_RUN_FILE set, the whole
   * per-role, per-route record is written there.
   *
   *  - The probe is shown to SEE: the same header carries what the role's own grants withhold, and a viewer's sweep
   *    must find some (a probe that read nothing would report "nothing withheld" just the same).
   *  - The frame beside the count: GET routes that answer JSON, on this fixture's records (files — a PDF, an image, a
   *    stream — are not swept). A field served only by a write's response, or only on data this fixture lacks, is not
   *    measured here — the contract test (every 2xx field has a class) and the test lane's 500 on any unclassified key
   *    cover it.
   *  - It is a standing check: default deny withholds NOTHING on any GET route today, for any role.
   *  - 🔴 And every route must ANSWER WITH ITS BODY to the admin (or, on the operator's surface, to the operator): until
   *    2026-11-26 fourteen routes answered 400, 404 or 409 for want of a parameter or a record, were counted as swept,
   *    and measured nothing.
   */
  it("🔴 default deny, enforced: every swept route answers with its body, and per role nothing unclassified is withheld — what each role's own grants withhold is recorded, route by route", async () => {
    primePermissionCache(PERMISSION_MATRIX);
    type Withheld = { path: string; class: string; level: string };
    const report: Record<string, { applies: boolean; routesSwept: number; answered: number; routesWithholdingByGrant: number; wouldWithhold: { route: string; paths: string[] }[]; perRoute: Record<string, { status: number; withheldByGrant: Withheld[]; unclassified: string[]; refusal?: string }> }> = {};
    __setDefaultDenyForTests(true);
    try {
      // the four organization roles, and the platform operator (no organization role: never denied) for its own surface
      for (const role of ["admin", "accountant", "bookkeeper", "viewer", "operator"]) {
        let answered = 0;
        let byGrant = 0;
        const wouldWithhold: { route: string; paths: string[] }[] = [];
        const perRoute: Record<string, { status: number; withheldByGrant: Withheld[]; unclassified: string[]; refusal?: string }> = {};
        for (const r of routes) {
          const res = await h.api(role, "GET", pathOf(r, role));
          if (res.status < 500) answered++;
          const listed: Withheld[] = res.headers["x-withheld"] ? JSON.parse(res.headers["x-withheld"]) : [];
          const unclassified = listed.filter((w) => w.class === "unclassified").map((w) => w.path);
          if (listed.some((w) => w.class !== "unclassified")) byGrant++;
          perRoute[r.key] = { status: res.status, withheldByGrant: listed.filter((w) => w.class !== "unclassified"), unclassified, ...(res.status >= 300 ? { refusal: `${res.body?.code ?? ""}: ${res.body?.error ?? ""}`.slice(0, 240) } : {}) };
          // the admin is never denied: an unclassified key in an admin's answer is the test lane's 500, named
          if (res.status === 500 && res.body?.code === "field_unclassified") wouldWithhold.push({ route: r.key, paths: res.body.fields });
          else if (unclassified.length) wouldWithhold.push({ route: r.key, paths: unclassified });
        }
        report[role] = { applies: role !== "admin", routesSwept: routes.length, answered, routesWithholdingByGrant: byGrant, wouldWithhold, perRoute };
      }
    } finally {
      __setDefaultDenyForTests(null);
    }
    const out = process.env.DEFAULT_DENY_DRY_RUN_FILE;
    if (out) writeFileSync(out, JSON.stringify({ routesSwept: routes.length, notFilled: unresolved, perRole: report }, null, 2));
    console.log(`[DEFAULT-DENY-DRY-RUN] ${Object.entries(report).map(([role, r]) => `${role}: ${r.wouldWithhold.length} route(s) would lose a field, of ${r.answered} answered`).join(" | ")}`);
    // every route answered for every role (a 5xx would hide what it serves)
    expect(Object.entries(report).map(([role, r]) => [role, r.answered])).toEqual(["admin", "accountant", "bookkeeper", "viewer", "operator"].map((role) => [role, routes.length]));
    // 🔴 NOT VACUOUS, route by route: every swept route ANSWERS WITH ITS BODY (2xx) to the admin — or, on the operator's
    // own surface, to the operator. A 400 or a 404 would be "swept" and read nothing.
    const unread = routes.map((r) => r.key).filter((k) => (k.startsWith("/operator/") ? report.operator!.perRoute[k]!.status : report.admin!.perRoute[k]!.status) >= 300)
      .map((k) => `${k} → ${(k.startsWith("/operator/") ? report.operator! : report.admin!).perRoute[k]!.status} ${(k.startsWith("/operator/") ? report.operator! : report.admin!).perRoute[k]!.refusal ?? ""}`);
    expect(unread).toEqual([]);
    // 🔴 the probe reads the header: the viewer's own grants withhold something on some route
    expect(report.viewer!.routesWithholdingByGrant).toBeGreaterThan(0);
    // 🔴 the result: nothing unclassified would be withheld, for any role
    expect(Object.fromEntries(Object.entries(report).map(([role, r]) => [role, r.wouldWithhold]))).toEqual({ admin: [], accountant: [], bookkeeper: [], viewer: [], operator: [] });
  }, 600_000);
});
