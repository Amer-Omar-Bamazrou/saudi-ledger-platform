/**
 * Batch 1B Part 2 — Phase E (customer statements, AR ageing and the customer
 * position). 2026-09-17.
 *
 * The representation under test: a customer's position is THREE non-negative
 * components — Accounts Receivable, Customer Credits, Customer Deposits — and
 * a NET that is derived (receivable − credit − deposit), never a fourth
 * stored figure and never a negative receivable. The statement is rebuilt
 * from the events in chronology and reconciled against the subledger; the
 * ageing carries only real receivable exposure and shows the liabilities
 * beside it.
 *
 * Every case asserts presence, absence and movement (§3): the figure that
 * must be there, the figure that must not, and that something moved.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { paymentsService } from "../services/payments.service";
import { customersService } from "../services/customers.service";
import { customerStatementService } from "../services/customerStatement.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { reportsService } from "../services/reports.service";
import { createApproved } from "./helpers/createApproved";
import { businessToday } from "@workspace/shared";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "d4-stmt";
const SLUG_OTHER = "d4-stmt-other";
const EMAIL = "d4-stmt@test.local";
const D1 = "2026-06-01";
const D2 = "2026-06-10";
const D3 = "2026-06-20";

type Pos = { receivable: number; creditBalance: number; depositBalance: number; netPosition: number };
const pos = (receivable: number, creditBalance: number, depositBalance: number): Pos => ({
  receivable, creditBalance, depositBalance, netPosition: Math.round((receivable - creditBalance - depositBalance) * 100) / 100 + 0,
});

describeMaybe("D-4 Part 2 Phase E — customer statement, position and AR ageing", () => {
  let orgId = "";
  let companyId = "";
  let company2Id = "";
  let otherOrgId = "";
  let otherCompanyId = "";
  let userId = 0;
  let bank = 0;
  let bankC2 = 0;
  let custOther = 0;

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
    for (const slug of [SLUG, SLUG_OTHER]) {
      const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
      for (const t of [
        "customer_refunds", "payment_allocation_reversals", "payment_allocations", "payments", "journal_entry_lines", "journal_entries",
        "invoice_items", "einvoice_documents", "invoices", "customers", "period_locks", "audit_logs", "organization_memberships",
        "bank_accounts", "categories", "companies",
      ]) {
        await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await pool.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
    }
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('D4E Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'D4E Co','1010828181','399999999988903') RETURNING id`, [orgId])).rows[0].id;
    company2Id = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'D4E Co 2','1010828182','399999999988913') RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('D4E Other','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'D4E Other Co','1010828183','399999999988923') RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','D4E',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    custOther = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Other Customer') RETURNING id`, [otherOrgId])).rows[0].id;
    bank = (await inTenant(() => bankAccountsService.create({ name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bankC2 = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Co2 Main','ANB') RETURNING id`, [orgId, company2Id])).rows[0].id;
  });
  afterAll(cleanup);

  let custSeq = 0;
  async function customer(name: string, nameAr: string | null = null) {
    custSeq += 1;
    return (await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,$2,$3) RETURNING id`, [orgId, `${name} ${custSeq}`, nameAr])).rows[0].id as number;
  }
  let seq = 0;
  /** An issued invoice for `net` SAR (+15% VAT) in the scoped company. */
  async function issue(customerId: number, net: number, opts: Record<string, unknown> = {}, run: <T>(fn: () => Promise<T>) => Promise<T> = inTenant) {
    seq += 1;
    return run(() =>
      createApproved<{ id: number; invoiceNumber: string; total: number }>(
        invoicesService,
        { invoiceNumber: `D4E-${String(seq).padStart(3, "0")}`, date: D1, dueDate: D1, customerId, items: [{ description: "Work", quantity: 1, unitPrice: net, vatRate: 15 }], ...opts },
        userId,
      ),
    );
  }
  const glAr = async (customerId: number, company = companyId) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS v
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND e.company_id = $2 AND c.system_code = 'AR' AND e.status IN ('posted','reversed') AND l.customer_id = $3`,
      [orgId, company, customerId])).rows[0].v);
  const glCompanyAr = async (company = companyId) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS v
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND e.company_id = $2 AND c.system_code = 'AR' AND e.status IN ('posted','reversed')`,
      [orgId, company])).rows[0].v);

  const positionOf = async (customerId: number) => {
    const c = await inTenant(() => customersService.getById(customerId));
    return { receivable: c.receivable, creditBalance: c.creditBalance, depositBalance: c.depositBalance, netPosition: c.netPosition, balance: c.balance };
  };
  const statement = (customerId: number, range: { from?: string; to?: string } = {}) => inTenant(() => customerStatementService.statement(customerId, range));

  /** The representation invariant: three components ≥ 0, net derived, `balance` IS the net, the statement reconciles, GL AR = receivable. */
  const assertRepresentation = async (customerId: number, expected: Pos) => {
    const p = await positionOf(customerId);
    expect(p.receivable).toBeGreaterThanOrEqual(0);
    expect(p.creditBalance).toBeGreaterThanOrEqual(0);
    expect(p.depositBalance).toBeGreaterThanOrEqual(0);
    expect(p.netPosition).toBe(Math.round((p.receivable - p.creditBalance - p.depositBalance) * 100) / 100 + 0);
    expect(p.balance).toBe(p.netPosition);
    expect({ receivable: p.receivable, creditBalance: p.creditBalance, depositBalance: p.depositBalance, netPosition: p.netPosition }).toEqual(expected);
    const s = await statement(customerId);
    expect(s.reconciled, `statement reconciles: ${JSON.stringify({ current: s.current, subledger: s.subledger })}`).toBe(true);
    expect(s.current).toEqual(expected);
    expect(s.closing).toEqual(expected);
    // the running balances never dip below zero — a liability is never a negative receivable, and vice versa
    for (const l of s.lines) {
      expect(l.receivable, `line ${l.seq} receivable`).toBeGreaterThanOrEqual(0);
      expect(l.creditBalance, `line ${l.seq} credit`).toBeGreaterThanOrEqual(0);
      expect(l.depositBalance, `line ${l.seq} deposit`).toBeGreaterThanOrEqual(0);
      expect(l.netPosition).toBe(Math.round((l.receivable - l.creditBalance - l.depositBalance) * 100) / 100 + 0);
    }
    expect(await glAr(customerId)).toBe(expected.receivable);
    // the credits endpoint reads the same definition
    const credits = await inTenant(() => paymentsService.customerCredits(customerId));
    expect(credits).toEqual({ customerId, deposits: expected.depositBalance, creditNotes: expected.creditBalance });
    return s;
  };

  // ── 1. invoice only ────────────────────────────────────────────────────
  it("🔴 invoice only: receivable = total, no liabilities, net = total; the statement is one line", async () => {
    const c = await customer("Invoice Only");
    const inv = await issue(c, 1000); // 1,150
    const s = await assertRepresentation(c, pos(1150, 0, 0));
    expect(s.lines.map((l) => [l.kind, l.documentNumber, l.receivableDelta])).toEqual([["invoice", inv.invoiceNumber, 1150]]);
    expect(s.opening).toEqual(pos(0, 0, 0));
    const aging = await inTenant(() => reportsService.arAging());
    expect(aging.items.find((i: { invoiceNumber: string }) => i.invoiceNumber === inv.invoiceNumber)?.outstanding).toBe(1150);
  });

  // ── 2. full payment ────────────────────────────────────────────────────
  it("full payment: everything returns to zero; the statement carries invoice → receipt → allocation in chronology and still reconciles", async () => {
    const c = await customer("Paid In Full");
    const inv = await issue(c, 2000); // 2,300
    const p = await inTenant(() => paymentsService.receive({ customerId: c, amount: 2300, paidAt: D2, bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 2300 }] }, userId));
    const s = await assertRepresentation(c, pos(0, 0, 0));
    expect(s.lines.map((l) => [l.date, l.kind, l.receivable, l.depositBalance])).toEqual([
      [D1, "invoice", 2300, 0],
      [D2, "receipt", 2300, 2300],
      [D2, "allocation", 0, 0],
    ]);
    expect(s.lines[1]!.documentNumber).toBe(`RCPT-${p.id}`);
    expect(s.lines[2]!.reference).toBe(`RCPT-${p.id}`);
    const aging = await inTenant(() => reportsService.arAging());
    expect(aging.items.find((i: { invoiceNumber: string }) => i.invoiceNumber === inv.invoiceNumber)).toBeUndefined();
  });

  // ── 3. partial payment ─────────────────────────────────────────────────
  it("partial payment: the receivable is the remainder, nothing else moves", async () => {
    const c = await customer("Partial");
    const inv = await issue(c, 4000); // 4,600
    await inTenant(() => paymentsService.receive({ customerId: c, amount: 1600, paidAt: D2, bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 1600 }] }, userId));
    await assertRepresentation(c, pos(3000, 0, 0));
    const aging = await inTenant(() => reportsService.arAging());
    expect(aging.items.find((i: { invoiceNumber: string }) => i.invoiceNumber === inv.invoiceNumber)?.outstanding).toBe(3000);
  });

  // ── 4. multiple invoices ───────────────────────────────────────────────
  it("multiple invoices, one receipt across both: receivable = Σ remainders; the ledger report lists both with their own outstanding", async () => {
    const c = await customer("Multi");
    const a = await issue(c, 1000); // 1,150
    const b = await issue(c, 3000); // 3,450
    await inTenant(() => paymentsService.receive({ customerId: c, amount: 2150, paidAt: D2, bankAccountId: bank, allocations: [{ invoiceId: a.id, amount: 1150 }, { invoiceId: b.id, amount: 1000 }] }, userId));
    const s = await assertRepresentation(c, pos(2450, 0, 0));
    expect(s.lines.filter((l) => l.kind === "allocation").map((l) => [l.documentNumber, l.amount])).toEqual([[a.invoiceNumber, 1150], [b.invoiceNumber, 1000]]);
    const ledger = await inTenant(() => reportsService.customerLedger(String(c)));
    const cust = ledger.customers.find((x) => x.customerId === c)!;
    // The ledger orders by customer name, then DATE — two same-day invoices have no defined order between
    // them (CI on PR #164 returned b before a once the receipt's UPDATE moved a's tuple). Assert the set.
    expect(cust.invoices.map((i) => [i.invoiceNumber, i.outstanding]).sort()).toEqual([[a.invoiceNumber, 0], [b.invoiceNumber, 2450]]);
    expect(cust.balance).toBe(2450);
    expect(cust.position).toEqual(pos(2450, 0, 0));
  });

  // ── 5. unapplied receipt ───────────────────────────────────────────────
  it("🔴 unapplied receipt: the invoice stays fully receivable, the money is a DEPOSIT, and the net is the difference — the ageing shows the gross receivable, never the net", async () => {
    const c = await customer("Unapplied");
    const inv = await issue(c, 1000); // 1,150
    await inTenant(() => paymentsService.receive({ customerId: c, amount: 500, paidAt: D2, bankAccountId: bank }, userId));
    await assertRepresentation(c, pos(1150, 0, 500));
    const aging = await inTenant(() => reportsService.arAging());
    expect(aging.items.find((i: { invoiceNumber: string }) => i.invoiceNumber === inv.invoiceNumber)?.outstanding).toBe(1150);
    expect(aging.liabilities.customerDeposits).toBeGreaterThanOrEqual(500);
  });

  // ── 6. deposit before the invoice ──────────────────────────────────────
  it("deposit first, invoice later, then allocated: the statement's chronology is receipt → invoice → allocation and the position ends at zero", async () => {
    const c = await customer("Deposit First");
    const p = await inTenant(() => paymentsService.receive({ customerId: c, amount: 1150, paidAt: D1, bankAccountId: bank, reference: "ADV-1" }, userId));
    await assertRepresentation(c, pos(0, 0, 1150));
    const inv = await issue(c, 1000, { date: D2, dueDate: D2 });
    await assertRepresentation(c, pos(1150, 0, 1150));
    await inTenant(() => paymentsService.allocate(p.id, { allocations: [{ invoiceId: inv.id, amount: 1150 }] }, userId));
    const s = await assertRepresentation(c, pos(0, 0, 0));
    expect(s.lines.map((l) => l.kind)).toEqual(["receipt", "invoice", "allocation"]);
    expect(s.lines[0]!.reference).toBe("ADV-1");
  });

  // ── 7. credit note applied to an open invoice ──────────────────────────
  it("credit note against an open invoice: the receivable falls by the applied part and NO credit balance remains", async () => {
    const c = await customer("Credited");
    const inv = await issue(c, 1000); // 1,150
    const note = await issue(c, 400, { documentType: "credit_note", originalInvoiceId: inv.id, noteReason: "Partial return", date: D2 }); // 460, applied in full
    const s = await assertRepresentation(c, pos(690, 0, 0));
    expect(s.lines.map((l) => [l.kind, l.receivableDelta, l.creditDelta])).toEqual([
      ["invoice", 1150, 0],
      ["credit_note", 0, 460],
      ["credit_application", -460, -460],
    ]);
    expect(s.lines[2]!.reference).toBe(note.invoiceNumber);
    const ledger = await inTenant(() => reportsService.customerLedger(String(c)));
    const cust = ledger.customers.find((x) => x.customerId === c)!;
    expect(cust.invoices.map((i) => [i.documentType, i.total, i.creditedAmount, i.outstanding])).toEqual([
      ["invoice", 1150, 460, 690],
      ["credit_note", -460, 0, 0],
    ]);
  });

  // ── 8. excess credit ───────────────────────────────────────────────────
  it("🔴 excess credit note (original already paid): a CREDIT BALANCE, never a negative receivable — the ageing excludes it and shows it as a liability; the customer row's balance is the negative NET", async () => {
    const c = await customer("Excess Credit");
    const inv = await issue(c, 1000); // 1,150
    await inTenant(() => paymentsService.receive({ customerId: c, amount: 1150, paidAt: D2, bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 1150 }] }, userId));
    const note = await issue(c, 1000, { documentType: "credit_note", originalInvoiceId: inv.id, noteReason: "Full return", date: D3 });
    const s = await assertRepresentation(c, pos(0, 1150, 0));
    expect(s.lines.map((l) => l.kind)).toEqual(["invoice", "receipt", "allocation", "credit_note"]);
    expect(s.current.netPosition).toBe(-1150);
    const p = await positionOf(c);
    expect(p.balance).toBe(-1150); // net exposure: we owe the customer
    expect(p.receivable).toBe(0); // and it is NOT a negative receivable
    const aging = await inTenant(() => reportsService.arAging());
    expect(aging.items.find((i: { invoiceNumber: string }) => i.invoiceNumber === inv.invoiceNumber)).toBeUndefined();
    expect(aging.items.find((i: { invoiceNumber: string }) => i.invoiceNumber === note.invoiceNumber)).toBeUndefined();
    expect(aging.liabilities.customerCredits).toBeGreaterThanOrEqual(1150);
  });

  // ── 9. application of a credit balance ─────────────────────────────────
  it("applying the credit balance to a later invoice moves value between the two components and leaves the net where it was", async () => {
    const c = await customer("Apply Credit");
    const inv = await issue(c, 1000); // 1,150
    await inTenant(() => paymentsService.receive({ customerId: c, amount: 1150, paidAt: D1, bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 1150 }] }, userId));
    const note = await issue(c, 1000, { documentType: "credit_note", originalInvoiceId: inv.id, noteReason: "Return", date: D2 }); // 1,150 credit
    const later = await issue(c, 2000, { date: D3, dueDate: D3 }); // 2,300
    await assertRepresentation(c, pos(2300, 1150, 0)); // net 1,150
    await inTenant(() => paymentsService.applyCreditNote(note.id, { allocations: [{ invoiceId: later.id, amount: 1150 }] }, userId));
    const s = await assertRepresentation(c, pos(1150, 0, 0)); // net still 1,150
    expect(s.lines.at(-1)!.kind).toBe("credit_application");
    expect(s.lines.at(-1)!.documentNumber).toBe(later.invoiceNumber);
  });

  // ── 10. unallocation ───────────────────────────────────────────────────
  it("unallocation: the superseding record appears as its own line and the components return to their pre-allocation values", async () => {
    const c = await customer("Unallocate");
    const inv = await issue(c, 1000); // 1,150
    const p = await inTenant(() => paymentsService.receive({ customerId: c, amount: 1150, paidAt: D2, bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 1150 }] }, userId));
    await assertRepresentation(c, pos(0, 0, 0));
    await inTenant(() => paymentsService.unallocate(p.allocations[0]!.id, { reason: "Wrong invoice" }, userId));
    const s = await assertRepresentation(c, pos(1150, 0, 1150));
    const un = s.lines.find((l) => l.kind === "unallocation")!;
    expect(un).toMatchObject({ receivableDelta: 1150, depositDelta: 1150, creditDelta: 0, documentNumber: inv.invoiceNumber, reference: `RCPT-${p.id}` });
    expect(un.description).toContain("Wrong invoice");
    // the original allocation line is still on the statement — superseded, not erased
    expect(s.lines.filter((l) => l.kind === "allocation")).toHaveLength(1);
  });

  // ── 11. refund ─────────────────────────────────────────────────────────
  it("refunds: a deposit refund and a credit-note refund each reduce ONLY their own component", async () => {
    const c = await customer("Refunds");
    const p = await inTenant(() => paymentsService.receive({ customerId: c, amount: 800, paidAt: D1, bankAccountId: bank }, userId));
    const inv = await issue(c, 1000); // 1,150
    await inTenant(() => paymentsService.receive({ customerId: c, amount: 1150, paidAt: D1, bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 1150 }] }, userId));
    const note = await issue(c, 1000, { documentType: "credit_note", originalInvoiceId: inv.id, noteReason: "Return", date: D2 }); // 1,150 credit
    await assertRepresentation(c, pos(0, 1150, 800));
    await inTenant(() => paymentsService.refund({ customerId: c, origin: "deposit", paymentId: p.id, amount: 300, bankAccountId: bank, refundedAt: D3, reason: "Overpaid" }, userId));
    await assertRepresentation(c, pos(0, 1150, 500));
    await inTenant(() => paymentsService.refund({ customerId: c, origin: "credit_note", creditNoteId: note.id, amount: 1150, bankAccountId: bank, refundedAt: D3, reason: "Goods returned" }, userId));
    const s = await assertRepresentation(c, pos(0, 0, 500));
    expect(s.lines.filter((l) => l.kind === "refund").map((l) => [l.depositDelta, l.creditDelta])).toEqual([[-300, 0], [0, -1150]]);
  });

  // ── 12. several balances at once ───────────────────────────────────────
  it("🔴 receivable, credit and deposit at once: three separate figures, the net derived from them, and the list totals add the components — not the nets", async () => {
    const c = await customer("All Three");
    const inv = await issue(c, 1000); // 1,150 receivable
    await inTenant(() => paymentsService.receive({ customerId: c, amount: 1150, paidAt: D1, bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 1150 }] }, userId));
    await issue(c, 500, { documentType: "credit_note", originalInvoiceId: inv.id, noteReason: "Return", date: D2 }); // 575 credit
    await inTenant(() => paymentsService.receive({ customerId: c, amount: 200, paidAt: D2, bankAccountId: bank }, userId)); // 200 deposit
    await issue(c, 2000, { date: D3, dueDate: D3 }); // 2,300 receivable
    await assertRepresentation(c, pos(2300, 575, 200)); // net 1,525
    const list = await inTenant(() => customersService.list({ search: "All Three" }));
    const me = list.items.find((i) => i.id === c)!;
    expect(me).toMatchObject({ receivable: 2300, creditBalance: 575, depositBalance: 200, netPosition: 1525, balance: 1525 });
    expect(list.totals).toMatchObject({ receivable: 2300, creditBalance: 575, depositBalance: 200, netPosition: 1525, balance: 1525 });
  });

  // ── 13. zero, only credit, only deposit ────────────────────────────────
  it("zero balance, only-credit and only-deposit customers each read exactly as they are; a customer with nothing in the books is all zeros", async () => {
    const zero = await customer("Zero");
    const inv = await issue(zero, 100);
    await inTenant(() => paymentsService.receive({ customerId: zero, amount: 115, paidAt: D2, bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 115 }] }, userId));
    await assertRepresentation(zero, pos(0, 0, 0));
    const onlyDeposit = await customer("Only Deposit");
    await inTenant(() => paymentsService.receive({ customerId: onlyDeposit, amount: 999, paidAt: D2, bankAccountId: bank }, userId));
    await assertRepresentation(onlyDeposit, pos(0, 0, 999));
    const onlyCredit = await customer("Only Credit");
    const paid = await issue(onlyCredit, 100);
    await inTenant(() => paymentsService.receive({ customerId: onlyCredit, amount: 115, paidAt: D2, bankAccountId: bank, allocations: [{ invoiceId: paid.id, amount: 115 }] }, userId));
    await issue(onlyCredit, 100, { documentType: "credit_note", originalInvoiceId: paid.id, noteReason: "Return", date: D3 });
    await assertRepresentation(onlyCredit, pos(0, 115, 0));
    const nothing = await customer("Nothing");
    expect(await positionOf(nothing)).toEqual({ receivable: 0, creditBalance: 0, depositBalance: 0, netPosition: 0, balance: 0 });
    const s = await statement(nothing);
    expect(s.lines).toEqual([]);
    expect(s.reconciled).toBe(true);
  });

  // ── 14. the ageing carries only real exposure ──────────────────────────
  it("🔴 AR ageing: every item ≥ 0, Σ items = Σ buckets = the company's GL AR, liabilities shown beside it and the net derived — never folded into a bucket", async () => {
    const aging = await inTenant(() => reportsService.arAging());
    expect(aging.items.length).toBeGreaterThan(0);
    for (const i of aging.items) expect(i.outstanding, i.invoiceNumber).toBeGreaterThan(0);
    const sumItems = Math.round(aging.items.reduce((s: number, i: { outstanding: number }) => s + i.outstanding, 0) * 100) / 100;
    const sumBuckets = Math.round(Object.values(aging.buckets).reduce((s: number, v) => s + Number(v), 0) * 100) / 100;
    expect(sumItems).toBe(aging.total);
    expect(sumBuckets).toBe(aging.total);
    expect(aging.total).toBe(await glCompanyAr());
    expect(aging.liabilities.customerCredits).toBeGreaterThan(0);
    expect(aging.liabilities.customerDeposits).toBeGreaterThan(0);
    expect(aging.netCustomerPosition).toBe(Math.round((aging.total - aging.liabilities.customerCredits - aging.liabilities.customerDeposits) * 100) / 100);
    // the liabilities are the Σ over the customer rows — one definition
    const list = await inTenant(() => customersService.list({ limit: 500 }));
    expect(list.totals.creditBalance).toBe(aging.liabilities.customerCredits);
    expect(list.totals.depositBalance).toBe(aging.liabilities.customerDeposits);
    expect(list.totals.receivable).toBe(aging.total);
  });

  // ── 15. the statement window ───────────────────────────────────────────
  it("statement window: opening folds the earlier events, closing = opening + Σ window deltas, and `current` still reconciles regardless of the window", async () => {
    const c = await customer("Windowed");
    const a = await issue(c, 1000); // D1: 1,150
    await inTenant(() => paymentsService.receive({ customerId: c, amount: 1150, paidAt: D2, bankAccountId: bank, allocations: [{ invoiceId: a.id, amount: 1150 }] }, userId));
    await issue(c, 3000, { date: D3, dueDate: D3 }); // 3,450
    const s = await statement(c, { from: D2, to: D2 });
    expect(s.opening).toEqual(pos(1150, 0, 0));
    expect(s.lines.map((l) => l.kind)).toEqual(["receipt", "allocation"]);
    expect(s.closing).toEqual(pos(0, 0, 0));
    expect(s.current).toEqual(pos(3450, 0, 0));
    expect(s.reconciled).toBe(true);
    const sumDeltas = s.lines.reduce((acc, l) => acc + l.receivableDelta, 0);
    expect(Math.round((s.opening.receivable + sumDeltas) * 100) / 100 + 0).toBe(s.closing.receivable);
    await expect(statement(c, { from: D3, to: D1 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(statement(c, { from: "yesterday" })).rejects.toMatchObject({ statusCode: 400 });
  });

  // ── 16. isolation ──────────────────────────────────────────────────────
  it("🔴 isolation: a second company's invoice for the same customer is absent from company 1's statement and position, present in company 2's (and moves it); another org's customer is 404", async () => {
    const c = await customer("Two Companies");
    await issue(c, 1000); // company 1: 1,150
    await issue(c, 2000, {}, inCompany2); // company 2: 2,300
    const s1 = await statement(c);
    expect(s1.current).toEqual(pos(1150, 0, 0));
    expect(s1.lines).toHaveLength(1);
    const s2 = await inCompany2(() => customerStatementService.statement(c, {}));
    expect(s2.current).toEqual(pos(2300, 0, 0));
    expect(s2.lines).toHaveLength(1);
    expect(s2.reconciled).toBe(true);
    const p1 = await positionOf(c);
    expect(p1.receivable).toBe(1150);
    const p2 = await inCompany2(() => customersService.getById(c));
    expect(p2.receivable).toBe(2300);
    // company 2's ageing sees only its own book, and it equals its own GL AR
    const aging2 = await inCompany2(() => reportsService.arAging());
    expect(aging2.total).toBe(2300);
    expect(aging2.total).toBe(await glCompanyAr(company2Id));
    await expect(inTenant(() => customerStatementService.statement(custOther, {}))).rejects.toMatchObject({ statusCode: 404 });
    await expect(inOther(() => customerStatementService.statement(c, {}))).rejects.toMatchObject({ statusCode: 404 });
    void bankC2;
  });

  // ── 17. Arabic data ────────────────────────────────────────────────────
  it("Arabic data: the Arabic name and Arabic reasons survive the statement unchanged", async () => {
    const c = await customer("Arabic", "شركة نجد للتجارة");
    const inv = await issue(c, 1000, { items: [{ description: "أعمال استشارية", quantity: 1, unitPrice: 1000, vatRate: 15 }] });
    const p = await inTenant(() => paymentsService.receive({ customerId: c, amount: 1150, paidAt: D2, bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 1150 }] }, userId));
    await inTenant(() => paymentsService.unallocate(p.allocations[0]!.id, { reason: "تم التخصيص للفاتورة الخطأ" }, userId));
    // dated TODAY: the unallocation posts in the open period (today), and a refund of what it freed cannot be dated before it
    await inTenant(() => paymentsService.refund({ customerId: c, origin: "deposit", paymentId: p.id, amount: 1150, bankAccountId: bank, refundedAt: businessToday(), reason: "إعادة المبلغ للعميل" }, userId));
    const s = await assertRepresentation(c, pos(1150, 0, 0));
    expect(s.customerNameAr).toBe("شركة نجد للتجارة");
    expect(s.lines.find((l) => l.kind === "unallocation")!.description).toContain("تم التخصيص للفاتورة الخطأ");
    expect(s.lines.find((l) => l.kind === "refund")!.description).toContain("إعادة المبلغ للعميل");
    const aging = await inTenant(() => reportsService.arAging());
    expect(aging.items.find((i: { invoiceNumber: string }) => i.invoiceNumber === inv.invoiceNumber)?.customerNameAr).toBe("شركة نجد للتجارة");
  });
});
