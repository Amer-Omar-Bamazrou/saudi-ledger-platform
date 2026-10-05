/**
 * PHASE 16 AUDIT — an OVERDUE VAT period stays on the obligations calendar
 * (decision pack §8.4, §13; found by the joint audit 2026-10-04).
 *
 * The calendar listed the last completed VAT period only while its due date
 * had not passed (`if (lastDue >= today)`). For a MONTHLY filer that is always
 * true (the due date is the end of the current month). For a QUARTERLY filer
 * — most small Saudi businesses — the previous quarter falls due at the end of
 * the quarter's first month, so for its second and third months an UNPAID
 * quarter vanished from the calendar, and from Treasury's expected outflows,
 * exactly when it was overdue. "Who finds out?" — nobody did.
 *
 * The business date is PINNED (the module mock below) to 2026-11-15, inside
 * Q4, so Q3 (due 2026-10-31) is overdue. A VAT-bearing invoice dated in Q3 is
 * created and approved through the product.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/shared")>();
  return { ...actual, businessToday: () => "2026-11-15" };
});

import { pool, beginTenantConnection } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { taxObligationsService } from "../services/tax/taxObligations.service";
import { treasuryService } from "../services/treasury/treasury.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase16-vat-obligation-overdue] no real DATABASE_URL — skipping.");

describeMaybe("Phase 16 audit — an overdue VAT period stays on the calendar (quarterly filer, pinned date)", () => {
  const SLUG = "p16-vat-overdue", EMAIL = "p16-vat-overdue@test.local";
  let orgId = "", coQ = "", coM = "", userId = 0, customerId = 0;

  const inCo = async <T,>(co: string, fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const ORGS = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      const { rows } = await c.query(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${ORGS}`);
      await c.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };
  const invoice = async (co: string, n: string, date: string, net: number) => {
    const inv = await inCo(co, () => invoicesService.create({ invoiceNumber: n, date, dueDate: date, customerId, items: [{ description: "Service", quantity: 1, unitPrice: net, vatRate: 15 }] }, userId)) as { id: number };
    await inCo(co, () => invoicesService.approve(inv.id, userId));
  };

  beforeAll(async () => {
    expect(businessToday(), "the pin holds").toBe("2026-11-15");
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('P16 VAT overdue','${SLUG}','approved') RETURNING id`)).rows[0].id;
    coQ = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, vat_tax_period) VALUES ($1,'Quarterly Co',1,'gregorian','399999999999993','1010404041','quarterly') RETURNING id`, [orgId])).rows[0].id;
    await new Promise((r) => setTimeout(r, 20));
    coM = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, vat_tax_period) VALUES ($1,'Monthly Co',1,'gregorian','399999999999993','1010404042','monthly') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P16V',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'VAT Customer') RETURNING id`, [orgId])).rows[0].id;
    // Q3 sales: 10,000 net → VAT 1,500 (quarterly co) · October sales 2,000 net → VAT 300 (monthly co)
    await invoice(coQ, "P16V-Q3", "2026-08-10", 10_000);
    await invoice(coM, "P16V-OCT", "2026-10-12", 2_000);
  }, 120_000);
  afterAll(cleanup);

  it("🔴 the UNPAID previous quarter is listed after its due date — overdue, with its amount — and Treasury carries it as an overdue outflow", async () => {
    const r = await inCo(coQ, () => taxObligationsService.list());
    const q3 = r.obligations.find((o) => o.kind === "vat" && o.reference === "2026-07-01 – 2026-09-30");
    expect(q3, "the overdue quarter is on the calendar").toBeTruthy();
    expect([q3!.amount, q3!.dueDate, q3!.overdue]).toEqual([1_500, "2026-10-31", true]);
    expect(q3!.note).toMatch(/Periods before it are not projected here/);
    const f = await inCo(coQ, () => treasuryService.forecast(13));
    const row = f.rows.find((x) => x.category === "tax" && x.source.type === "tax_vat" && x.source.id === "2026-07-01 – 2026-09-30");
    expect([row?.bucket, row?.bucketReason, row?.amount]).toEqual([0, "overdue", 1_500]);
  });

  it("a monthly filer's previous month is NOT overdue on the same day (its due date is the end of this month) — the figure moves with the rule, not with the code path", async () => {
    const r = await inCo(coM, () => taxObligationsService.list());
    const oct = r.obligations.find((o) => o.kind === "vat" && o.reference === "2026-10-01 – 2026-10-31");
    expect([oct?.amount, oct?.dueDate, oct?.overdue]).toEqual([300, "2026-11-30", false]);
  });
});
