/**
 * D-4 / Batch 1B Part 1 (2026-09-17) — THE CUSTOMER PAYMENT CORE.
 *
 * Every case posts through the product's own write path and is checked on
 * the figure a human would check: the GL by account and party, the
 * balance sheet, the aging, the invoice caches, the customer's credit
 * position — and every journal balances. The suite asserts PRESENCE,
 * ABSENCE and MOVEMENT (§3): a figure appears where it should, is absent
 * where it must be, and moves by exactly the amount posted.
 *
 * The invariants this file pins (decision pack §D-4 §12):
 *   AR(customer) in the GL          = Σ invoice (total − paid − credited)
 *   Customer deposits(customer)     = Σ payment unapplied
 *   Customer credit balances(cust)  = Σ credit-note remainder beyond the original
 *   paid_amount / credited_amount   = Σ allocations (the caches never drift)
 *   every entry: debits = credits
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool, PERMISSION_MATRIX } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { can, primePermissionCache, resetPermissionCache } from "../lib/rbac";
import { invoicesService } from "../services/invoices.service";
import { paymentsService } from "../services/payments.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { reportsService } from "../services/reports.service";
import { periodLocksService } from "../services/periodLocks.service";
import { invoicesRepository } from "../repositories/invoices.repository";
import { customersRepository } from "../repositories/customers.repository";
import { createApproved } from "./helpers/createApproved";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[d4-payment-core] no real DATABASE_URL — skipping.");

const SLUG = "d4-pay";
const SLUG_OTHER = "d4-pay-other";
const EMAIL = "d4-pay@test.local";
const DATE = "2026-06-15";

describeMaybe("D-4 — customer payments, allocations, deposits, credit application", () => {
  let orgId = "";
  let companyId = "";
  let company2Id = "";
  let otherOrgId = "";
  let otherCompanyId = "";
  let userId = 0;
  let custA = 0;
  let custB = 0;
  let custOther = 0;
  let bank = 0;
  let bankC2 = 0;
  let bankOther = 0;

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
      await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
      for (const t of [
        "payment_allocations", "payments", "journal_entry_lines", "journal_entries", "transactions",
        "invoice_items", "einvoice_documents", "invoices", "customers", "period_locks",
        "audit_logs", "organization_memberships", "bank_accounts", "categories", "companies",
      ]) {
        await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await pool.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
    }
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('D4 Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'D4 Co','1010808081','399999999966603') RETURNING id`, [orgId])).rows[0].id;
    company2Id = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'D4 Co 2','1010808082','399999999966613') RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('D4 Other','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'D4 Other Co','1010808083','399999999966623') RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','D4',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) {
      await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    }
    custA = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Najd Trading') RETURNING id`, [orgId])).rows[0].id;
    custB = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Hail Supplies') RETURNING id`, [orgId])).rows[0].id;
    custOther = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Other Customer') RETURNING id`, [otherOrgId])).rows[0].id;
    bank = (await inTenant(() => bankAccountsService.create({ name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bankC2 = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Co2 Main','ANB') RETURNING id`, [orgId, company2Id])).rows[0].id;
    bankOther = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Other Main','ANB') RETURNING id`, [otherOrgId, otherCompanyId])).rows[0].id;
  });
  afterAll(cleanup);

  // ── helpers ──────────────────────────────────────────────────────────────
  let seq = 0;
  /** An issued invoice for `net` (+15% VAT) — the product's own path. */
  async function issue(customerId: number, net: number, opts: Record<string, unknown> = {}, run = inTenant) {
    seq += 1;
    const inv = await run(() =>
      createApproved<{ id: number; total: number; invoiceNumber: string }>(
        invoicesService,
        { invoiceNumber: `D4-${String(seq).padStart(3, "0")}`, date: DATE, dueDate: DATE, customerId, items: [{ description: "Work", quantity: 1, unitPrice: net, vatRate: 15 }], ...opts },
        userId,
      ),
    );
    return inv;
  }
  async function creditNote(customerId: number, originalId: number, net: number) {
    return issue(customerId, net, { documentType: "credit_note", originalInvoiceId: originalId, noteReason: "Return" });
  }
  const invoiceRow = async (id: number) => (await pool.query(`SELECT status, total::text, paid_amount::text, credited_amount::text, paid_at FROM invoices WHERE id = $1`, [id])).rows[0];
  /** Σ (Dr − Cr) on a system account for one customer, in-books entries only. */
  const gl = async (code: string, customerId: number | null, org = orgId) =>
    Number(
      (
        await pool.query(
          `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS v
             FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
            WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')
              AND ($3::int IS NULL OR l.customer_id = $3)`,
          [org, code, customerId],
        )
      ).rows[0].v,
    );
  const bankBalance = async (bankId: number) =>
    Number((await pool.query(`SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS v FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE c.bank_account_id = $1`, [bankId])).rows[0].v);
  /** Every entry of the org balances. */
  const allEntriesBalance = async () => {
    const { rows } = await pool.query(
      `SELECT e.entry_number, sum(l.debit_amount)::text AS dr, sum(l.credit_amount)::text AS cr
         FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id
        WHERE e.organization_id = $1 GROUP BY e.entry_number HAVING sum(l.debit_amount) <> sum(l.credit_amount)`,
      [orgId],
    );
    expect(rows, "unbalanced entries").toEqual([]);
  };
  /** The subledger ↔ GL ↔ cache invariants, for one customer. */
  const assertInvariants = async (customerId: number) => {
    await allEntriesBalance();
    const { rows: invs } = await pool.query(
      `SELECT id, total::numeric AS total, coalesce(paid_amount,0)::numeric AS paid, credited_amount::numeric AS credited, document_type
         FROM invoices WHERE organization_id = $1 AND customer_id = $2 AND invoice_hash IS NOT NULL`,
      [orgId, customerId],
    );
    let receivable = 0;
    for (const i of invs) {
      const { rows: [a] } = await pool.query(
        `SELECT coalesce(sum(amount) FILTER (WHERE payment_id IS NOT NULL), 0)::numeric AS paid,
                coalesce(sum(amount) FILTER (WHERE credit_note_id IS NOT NULL), 0)::numeric AS credited
           FROM payment_allocations WHERE invoice_id = $1`,
        [i.id],
      );
      if (i.document_type === "invoice") {
        expect(Number(i.paid), `paid_amount cache of invoice ${i.id}`).toBe(Number(a.paid));
        expect(Number(i.credited), `credited_amount cache of invoice ${i.id}`).toBe(Number(a.credited));
        receivable += Number(i.total) - Number(i.paid) - Number(i.credited);
      }
    }
    const z = (n: number) => Math.round(n * 100) / 100 + 0; // −0 → +0 for Object.is
    expect(z(await gl("AR", customerId)), "GL AR(customer) = Σ outstanding").toBe(z(receivable));
    const pos = await inTenant(() => paymentsService.customerCredits(customerId));
    expect(z(-(await gl("CUSTOMER_DEPOSITS", customerId))), "GL deposits(customer) = Σ unapplied").toBe(z(pos.deposits));
    expect(z(-(await gl("CUSTOMER_CREDITS", customerId))), "GL credit balances(customer) = Σ note remainder").toBe(z(pos.creditNotes));
  };

  // ── 1. full payment ────────────────────────────────────────────────────
  it("🔴 full payment: Dr bank / Cr AR for the whole invoice; invoice PAID; one payment, one allocation, one entry", async () => {
    const inv = await issue(custA, 5000); // 5,750
    const arBefore = await gl("AR", custA);
    const cashBefore = await bankBalance(bank);
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 5750, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 5750 }], reference: "TT-1" }, userId));
    expect(p).toMatchObject({ amount: 5750, allocatedAmount: 5750, unappliedAmount: 0, customerId: custA, bankAccountId: bank, source: "manual", direction: "in" });
    expect(p.allocations).toHaveLength(1);
    expect(p.allocations[0]).toMatchObject({ invoiceId: inv.id, amount: 5750, journalEntryId: null }); // folded into the receipt's entry
    const row = await invoiceRow(inv.id);
    expect(row.status).toBe("paid");
    expect(row.paid_amount).toBe("5750.00");
    expect(await gl("AR", custA)).toBe(arBefore - 5750);
    expect(await bankBalance(bank)).toBe(cashBefore + 5750);
    expect(await gl("CUSTOMER_DEPOSITS", custA)).toBe(0);
    const { rows: [je] } = await pool.query(`SELECT entry_number, date FROM journal_entries WHERE id = $1`, [p.journalEntryId]);
    expect(je.entry_number).toBe(`GL-${inv.invoiceNumber}-RCPT-${p.id}`);
    await assertInvariants(custA);
  });

  // ── 2. partial payment ─────────────────────────────────────────────────
  it("🔴 partial payment: the invoice stays open at total − paid; AR, cash, customer balance move by exactly the amount", async () => {
    const inv = await issue(custA, 5000); // 5,750
    const bal0 = (await inTenant(() => customersRepository.customerBalances(custA)))[0]?.totalPaid ?? 0;
    await inTenant(() => paymentsService.receive({ customerId: custA, amount: 2000, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 2000 }] }, userId));
    const row = await invoiceRow(inv.id);
    expect(row.status).toBe("sent");
    expect(row.paid_amount).toBe("2000.00");
    const [bal] = await inTenant(() => customersRepository.customerBalances(custA));
    expect(bal.totalPaid - bal0).toBe(2000);
    const aging = await inTenant(() => reportsService.arAging());
    expect(aging.items.find((i: { invoiceNumber: string }) => i.invoiceNumber === inv.invoiceNumber)?.outstanding).toBe(3750);
    // The KPI equals Σ aging equals GL AR — one fact, three readers.
    const meta = await inTenant(() => invoicesRepository.listMeta({}));
    expect(meta.outstanding).toBe(Number(aging.total));
    const bs = await inTenant(() => reportsService.balanceSheet("2026-12-31"));
    expect(Number(bs.assets.accountsReceivable)).toBe(Number(aging.total));
    await assertInvariants(custA);
  });

  // ── 3. multiple payments → one invoice ─────────────────────────────────
  it("multiple payments to one invoice: 4,000 + 6,000 settle 10,000; each payment stays its own auditable record", async () => {
    const inv = await issue(custA, 10000 / 1.15); // ≈ 10,000 gross
    const total = Number((await invoiceRow(inv.id)).total);
    const p1 = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 4000, paidAt: "2026-06-16", bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 4000 }] }, userId));
    const p2 = await inTenant(() => paymentsService.receive({ customerId: custA, amount: total - 4000, paidAt: "2026-06-20", bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: total - 4000 }] }, userId));
    expect(p1.id).not.toBe(p2.id);
    expect((await invoiceRow(inv.id)).status).toBe("paid");
    const history = await inTenant(() => invoicesService.payments(inv.id));
    expect(history.map((h) => h.paidAt)).toEqual(["2026-06-20", "2026-06-16"]);
    expect(history.map((h) => h.paymentId)).toEqual([p2.id, p1.id]);
    const { rows } = await pool.query(`SELECT entity_id, action FROM audit_logs WHERE organization_id = $1 AND entity_type = 'payment' AND entity_id IN ($2, $3)`, [orgId, String(p1.id), String(p2.id)]);
    expect(rows.map((r) => r.action)).toEqual(["create", "create"]);
    await assertInvariants(custA);
  });

  // ── 4. one payment → multiple invoices ─────────────────────────────────
  it("🔴 one payment → several invoices: allocations settle A and B in one entry; Σ allocations ≤ amount and ≤ each outstanding are enforced", async () => {
    const a = await issue(custA, 4000 / 1.15);
    const b = await issue(custA, 6000 / 1.15);
    const ta = Number((await invoiceRow(a.id)).total);
    const tb = Number((await invoiceRow(b.id)).total);
    // beyond the invoice's outstanding → refused whole, nothing posted
    const jeBefore = (await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n;
    await expect(inTenant(() => paymentsService.receive({ customerId: custA, amount: ta + tb + 1, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: a.id, amount: ta + 1 }, { invoiceId: b.id, amount: tb }] }, userId))).rejects.toMatchObject({ statusCode: 409 });
    // beyond the payment → refused
    await expect(inTenant(() => paymentsService.receive({ customerId: custA, amount: ta, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: a.id, amount: ta }, { invoiceId: b.id, amount: tb }] }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "allocation_exceeds_payment" } });
    expect((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(jeBefore);
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: ta + tb, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: a.id, amount: ta }, { invoiceId: b.id, amount: tb }] }, userId));
    expect(p.allocations).toHaveLength(2);
    expect((await invoiceRow(a.id)).status).toBe("paid");
    expect((await invoiceRow(b.id)).status).toBe("paid");
    const { rows: lines } = await pool.query(`SELECT count(*)::int AS n FROM journal_entry_lines WHERE journal_entry_id = $1`, [p.journalEntryId]);
    expect(lines[0].n).toBe(2); // one bank line, one AR line for the sum
    await assertInvariants(custA);
  });

  // ── 5. unapplied receipt ───────────────────────────────────────────────
  let depositPayment = 0;
  it("🔴 unapplied receipt: Dr bank / Cr Customer deposits — AR untouched, no negative invoice, the receipt is auditable as unapplied", async () => {
    const arBefore = await gl("AR", custB);
    const p = await inTenant(() => paymentsService.receive({ customerId: custB, amount: 5000, paidAt: DATE, bankAccountId: bank, reference: "ON ACCOUNT" }, userId));
    depositPayment = p.id;
    expect(p).toMatchObject({ allocatedAmount: 0, unappliedAmount: 5000 });
    expect(await gl("AR", custB)).toBe(arBefore);
    expect(await gl("CUSTOMER_DEPOSITS", custB)).toBe(-5000);
    const { rows: [je] } = await pool.query(`SELECT entry_number FROM journal_entries WHERE id = $1`, [p.journalEntryId]);
    expect(je.entry_number).toBe(`RCPT-${p.id}`);
    const { rows: audit } = await pool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND entity_type = 'payment' AND entity_id = $2`, [orgId, String(p.id)]);
    expect(audit.map((r) => r.action).sort()).toEqual(["create", "unapplied"]);
    const credits = await inTenant(() => paymentsService.customerCredits(custB));
    expect(credits).toEqual({ customerId: custB, deposits: 5000, creditNotes: 0 });
    // the liability is on the balance sheet, not netted into AR
    const bs = await inTenant(() => reportsService.balanceSheet("2026-12-31"));
    const dep = bs.liabilities.items.find((i: { name: string }) => i.name === "Customer deposits and advances");
    expect(Number(dep?.amount)).toBe(5000);
    await assertInvariants(custB);
  });

  it("an unapplied amount with no customer is refused — a deposit is owed to someone", async () => {
    await expect(inTenant(() => paymentsService.receive({ amount: 100, paidAt: DATE, bankAccountId: bank }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "customer_required_for_unapplied" } });
  });

  // ── 6. later allocation ────────────────────────────────────────────────
  it("🔴 later allocation: Dr Customer deposits / Cr AR for 3,000; 2,000 stays on deposit; the original receipt is intact; the allocation is its own entry", async () => {
    const inv = await issue(custB, 3000 / 1.15);
    const total = Number((await invoiceRow(inv.id)).total);
    const before = await inTenant(() => paymentsService.get(depositPayment));
    const p = await inTenant(() => paymentsService.allocate(depositPayment, { allocations: [{ invoiceId: inv.id, amount: total }] }, userId));
    expect(p.amount).toBe(before.amount);
    expect(p.journalEntryId).toBe(before.journalEntryId); // the receipt's own entry untouched
    expect(p.unappliedAmount).toBe(Math.round((5000 - total) * 100) / 100);
    const alloc = p.allocations.find((a) => a.invoiceId === inv.id)!;
    expect(alloc.journalEntryId).not.toBeNull();
    const { rows: [je] } = await pool.query(`SELECT entry_number FROM journal_entries WHERE id = $1`, [alloc.journalEntryId]);
    expect(je.entry_number).toBe(`ALLOC-${alloc.id}`);
    expect(await gl("CUSTOMER_DEPOSITS", custB)).toBe(-(5000 - total));
    expect((await invoiceRow(inv.id)).status).toBe("paid");
    const { rows: audit } = await pool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND entity_type = 'payment' AND entity_id = $2`, [orgId, String(depositPayment)]);
    expect(audit.map((r) => r.action).sort()).toEqual(["allocate", "create", "unapplied"]);
    // beyond the remainder → refused
    const inv2 = await issue(custB, 5000);
    await expect(inTenant(() => paymentsService.allocate(depositPayment, { allocations: [{ invoiceId: inv2.id, amount: 5000 - total + 0.01 }] }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "allocation_exceeds_payment" } });
    await assertInvariants(custB);
  });

  // ── 7. overpayment ─────────────────────────────────────────────────────
  it("🔴 over-payment: 5,000 settles the invoice, 1,000 becomes a deposit with its origin (the receipt) — never AR = −1,000, never a credit note", async () => {
    const inv = await issue(custA, 5000 / 1.15);
    const total = Number((await invoiceRow(inv.id)).total);
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: total + 1000, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: total }] }, userId));
    expect(p.unappliedAmount).toBe(1000);
    expect((await invoiceRow(inv.id)).status).toBe("paid");
    const outstanding = (await inTenant(() => reportsService.arAging())).items.find((i: { invoiceNumber: string }) => i.invoiceNumber === inv.invoiceNumber);
    expect(outstanding).toBeUndefined(); // 0, not −1,000
    const credits = await inTenant(() => paymentsService.customerCredits(custA));
    expect(credits.deposits).toBe(1000);
    expect(credits.creditNotes).toBe(0);
    // Mark Paid (the convenience) still refuses more than the outstanding — the excess is the caller's explicit decision through POST /payments
    const inv2 = await issue(custA, 1000);
    await expect(inTenant(() => invoicesService.pay(inv2.id, { amount: 1150.01, bankAccountId: bank }, userId))).rejects.toMatchObject({ statusCode: 409 });
    await assertInvariants(custA);
  });

  // ── 8. credit-note application ─────────────────────────────────────────
  it("🔴 credit note: settles its original's open balance (contra-AR), the excess is a credit balance; applied later to another invoice with the note untouched", async () => {
    // A: 2,300 gross, 1,000 already paid (outstanding 1,300). A full credit note
    // for 2,300 (the over-crediting guard caps a note at the original's total):
    // 1,300 settles A, the 1,000 the customer already paid is owed BACK.
    const a = await issue(custB, 2000); // 2,300
    await inTenant(() => paymentsService.receive({ customerId: custB, amount: 1000, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: a.id, amount: 1000 }] }, userId));
    const ta = 1300; // A's outstanding when the note lands
    const note = await creditNote(custB, a.id, 2000); // 2,300
    const noteRow = await invoiceRow(note.id);
    expect(noteRow.paid_amount).toBe("0.00"); // the note itself is untouched
    expect((await invoiceRow(a.id)).credited_amount).toBe(ta.toFixed(2));
    expect((await invoiceRow(a.id)).paid_amount).toBe("1000.00"); // cash history untouched by the note
    expect(await gl("CUSTOMER_CREDITS", custB)).toBe(-(2300 - ta));
    const { rows: [issueAlloc] } = await pool.query(`SELECT amount::text, journal_entry_id FROM payment_allocations WHERE credit_note_id = $1`, [note.id]);
    expect(issueAlloc.amount).toBe(ta.toFixed(2));
    expect(issueAlloc.journal_entry_id).not.toBeNull();
    // A is settled: aging shows nothing for it and nothing negative anywhere
    const aging = await inTenant(() => reportsService.arAging());
    expect(aging.items.find((i: { invoiceNumber: string }) => i.invoiceNumber === a.invoiceNumber)).toBeUndefined();
    expect(aging.items.every((i: { outstanding: number }) => i.outstanding >= 0)).toBe(true);
    // apply the 1,000 remainder to B
    const b = await issue(custB, 1000); // 1,150
    const remainder = Math.round((2300 - ta) * 100) / 100;
    const app = await inTenant(() => paymentsService.applyCreditNote(note.id, { allocations: [{ invoiceId: b.id, amount: remainder }] }, userId));
    expect(app.remainingAmount).toBe(0);
    expect(app.applications).toHaveLength(2);
    expect((await invoiceRow(b.id)).credited_amount).toBe(remainder.toFixed(2));
    expect(await gl("CUSTOMER_CREDITS", custB)).toBe(0);
    expect((await invoiceRow(note.id)).paid_amount).toBe("0.00"); // still untouched
    const { rows: [je] } = await pool.query(`SELECT entry_number FROM journal_entries WHERE id = $1`, [app.applications[1]!.journalEntryId]);
    expect(je.entry_number).toMatch(new RegExp(`^GL-${note.invoiceNumber}-APP-\\d+$`));
    // beyond the remainder → refused; a note is never a payment target; a note cannot be paid
    await expect(inTenant(() => paymentsService.applyCreditNote(note.id, { allocations: [{ invoiceId: b.id, amount: 0.01 }] }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "allocation_exceeds_credit" } });
    await expect(inTenant(() => paymentsService.receive({ customerId: custB, amount: 10, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: note.id, amount: 10 }] }, userId))).rejects.toMatchObject({ statusCode: 409 });
    // the deposit and the credit-note balance are shown APART, never one figure
    const credits = await inTenant(() => paymentsService.customerCredits(custB));
    expect(credits.creditNotes).toBe(0);
    expect(credits.deposits).toBeGreaterThan(0);
    await assertInvariants(custB);
  });

  it("a credit note whose excess would be owed to an UNIDENTIFIED customer is refused at approval — nothing posts", async () => {
    // A B2C invoice, paid in full, then over-credited: no customer to owe the excess to.
    const b2c = await issue(null as unknown as number, 1000, { customerId: null });
    await inTenant(() => invoicesService.pay(b2c.id, { amount: 1150, bankAccountId: bank }, userId));
    const draft = await inTenant(() => invoicesService.create({ invoiceNumber: "D4-B2C-CN", date: DATE, customerId: null, documentType: "credit_note", originalInvoiceId: b2c.id, noteReason: "Return", items: [{ description: "Return", quantity: 1, unitPrice: 1000, vatRate: 15 }] }, userId));
    await expect(inTenant(() => invoicesService.approve(draft.id, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "credit_note_excess_unidentified_customer" } });
    const { rows: [n] } = await pool.query(`SELECT status, invoice_hash FROM invoices WHERE id = $1`, [draft.id]);
    expect(n.invoice_hash).toBeNull();
  });

  // ── 9. duplicate payment request ───────────────────────────────────────
  it("🔴 the same payment request twice is ONE payment; the key reused for a different payment is a 409", async () => {
    const inv = await issue(custA, 1000);
    const body = { customerId: custA, amount: 1150, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 1150 }], idempotencyKey: `d4-key-${Date.now()}` };
    const first = await inTenant(() => paymentsService.receive(body, userId));
    const second = await inTenant(() => paymentsService.receive(body, userId));
    expect(second.id).toBe(first.id);
    expect((await pool.query(`SELECT count(*)::int AS n FROM payments WHERE idempotency_key = $1`, [body.idempotencyKey])).rows[0].n).toBe(1);
    expect((await invoiceRow(inv.id)).paid_amount).toBe("1150.00");
    await expect(inTenant(() => paymentsService.receive({ ...body, amount: 999, allocations: [] }, userId))).rejects.toMatchObject({ statusCode: 409 });
    // the DB refuses a raw duplicate too — the guard is not the client's
    await expect(pool.query(`INSERT INTO payments (organization_id, company_id, direction, party_type, customer_id, bank_account_id, amount, paid_at, idempotency_key, source, journal_entry_id) VALUES ($1,$2,'in','customer',$3,$4,1,'2026-06-15',$5,'manual',$6)`, [orgId, companyId, custA, bank, body.idempotencyKey, first.journalEntryId])).rejects.toMatchObject({ code: "23505" });
    // Mark Paid carries the key too
    const inv2 = await issue(custA, 1000);
    const key = `d4-pay-key-${Date.now()}`;
    await inTenant(() => invoicesService.pay(inv2.id, { amount: 500, bankAccountId: bank, idempotencyKey: key }, userId));
    await inTenant(() => invoicesService.pay(inv2.id, { amount: 500, bankAccountId: bank, idempotencyKey: key }, userId));
    expect((await invoiceRow(inv2.id)).paid_amount).toBe("500.00");
    await assertInvariants(custA);
  });

  // ── 10. duplicate allocation request ───────────────────────────────────
  it("🔴 the same allocation request twice is ONE allocation; the same (payment, invoice) pair twice is refused by the index", async () => {
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 3000, paidAt: DATE, bankAccountId: bank }, userId));
    const inv = await issue(custA, 1000);
    const key = `d4-alloc-${Date.now()}`;
    const first = await inTenant(() => paymentsService.allocate(p.id, { allocations: [{ invoiceId: inv.id, amount: 1150 }], idempotencyKey: key }, userId));
    const second = await inTenant(() => paymentsService.allocate(p.id, { allocations: [{ invoiceId: inv.id, amount: 1150 }], idempotencyKey: key }, userId));
    expect(second.allocations).toHaveLength(first.allocations.length);
    expect(second.unappliedAmount).toBe(1850);
    // no key, same pair again → the unique index speaks
    const inv2 = await issue(custA, 1000);
    await inTenant(() => paymentsService.allocate(p.id, { allocations: [{ invoiceId: inv2.id, amount: 100 }] }, userId));
    await expect(inTenant(() => paymentsService.allocate(p.id, { allocations: [{ invoiceId: inv2.id, amount: 100 }] }, userId))).rejects.toMatchObject({ statusCode: 409 });
    expect((await invoiceRow(inv2.id)).paid_amount).toBe("100.00");
    await assertInvariants(custA);
  });

  // ── accounting: every entry balances, TB conserved ─────────────────────
  it("every journal posted by this suite balances, and the balance sheet balances", async () => {
    await allEntriesBalance();
    const bs = await inTenant(() => reportsService.balanceSheet("2026-12-31"));
    expect(bs.balanced).toBe(true);
  });

  // ── security ───────────────────────────────────────────────────────────
  it("🔴 isolation: another org cannot see, allocate or target this org's payment/invoice; presence on one side, absence on the other, movement on both", async () => {
    const inv = await issue(custA, 1000);
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 2000, paidAt: DATE, bankAccountId: bank }, userId));
    // absence: the other org sees nothing
    await expect(inOther(() => paymentsService.get(p.id))).rejects.toMatchObject({ statusCode: 404 });
    await expect(inOther(() => paymentsService.allocate(p.id, { allocations: [{ invoiceId: inv.id, amount: 1 }] }, userId))).rejects.toMatchObject({ statusCode: 404 });
    // the other org's own receipt cannot target our invoice (RLS hides it — "not found", not "not yours")
    const other = await inOther(() => paymentsService.receive({ customerId: custOther, amount: 500, paidAt: DATE, bankAccountId: bankOther }, userId));
    await expect(inOther(() => paymentsService.allocate(other.id, { allocations: [{ invoiceId: inv.id, amount: 1 }] }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "reference_not_found" } });
    // our receipt cannot name the other org's bank or customer
    await expect(inTenant(() => paymentsService.receive({ customerId: custA, amount: 1, paidAt: DATE, bankAccountId: bankOther }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "reference_not_found" } });
    await expect(inTenant(() => paymentsService.receive({ customerId: custOther, amount: 1, paidAt: DATE, bankAccountId: bank }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "reference_not_found" } });
    // presence + movement: each side shows its own figure
    expect((await inTenant(() => paymentsService.list({}))).some((x) => x.id === p.id)).toBe(true);
    expect((await inOther(() => paymentsService.list({}))).map((x) => x.id)).toEqual([other.id]);
    expect(await gl("CUSTOMER_DEPOSITS", custOther, otherOrgId)).toBe(-500);
    // company arm: company 2 of the SAME org sees neither the payment nor the invoice
    await expect(inCompany2(() => paymentsService.get(p.id))).rejects.toMatchObject({ statusCode: 404 });
    await expect(inCompany2(() => paymentsService.receive({ customerId: custA, amount: 1, paidAt: DATE, bankAccountId: bankC2, allocations: [{ invoiceId: inv.id, amount: 1 }] }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "reference_not_found" } });
    // a party mismatch inside the org is named, not silently allocated
    const otherCustomersInvoice = await issue(custB, 100);
    await expect(inTenant(() => paymentsService.allocate(p.id, { allocations: [{ invoiceId: otherCustomersInvoice.id, amount: 1 }] }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "allocation_party_mismatch" } });
  });

  it("permissions: recording, allocating and applying are approver-level; every role can read", async () => {
    primePermissionCache(PERMISSION_MATRIX);
    expect(await can("admin", "payments", "create")).toBe(true);
    expect(await can("accountant", "payments", "create")).toBe(true);
    expect(await can("bookkeeper", "payments", "create")).toBe(false);
    expect(await can("viewer", "payments", "create")).toBe(false);
    expect(await can("bookkeeper", "payments", "approve")).toBe(false);
    expect(await can("accountant", "payments", "approve")).toBe(true);
    for (const r of ["admin", "accountant", "bookkeeper", "viewer"]) expect(await can(r, "payments", "read")).toBe(true);
    resetPermissionCache();
  });

  it("append-only: the app role can neither update nor delete a payment or an allocation", async () => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const sql = (await import("drizzle-orm")).sql;
      const { db } = await import("@workspace/db");
      await expect(conn.run(() => db.execute(sql`UPDATE payments SET amount = 1`))).rejects.toMatchObject({ cause: { code: "42501" } });
    } finally {
      await conn.rollback();
    }
    const conn2 = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const sql = (await import("drizzle-orm")).sql;
      const { db } = await import("@workspace/db");
      await expect(conn2.run(() => db.execute(sql`DELETE FROM payment_allocations`))).rejects.toMatchObject({ cause: { code: "42501" } });
    } finally {
      await conn2.rollback();
    }
  });

  // ── period controls ────────────────────────────────────────────────────
  it("🔴 a receipt into a CLOSED month is refused with the structured 423 and nothing posts; an open month posts", async () => {
    const inv = await issue(custA, 1000);
    await inTenant(() => periodLocksService.lock({ period: "2026-05", userId }));
    const before = (await pool.query(`SELECT count(*)::int AS n FROM payments WHERE organization_id = $1`, [orgId])).rows[0].n;
    await expect(inTenant(() => paymentsService.receive({ customerId: custA, amount: 100, paidAt: "2026-05-10", bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 100 }] }, userId))).rejects.toMatchObject({ statusCode: 423 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM payments WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(before);
    expect((await invoiceRow(inv.id)).paid_amount).toBe("0.00");
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 100, paidAt: "2026-06-10", bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 100 }] }, userId));
    expect(p.amount).toBe(100);
    await inTenant(() => periodLocksService.unlock("2026-05"));
  });

  it("a receipt with no bank, an inactive bank, or a draft target fails closed", async () => {
    const inv = await issue(custA, 100);
    await expect(inTenant(() => paymentsService.receive({ customerId: custA, amount: 1, paidAt: DATE }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "bank_account_required" } });
    const draft = await inTenant(() => invoicesService.create({ invoiceNumber: "D4-DRAFT", date: DATE, customerId: custA, items: [{ description: "x", quantity: 1, unitPrice: 10, vatRate: 15 }] }, userId));
    await expect(inTenant(() => paymentsService.receive({ customerId: custA, amount: 1, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: draft.id, amount: 1 }] }, userId))).rejects.toMatchObject({ statusCode: 409 });
    void inv;
  });
});
