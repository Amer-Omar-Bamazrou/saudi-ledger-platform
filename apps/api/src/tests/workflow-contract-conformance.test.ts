/**
 * WORKFLOW CONTRACT CONFORMANCE — quotations, purchase orders, budgets,
 * recurring rules, and the pending-approvals queue, on REAL ROWS (contract
 * milestone, batch 5 — the last money batch; the stop is recorded in the
 * findings file). Same instrument as the four earlier conformance suites.
 *
 * ── 🔴 THE QUEUE'S TWO OWNER HOLDS, PINNED AS ASSERTIONS ────────────────────
 * 1. UNBOUNDED: the old page fetched the default page (50) per entity and
 *    filtered client-side, so pending drafts older than the newest 50
 *    documents were invisible. The fixture seeds MORE pending invoices than
 *    the old cap and asserts every one appears — a cap returning through the
 *    new endpoint fails here, by construction.
 * 2. ONE AGGREGATE: a journal entry's queue amount must equal the sum of its
 *    lines — the same aggregate the ledger list uses — never zero, never a
 *    second computation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import {
  CreateQuotationBody,
  CreateQuotationResponse,
  GetQuotationResponse,
  UpdateQuotationBody,
  UpdateQuotationResponse,
  ConvertQuotationBody,
  ConvertQuotationResponse,
  ListQuotationConversionsResponse,
  CreatePurchaseOrderBody,
  CreatePurchaseOrderResponse,
  GetPurchaseOrderResponse,
  ConvertPurchaseOrderBody,
  ConvertPurchaseOrderResponse,
  ListPurchaseOrderConversionsResponse,
  ListBudgetsResponse,
  CreateBudgetBody,
  CreateBudgetResponse,
  UpdateBudgetBody,
  UpdateBudgetResponse,
  ListRecurringRulesResponse,
  GetRecurringRuleRunsResponse,
  PauseRecurringRuleResponse,
  ListPendingApprovalsResponse,
} from "@workspace/api-zod";
import { auditContext } from "../lib/auditContext";
import { primePermissionCache, resetPermissionCache } from "../lib/rbac";
import { quotationsService } from "../services/quotations.service";
import { quotationConversionService } from "../services/quotationConversion.service";
import { purchaseOrdersService } from "../services/purchaseOrders.service";
import { purchaseOrderConversionService } from "../services/purchaseOrderConversion.service";
import { budgetsService } from "../services/budgets.service";
import { recurringService } from "../services/recurring/recurring.service";
import { approvalsQueueService } from "../services/approvalsQueue.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[workflow-contract-conformance] no real DATABASE_URL — skipping.");

const SLUG = "workflow-contract";
const EMAIL = "workflow-contract@test.local";
const DATE = "2026-06-15";
/** More pending invoices than the old per-entity page (50) — the cap proof. */
const MANY = 60;

type ParseResult = { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } };
function issues(r: ParseResult): string {
  if (r.success || !r.error) return "";
  return r.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
}

