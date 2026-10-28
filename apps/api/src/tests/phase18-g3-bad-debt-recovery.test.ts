/**
 * 🔴 Phase 18 G3 — bad-debt recovery: owner decisions 3, 7 and A1 (register
 * §11.30; final-run memo §2 G). Each DECIDED 2026-10-27: an owner decision
 * based on research, not a professional opinion; reversible; to be reviewed
 * before go-live.
 *
 *  - A1: a recovered bad debt is presented as OTHER INCOME by default (a
 *    permitted choice under IFRS 9) — the Art. 40(9) recovery's entry credits
 *    other income, net of the VAT payable again, and leaves bad debts alone.
 *  - 3: a recovery invoice is NEVER corrected with an ordinary sales credit
 *    (or debit) note; the G59 refusal stands; a controlled "recovery
 *    correction" is a design item, not automated.
 *  - 7: a wrong or refunded recovery is a controlled MANUAL correction — never
 *    an automatic credit note against the original sale, never an automatic
 *    re-claim of relief (records only; nothing here automates either).
 *
 * The product's own HTTP path on rows it created (the G59 recipe). DB-backed
 * (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3248";
process.env.SESSION_SECRET ??= "phase18-g3-bad-debt-recovery-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18G3BadDebtPw1!";
// Twelve months between the supply and the relief (Art. 40(7)(c)); the receipt follows the relief.
const SUPPLY_DATE = "2025-06-01";
const CLAIMED_ON = "2026-07-01";
const RECEIPT_DATE = "2026-08-15";

describeMaybe("Phase 18 G3 — bad-debt recovery (decisions 3, 7, A1)", () => {
  const h = g04Harness("p18g3");
  let orgId = "", customerId = 0, bankId = 0, seq = 0;
  const ok = (r: { status: number; body: unknown }, status: number) => expect(r.status, JSON.stringify(r.body)).toBe(status);

  const issueInvoice = async (net: number, date: string) => {
    seq += 1;
    const created = await h.api("admin", "POST", "/invoices", { invoiceNumber: `P18G3-INV-${seq}`, date, customerId, items: [{ description: "Consulting", quantity: 1, unitPrice: net, vatRate: 15 }] });
    ok(created, 201);
    const approved = await h.api("admin", "POST", `/invoices/${created.body.id}/approve`, {});
    ok(approved, 200);
    return { id: created.body.id as number, total: Number(approved.body.total) };
  };
  /** A receivable written off with relief, a later receipt on account, and the issued Art. 40(9) recovery. */
  const recoveryChain = async (net: number, recovered: number) => {
    const inv = await issueInvoice(net, SUPPLY_DATE);
    ok(await h.api("admin", "POST", `/invoices/${inv.id}/bad-debt-relief`, { claimedOn: CLAIMED_ON, certificateRef: `CA-P18G3-${seq}` }), 200);
    const rcpt = await h.api("admin", "POST", "/payments", { customerId, amount: recovered, paidAt: RECEIPT_DATE, bankAccountId: bankId, classification: "unknown" });
    ok(rcpt, 201);
    const draft = await h.api("admin", "POST", `/invoices/${inv.id}/bad-debt-recoveries`, { paymentId: rcpt.body.id, amount: recovered });
    ok(draft, 201);
    const issued = await h.api("admin", "POST", `/invoices/${draft.body.id}/approve`, {});
    ok(issued, 200);
    return { invoiceId: inv.id, recoveryId: draft.body.id as number, recoveryNumber: issued.body.invoiceNumber as string };
  };
  /** The recovery entry's lines on the P&L accounts that could present it: [code, debit, credit]. */
  const pnlLines = async (entryNumber: string) => (await pool.query(
    `SELECT c.system_code AS code, l.debit_amount::float AS dr, l.credit_amount::float AS cr
       FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.organization_id = $1 AND e.entry_number = $2 AND c.system_code IN ('OTHER_INCOME', 'BAD_DEBT_EXPENSE') ORDER BY l.id`, [orgId, entryNumber])).rows
    .map((r) => [r.code, r.dr, r.cr]);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'P18 G3 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'P18 G3 Buyer') RETURNING id`, [orgId])).rows[0].id;
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "P18 G3 Main", bankName: "P18 G3 Bank", isDefault: true });
    ok(bank, 201);
    bankId = bank.body.id;
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 A1: the recovery is presented as OTHER INCOME — credited the amount received, debited the VAT payable again — and bad debts do not move", async () => {
    const r = await recoveryChain(1_000, 1_150);
    expect(await pnlLines(`GL-${r.recoveryNumber}`)).toEqual([["OTHER_INCOME", 150, 0], ["OTHER_INCOME", 0, 1_150]]);
  });

  it("control 3: an ordinary invoice is still corrected with a credit note", async () => {
    const inv = await issueInvoice(500, "2026-09-01");
    const cn = await h.api("admin", "POST", "/invoices", { documentType: "credit_note", originalInvoiceId: inv.id, noteReason: "Goods returned", customerId, date: "2026-09-05", items: [{ description: "Return", quantity: 1, unitPrice: 100, vatRate: 15 }] });
    ok(cn, 201);
  });

  it("🔴 3: a recovery invoice is never corrected with an ordinary credit or debit note — refused by name, nothing is created", async () => {
    const r = await recoveryChain(800, 920);
    const before = (await pool.query(`SELECT count(*)::int n FROM invoices WHERE organization_id = $1`, [orgId])).rows[0].n;
    const cn = await h.api("admin", "POST", "/invoices", { documentType: "credit_note", originalInvoiceId: r.recoveryId, noteReason: "Recovery refunded", customerId, date: "2026-09-10", items: [{ description: "Refund", quantity: 1, unitPrice: 100, vatRate: 15 }] });
    const dn = await h.api("admin", "POST", "/invoices", { documentType: "debit_note", originalInvoiceId: r.recoveryId, noteReason: "Recovery understated", customerId, date: "2026-09-10", chargeSubstance: "price_change", chargeEventDate: "2026-09-01", items: [{ description: "More", quantity: 1, unitPrice: 100, vatRate: 15 }] });
    const after = (await pool.query(`SELECT count(*)::int n FROM invoices WHERE organization_id = $1`, [orgId])).rows[0].n;
    expect([[cn.status, cn.body.code], [dn.status, dn.body.code], after - before]).toEqual([[409, "note_original_is_recovery_invoice"], [409, "note_original_is_recovery_invoice"], 0]);
  });
});
