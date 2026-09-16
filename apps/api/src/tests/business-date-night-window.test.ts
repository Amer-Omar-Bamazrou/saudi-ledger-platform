/**
 * 🔴 THE NIGHT WINDOW — business dates at 01:00 Riyadh (2026-09-16, the
 * pre-pilot sanity walk).
 *
 * Every "today" the product decided was the UTC calendar day. Riyadh is
 * UTC+3, so from 00:00 to 03:00 local the product dated business events
 * YESTERDAY: seen live at 02:40 — an invoice form defaulting to the 15th on
 * the 16th, and a journal entry dated the 16th reversed with a reversal
 * dated the 15th. Every suite and every browser walk had run in daytime,
 * where UTC day = Riyadh day, so none could see it. This file is the
 * fixed clock those runs never had.
 *
 * The clock: 2026-09-30T22:00:00Z = 01:00 on 1 October in Riyadh, with
 * SEPTEMBER LOCKED. Under the old code every server-decided date below was
 * 2026-09-30 — into the closed month, or a reversal dated before its
 * original — so each assertion is one that could not pass by accident.
 * `vi.setSystemTime` fixes `new Date()` for the process; nothing here
 * reads the machine's clock.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { businessDate, businessToday, businessDateShift } from "@workspace/shared";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { periodLocksService } from "../services/periodLocks.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const SLUG = "night-window";
const EMAIL = "night-window@test.local";

/** 01:00 Riyadh on 1 Oct 2026. The UTC day is still 30 Sep. */
const NIGHT = new Date("2026-09-30T22:00:00.000Z");
/** 12:00 Riyadh the same day — the daytime every earlier run happened in. */
const NOON = new Date("2026-10-01T09:00:00.000Z");
const RIYADH_DAY = "2026-10-01";
const LOCKED = "2026-09";