describeMaybe("workflow contract conformance — quotations, POs, budgets, recurring, and the approvals queue", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let vendorId = 0;
  let cash = { id: 0, name: "" };
  let equity = { id: 0, name: "" };
  let jeId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const U = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    for (const t of [
      "quotation_conversion_items", "quotation_conversions", "quotation_items", "quotations",
      "purchase_order_conversion_items", "purchase_order_conversions", "purchase_order_items", "purchase_orders",
      "recurring_runs", "recurring_rules", "budgets",
      "journal_entry_lines", "journal_entries", "invoice_items", "invoices", "bill_items", "bills",
      "transactions", "bank_accounts", "customers", "vendors", "document_numbers",
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${O}`).catch((e: Error) => {
        if (!/does not exist/.test(e.message)) throw e;
      });
    }
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${O} OR user_id IN ${U}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${U} OR organization_id IN ${O}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Workflow Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number) VALUES ($1,'Workflow Co','1010101067') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','WC',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Workflow Customer') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Workflow Vendor') RETURNING id`, [orgId])).rows[0].id;
    const c = await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND system_code = 'CASH'`, [orgId]);
    const e = await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND type = 'equity' ORDER BY id LIMIT 1`, [orgId]);
    cash = { id: Number(c.rows[0].id), name: c.rows[0].name };
    equity = { id: Number(e.rows[0].id), name: e.rows[0].name };

    // ── the queue's fixture: pending documents of three entities, incl. MORE
    //    invoices than the old cap, and a JE whose amount only the line
    //    aggregate can produce. (Payroll's queue row shape equals the others';
    //    its pending path is proven in ledger-contract-conformance.)
    for (let i = 1; i <= MANY; i++) {
      await pool.query(
        `INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, date, subtotal, vat_amount, total, status)
         VALUES ($1,$2,$3,$4,'invoice','2026-05-01',100,15,115,'draft')`,
        [orgId, companyId, customerId, `WC-INV-${String(i).padStart(3, "0")}`],
      );
    }
    await pool.query(
      `INSERT INTO bills (organization_id, company_id, vendor_id, bill_number, date, subtotal, vat_amount, total, status)
       VALUES ($1,$2,$3,'WC-BILL-1','2026-05-02',400,60,460,'submitted')`,
      [orgId, companyId, vendorId],
    );
    jeId = (
      await pool.query(
        `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status)
         VALUES ($1,$2,'WC-JE-1','2026-05-03','queue fixture','draft') RETURNING id`,
        [orgId, companyId],
      )
    ).rows[0].id;
    for (const [acct, d, cr] of [[cash, 750, 0], [equity, 0, 750]] as const) {
      await pool.query(
        `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orgId, companyId, jeId, acct.id, acct.name, d, cr],
      );
    }

    // Deterministic permission cache: the admin read grants the queue consults.
    primePermissionCache([
      { role: "admin", resource: "invoices", action: "read" },
      { role: "admin", resource: "bills", action: "read" },
      { role: "admin", resource: "journal_entries", action: "read" },
      { role: "admin", resource: "payroll", action: "read" },
    ]);
  });

  afterAll(async () => {
    resetPermissionCache();
    await cleanup();
  });

  function conforms(schema: { safeParse: (v: unknown) => ParseResult }, value: unknown, label: string) {
    const r = schema.safeParse(JSON.parse(JSON.stringify(value)));
    expect(r.success, `${label} does not conform to its generated schema:\n${issues(r)}`).toBe(true);
  }

  // ── the approvals queue ──────────────────────────────────────────────────
  it("🔴 GET /approvals/pending — UNBOUNDED: every pending document appears, not a page of them", async () => {
    const rows = await inTenant(() => approvalsQueueService.pending("admin"));
    const invoices = rows.filter((r) => r.entity === "invoices");
    expect(invoices.length).toBe(MANY); // the old page showed at most 50
    expect(rows.filter((r) => r.entity === "bills").length).toBe(1);
    conforms(ListPendingApprovalsResponse, rows, "listPendingApprovals");
  });

  it("🔴 a journal entry's queue amount comes from the LINE aggregate — the ledger's own number, not zero", async () => {
    const rows = await inTenant(() => approvalsQueueService.pending("admin"));
    const je = rows.find((r) => r.entity === "journal-entries" && r.id === jeId);
    expect(je?.amount).toBe(750);
  });

  it("a role with no read grants gets an EMPTY queue, not an error", async () => {
    const rows = await inTenant(() => approvalsQueueService.pending("no-such-role"));
    expect(rows).toEqual([]);
  });

  // ── quotations: create → approve → convert, every response conformant ────
  let quoId = 0;

  it("POST /quotations, GET /quotations/{id}, PATCH — on real rows", async () => {
    const body = CreateQuotationBody.parse({
      date: DATE,
      customerId,
      items: [{ description: "Consulting", quantity: 2, unitPrice: 500, vatRate: 15 }],
    });
    const q = await inTenant(() => quotationsService.create(body, userId));
    quoId = q.id;
    expect(q.total).toBe(1150);
    conforms(CreateQuotationResponse, q, "createQuotation");
    const got = await inTenant(() => quotationsService.getById(quoId));
    expect(got.items?.length).toBe(1);
    conforms(GetQuotationResponse, got, "getQuotation");
    const upd = await inTenant(() => quotationsService.update(quoId, UpdateQuotationBody.parse({ notes: "edited" })));
    conforms(UpdateQuotationResponse, upd, "updateQuotation");
  });

  it("convert an APPROVED quotation; the conversion list carries the invoice it made", async () => {
    await inTenant(() => quotationsService.submit(quoId, userId));
    await inTenant(() => quotationsService.approve(quoId, userId));
    const out = await inTenant(() => quotationConversionService.convert(quoId, ConvertQuotationBody.parse({ date: DATE }), userId));
    conforms(ConvertQuotationResponse, out, "convertQuotation");
    const history = await inTenant(() => quotationConversionService.history(quoId));
    expect(history.length).toBe(1);
    conforms(ListQuotationConversionsResponse, history, "listQuotationConversions");
  });

  // ── purchase orders: mirror ──────────────────────────────────────────────
  let poId = 0;

  it("POST /purchase-orders → approve → convert to a bill", async () => {
    const po = await inTenant(() => purchaseOrdersService.create(CreatePurchaseOrderBody.parse({
      date: DATE,
      vendorId,
      items: [{ description: "Paper", quantity: 10, unitPrice: 30, vatRate: 15 }],
    }), userId));
    poId = po.id;
    expect(po.total).toBe(345);
    conforms(CreatePurchaseOrderResponse, po, "createPurchaseOrder");
    const got = await inTenant(() => purchaseOrdersService.getById(poId));
    conforms(GetPurchaseOrderResponse, got, "getPurchaseOrder");
    await inTenant(() => purchaseOrdersService.submit(poId, userId));
    await inTenant(() => purchaseOrdersService.approve(poId, userId));
    const out = await inTenant(() => purchaseOrderConversionService.convert(poId, ConvertPurchaseOrderBody.parse({ date: DATE }), userId));
    conforms(ConvertPurchaseOrderResponse, out, "convertPurchaseOrder");
    const history = await inTenant(() => purchaseOrderConversionService.history(poId));
    expect(history.length).toBe(1);
    conforms(ListPurchaseOrderConversionsResponse, history, "listPurchaseOrderConversions");
  });

  // ── budgets ──────────────────────────────────────────────────────────────
  let budgetId = 0;

  it("POST /budgets, GET /budgets (with derived actuals), PATCH, DELETE", async () => {
    expect(CreateBudgetBody.safeParse({ period: "2026" }).success).toBe(false); // budgetedAmount required
    const b = await inTenant(() => budgetsService.create(CreateBudgetBody.parse({ name: "Cash budget", period: "2026", categoryId: cash.id, budgetedAmount: 120000 })));
    budgetId = b.id;
    expect(b.budgetedAmount).toBe(120000);
    conforms(CreateBudgetResponse, b, "createBudget");
    const list = await inTenant(() => budgetsService.list("2026"));
    expect(list.length).toBe(1);
    expect(typeof list[0].actualAmount).toBe("number");
    conforms(ListBudgetsResponse, list, "listBudgets");
    const upd = await inTenant(() => budgetsService.update(budgetId, UpdateBudgetBody.parse({ budgetedAmount: 90000 })));
    expect(upd.budgetedAmount).toBe(90000);
    conforms(UpdateBudgetResponse, upd, "updateBudget");
    await inTenant(() => budgetsService.remove(budgetId));
    expect((await inTenant(() => budgetsService.list("2026"))).length).toBe(0);
  });

  // ── recurring rules ──────────────────────────────────────────────────────
  it("POST /recurring, GET /recurring (with rule health), runs, pause", async () => {
    const rule = await inTenant(() => recurringService.create(
      {
        entity: "invoice",
        template: { customerId, items: [{ description: "Retainer", quantity: 1, unitPrice: 1000, vatRate: 15 }] },
        frequency: "monthly",
        dayOfMonth: 1,
        startsOn: "2026-07-01",
        endsOn: null,
        autoIssue: false,
      },
      { userId, role: "admin" },
    ));
    const rules = await inTenant(() => recurringService.list());
    expect(rules.length).toBe(1);
    expect(rules[0].consecutiveFailures).toBe(0);
    conforms(ListRecurringRulesResponse, rules, "listRecurringRules");
    // A new rule has no runs yet — [] is the TRUE answer here, and the run-row
    // schema itself is exercised by the automation suite that executes rules.
    const runs = await inTenant(() => recurringService.runs(rule.id));
    conforms(GetRecurringRuleRunsResponse, runs, "getRecurringRuleRuns");
    const paused = await inTenant(() => recurringService.pause(rule.id, true));
    expect(paused.status).toBe("paused");
    conforms(PauseRecurringRuleResponse, paused, "pauseRecurringRule");
  });

  it("🔴 the instrument is not vacuous — a wrong shape FAILS", async () => {
    const rows = await inTenant(() => approvalsQueueService.pending("admin"));
    const broken = rows.map(({ amount, ...r }) => ({ ...r, total: amount }));
    expect(ListPendingApprovalsResponse.safeParse(broken).success).toBe(false);
    expect(ListPendingApprovalsResponse.safeParse([{ entity: "cheques", id: 1, label: "x", status: "draft", amount: 1 }]).success).toBe(false);
  });
});
