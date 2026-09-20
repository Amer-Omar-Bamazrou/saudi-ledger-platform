/**
 * Batch 1B Part 2 — Phase A (unallocation as a superseding record) and
 * Phase C (customer refunds). 2026-09-17.
 *
 * The correction model under test: an allocation is never edited or
 * deleted. A `payment_allocation_reversals` row (UNIQUE per allocation)
 * supersedes it with its own entry — Dr AR / Cr the origin's liability —
 * restoring the source's availability and the invoice's outstanding by
 * exactly the allocation's amount, party-correct, dated today, period-
 * controlled. A refund settles an existing deposit or credit-note balance
 * from a NAMED source — Dr the origin's liability / Cr bank — and never
 * reverses the receipt or the note.
 *
 * Every case ends by asserting the invariant set (§3: presence, absence,
 * movement): journals balance, outstanding ≥ 0, GL AR / deposits / credits
 * = the subledger per customer, caches = allocation truth.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { paymentsService } from "../services/payments.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { reportsService } from "../services/reports.service";
import { periodLocksService } from "../services/periodLocks.service";
import { createApproved } from "./helpers/createApproved";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "d4-corr";
const SLUG_OTHER = "d4-corr-other";
const EMAIL = "d4-corr@test.local";
const DATE = "2026-06-15";

describeMaybe("D-4 Part 2 — unallocation (superseding record) and customer refunds", () => {
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
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('D4C Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'D4C Co','1010818181','399999999988803') RETURNING id`, [orgId])).rows[0].id;
    company2Id = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'D4C Co 2','1010818182','399999999988813') RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('D4C Other','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'D4C Other Co','1010818183','399999999988823') RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','D4C',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    custA = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Najd Trading') RETURNING id`, [orgId])).rows[0].id;
    custB = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Hail Supplies') RETURNING id`, [orgId])).rows[0].id;
    custOther = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Other Customer') RETURNING id`, [otherOrgId])).rows[0].id;
    bank = (await inTenant(() => bankAccountsService.create({ name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bankC2 = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Co2 Main','ANB') RETURNING id`, [orgId, company2Id])).rows[0].id;
    bankOther = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Other Main','ANB') RETURNING id`, [otherOrgId, otherCompanyId])).rows[0].id;
  });
  afterAll(cleanup);

  let seq = 0;
  /** An issued invoice for `net` SAR (+15% VAT — gross = net × 1.15, exact for round nets). */
  async function issue(customerId: number, net: number, opts: Record<string, unknown> = {}) {
    seq += 1;
    return inTenant(() =>
      createApproved<{ id: number; invoiceNumber: string }>(
        invoicesService,
        { invoiceNumber: `D4C-${String(seq).padStart(3, "0")}`, date: DATE, dueDate: DATE, customerId, items: [{ description: "Work", quantity: 1, unitPrice: net, vatRate: 15 }], ...opts },
        userId,
      ),
    );
  }
  const row = async (id: number) => (await pool.query(`SELECT status, total::text, coalesce(paid_amount,0)::text AS paid, credited_amount::text AS credited FROM invoices WHERE id = $1`, [id])).rows[0];
  const outstanding = async (id: number) => { const r = await row(id); return Math.round((Number(r.total) - Number(r.paid) - Number(r.credited)) * 100) / 100; };
  const gl = async (code: string, customerId: number | null, org = orgId) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS v
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed') AND ($3::int IS NULL OR l.customer_id = $3)`,
      [org, code, customerId])).rows[0].v);
  const bankBalance = async (bankId: number) => Number((await pool.query(`SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS v FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE c.bank_account_id = $1`, [bankId])).rows[0].v);
  const entry = async (id: number) => (await pool.query(`SELECT entry_number, date, status FROM journal_entries WHERE id = $1`, [id])).rows[0];
  const z = (n: number) => Math.round(n * 100) / 100 + 0;

  /** The invariant set for one customer (and the org's journals). */
  const assertInvariants = async (customerId: number) => {
    const { rows: bad } = await pool.query(`SELECT e.entry_number FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id WHERE e.organization_id = $1 GROUP BY e.id HAVING sum(l.debit_amount) <> sum(l.credit_amount)`, [orgId]);
    expect(bad, "unbalanced").toEqual([]);
    const { rows: invs } = await pool.query(`SELECT id, total::numeric AS total, coalesce(paid_amount,0)::numeric AS paid, credited_amount::numeric AS credited FROM invoices WHERE organization_id = $1 AND customer_id = $2 AND document_type = 'invoice' AND invoice_hash IS NOT NULL`, [orgId, customerId]);
    let receivable = 0;
    for (const i of invs) {
      const { rows: [a] } = await pool.query(
        `SELECT coalesce(sum(a.amount) FILTER (WHERE a.payment_id IS NOT NULL), 0)::numeric AS paid,
                coalesce(sum(a.amount) FILTER (WHERE a.credit_note_id IS NOT NULL), 0)::numeric AS credited
           FROM payment_allocations a LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id
          WHERE a.invoice_id = $1 AND r.id IS NULL`, [i.id]);
      expect(Number(i.paid), `paid cache ${i.id}`).toBe(Number(a.paid));
      expect(Number(i.credited), `credited cache ${i.id}`).toBe(Number(a.credited));
      const o = Number(i.total) - Number(i.paid) - Number(i.credited);
      expect(o, `outstanding ${i.id} ≥ 0`).toBeGreaterThanOrEqual(-0.001);
      receivable += o;
    }
    expect(z(await gl("AR", customerId)), "GL AR = Σ outstanding").toBe(z(receivable));
    const pos = await inTenant(() => paymentsService.customerCredits(customerId));
    expect(z(-(await gl("CUSTOMER_DEPOSITS", customerId))), "GL deposits = subledger").toBe(z(pos.deposits));
    expect(z(-(await gl("CUSTOMER_CREDITS", customerId))), "GL credits = subledger").toBe(z(pos.creditNotes));
    // Σ active allocations + Σ refunds ≤ every source
    const { rows: over } = await pool.query(
      `SELECT p.id FROM payments p WHERE p.organization_id = $1 AND p.amount < coalesce((SELECT sum(a.amount) FROM payment_allocations a LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id WHERE a.payment_id = p.id AND r.id IS NULL), 0) + coalesce((SELECT sum(f.amount) FROM customer_refunds f WHERE f.payment_id = p.id), 0)`, [orgId]);
    expect(over, "payment over-consumed").toEqual([]);
    const { rows: overNote } = await pool.query(
      `SELECT n.id FROM invoices n WHERE n.organization_id = $1 AND n.document_type = 'credit_note' AND n.total::numeric < coalesce((SELECT sum(a.amount) FROM payment_allocations a LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id WHERE a.credit_note_id = n.id AND r.id IS NULL), 0) + coalesce((SELECT sum(f.amount) FROM customer_refunds f WHERE f.credit_note_id = n.id), 0)`, [orgId]);
    expect(overNote, "note over-consumed").toEqual([]);
  };

  // ── Phase A ────────────────────────────────────────────────────────────
  it("🔴 wrong-invoice allocation: correction supersedes it, restores the payment to 5,000 available and A's outstanding, then B can be settled — the original allocation stays visible", async () => {
    const a = await issue(custA, 4000); // 4,600
    const b = await issue(custA, 6000); // 6,900 — B can absorb the 5,000
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 5000, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: a.id, amount: 4600 }] }, userId));
    const allocId = p.allocations[0]!.id;
    expect((await row(a.id)).status).toBe("paid");
    expect(p.unappliedAmount).toBe(400);
    expect(await gl("CUSTOMER_DEPOSITS", custA)).toBe(-400);

    const corrected = await inTenant(() => paymentsService.unallocate(allocId, { reason: "Allocated to the wrong invoice" }, userId));
    expect(corrected.reversedBy).not.toBeNull();
    expect(corrected.amount).toBe(4600); // the original row is untouched
    const { rows: [orig] } = await pool.query(`SELECT amount::text, invoice_id, journal_entry_id FROM payment_allocations WHERE id = $1`, [allocId]);
    expect(orig).toEqual({ amount: "4600.00", invoice_id: a.id, journal_entry_id: null });
    const je = await entry(corrected.reversedBy!.journalEntryId);
    expect(je.entry_number).toBe(`UNALLOC-${corrected.reversedBy!.id}`);
    expect(je.status).toBe("posted");
    // GL: Dr AR(custA) 5,000 / Cr deposits(custA) 5,000 — party-correct
    const { rows: lines } = await pool.query(`SELECT c.system_code, l.debit_amount::text dr, l.credit_amount::text cr, l.customer_id FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.id`, [corrected.reversedBy!.journalEntryId]);
    expect(lines).toEqual([
      { system_code: "AR", dr: "4600.00", cr: "0.00", customer_id: custA },
      { system_code: "CUSTOMER_DEPOSITS", dr: "0.00", cr: "4600.00", customer_id: custA },
    ]);
    // subledger + caches restored
    const after = await inTenant(() => paymentsService.get(p.id));
    expect(after).toMatchObject({ allocatedAmount: 0, unappliedAmount: 5000 });
    expect(await outstanding(a.id)).toBe(4600);
    expect((await row(a.id)).status).toBe("sent");
    expect(await bankBalance(bank)).toBe(5000); // cash never moved
    // history stays: the reversed allocation is listed, flagged
    expect(after.allocations.find((x) => x.id === allocId)?.reversedBy?.reason).toBe("Allocated to the wrong invoice");
    // re-allocate to B
    const re = await inTenant(() => paymentsService.allocate(p.id, { allocations: [{ invoiceId: b.id, amount: 5000 }] }, userId));
    expect(re.unappliedAmount).toBe(0);
    expect(await outstanding(b.id)).toBe(1900);
    // audit
    const { rows: audit } = await pool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND entity_type = 'payment_allocation' AND entity_id = $2`, [orgId, String(allocId)]);
    expect(audit.map((r) => r.action)).toEqual(["unallocate"]);
    await assertInvariants(custA);
  });

  it("partial allocation: correcting it restores exactly its own amount, never more; re-allocation to the SAME invoice is allowed after the correction", async () => {
    const a = await issue(custA, 5000); // 5,750
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 5750, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: a.id, amount: 2000 }] }, userId));
    expect(p.unappliedAmount).toBe(3750);
    await inTenant(() => paymentsService.unallocate(p.allocations[0]!.id, { reason: "Wrong amount" }, userId));
    const after = await inTenant(() => paymentsService.get(p.id));
    expect(after).toMatchObject({ allocatedAmount: 0, unappliedAmount: 5750 });
    expect(await outstanding(a.id)).toBe(5750);
    const re = await inTenant(() => paymentsService.allocate(p.id, { allocations: [{ invoiceId: a.id, amount: 5750 }] }, userId));
    expect(re.unappliedAmount).toBe(0);
    expect((await row(a.id)).status).toBe("paid");
    // one ACTIVE allocation per (payment, invoice) still holds
    const b = await issue(custA, 1000); // 1,150
    const p2 = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 1150, paidAt: DATE, bankAccountId: bank }, userId));
    await inTenant(() => paymentsService.allocate(p2.id, { allocations: [{ invoiceId: b.id, amount: 400 }] }, userId));
    await expect(inTenant(() => paymentsService.allocate(p2.id, { allocations: [{ invoiceId: b.id, amount: 100 }] }, userId))).rejects.toMatchObject({ statusCode: 409 });
    await assertInvariants(custA);
  });

  it("🔴 multi-invoice: 4,000 → A, 3,000 → B, 3,000 → C; correcting B alone leaves A and C intact and returns exactly 3,000", async () => {
    const a = await issue(custB, 4000); // 4,600
    const b = await issue(custB, 3000); // 3,450
    const c = await issue(custB, 3000); // 3,450
    const p = await inTenant(() => paymentsService.receive({ customerId: custB, amount: 11500, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: a.id, amount: 4600 }, { invoiceId: b.id, amount: 3450 }, { invoiceId: c.id, amount: 3450 }] }, userId));
    const bAlloc = p.allocations.find((x) => x.invoiceId === b.id)!;
    await inTenant(() => paymentsService.unallocate(bAlloc.id, { reason: "B was the wrong invoice" }, userId));
    const after = await inTenant(() => paymentsService.get(p.id));
    expect(after).toMatchObject({ allocatedAmount: 8050, unappliedAmount: 3450 });
    expect((await row(a.id)).status).toBe("paid");
    expect((await row(c.id)).status).toBe("paid");
    expect(await outstanding(b.id)).toBe(3450);
    expect((await row(b.id)).status).toBe("sent");
    expect(after.allocations.filter((x) => x.reversedBy == null).map((x) => x.invoiceId).sort()).toEqual([a.id, c.id].sort());
    expect(await gl("CUSTOMER_DEPOSITS", custB)).toBe(-3450);
    await assertInvariants(custB);
  });

  it("🔴 repeated and CONCURRENT corrections: one succeeds, the rest get a deterministic already-corrected 409; the key returns the same result", async () => {
    const a = await issue(custA, 1000); // 1,150
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 1150, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: a.id, amount: 1150 }] }, userId));
    const allocId = p.allocations[0]!.id;
    const results = await Promise.allSettled([
      inTenant(() => paymentsService.unallocate(allocId, { reason: "race 1" }, userId)),
      inTenant(() => paymentsService.unallocate(allocId, { reason: "race 2" }, userId)),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ statusCode: 409, payload: { code: "allocation_already_corrected" } });
    expect((await pool.query(`SELECT count(*)::int AS n FROM payment_allocation_reversals WHERE allocation_id = $1`, [allocId])).rows[0].n).toBe(1);
    // a later repeat is the same 409; an idempotency key replays the first result
    await expect(inTenant(() => paymentsService.unallocate(allocId, { reason: "again" }, userId))).rejects.toMatchObject({ statusCode: 409, payload: { code: "allocation_already_corrected" } });
    const b = await issue(custA, 500); // 575
    const p2 = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 575, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: b.id, amount: 575 }] }, userId));
    const key = `corr-${Date.now()}`;
    const first = await inTenant(() => paymentsService.unallocate(p2.allocations[0]!.id, { reason: "keyed", idempotencyKey: key }, userId));
    const second = await inTenant(() => paymentsService.unallocate(p2.allocations[0]!.id, { reason: "keyed", idempotencyKey: key }, userId));
    expect(second.reversedBy?.id).toBe(first.reversedBy?.id);
    // the raw DB refuses a second correction row too
    await expect(pool.query(`INSERT INTO payment_allocation_reversals (organization_id, company_id, allocation_id, amount, journal_entry_id, reason) VALUES ($1,$2,$3,1,$4,'raw')`, [orgId, companyId, allocId, p.journalEntryId])).rejects.toMatchObject({ code: "23505" });
    await assertInvariants(custA);
  });

  it("🔴 closed period: the correction is dated today; when today's month is locked it is refused with 423 and nothing changes", async () => {
    const a = await issue(custA, 1000); // 1,150
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 1150, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: a.id, amount: 1150 }] }, userId));
    const month = new Date().toISOString().slice(0, 7);
    await inTenant(() => periodLocksService.lock({ period: month, userId }));
    try {
      await expect(inTenant(() => paymentsService.unallocate(p.allocations[0]!.id, { reason: "in a closed month" }, userId))).rejects.toMatchObject({ statusCode: 423 });
      expect((await pool.query(`SELECT count(*)::int AS n FROM payment_allocation_reversals WHERE allocation_id = $1`, [p.allocations[0]!.id])).rows[0].n).toBe(0);
      expect((await row(a.id)).status).toBe("paid");
    } finally {
      await inTenant(() => periodLocksService.unlock(month));
    }
  });

  it("🔴 credit-note application correction: full and partial applications are superseded, the note's balance and the credit liability come back, the note and its own entry are untouched; its ORIGINAL settlement cannot be unapplied", async () => {
    // original 2,300 paid 1,000 → note 2,300 settles 1,300, 1,000 becomes credit balance
    const a = await issue(custB, 2000); // 2,300
    await inTenant(() => paymentsService.receive({ customerId: custB, amount: 1000, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: a.id, amount: 1000 }] }, userId));
    const note = await issue(custB, 2000, { documentType: "credit_note", originalInvoiceId: a.id, noteReason: "Return" }); // 2,300
    const { rows: [noteJe] } = await pool.query(`SELECT id, entry_number FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [orgId, `GL-${note.invoiceNumber}`]);
    const { rows: [issueAlloc] } = await pool.query(`SELECT id FROM payment_allocations WHERE credit_note_id = $1`, [note.id]);
    // the original's settlement is the tax document's own effect
    await expect(inTenant(() => paymentsService.unallocate(issueAlloc.id, { reason: "try" }, userId))).rejects.toMatchObject({ statusCode: 409, payload: { code: "credit_note_original_application_immutable" } });
    // apply 1,000: 600 to X and 400 to Y
    const x = await issue(custB, 1000); // 1,150
    const y = await issue(custB, 1000); // 1,150
    const app = await inTenant(() => paymentsService.applyCreditNote(note.id, { allocations: [{ invoiceId: x.id, amount: 600 }, { invoiceId: y.id, amount: 400 }] }, userId));
    expect(app.remainingAmount).toBe(0);
    expect(await gl("CUSTOMER_CREDITS", custB)).toBe(0);
    const yApp = app.applications.find((r) => r.invoiceId === y.id)!;
    const corrected = await inTenant(() => paymentsService.unallocate(yApp.id, { reason: "Y was wrong" }, userId));
    const { rows: lines } = await pool.query(`SELECT c.system_code, l.debit_amount::text dr, l.credit_amount::text cr, l.customer_id FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.id`, [corrected.reversedBy!.journalEntryId]);
    expect(lines).toEqual([
      { system_code: "AR", dr: "400.00", cr: "0.00", customer_id: custB },
      { system_code: "CUSTOMER_CREDITS", dr: "0.00", cr: "400.00", customer_id: custB },
    ]);
    const apps = await inTenant(() => paymentsService.creditNoteApplications(note.id));
    expect(apps.remainingAmount).toBe(400);
    expect(apps.appliedAmount).toBe(1900); // 1,300 at issue + 600 to X
    expect((await row(y.id)).credited).toBe("0.00");
    expect(await outstanding(y.id)).toBe(1150);
    expect(await gl("CUSTOMER_CREDITS", custB)).toBe(-400);
    // the note row and its own entry are exactly as issued
    expect((await row(note.id)).paid).toBe("0.00");
    expect((await entry(noteJe.id)).status).toBe("posted");
    // no duplicate credit: applying 400 again to Y works and consumes it; 401 would not
    await expect(inTenant(() => paymentsService.applyCreditNote(note.id, { allocations: [{ invoiceId: y.id, amount: 401 }] }, userId))).rejects.toMatchObject({ statusCode: 422 });
    await inTenant(() => paymentsService.applyCreditNote(note.id, { allocations: [{ invoiceId: y.id, amount: 400 }] }, userId));
    expect((await inTenant(() => paymentsService.creditNoteApplications(note.id))).remainingAmount).toBe(0);
    await assertInvariants(custB);
  });

  // ── Phase C ────────────────────────────────────────────────────────────
  it("🔴 deposit refund (partial then full): Dr deposits / Cr bank from the NAMED receipt; the receipt is untouched; excess, wrong customer, missing bank and duplicates refused", async () => {
    const depositsBefore = (await inTenant(() => paymentsService.customerCredits(custA))).deposits;
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 3000, paidAt: DATE, bankAccountId: bank, reference: "ON ACCOUNT" }, userId));
    const cashBefore = await bankBalance(bank);
    const r1 = await inTenant(() => paymentsService.refund({ customerId: custA, origin: "deposit", paymentId: p.id, amount: 1000, bankAccountId: bank, refundedAt: DATE, reason: "Customer asked for part back" }, userId));
    expect(r1).toMatchObject({ origin: "deposit", paymentId: p.id, creditNoteId: null, amount: 1000, customerId: custA });
    const { rows: lines } = await pool.query(`SELECT c.system_code, c.bank_account_id, l.debit_amount::text dr, l.credit_amount::text cr, l.customer_id FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.id`, [r1.journalEntryId]);
    expect(lines).toEqual([
      { system_code: "CUSTOMER_DEPOSITS", bank_account_id: null, dr: "1000.00", cr: "0.00", customer_id: custA },
      { system_code: null, bank_account_id: bank, dr: "0.00", cr: "1000.00", customer_id: null },
    ]);
    expect((await entry(r1.journalEntryId)).entry_number).toBe(`REFUND-${r1.id}`);
    expect(await bankBalance(bank)).toBe(cashBefore - 1000);
    const after = await inTenant(() => paymentsService.get(p.id));
    expect(after).toMatchObject({ amount: 3000, refundedAmount: 1000, unappliedAmount: 2000 });
    expect((await inTenant(() => paymentsService.customerCredits(custA))).deposits).toBe(depositsBefore + 2000);
    // excessive → refused; other customer's receipt → refused; no bank → refused
    await expect(inTenant(() => paymentsService.refund({ customerId: custA, origin: "deposit", paymentId: p.id, amount: 2000.01, bankAccountId: bank, reason: "too much" }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "refund_exceeds_balance" } });
    await expect(inTenant(() => paymentsService.refund({ customerId: custB, origin: "deposit", paymentId: p.id, amount: 100, bankAccountId: bank, reason: "wrong customer" }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "refund_source_mismatch" } });
    await expect(inTenant(() => paymentsService.refund({ customerId: custA, origin: "deposit", paymentId: p.id, amount: 100, reason: "no bank" }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "bank_account_required" } });
    await expect(inTenant(() => paymentsService.refund({ customerId: custA, origin: "deposit", paymentId: p.id, amount: 100, bankAccountId: bank, reason: "" }, userId))).rejects.toMatchObject({ statusCode: 400 });
    // duplicate by key → same refund, one row
    const key = `ref-${Date.now()}`;
    const r2 = await inTenant(() => paymentsService.refund({ customerId: custA, origin: "deposit", paymentId: p.id, amount: 2000, bankAccountId: bank, reason: "rest", idempotencyKey: key }, userId));
    const r2b = await inTenant(() => paymentsService.refund({ customerId: custA, origin: "deposit", paymentId: p.id, amount: 2000, bankAccountId: bank, reason: "rest", idempotencyKey: key }, userId));
    expect(r2b.id).toBe(r2.id);
    expect((await pool.query(`SELECT count(*)::int AS n FROM customer_refunds WHERE payment_id = $1`, [p.id])).rows[0].n).toBe(2);
    expect((await inTenant(() => paymentsService.get(p.id))).unappliedAmount).toBe(0);
    expect(z(-(await gl("CUSTOMER_DEPOSITS", custA)))).toBe(z(depositsBefore));
    // the receipt itself and its entry are untouched
    expect((await entry(p.journalEntryId)).status).toBe("posted");
    // nothing left → refused
    await expect(inTenant(() => paymentsService.refund({ customerId: custA, origin: "deposit", paymentId: p.id, amount: 1, bankAccountId: bank, reason: "empty" }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "refund_exceeds_balance" } });
    const { rows: audit } = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND entity_type = 'customer_refund' AND action = 'refund'`, [orgId]);
    expect(audit[0].n).toBe(2);
    await assertInvariants(custA);
  });

  it("🔴 credit-note refund: Dr credit balances / Cr bank from the NAMED note; the note is not reversed; an unissued note is refused (tax-sensitive fail-closed); excess refused", async () => {
    const creditsBefore = (await inTenant(() => paymentsService.customerCredits(custB))).creditNotes;
    const a = await issue(custB, 1000); // 1,150
    await inTenant(() => paymentsService.receive({ customerId: custB, amount: 1150, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: a.id, amount: 1150 }] }, userId));
    const note = await issue(custB, 1000, { documentType: "credit_note", originalInvoiceId: a.id, noteReason: "Full return" }); // fully paid original → 1,150 credit balance
    expect((await inTenant(() => paymentsService.customerCredits(custB))).creditNotes).toBe(creditsBefore + 1150);
    const cashBefore = await bankBalance(bank);
    const r = await inTenant(() => paymentsService.refund({ customerId: custB, origin: "credit_note", creditNoteId: note.id, amount: 1150, bankAccountId: bank, refundedAt: DATE, reason: "Goods returned, customer refunded" }, userId));
    const { rows: lines } = await pool.query(`SELECT c.system_code, l.debit_amount::text dr, l.credit_amount::text cr, l.customer_id FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.id`, [r.journalEntryId]);
    expect(lines[0]).toEqual({ system_code: "CUSTOMER_CREDITS", dr: "1150.00", cr: "0.00", customer_id: custB });
    expect(await bankBalance(bank)).toBe(cashBefore - 1150);
    expect(z(-(await gl("CUSTOMER_CREDITS", custB)))).toBe(z(creditsBefore));
    const apps = await inTenant(() => paymentsService.creditNoteApplications(note.id));
    expect(apps).toMatchObject({ refundedAmount: 1150, remainingAmount: 0 });
    // the note: same row, same entry, still posted, no reversal
    const { rows: [n] } = await pool.query(`SELECT status, invoice_hash IS NOT NULL AS issued FROM invoices WHERE id = $1`, [note.id]);
    expect(n.issued).toBe(true);
    const { rows: [nj] } = await pool.query(`SELECT status FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [orgId, `GL-${note.invoiceNumber}`]);
    expect(nj.status).toBe("posted");
    await expect(inTenant(() => paymentsService.refund({ customerId: custB, origin: "credit_note", creditNoteId: note.id, amount: 1, bankAccountId: bank, reason: "more" }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "refund_exceeds_balance" } });
    // tax-sensitive: a DRAFT note has no VAT effect → refund refused, nothing posts
    const c = await issue(custB, 100); // a fresh original the draft can reference (a is fully credited)
    const draft = await inTenant(() => invoicesService.create({ invoiceNumber: "D4C-CN-DRAFT", date: DATE, customerId: custB, documentType: "credit_note", originalInvoiceId: c.id, noteReason: "Draft", items: [{ description: "x", quantity: 1, unitPrice: 10, vatRate: 15 }] }, userId));
    const jeBefore = (await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n;
    await expect(inTenant(() => paymentsService.refund({ customerId: custB, origin: "credit_note", creditNoteId: draft.id, amount: 5, bankAccountId: bank, reason: "draft" }, userId))).rejects.toMatchObject({ statusCode: 409, payload: { code: "credit_note_not_issued" } });
    expect((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(jeBefore);
    await assertInvariants(custB);
  });

  it("refund into a closed month is refused (423) and nothing posts; an open month posts", async () => {
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 200, paidAt: DATE, bankAccountId: bank }, userId));
    await inTenant(() => periodLocksService.lock({ period: "2026-05", userId }));
    try {
      await expect(inTenant(() => paymentsService.refund({ customerId: custA, origin: "deposit", paymentId: p.id, amount: 100, bankAccountId: bank, refundedAt: "2026-05-10", reason: "closed" }, userId))).rejects.toMatchObject({ statusCode: 423 });
      expect((await pool.query(`SELECT count(*)::int AS n FROM customer_refunds WHERE payment_id = $1`, [p.id])).rows[0].n).toBe(0);
    } finally {
      await inTenant(() => periodLocksService.unlock("2026-05"));
    }
    const r = await inTenant(() => paymentsService.refund({ customerId: custA, origin: "deposit", paymentId: p.id, amount: 100, bankAccountId: bank, refundedAt: "2026-06-10", reason: "open" }, userId));
    expect(r.amount).toBe(100);
    await assertInvariants(custA);
  });

  it("🔴 isolation: another org or company cannot correct, read or refund this org's records; the source must be this customer's", async () => {
    const a = await issue(custA, 1000);
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 1000, paidAt: DATE, bankAccountId: bank, allocations: [{ invoiceId: a.id, amount: 1000 }] }, userId));
    const allocId = p.allocations[0]!.id;
    await expect(inOther(() => paymentsService.allocation(allocId))).rejects.toMatchObject({ statusCode: 404 });
    await expect(inOther(() => paymentsService.unallocate(allocId, { reason: "x" }, userId))).rejects.toMatchObject({ statusCode: 404 });
    await expect(inCompany2(() => paymentsService.unallocate(allocId, { reason: "x" }, userId))).rejects.toMatchObject({ statusCode: 404 });
    await expect(inOther(() => paymentsService.refund({ customerId: custOther, origin: "deposit", paymentId: p.id, amount: 1, bankAccountId: bankOther, reason: "x" }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "reference_not_found" } });
    await expect(inCompany2(() => paymentsService.refund({ customerId: custA, origin: "deposit", paymentId: p.id, amount: 1, bankAccountId: bankC2, reason: "x" }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "reference_not_found" } });
    // our refund cannot be paid from another tenant's bank
    const dep = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 50, paidAt: DATE, bankAccountId: bank }, userId));
    await expect(inTenant(() => paymentsService.refund({ customerId: custA, origin: "deposit", paymentId: dep.id, amount: 50, bankAccountId: bankOther, reason: "x" }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "reference_not_found" } });
    // append-only: the app role cannot update or delete a correction or a refund
    for (const t of ["payment_allocation_reversals", "customer_refunds"]) {
      const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
      try {
        const sql = (await import("drizzle-orm")).sql;
        const { db } = await import("@workspace/db");
        await expect(conn.run(() => db.execute(sql.raw(`DELETE FROM ${t}`)))).rejects.toMatchObject({ cause: { code: "42501" } });
      } finally {
        await conn.rollback();
      }
    }
    await assertInvariants(custA);
  });

  it("the balance sheet balances after everything above", async () => {
    const bs = await inTenant(() => reportsService.balanceSheet("2026-12-31"));
    expect(bs.balanced).toBe(true);
    const liab = bs.liabilities.items as Array<{ name: string; amount: number | string }>;
    expect(z(Number(liab.find((i) => i.name === "Customer deposits and advances")?.amount ?? 0))).toBe(z(-(await gl("CUSTOMER_DEPOSITS", null))));
    expect(z(Number(liab.find((i) => i.name === "Customer credit balances")?.amount ?? 0))).toBe(z(-(await gl("CUSTOMER_CREDITS", null))));
  });
});
