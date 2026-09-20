/**
 * Batch 1B Part 2, Phase D (2026-09-17) — DETERMINISTIC BANK MATCHING.
 *
 * The rule under test: a statement row matches a receipt (or a refund) only
 * when EVERY clause holds — same bank, same direction, exact amount, an
 * identifying reference resolving uniquely, date inside ±3 days, exactly
 * one candidate, one-to-one across the batch. Everything short of that is
 * AMBIGUOUS (human review), nothing at all is UNMATCHED, and a reference
 * that names a counterpart failing another clause is INCONSISTENT. Matching
 * posts nothing; the payment journal is never touched.
 *
 * Also proves the carried item: the ACTIVE-PAIR guard on allocations is a
 * database trigger — two raw sessions inserting the first allocation for a
 * pair get one success and one 23505 with no service involved.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { paymentsService } from "../services/payments.service";
import { transactionsService } from "../services/transactions.service";
import { statementMatchingService, referenceTokens } from "../services/statementMatching.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { MATCH_DATE_WINDOW_DAYS } from "../services/accounting/matchingPolicy";
import { createApproved } from "./helpers/createApproved";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "d4-match";
const SLUG_OTHER = "d4-match-other";
const EMAIL = "d4-match@test.local";
const DATE = "2026-06-15";

describeMaybe("D-4 Phase D — deterministic bank matching", () => {
  let orgId = "";
  let companyId = "";
  let company2Id = "";
  let otherOrgId = "";
  let otherCompanyId = "";
  let userId = 0;
  let custA = 0;
  let custB = 0;
  let bank1 = 0;
  let bank2 = 0;
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
        "statement_match_reversals", "statement_matches", "customer_refunds", "payment_allocation_reversals", "payment_allocations", "payments",
        "journal_entry_lines", "journal_entries", "transactions", "invoice_items", "einvoice_documents", "invoices", "customers",
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
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('D4M Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'D4M Co','1010828281','399999999999903') RETURNING id`, [orgId])).rows[0].id;
    company2Id = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'D4M Co 2','1010828282','399999999999913') RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('D4M Other','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'D4M Other Co','1010828283','399999999999923') RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','D4M',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    custA = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Najd Trading') RETURNING id`, [orgId])).rows[0].id;
    custB = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Hail Supplies') RETURNING id`, [orgId])).rows[0].id;
    bank1 = (await inTenant(() => bankAccountsService.create({ name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bank2 = (await inTenant(() => bankAccountsService.create({ name: "ANB Payroll", bankName: "ANB", currency: "SAR" }))).id;
    bankC2 = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Co2 Main','ANB') RETURNING id`, [orgId, company2Id])).rows[0].id;
    bankOther = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Other Main','ANB') RETURNING id`, [otherOrgId, otherCompanyId])).rows[0].id;
  });
  afterAll(cleanup);

  let seq = 0;
  async function issue(customerId: number, net: number) {
    seq += 1;
    return inTenant(() => createApproved<{ id: number; invoiceNumber: string }>(invoicesService, { invoiceNumber: `D4M-INV-${String(seq).padStart(3, "0")}`, date: DATE, dueDate: DATE, customerId, items: [{ description: "Work", quantity: 1, unitPrice: net, vatRate: 15 }] }, userId));
  }
  /** A statement row through the product's own import path (the row keeps its bank). */
  async function statementRow(bankAccountId: number, row: { date: string; description: string; amount: number; type: "credit" | "debit" }, run = inTenant) {
    await run(() => transactionsService.upload({ rows: [{ ...row, currency: "SAR" }], autoCategrize: false, bankAccountId } as never));
    const { rows } = await pool.query(`SELECT id FROM transactions WHERE description = $1 AND bank_account_id = $2 ORDER BY id DESC LIMIT 1`, [row.description, bankAccountId]);
    return Number(rows[0].id);
  }
  const classificationOf = async (transactionId: number, run = inTenant) => (await run(() => statementMatchingService.classify({ limit: 500 }))).find((r) => r.transactionId === transactionId)!;
  const journalCount = async () => (await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n;

  it("reference tokens: whole alphanumeric tokens ≥ 4 chars, upper-cased, hyphens kept inside", () => {
    expect(referenceTokens("TT FROM NAJD ref INV-1042 /rcpt-7 x")).toEqual(["FROM", "NAJD", "INV-1042", "RCPT-7"]);
  });

  // ── the exact deterministic case ───────────────────────────────────────
  it("🔴 exact deterministic match: same bank, credit, 5,750, narrative names the allocated invoice, same day, one candidate → DETERMINISTIC; apply records it; the payment journal is untouched", async () => {
    const inv = await issue(custA, 5000); // 5,750
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 5750, paidAt: DATE, bankAccountId: bank1, allocations: [{ invoiceId: inv.id, amount: 5750 }] }, userId));
    const tx = await statementRow(bank1, { date: DATE, description: `TRANSFER FROM NAJD TRADING ${inv.invoiceNumber}`, amount: 5750, type: "credit" });
    const c = await classificationOf(tx);
    expect(c.classification).toBe("DETERMINISTIC");
    expect(c.target).toMatchObject({ kind: "payment", id: p.id, identifiedBy: `invoice ${inv.invoiceNumber}` });
    expect(c.window).toEqual({ from: "2026-06-12", to: "2026-06-18", days: MATCH_DATE_WINDOW_DAYS });
    const jeBefore = await journalCount();
    const { rows: [jeLines] } = await pool.query(`SELECT string_agg(l.id::text || ':' || l.debit_amount || '/' || l.credit_amount, ',' ORDER BY l.id) AS sig FROM journal_entry_lines l WHERE l.journal_entry_id = $1`, [p.journalEntryId]);
    const res = await inTenant(() => statementMatchingService.apply({}, userId));
    expect(res.recorded.map((m) => m.transactionId)).toEqual([tx]);
    expect(res.recorded[0]).toMatchObject({ paymentId: p.id, refundId: null, method: "deterministic" });
    expect(await journalCount()).toBe(jeBefore); // matching posts nothing
    const { rows: [after] } = await pool.query(`SELECT string_agg(l.id::text || ':' || l.debit_amount || '/' || l.credit_amount, ',' ORDER BY l.id) AS sig FROM journal_entry_lines l WHERE l.journal_entry_id = $1`, [p.journalEntryId]);
    expect(after.sig).toBe(jeLines.sig);
    expect((await classificationOf(tx)).classification).toBe("MATCHED");
    // idempotent: applying again records nothing new
    const again = await inTenant(() => statementMatchingService.apply({}, userId));
    expect(again.recorded).toEqual([]);
    const { rows: audit } = await pool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND entity_type = 'statement_match'`, [orgId]);
    expect(audit.map((a) => a.action)).toEqual(["match"]);
  });

  it("the payment's own reference and its receipt number also identify it", async () => {
    const p1 = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 111, paidAt: DATE, bankAccountId: bank1, reference: "REM-77A1" }, userId));
    const p2 = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 222, paidAt: DATE, bankAccountId: bank1 }, userId));
    const t1 = await statementRow(bank1, { date: DATE, description: "IPS CREDIT REM-77A1", amount: 111, type: "credit" });
    const t2 = await statementRow(bank1, { date: DATE, description: `IPS CREDIT RCPT-${p2.id}`, amount: 222, type: "credit" });
    expect((await classificationOf(t1))).toMatchObject({ classification: "DETERMINISTIC", target: { id: p1.id, identifiedBy: "reference REM-77A1" } });
    expect((await classificationOf(t2))).toMatchObject({ classification: "DETERMINISTIC", target: { id: p2.id, identifiedBy: `receipt number RCPT-${p2.id}` } });
    await inTenant(() => statementMatchingService.apply({}, userId));
  });

  // ── the refusals ───────────────────────────────────────────────────────
  it("🔴 same amount, ambiguous reference: two receipts both named → AMBIGUOUS; nothing recorded", async () => {
    const a = await issue(custA, 1000); // 1,150
    const b = await issue(custB, 1000);
    await inTenant(() => paymentsService.receive({ customerId: custA, amount: 1150, paidAt: DATE, bankAccountId: bank1, allocations: [{ invoiceId: a.id, amount: 1150 }] }, userId));
    await inTenant(() => paymentsService.receive({ customerId: custB, amount: 1150, paidAt: DATE, bankAccountId: bank1, allocations: [{ invoiceId: b.id, amount: 1150 }] }, userId));
    const tx = await statementRow(bank1, { date: DATE, description: `PAYMENT ${a.invoiceNumber} ${b.invoiceNumber}`, amount: 1150, type: "credit" });
    const c = await classificationOf(tx);
    expect(c.classification).toBe("AMBIGUOUS");
    expect(c.candidates).toHaveLength(2);
    expect((await inTenant(() => statementMatchingService.apply({}, userId))).recorded).toEqual([]);
  });

  it("🔴 amount and date only (no reference) — even with exactly ONE candidate — is AMBIGUOUS, never matched", async () => {
    await inTenant(() => paymentsService.receive({ customerId: custA, amount: 333, paidAt: DATE, bankAccountId: bank1 }, userId));
    const tx = await statementRow(bank1, { date: DATE, description: "INCOMING TRANSFER", amount: 333, type: "credit" });
    const c = await classificationOf(tx);
    expect(c.classification).toBe("AMBIGUOUS");
    expect(c.candidates).toHaveLength(1);
    expect(c.reason).toMatch(/amount and date alone never match/);
    expect((await inTenant(() => statementMatchingService.apply({}, userId))).recorded).toEqual([]);
  });

  it("🔴 nearest date is not evidence: two same-amount receipts inside the window, no reference → AMBIGUOUS (the closer one is not picked)", async () => {
    await inTenant(() => paymentsService.receive({ customerId: custA, amount: 444, paidAt: "2026-06-14", bankAccountId: bank1 }, userId));
    await inTenant(() => paymentsService.receive({ customerId: custB, amount: 444, paidAt: "2026-06-17", bankAccountId: bank1 }, userId));
    const tx = await statementRow(bank1, { date: "2026-06-15", description: "TRANSFER", amount: 444, type: "credit" });
    const c = await classificationOf(tx);
    expect(c.classification).toBe("AMBIGUOUS");
    expect(c.candidates.map((x) => x.date).sort()).toEqual(["2026-06-14", "2026-06-17"]);
  });

  it("🔴 outside the window: a receipt 4 days away is not a candidate; when the narrative NAMES it, the row is INCONSISTENT", async () => {
    const inv = await issue(custA, 600); // 690
    await inTenant(() => paymentsService.receive({ customerId: custA, amount: 690, paidAt: "2026-06-10", bankAccountId: bank1, allocations: [{ invoiceId: inv.id, amount: 690 }] }, userId));
    const far = await statementRow(bank1, { date: "2026-06-15", description: "TRANSFER", amount: 690, type: "credit" });
    expect((await classificationOf(far)).classification).toBe("UNMATCHED");
    const named = await statementRow(bank1, { date: "2026-06-15", description: `TRANSFER ${inv.invoiceNumber}`, amount: 690, type: "credit" });
    const c = await classificationOf(named);
    expect(c.classification).toBe("INCONSISTENT");
    expect(c.reason).toMatch(/outside the ±3-day window/);
  });

  it("🔴 wrong bank: the narrative names a receipt that moved through ANOTHER bank → INCONSISTENT; an override cannot cross banks", async () => {
    const inv = await issue(custA, 700); // 805
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 805, paidAt: DATE, bankAccountId: bank2, allocations: [{ invoiceId: inv.id, amount: 805 }] }, userId));
    const tx = await statementRow(bank1, { date: DATE, description: `TRANSFER ${inv.invoiceNumber}`, amount: 805, type: "credit" });
    const c = await classificationOf(tx);
    expect(c.classification).toBe("INCONSISTENT");
    expect(c.reason).toMatch(/different bank account/);
    await expect(inTenant(() => statementMatchingService.override({ transactionId: tx, paymentId: p.id, reason: "force" }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "match_bank_mismatch" } });
  });

  it("🔴 wrong direction: a DEBIT row never sees receipts; a refund is its counterpart, and the narrative must identify it", async () => {
    const dep = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 900, paidAt: DATE, bankAccountId: bank1 }, userId));
    const refund = await inTenant(() => paymentsService.refund({ customerId: custA, origin: "deposit", paymentId: dep.id, amount: 900, bankAccountId: bank1, refundedAt: DATE, reason: "returned", reference: "RFD-9Q" }, userId));
    const debit = await statementRow(bank1, { date: DATE, description: "OUTGOING RFD-9Q", amount: 900, type: "debit" });
    const c = await classificationOf(debit);
    expect(c).toMatchObject({ classification: "DETERMINISTIC", direction: "out", target: { kind: "refund", id: refund.id, identifiedBy: "reference RFD-9Q" } });
    // a credit row with the same narrative cannot match the refund, and an override that tries is refused on direction
    const credit = await statementRow(bank1, { date: DATE, description: "OUTGOING RFD-9Q", amount: 900, type: "credit" });
    expect((await classificationOf(credit)).candidates.every((x) => x.kind === "payment")).toBe(true);
    await expect(inTenant(() => statementMatchingService.override({ transactionId: credit, refundId: refund.id, reason: "wrong way" }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "match_direction_mismatch" } });
    await inTenant(() => statementMatchingService.apply({}, userId));
    expect((await classificationOf(debit)).classification).toBe("MATCHED");
  });

  it("🔴 duplicate statement rows: two rows naming the same receipt are BOTH ambiguous; the first to be overridden wins, the second is refused by the database", async () => {
    const inv = await issue(custA, 800); // 920
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 920, paidAt: DATE, bankAccountId: bank1, allocations: [{ invoiceId: inv.id, amount: 920 }] }, userId));
    const t1 = await statementRow(bank1, { date: DATE, description: `TRANSFER ${inv.invoiceNumber} A`, amount: 920, type: "credit" });
    const t2 = await statementRow(bank1, { date: DATE, description: `TRANSFER ${inv.invoiceNumber} B`, amount: 920, type: "credit" });
    const c1 = await classificationOf(t1);
    const c2 = await classificationOf(t2);
    expect([c1.classification, c2.classification]).toEqual(["AMBIGUOUS", "AMBIGUOUS"]);
    expect(c1.reason).toMatch(/duplicate statement rows/);
    expect((await inTenant(() => statementMatchingService.apply({}, userId))).recorded).toEqual([]);
    const m = await inTenant(() => statementMatchingService.override({ transactionId: t1, paymentId: p.id, reason: "bank duplicated the line; A is the real one" }, userId));
    expect(m.method).toBe("manual");
    await expect(inTenant(() => statementMatchingService.override({ transactionId: t2, paymentId: p.id, reason: "second" }, userId))).rejects.toMatchObject({ statusCode: 409 });
    // the receipt is now consumed: t2 has no candidate left and is UNMATCHED (the narrative's receipt is matched elsewhere → INCONSISTENT names it)
    expect((await classificationOf(t2)).classification).toBe("INCONSISTENT");
  });

  it("🔴 duplicate candidates: two identical receipts (same customer, amount, day) for one row → AMBIGUOUS even when the narrative names their shared invoice", async () => {
    const inv = await issue(custA, 2000); // 2,300
    await inTenant(() => paymentsService.receive({ customerId: custA, amount: 1150, paidAt: DATE, bankAccountId: bank1, allocations: [{ invoiceId: inv.id, amount: 1150 }] }, userId));
    await inTenant(() => paymentsService.receive({ customerId: custA, amount: 1150, paidAt: DATE, bankAccountId: bank1, allocations: [{ invoiceId: inv.id, amount: 1150 }] }, userId).catch(async () => {
      // one active allocation per (payment, invoice) is per PAYMENT — a second receipt allocating to the same invoice is fine; this catch only guards a fixture surprise
      throw new Error("second receipt should be allowed");
    }));
    const tx = await statementRow(bank1, { date: DATE, description: `INSTALMENT ${inv.invoiceNumber}`, amount: 1150, type: "credit" });
    const c = await classificationOf(tx);
    expect(c.classification).toBe("AMBIGUOUS");
    // both receipts are named by the shared invoice; earlier unmatched same-amount receipts may also sit in the window as unnamed candidates
    expect(c.candidates.filter((x) => x.identifiedBy).length).toBe(2);
    expect(c.reason).toMatch(/2 candidates are each named/);
  });

  it("🔴 one-to-one: a payment already matched is never a candidate again; unmatch (a superseding record) frees it; the match row stays", async () => {
    const inv = await issue(custB, 300); // 345
    const p = await inTenant(() => paymentsService.receive({ customerId: custB, amount: 345, paidAt: DATE, bankAccountId: bank1, allocations: [{ invoiceId: inv.id, amount: 345 }] }, userId));
    const t1 = await statementRow(bank1, { date: DATE, description: `X ${inv.invoiceNumber}`, amount: 345, type: "credit" });
    const [m] = (await inTenant(() => statementMatchingService.apply({}, userId))).recorded;
    expect(m!.paymentId).toBe(p.id);
    const t2 = await statementRow(bank1, { date: "2026-06-16", description: `Y ${inv.invoiceNumber}`, amount: 345, type: "credit" });
    expect((await classificationOf(t2)).classification).toBe("INCONSISTENT"); // the narrative names a receipt already matched
    // the raw database refuses a second active match for the payment, and for the row
    await expect(pool.query(`INSERT INTO statement_matches (organization_id, company_id, transaction_id, payment_id, method, evidence) VALUES ($1,$2,$3,$4,'manual','{}')`, [orgId, companyId, t2, p.id])).rejects.toMatchObject({ code: "23505", constraint: "statement_matches_active_target_unq" });
    await expect(pool.query(`INSERT INTO statement_matches (organization_id, company_id, transaction_id, payment_id, method, evidence) VALUES ($1,$2,$3,$4,'manual','{}')`, [orgId, companyId, t1, p.id])).rejects.toMatchObject({ code: "23505", constraint: "statement_matches_active_row_unq" });
    const un = await inTenant(() => statementMatchingService.unmatch(m!.id, { reason: "wrong row" }, userId));
    expect(un.reversedBy?.reason).toBe("wrong row");
    expect((await pool.query(`SELECT count(*)::int AS n FROM statement_matches WHERE id = $1`, [m!.id])).rows[0].n).toBe(1); // still there
    await expect(inTenant(() => statementMatchingService.unmatch(m!.id, { reason: "again" }, userId))).rejects.toMatchObject({ statusCode: 409, payload: { code: "match_already_reversed" } });
    // now the payment is free: t1 and t2 both name it → duplicate-row ambiguity; override t2
    expect((await classificationOf(t2)).classification).toBe("AMBIGUOUS");
    const m2 = await inTenant(() => statementMatchingService.override({ transactionId: t2, paymentId: p.id, reason: "Y is the real line" }, userId));
    expect(m2.paymentId).toBe(p.id);
    expect((await classificationOf(t1)).classification).toBe("INCONSISTENT");
  });

  it("🔴 override: records actor, reason, row, counterpart and evidence incl. an amount difference; never touches the receipt's journal; a duplicate by key is one match", async () => {
    const inv = await issue(custA, 1000); // 1,150
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 1150, paidAt: DATE, bankAccountId: bank1, allocations: [{ invoiceId: inv.id, amount: 1150 }] }, userId));
    // the bank netted 15.00 of charges: 1,135 arrived; amount is identity for AUTO matching, so this is not a candidate
    const tx = await statementRow(bank1, { date: DATE, description: `TRANSFER ${inv.invoiceNumber} NET OF CHARGES`, amount: 1135, type: "credit" });
    expect((await classificationOf(tx)).classification).toBe("INCONSISTENT"); // named, but the amount differs
    const jeBefore = await journalCount();
    const key = `ovr-${Date.now()}`;
    const m = await inTenant(() => statementMatchingService.override({ transactionId: tx, paymentId: p.id, reason: "Bank deducted SAR 15 charges; customer paid in full", idempotencyKey: key }, userId));
    expect(m).toMatchObject({ method: "manual", createdBy: userId, paymentId: p.id, transactionId: tx });
    expect(m.evidence).toMatchObject({ rowAmount: 1135, targetAmount: 1150, amountDifference: -15, bankAccountId: bank1, direction: "in" });
    expect(await journalCount()).toBe(jeBefore); // no charge invented, no journal
    const again = await inTenant(() => statementMatchingService.override({ transactionId: tx, paymentId: p.id, reason: "retry", idempotencyKey: key }, userId));
    expect(again.id).toBe(m.id);
    await expect(inTenant(() => statementMatchingService.override({ transactionId: tx, paymentId: p.id, reason: "" }, userId))).rejects.toMatchObject({ statusCode: 400 });
    const { rows: [audit] } = await pool.query(`SELECT after_state FROM audit_logs WHERE organization_id = $1 AND entity_type = 'statement_match' AND action = 'match_override' AND entity_id = $2`, [orgId, String(m.id)]);
    expect(audit.after_state).toMatchObject({ reason: "Bank deducted SAR 15 charges; customer paid in full", transactionId: tx });
  });

  it("a row settled from Review is MATCHED by construction and cannot be overridden or re-matched", async () => {
    const inv = await issue(custB, 500); // 575
    const tx = await statementRow(bank1, { date: DATE, description: `FROM HAIL ${inv.invoiceNumber}`, amount: 575, type: "credit" });
    await inTenant(() => transactionsService.settle(tx, { invoiceId: inv.id }, userId));
    const c = await classificationOf(tx);
    expect(c.classification).toBe("MATCHED");
    expect(c.target?.identifiedBy).toBe("settlement");
    const { rows: [p] } = await pool.query(`SELECT id FROM payments WHERE source_transaction_id = $1`, [tx]);
    await expect(inTenant(() => statementMatchingService.override({ transactionId: tx, paymentId: p.id, reason: "x" }, userId))).rejects.toMatchObject({ statusCode: 409 });
    // the settlement receipt is never a candidate for another row (a distinct narrative — an identical line is de-duplicated at import)
    const t2 = await statementRow(bank1, { date: DATE, description: `FROM HAIL ${inv.invoiceNumber} SECOND LINE`, amount: 575, type: "credit" });
    expect((await classificationOf(t2)).classification).toBe("INCONSISTENT");
  });

  it("🔴 concurrent apply: two parallel runs record ONE match; the loser gets a deterministic 409", async () => {
    const inv = await issue(custA, 1300); // 1,495
    await inTenant(() => paymentsService.receive({ customerId: custA, amount: 1495, paidAt: DATE, bankAccountId: bank1, allocations: [{ invoiceId: inv.id, amount: 1495 }] }, userId));
    const tx = await statementRow(bank1, { date: DATE, description: `TRANSFER ${inv.invoiceNumber}`, amount: 1495, type: "credit" });
    const results = await Promise.allSettled([inTenant(() => statementMatchingService.apply({}, userId)), inTenant(() => statementMatchingService.apply({}, userId))]);
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ recorded: unknown[] }>[];
    const recordedTotal = ok.reduce((s, r) => s + r.value.recorded.length, 0);
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(recordedTotal + (failed.length > 0 ? 0 : 0)).toBe(1);
    if (failed.length) expect(failed[0]!.reason).toMatchObject({ statusCode: 409 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM statement_matches WHERE transaction_id = $1`, [tx])).rows[0].n).toBe(1);
  });

  it("🔴 isolation: another company or org sees no rows, cannot override ours, and cannot use our receipt", async () => {
    const inv = await issue(custA, 200); // 230
    const p = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 230, paidAt: DATE, bankAccountId: bank1, allocations: [{ invoiceId: inv.id, amount: 230 }] }, userId));
    const tx = await statementRow(bank1, { date: DATE, description: `TRANSFER ${inv.invoiceNumber}`, amount: 230, type: "credit" });
    expect((await inOther(() => statementMatchingService.classify({ limit: 500 }))).some((r) => r.transactionId === tx)).toBe(false);
    expect((await inCompany2(() => statementMatchingService.classify({ limit: 500 }))).some((r) => r.transactionId === tx)).toBe(false);
    await expect(inOther(() => statementMatchingService.override({ transactionId: tx, paymentId: p.id, reason: "x" }, userId))).rejects.toMatchObject({ statusCode: 404 });
    // the other org's own row cannot name our receipt: RLS hides it — reference_not_found
    const otherTx = await statementRow(bankOther, { date: DATE, description: `TRANSFER ${inv.invoiceNumber}`, amount: 230, type: "credit" }, inOther);
    await expect(inOther(() => statementMatchingService.override({ transactionId: otherTx, paymentId: p.id, reason: "x" }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "reference_not_found" } });
    // company 2 of the same org: its own row, same invoice number in the narrative — the receipt is invisible to it, so UNMATCHED, never INCONSISTENT
    const c2Tx = await statementRow(bankC2, { date: DATE, description: `TRANSFER ${inv.invoiceNumber}`, amount: 230, type: "credit" }, inCompany2);
    expect((await classificationOf(c2Tx, inCompany2)).classification).toBe("UNMATCHED");
    // ours still deterministic and applies exactly once
    expect((await inTenant(() => statementMatchingService.apply({}, userId))).recorded.map((m) => m.transactionId)).toEqual([tx]);
    // append-only for the app role
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const sql = (await import("drizzle-orm")).sql;
      const { db } = await import("@workspace/db");
      await expect(conn.run(() => db.execute(sql`DELETE FROM statement_matches`))).rejects.toMatchObject({ cause: { code: "42501" } });
    } finally {
      await conn.rollback();
    }
  });

  // ── the carried item: the active-pair guard lives in the database ──────
  it("🔴 the active-allocation pair guard is a DB trigger: two raw sessions inserting the first allocation of a pair → one wins, one 23505; after a reversal the pair is free again", async () => {
    const inv = await issue(custB, 100); // 115
    const p = await inTenant(() => paymentsService.receive({ customerId: custB, amount: 115, paidAt: DATE, bankAccountId: bank1 }, userId));
    // Two dedicated sessions from the owner pool — no service, no lock but the trigger's own.
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN"); await b.query("BEGIN");
      const ins = (c: { query: typeof a.query }) =>
        c.query(`INSERT INTO payment_allocations (organization_id, company_id, payment_id, invoice_id, amount) VALUES ($1,$2,$3,$4,10) RETURNING id`, [orgId, companyId, p.id, inv.id])
          .then((r) => ({ ok: true, id: r.rows[0].id as number }))
          .catch((e: { code: string; constraint: string }) => ({ ok: false, code: e.code, constraint: e.constraint }));
      const pa = ins(a);
      await new Promise((r) => setTimeout(r, 50));
      const pb = ins(b);
      const ra = await pa;
      // A holds the pair lock until it commits; B is queued in the trigger. Commit A → B wakes and sees the row.
      await a.query("COMMIT");
      const rb = await pb;
      await b.query("ROLLBACK");
      expect(ra).toMatchObject({ ok: true });
      expect(rb).toMatchObject({ ok: false, code: "23505", constraint: "payment_allocations_active_pair_unq" });
      // reverse A's allocation through the service; the pair is free; a new allocation of the pair succeeds
      const allocId = (ra as { id: number }).id;
      await pool.query(`UPDATE invoices SET paid_amount = coalesce(paid_amount,0) + 10 WHERE id = $1`, [inv.id]); // the raw insert bypassed the service cache; align it for the unallocate path
      await inTenant(() => paymentsService.unallocate(allocId, { reason: "raw test row" }, userId));
      const re = await inTenant(() => paymentsService.allocate(p.id, { allocations: [{ invoiceId: inv.id, amount: 115 }] }, userId));
      expect(re.unappliedAmount).toBe(0);
    } finally {
      a.release(); b.release();
    }
  });
});
