/**
 * 🔴 L3 (owner, 2026-11-25) — DETECTION ONLY: a purchase still not paid in full twelve months after the month following
 * the supply's month. VAT IR Art. 40(10)–(11) as amended (Res. 01-06-24), the reading settled in advisor-questions
 * Block L3: the buyer's input VAT on the UNPAID portion is reversed in the return for the month in which those twelve
 * months end; a later payment restores it; goods under financing contracts are excepted on the supplier's certificate.
 *
 * The finding `input_vat_nonpayment` lists each such bill with the unpaid share (billPosition, the one definition of
 * what a bill owes), its VAT (the unpaid share × the bill's own VAT ÷ total), the trigger month (supply month + 13) and
 * the return period the adjustment belongs to (the company's declared VAT tax period: `taxPeriodStart`, the one
 * definition; NOT DECLARED is said, never assumed). NOTHING POSTS and no return changes: the findings run moves
 * nothing (the zero-movement standard). Only VAT that was CLAIMED is listed — held or blocked VAT was never deducted.
 * DB-backed; skips on the placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { findingsService } from "../services/findings.service";
import { purgeInputVatLedger } from "./helpers/purgeInputVatLedger";
import { releasePostedJournalsForTeardown } from "./helpers/journalFixtures";
import { deleterFor } from "./helpers/replica";

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString ? describe : describe.skip;
const SLUG = "l3-input-vat-nonpayment";
const EMAIL = "l3-nonpay@test.local";

describeMaybe("L3 — the input-VAT non-payment finding (detection only)", () => {
  let orgId = "";
  let companyId = "";
  let vendorId = 0;
  let userId = 0;
  let bankId = 0;
  const bills: Record<string, { id: number; billNumber: string }> = {};

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated", actorUserId: userId });
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
    await purgeInputVatLedger(`SELECT id FROM organizations WHERE slug = '${SLUG}'`);
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await releasePostedJournalsForTeardown(`organization_id IN ${O}`);
    for (const t of ["findings", "finding_runs", "bill_payments", "payments", "journal_entry_lines", "journal_entries", "bill_items", "bills", "document_numbers", "vendors", "bank_accounts", "audit_logs", "categories", "organization_memberships", "companies"]) {
      await deleterFor(pool, t).query(`DELETE FROM ${t} WHERE organization_id IN ${O}`).catch((e: Error) => {
        if (!/does not exist/.test(e.message)) throw e;
      });
    }
    await deleterFor(pool, "audit_logs").query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email = '${EMAIL}')`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  const bill = (key: string, date: string, extra: Record<string, unknown> = {}) =>
    inTenant(async () => {
      const b = await billsService.create({ supplierDocumentKind: "tax_invoice", vendorReference: `L3-${key}`, date, vendorId, subtotal: 1000, vatAmount: 150, total: 1150, items: [], ...extra }, userId);
      const posted = await billsService.post(b.id, {}, userId);
      bills[key] = { id: b.id, billNumber: b.billNumber };
      return posted;
    });

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('L3 Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, vat_tax_period) VALUES ($1,'L3 Co','1010101099','399999999999993','monthly') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','L3',' ','viewer',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'L3 Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    bankId = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'L3 Bank','ANB') RETURNING id`, [orgId, companyId])).rows[0].id;
    await bill("unpaid", "2024-09-10");                         // trigger month 2025-10 — ended
    await bill("half", "2024-09-12");                           // half paid below
    await bill("paid", "2024-09-14");                           // paid in full below
    await bill("recent", "2026-05-10");                         // trigger month 2027-06 — not yet
    await bill("held", "2024-09-16", { supplierDocumentKind: "no_tax_invoice" }); // VAT held, never claimed
    await inTenant(() => billsService.pay(bills.half!.id, { amount: 575, paidAt: "2024-12-01", bankAccountId: bankId }, userId));
    await inTenant(() => billsService.pay(bills.paid!.id, { amount: 1150, paidAt: "2024-12-02", bankAccountId: bankId }, userId));
  }, 120_000);
  afterAll(cleanup);

  const findings = async () =>
    (await pool.query(`SELECT ref_key, status, facts FROM findings WHERE organization_id = $1 AND kind = 'input_vat_nonpayment' ORDER BY ref_key`, [orgId])).rows as Array<{ ref_key: string; status: string; facts: any }>;
  const movement = async () => (await pool.query(
    `SELECT (SELECT count(*) FROM journal_entries WHERE organization_id = $1)::int AS entries,
            (SELECT coalesce(sum(vat_amount), 0)::text FROM bills WHERE organization_id = $1) AS bill_vat,
            (SELECT count(*) FROM input_vat_events WHERE organization_id = $1)::int AS vat_events`, [orgId])).rows[0];

  it("🔴 lists each bill still unpaid after its twelve months, with the unpaid share, its VAT, the trigger month and the return period — and only those", async () => {
    const before = await movement();
    await inTenant(() => findingsService.run());
    const rows = await findings();
    const byBill = new Map(rows.map((r) => [r.facts.billId as number, r]));
    // presence
    expect(byBill.get(bills.unpaid!.id)?.facts).toMatchObject({ billNumber: bills.unpaid!.billNumber, supplyDate: "2024-09-10", unpaid: 1150, unpaidVat: 150, triggerMonth: "2025-10", returnPeriod: { from: "2025-10", to: "2025-10", basis: "monthly" } });
    expect(byBill.get(bills.half!.id)?.facts).toMatchObject({ unpaid: 575, unpaidVat: 75, triggerMonth: "2025-10" });
    // absence: paid in full, not yet due, VAT never claimed
    for (const k of ["paid", "recent", "held"]) expect([k, byBill.has(bills[k]!.id)]).toEqual([k, false]);
    expect(rows.every((r) => r.status === "open")).toBe(true);
    // 🔴 nothing moves: no entry, no bill, no VAT event
    expect(await movement()).toEqual(before);
  });

  it("the return period follows the company's declared tax period — a quarter, or 'not declared' said, never assumed", async () => {
    await pool.query(`UPDATE companies SET vat_tax_period = 'quarterly' WHERE id = $1`, [companyId]);
    await inTenant(() => findingsService.run());
    expect((await findings()).find((r) => r.facts.billId === bills.unpaid!.id)?.facts.returnPeriod).toEqual({ from: "2025-10", to: "2025-12", basis: "quarterly" });
    await pool.query(`UPDATE companies SET vat_tax_period = NULL WHERE id = $1`, [companyId]);
    await inTenant(() => findingsService.run());
    const f = (await findings()).find((r) => r.facts.billId === bills.unpaid!.id)?.facts;
    expect(f.returnPeriod).toBeNull();
    expect(f.returnPeriodNote).toContain("not declared");
    await pool.query(`UPDATE companies SET vat_tax_period = 'monthly' WHERE id = $1`, [companyId]);
  });

  it("movement: the bill paid in full — the next run resolves its finding", async () => {
    await inTenant(() => billsService.pay(bills.unpaid!.id, { amount: 1150, paidAt: "2026-11-01", bankAccountId: bankId }, userId));
    await inTenant(() => findingsService.run());
    const rows = await findings();
    expect(rows.find((r) => r.facts.billId === bills.unpaid!.id)?.status).toBe("resolved");
    expect(rows.find((r) => r.facts.billId === bills.half!.id)?.status).toBe("open");
  });
});