describe("businessDate — the seam itself (no database, no machine clock)", () => {
  it("resolves the Riyadh calendar day, not the UTC one, on both sides of midnight", () => {
    expect(businessDate(new Date("2026-09-30T20:59:59.000Z"))).toBe("2026-09-30"); // 23:59:59 Riyadh
    expect(businessDate(new Date("2026-09-30T21:00:00.000Z"))).toBe("2026-10-01"); // 00:00:00 Riyadh
    expect(businessDate(NIGHT)).toBe(RIYADH_DAY);
    expect(businessDate(NOON)).toBe(RIYADH_DAY);
  });

  it("businessToday() follows a fixed clock — 01:00 Riyadh is already tomorrow's UTC-yesterday", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NIGHT);
      expect(new Date().toISOString().slice(0, 10), "the UTC day — what the old code used").toBe("2026-09-30");
      expect(businessToday()).toBe(RIYADH_DAY);
      vi.setSystemTime(NOON);
      expect(businessToday()).toBe(RIYADH_DAY);
    } finally {
      vi.useRealTimers();
    }
  });

  it("day arithmetic is pure — no zone drift", () => {
    expect(businessDateShift("2026-10-01", -30)).toBe("2026-09-01");
    expect(businessDateShift("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describeMaybe("business dates at 01:00 Riyadh, through the product's own write paths", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let cashId = 0;
  let bankChargesId = 0;

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
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usr = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM einvoice_documents WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM period_locks WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Night Window Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'NW Co','1010606061','399999999944403') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','NW',' ','admin',true) RETURNING id`)
    ).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'NW Customer') RETURNING id`, [orgId])).rows[0].id;
    const cat = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id;
    cashId = await cat("CASH");
    bankChargesId = await cat("BANK_CHARGES");
    // The month the UTC clock still thinks it is. Every wrongly-dated write lands here and is refused.
    await inTenant(() => periodLocksService.lock({ period: LOCKED, notes: "the UTC-yesterday month", userId }));
  });
  afterAll(cleanup);
  afterEach(() => vi.useRealTimers());

  const atClock = (at: Date) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
  };

  it("🔴 an invoice created with no date is dated the Riyadh day, numbered for it, and approves into the OPEN month", async () => {
    atClock(NIGHT);
    const inv = await inTenant(() =>
      invoicesService.create({ customerId, items: [{ description: "Night", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId),
    );
    expect(inv.date, "the issue date is the business day, not the UTC day").toBe(RIYADH_DAY);
    expect(String(inv.invoiceNumber)).toMatch(/^INV-2026-/);
    // Under the old code this was dated 2026-09-30 and the lock refused it.
    const approved = await inTenant(() => invoicesService.approve(inv.id, userId));
    expect(approved.status).toBe("sent");
    const { rows: [row] } = await pool.query(`SELECT date, status FROM invoices WHERE id = $1`, [inv.id]);
    expect(row).toEqual({ date: RIYADH_DAY, status: "sent" });
  });

  it("🔴 a payment with no paid-at date is dated the Riyadh day and its entry posts into the open month", async () => {
    atClock(NIGHT);
    const inv = await inTenant(() =>
      invoicesService.create({ date: RIYADH_DAY, customerId, items: [{ description: "Pay", quantity: 1, unitPrice: 200, vatRate: 15 }] }, userId),
    );
    await inTenant(() => invoicesService.approve(inv.id, userId));
    await inTenant(() => invoicesService.pay(inv.id, { amount: 230 }, userId));
    const { rows: [pay] } = await pool.query(`SELECT paid_at::text AS date FROM invoice_payments WHERE invoice_id = $1`, [inv.id]);
    expect(pay.date).toBe(RIYADH_DAY);
    const { rows: [je] } = await pool.query(
      `SELECT date::text AS date FROM journal_entries WHERE organization_id = $1 AND entry_number LIKE $2`,
      [orgId, `GL-${inv.invoiceNumber}-PAY-%`],
    );
    expect(je.date).toBe(RIYADH_DAY);
  });

  it("🔴 a journal entry dated the Riyadh day posts, and its reversal is dated THAT day — never before the original", async () => {
    atClock(NIGHT);
    const lines = [
      { accountId: bankChargesId, accountName: "Bank Charges", description: "x", debitAmount: 75, creditAmount: 0 },
      { accountId: cashId, accountName: "Cash and Bank", description: "x", debitAmount: 0, creditAmount: 75 },
    ];
    const je = await inTenant(() =>
      journalEntriesService.create({ entryNumber: "JE-NIGHT-1", date: businessToday(), description: "Night entry", lines }, userId),
    );
    expect(je.date).toBe(RIYADH_DAY);
    await inTenant(() => journalEntriesService.approve(je.id, userId));
    const result = (await inTenant(() => journalEntriesService.reverse(je.id))) as { reversal: { date: string; entryNumber: string } };
    expect(result.reversal.entryNumber).toBe("JE-NIGHT-1-REV");
    expect(result.reversal.date, "the reversal is dated the business day").toBe(RIYADH_DAY);
    expect(result.reversal.date >= je.date, "a reversal can never precede the entry it reverses because of the UTC/local boundary").toBe(true);
    const { rows } = await pool.query(
      `SELECT entry_number, date::text AS date, status FROM journal_entries WHERE organization_id = $1 AND entry_number LIKE 'JE-NIGHT-1%' ORDER BY id`,
      [orgId],
    );
    expect(rows).toEqual([
      { entry_number: "JE-NIGHT-1", date: RIYADH_DAY, status: "reversed" },
      { entry_number: "JE-NIGHT-1-REV", date: RIYADH_DAY, status: "posted" },
    ]);
  });

  it("daytime is unchanged: at noon Riyadh the same paths give the same day", async () => {
    atClock(NOON);
    expect(businessToday()).toBe(RIYADH_DAY);
    const inv = await inTenant(() =>
      invoicesService.create({ customerId, items: [{ description: "Noon", quantity: 1, unitPrice: 50, vatRate: 15 }] }, userId),
    );
    expect(inv.date).toBe(RIYADH_DAY);
    await inTenant(() => invoicesService.approve(inv.id, userId));
    await inTenant(() => invoicesService.pay(inv.id, { amount: 57.5 }, userId));
    const { rows: [pay] } = await pool.query(`SELECT paid_at::text AS date FROM invoice_payments WHERE invoice_id = $1`, [inv.id]);
    expect(pay.date).toBe(RIYADH_DAY);
  });
});
