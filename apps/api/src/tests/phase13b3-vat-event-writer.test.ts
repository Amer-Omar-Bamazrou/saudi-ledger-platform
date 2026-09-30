/**
 * PHASE 13B-3 — THE INPUT-VAT EVENT WRITER (2026-09-29).
 * Records: docs/product/phase-13b-vat-claim-ledger-architecture.md §26;
 *          docs/product/phase-13b2-credit-note-event-design.md §19 (O-1…O-6, D-4a, D-6).
 *
 * Every document here is written by the PRODUCT (billsService, the supplier
 * advance services, the evidence claim) and every event by the WRITER
 * (`inputVatLedgerService`) inside the posting's own transaction — the test
 * reads what they recorded (CLAUDE.md §3, standing rule 2). The database is
 * probed directly only where the property IS the database (admission, the
 * cache-consistency trigger), and each such guard carries a mutation proof:
 * the same act is shown to pass with the guard out of the way, inside a
 * rolled-back transaction, so the test goes red if the guard is removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { periodLocksService } from "../services/periodLocks.service";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { supplierAdvanceInvoicesService } from "../services/accounting/supplierAdvanceInvoices.service";
import { inputVatLedgerService } from "../services/accounting/inputVatLedger.service";
import { billsRepository } from "../repositories/bills.repository";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase13b3-vat-event-writer] no real DATABASE_URL — skipping.");

type PgError = { code?: string; constraint?: string; message: string };
/** The owner pool's client, structurally (the API package does not depend on `pg`'s types). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PoolClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; release: () => void };
type Doc = { id: number; billNumber: string };

describeMaybe("Phase 13B-3 — the input-VAT event writer", () => {
  const SLUG_A = "p13b3-writer-a", SLUG_B = "p13b3-writer-b";
  const EMAIL = "p13b3-writer@test.local";
  let orgA = "", coA = "", coA2 = "", orgB = "", coB = "", userId = 0;
  let vendorA = 0, vendorA2 = 0, vendorB = 0, bankA = 0, purchasesA = 0, mealsA = 0;

  const inTenant = async <T,>(fn: () => Promise<T>, org = orgA, co = coA): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  /** One owner transaction that is ALWAYS rolled back — for probes and mutation proofs. */
  const probe = async <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = (await pool.connect()) as unknown as PoolClient;
    try { await c.query("BEGIN"); return await fn(c); } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  };
  /** One owner transaction, committed; deferred (commit-time) checks throw from COMMIT. */
  const tx = async <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = (await pool.connect()) as unknown as PoolClient;
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) { await c.query("ROLLBACK").catch(() => undefined); throw err; } finally { c.release(); }
  };
  const asApp = async <T,>(org: string, co: string, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = (await pool.connect()) as unknown as PoolClient;
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('app.current_org_id', $1, true)", [org]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [co]);
      return await fn(c);
    } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  };
  const dbRefusal = async (p: Promise<unknown>): Promise<PgError> => {
    let err: PgError | undefined;
    try { await p; } catch (e) { err = e as PgError; }
    expect(err, "expected the database to refuse").toBeTruthy();
    return err!;
  };
  const expectRefusal = async (p: Promise<unknown>, status: number, code: string) => {
    let err: { statusCode?: number; payload?: { code?: string; error?: string }; message?: string } | undefined;
    try { await p; } catch (e) { err = e as typeof err; }
    expect(err, `expected a ${status} ${code} refusal`).toBeTruthy();
    expect([err!.statusCode, err!.payload?.code], err!.message).toEqual([status, code]);
    return err!.payload?.error ?? "";
  };

  const ORGS = `(SELECT id FROM organizations WHERE slug IN ('${SLUG_A}','${SLUG_B}'))`;
  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      for (const t of ["input_vat_events", "input_vat_balances", "bill_prepayments", "supplier_refunds", "supplier_payment_allocation_reversals",
                       "supplier_payment_allocations", "supplier_payment_classifications", "supplier_payments", "captured_documents", "bill_payments",
                       "bill_items", "bills", "cash_line_bank_attributions", "journal_entry_lines", "journal_entries", "period_locks", "audit_logs",
                       "organization_memberships", "vendors", "bank_accounts", "categories", "companies"]) {
        await c.query(`DELETE FROM ${t} WHERE organization_id IN ${ORGS}`);
      }
      await c.query(`DELETE FROM organizations WHERE slug IN ('${SLUG_A}','${SLUG_B}')`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };

  /** A document's events, in order, as [type, from, to, amount, entry number, related document]. */
  const events = async (docId: number) =>
    (await pool.query(
      `SELECT v.event_type, v.from_bucket, v.to_bucket, v.amount::text AS amount, e.entry_number, v.related_document_id
         FROM input_vat_events v LEFT JOIN journal_entries e ON e.id = v.journal_entry_id
        WHERE v.document_id = $1 ORDER BY v.id`, [docId])).rows.map((r) => [r.event_type, r.from_bucket, r.to_bucket, r.amount, r.entry_number, r.related_document_id]);
  const eventRows = async (docId: number) => (await pool.query(`SELECT * FROM input_vat_events WHERE document_id = $1 ORDER BY id`, [docId])).rows;
  const balances = async (docId: number) =>
    (await pool.query(`SELECT held::text, claimed::text, blocked::text FROM input_vat_balances WHERE document_id = $1`, [docId])).rows[0] ?? null;
  const cache = async (docId: number) =>
    (await pool.query(`SELECT status, input_vat_state AS state, input_vat_pending::text AS pending, input_vat_claimed_on AS "claimedOn", input_vat_claim_entry_id AS "claimEntry" FROM bills WHERE id = $1`, [docId])).rows[0];
  const entryId = async (org: string, number: string) =>
    (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [org, number])).rows[0]?.id as number | undefined;
  const reconcile = async (docId: number) =>
    (await pool.query(`SELECT input_vat_document_mismatch($1) AS doc, input_vat_gl_mismatch($1) AS gl`, [docId])).rows[0];

  const create = (body: Record<string, unknown>, org = orgA, co = coA) =>
    inTenant(() => billsService.create({ vendorId: vendorA, vendorReference: `SUP-${String(body.billNumber)}`, items: [], ...body }, userId), org, co) as Promise<Doc>;
  const approve = (id: number, org = orgA, co = coA) => inTenant(() => billsService.approve(id, {}, userId), org, co) as Promise<Doc>;
  const post = async (body: Record<string, unknown>, org = orgA, co = coA) => {
    const b = await create(body, org, co);
    await approve(b.id, org, co);
    return { id: b.id, billNumber: b.billNumber };
  };
  /** A claimed bill (evidenced), a held one (no evidence), a blocked one (Art. 50 meals). */
  const claimedBill = (n: string, date: string, vat = 150) => post({ billNumber: n, date, subtotal: vat / 0.15, vatAmount: vat, total: vat / 0.15 + vat, supplierDocumentKind: "tax_invoice", expenseAccountId: purchasesA });
  const heldBill = (n: string, date: string, vat = 150) => post({ billNumber: n, date, subtotal: vat / 0.15, vatAmount: vat, total: vat / 0.15 + vat, expenseAccountId: purchasesA });
  const blockedBill = (n: string, date: string, vat = 150) => post({ billNumber: n, date, subtotal: vat / 0.15, vatAmount: vat, total: vat / 0.15 + vat, supplierDocumentKind: "tax_invoice", expenseAccountId: mealsA });
  const creditNoteDraft = (original: number, n: string, date: string, vat: number) =>
    create({ documentType: "credit_note", creditNoteAgainstBillId: original, billNumber: n, date, subtotal: vat / 0.15, vatAmount: vat, total: vat / 0.15 + vat });
  const creditNote = async (original: number, n: string, date: string, vat: number) => {
    const d = await creditNoteDraft(original, n, date, vat);
    await approve(d.id);
    return d;
  };
  const claimEvidence = (id: number, date: string) =>
    inTenant(() => billsService.attachEvidence(id, { supplierDocumentKind: "tax_invoice", evidenceDate: date }, userId));
  const advance = async (amount: number, paidAt: string, invoiceDate: string, ref: string) => {
    const p = await inTenant(() => supplierPaymentsService.create({ vendorId: vendorA, bankAccountId: bankA, amount, paidAt, classification: "advance" }, userId)) as { id: number };
    const d = await inTenant(() => supplierAdvanceInvoicesService.createFromPayment(p.id, { amount, date: invoiceDate, vendorReference: ref }, userId));
    return approve(d.id);
  };
  const finalBill = async (net: number, date: string, advanceBillId: number, n: string) =>
    post({ billNumber: n, date, supplierDocumentKind: "tax_invoice", items: [{ description: "Supply", quantity: 1, unitPrice: net, vatRate: 15 }], prepayments: [{ advanceBillId }] });

  beforeAll(async () => {
    const { seedPermissions } = await import("@workspace/db");
    await seedPermissions();
    await cleanup();
    orgA = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P13B3 Writer A', '${SLUG_A}') RETURNING id`)).rows[0].id;
    coA = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1, 'P13B3 A1') RETURNING id`, [orgA])).rows[0].id;
    coA2 = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1, 'P13B3 A2') RETURNING id`, [orgA])).rows[0].id;
    orgB = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P13B3 Writer B', '${SLUG_B}') RETURNING id`)).rows[0].id;
    coB = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1, 'P13B3 B1') RETURNING id`, [orgB])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}', 'P', ' ', 'admin', true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1, $2, 'admin', 'active'), ($1, $3, 'admin', 'active')`, [userId, orgA, orgB]);
    vendorA = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1, 'Riyadh Stationers', '399999999999993') RETURNING id`, [orgA])).rows[0].id;
    vendorA2 = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1, 'Dammam Supplies', '311111111111113') RETURNING id`, [orgA])).rows[0].id;
    vendorB = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1, 'Jeddah Supplies', '311111111111113') RETURNING id`, [orgB])).rows[0].id;
    bankA = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1, $2, 'P13B3 Bank', 'SNB') RETURNING id`, [orgA, coA])).rows[0].id;
    purchasesA = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'PURCHASES'`, [orgA])).rows[0].id;
    mealsA = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'FOOD_MEALS' AND input_vat_blocked`, [orgA])).rows[0].id;
  }, 120_000);
  afterAll(cleanup);

  // ════════════════════════════════════════════════════════════════════════
  // A. The live paths record their events — exactly.
  // ════════════════════════════════════════════════════════════════════════
  it("🔴 a CLAIMED bill: recognised_claimed of its whole VAT inside its own BILL- entry, RECORDED by the approver, in the approval's transaction — and the cache the events imply", async () => {
    const c = await claimedBill("P13B3-C1", "2026-05-10");
    expect(await events(c.id)).toEqual([["recognised_claimed", "NONE", "CLAIMED", "150.00", "BILL-P13B3-C1", null]]);
    const [e] = await eventRows(c.id);
    expect(e).toMatchObject({
      provenance: "recorded", actor_user_id: userId, actor_system: null, reason: "Bill P13B3-C1 approved",
      occurred_on: "2026-05-10", posting_date: "2026-05-10", journal_role: "own_entry",
      idempotency_key: `recognised_claimed:${c.id}`, backfill_migration: null, organization_id: orgA, company_id: coA,
    });
    expect(e.evidence_snapshot).toMatchObject({ status: "evidenced", supplierDocumentKind: "tax_invoice" });
    expect(await balances(c.id)).toEqual({ held: "0.00", claimed: "150.00", blocked: "0.00" });
    expect(await cache(c.id)).toMatchObject({ state: "claimed", pending: "0.00", claimedOn: "2026-05-10", claimEntry: null });
    expect(await reconcile(c.id)).toEqual({ doc: null, gl: null });
  });

  it("🔴 a HELD bill: recognised_held; the evidence claim records `claimed` — the WHOLE held VAT, on the evidence date, inside VATEV-; the cache follows", async () => {
    const h = await heldBill("P13B3-H1", "2026-05-11");
    expect(await events(h.id)).toEqual([["recognised_held", "NONE", "HELD", "150.00", "BILL-P13B3-H1", null]]);
    expect(await cache(h.id)).toMatchObject({ state: "awaiting_evidence", pending: "150.00", claimedOn: null });
    await claimEvidence(h.id, "2026-07-15");
    const vatev = await entryId(orgA, "VATEV-P13B3-H1");
    expect(await events(h.id)).toEqual([
      ["recognised_held", "NONE", "HELD", "150.00", "BILL-P13B3-H1", null],
      ["claimed", "HELD", "CLAIMED", "150.00", "VATEV-P13B3-H1", null],
    ]);
    const claim = (await eventRows(h.id))[1];
    expect(claim).toMatchObject({ occurred_on: "2026-07-15", posting_date: "2026-07-15", journal_role: "claim_entry", idempotency_key: `claimed:${h.id}`, actor_user_id: userId });
    expect(await balances(h.id)).toEqual({ held: "0.00", claimed: "150.00", blocked: "0.00" });
    expect(await cache(h.id)).toMatchObject({ state: "claimed", pending: "0.00", claimedOn: "2026-07-15", claimEntry: vatev });
    expect(await reconcile(h.id)).toEqual({ doc: null, gl: null });
  });

  it("🔴 BLOCKED (Art. 50) VAT: recognised_blocked, its entry carrying no VAT line; D-4a — a debit note on it is BLOCKED on ITS OWN document; a debit note on a claimed bill claims on its own (O-3)", async () => {
    const b = await blockedBill("P13B3-B1", "2026-05-12");
    expect(await events(b.id)).toEqual([["recognised_blocked", "NONE", "BLOCKED", "150.00", "BILL-P13B3-B1", null]]);
    expect(await cache(b.id)).toMatchObject({ state: "not_deductible", pending: "0.00", claimedOn: null });
    const dnBlocked = await post({ documentType: "debit_note", creditNoteAgainstBillId: b.id, billNumber: "P13B3-DN-B", date: "2026-05-20", subtotal: 100, vatAmount: 15, total: 115, supplierDocumentKind: "tax_invoice", expenseAccountId: purchasesA });
    expect(await events(dnBlocked.id), "D-4a: recognised_blocked on the DEBIT NOTE itself").toEqual([["recognised_blocked", "NONE", "BLOCKED", "15.00", "BILL-P13B3-DN-B", null]]);
    expect(await events(b.id), "the original is untouched — increased_by_note is retired").toHaveLength(1);
    const c = await claimedBill("P13B3-C-DN", "2026-05-12");
    const dnClaimed = await post({ documentType: "debit_note", creditNoteAgainstBillId: c.id, billNumber: "P13B3-DN-C", date: "2026-05-21", subtotal: 100, vatAmount: 15, total: 115, supplierDocumentKind: "tax_invoice", expenseAccountId: purchasesA });
    expect(await events(dnClaimed.id)).toEqual([["recognised_claimed", "NONE", "CLAIMED", "15.00", "BILL-P13B3-DN-C", null]]);
    for (const id of [b.id, dnBlocked.id, c.id, dnClaimed.id]) expect(await reconcile(id)).toEqual({ doc: null, gl: null });
  });

  it("🔴 nothing to recognise (a zero-VAT bill): no event, no balance row, the cache reads claimed on its date", async () => {
    const z = await post({ billNumber: "P13B3-Z1", date: "2026-05-13", subtotal: 500, vatAmount: 0, total: 500, supplierDocumentKind: "tax_invoice", expenseAccountId: purchasesA });
    expect(await events(z.id)).toEqual([]);
    expect(await balances(z.id)).toBeNull();
    expect(await cache(z.id)).toMatchObject({ state: "claimed", pending: "0.00", claimedOn: "2026-05-13" });
    expect(await reconcile(z.id)).toEqual({ doc: null, gl: null });
  });

  it("🔴 SETTLED credit notes (B-1): each is ONE reduced_by_note on its ORIGINAL, inside the note's BILLCN- entry, from the bucket its VAT is in — held (the later claim is the net), claimed, blocked", async () => {
    // Held: two notes, then the claim of what is left.
    const h = await heldBill("P13B3-H2", "2026-06-01");
    const n1 = await creditNote(h.id, "P13B3-CN-H2a", "2026-06-05", 15);
    const n2 = await creditNote(h.id, "P13B3-CN-H2b", "2026-06-06", 30);
    expect(await cache(h.id), "X3: the held amount is the net").toMatchObject({ state: "awaiting_evidence", pending: "105.00" });
    await claimEvidence(h.id, "2026-06-20");
    expect(await events(h.id)).toEqual([
      ["recognised_held", "NONE", "HELD", "150.00", "BILL-P13B3-H2", null],
      ["reduced_by_note", "HELD", "NONE", "15.00", "BILLCN-P13B3-CN-H2a", n1.id],
      ["reduced_by_note", "HELD", "NONE", "30.00", "BILLCN-P13B3-CN-H2b", n2.id],
      ["claimed", "HELD", "CLAIMED", "105.00", "VATEV-P13B3-H2", null],
    ]);
    const note = (await eventRows(h.id))[1];
    expect(note).toMatchObject({ cause_type: "credit_note", cause_id: n1.id, occurred_on: "2026-06-05", journal_role: "note_entry", idempotency_key: `reduced_by_note:${n1.id}`, reason: "Supplier credit note P13B3-CN-H2a approved" });
    expect(await events(n1.id), "a credit note carries no event of its own").toEqual([]);
    // Claimed, then a note.
    const c = await claimedBill("P13B3-C2", "2026-06-02");
    const nc = await creditNote(c.id, "P13B3-CN-C2", "2026-06-10", 45);
    expect(await events(c.id)).toEqual([
      ["recognised_claimed", "NONE", "CLAIMED", "150.00", "BILL-P13B3-C2", null],
      ["reduced_by_note", "CLAIMED", "NONE", "45.00", "BILLCN-P13B3-CN-C2", nc.id],
    ]);
    expect(await cache(nc.id)).toMatchObject({ state: "claimed", pending: "0.00", claimedOn: "2026-06-10" });
    // Blocked, then a note.
    const b = await blockedBill("P13B3-B2", "2026-06-03");
    const nb = await creditNote(b.id, "P13B3-CN-B2", "2026-06-11", 15);
    expect(await events(b.id)).toEqual([
      ["recognised_blocked", "NONE", "BLOCKED", "150.00", "BILL-P13B3-B2", null],
      ["reduced_by_note", "BLOCKED", "NONE", "15.00", "BILLCN-P13B3-CN-B2", nb.id],
    ]);
    expect(await balances(b.id)).toEqual({ held: "0.00", claimed: "0.00", blocked: "135.00" });
    expect(await cache(nb.id)).toMatchObject({ state: "not_deductible", claimedOn: null });
    for (const id of [h.id, n1.id, n2.id, c.id, nc.id, b.id, nb.id]) expect(await reconcile(id), `doc ${id}`).toEqual({ doc: null, gl: null });
  });

  it("🔴 O-6 — credit notes consume ALL held VAT: the claim writes NO `claimed` event (an event moves a positive amount); the cache reads claimed, no claim entry", async () => {
    const h = await heldBill("P13B3-H6", "2026-06-01");
    await creditNote(h.id, "P13B3-CN-H6", "2026-06-02", 150);
    expect(await cache(h.id)).toMatchObject({ state: "awaiting_evidence", pending: "0.00" });
    await claimEvidence(h.id, "2026-06-03");
    expect((await events(h.id)).map((e) => e[0])).toEqual(["recognised_held", "reduced_by_note"]);
    expect(await balances(h.id)).toEqual({ held: "0.00", claimed: "0.00", blocked: "0.00" });
    expect(await cache(h.id)).toMatchObject({ state: "claimed", pending: "0.00", claimedOn: "2026-06-03", claimEntry: null });
    expect(await reconcile(h.id)).toEqual({ doc: null, gl: null });
  });

  it("🔴 Z-AP1: the advance invoice recognises its VAT inside BILLADV-; the final bill recognises only the rest and records advance_deducted; the advance credit note reduces the ADVANCE's claimed VAT inside BILLADVCN-", async () => {
    const adv = await advance(1_150, "2026-04-01", "2026-04-02", "ADV-1");
    expect(await events(adv.id)).toEqual([["recognised_claimed", "NONE", "CLAIMED", "150.00", `BILLADV-${adv.billNumber}`, null]]);
    const fin = await finalBill(2_000, "2026-04-20", adv.id, "P13B3-FIN1");
    expect(await events(fin.id)).toEqual([
      ["recognised_claimed", "NONE", "CLAIMED", "150.00", "BILL-P13B3-FIN1", null],
      ["advance_deducted", "NONE", "NONE", "150.00", "BILL-P13B3-FIN1", adv.id],
    ]);
    expect(await balances(adv.id), "the advance's VAT stays claimed — an annotation moves no bucket").toEqual({ held: "0.00", claimed: "150.00", blocked: "0.00" });
    const adv2 = await advance(2_300, "2026-04-03", "2026-04-04", "ADV-2");
    const draft = await inTenant(() => supplierAdvanceInvoicesService.createCreditNote(adv2.id, { amount: 1_150, date: "2026-04-25", vendorReference: "ADV-CN-2" }, userId));
    await approve(draft.id);
    expect(await events(adv2.id)).toEqual([
      ["recognised_claimed", "NONE", "CLAIMED", "300.00", `BILLADV-${adv2.billNumber}`, null],
      ["reduced_by_note", "CLAIMED", "NONE", "150.00", `BILLADVCN-${draft.billNumber}`, draft.id],
    ]);
    for (const id of [adv.id, fin.id, adv2.id, draft.id]) expect(await reconcile(id), `doc ${id}`).toEqual({ doc: null, gl: null });
  });

  // ════════════════════════════════════════════════════════════════════════
  // B. O-2 and D-6: refused by name, in words, BEFORE anything posts.
  // ════════════════════════════════════════════════════════════════════════
  const nothingPosted = async (noteId: number, noteNumber: string, originalId: number, eventsBefore: unknown[]) => {
    expect((await cache(noteId)).status, "the note stays a draft").toBe("draft");
    expect(await entryId(orgA, `BILLCN-${noteNumber}`), "no entry posted").toBeUndefined();
    expect(await events(originalId), "no event recorded").toEqual(eventsBefore);
  };

  it("🔴 O-2 rule 1 — OVER-CREDIT: a note beyond the VAT the original charged less its other notes is refused as credit_note_exceeds_invoice_vat (IR Art. 54(1); closes D-1 — the claimed and blocked cases posted before)", async () => {
    // Notes whose VAT is not 15 % of their net: the create-time cap (purchaseNotePolicy) bounds TOTALS
    // only, which is exactly why a VAT over-credit reached the books before (D-1).
    const vatNote = async (original: number, n: string, date: string, vat: number) =>
      create({ documentType: "credit_note", creditNoteAgainstBillId: original, billNumber: n, date, subtotal: 10, vatAmount: vat, total: 10 + vat });
    const c = await claimedBill("P13B3-C-OVER", "2026-06-01");
    await approve((await vatNote(c.id, "P13B3-CN-OVER1", "2026-06-02", 100)).id);
    const before = await events(c.id);
    const over = await vatNote(c.id, "P13B3-CN-OVER2", "2026-06-03", 60);
    const words = await expectRefusal(approve(over.id), 422, "credit_note_exceeds_invoice_vat");
    expect(words).toMatch(/only 50\.00 of the 150\.00 VAT charged on P13B3-C-OVER is left/);
    await nothingPosted(over.id, "P13B3-CN-OVER2", c.id, before);
    const b = await blockedBill("P13B3-B-OVER", "2026-06-01");
    const overB = await vatNote(b.id, "P13B3-CN-OVERB", "2026-06-03", 165);
    await expectRefusal(approve(overB.id), 422, "credit_note_exceeds_invoice_vat");
    // …and exactly the remaining amount is admitted (the boundary).
    await approve((await vatNote(c.id, "P13B3-CN-OVER3", "2026-06-03", 50)).id);
    expect(await balances(c.id)).toEqual({ held: "0.00", claimed: "0.00", blocked: "0.00" });
  });

  it("🔴 O-2 rule 4 — ALLOCATION UNDECIDED (CN-7): a note on a final bill within the VAT it charged but beyond its OWN claimed VAT is refused by that name — never as an over-credit", async () => {
    const adv = await advance(1_150, "2026-04-05", "2026-04-06", "ADV-CN7");
    const fin = await finalBill(2_000, "2026-04-21", adv.id, "P13B3-FIN-CN7"); // VAT 300: 150 on the advance, 150 claimed here
    const before = await events(fin.id);
    const tooFar = await creditNoteDraft(fin.id, "P13B3-CN-CN7", "2026-05-01", 200);
    const words = await expectRefusal(approve(tooFar.id), 422, "input_vat_note_allocation_undecided");
    expect(words).toMatch(/not yet decided/);
    await nothingPosted(tooFar.id, "P13B3-CN-CN7", fin.id, before);
    const within = await creditNote(fin.id, "P13B3-CN-CN7-OK", "2026-05-01", 100);
    expect((await events(fin.id)).at(-1)).toEqual(["reduced_by_note", "CLAIMED", "NONE", "100.00", "BILLCN-P13B3-CN-CN7-OK", within.id]);
  });

  it("🔴 O-2 rule 2 — NI-4: once a document's history holds a reversal (13B-6's event, planted here with its own entry), ANY credit note is refused as input_vat_note_interaction_undecided (CN-1…CN-6)", async () => {
    const c = await claimedBill("P13B3-C-NI4", "2026-03-01");
    await tx(async (cl) => {
      const acct = async (code: string) => (await cl.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgA, code])).rows[0];
      const [cost, adj] = [await acct("PURCHASES"), await acct("VAT_ADJ_NONPAYMENT")];
      const { rows: [je] } = await cl.query(
        `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status, source, posted_at)
         VALUES ($1, $2, 'VATADJ-P13B3-NI4', '2027-03-31', 'planted 40(10) reversal', 'posted', 'input_vat_event', now()) RETURNING id`, [orgA, coA]);
      for (const [a, dr, cr] of [[cost, 50, 0], [adj, 0, 50]] as const) {
        await cl.query(`INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [orgA, coA, je.id, a.id, a.name, dr, cr]);
      }
      await cl.query(
        `INSERT INTO input_vat_events (organization_id, company_id, document_id, event_type, from_bucket, to_bucket, amount, occurred_on, posting_date, trigger_month,
                                       journal_entry_id, journal_role, provenance, actor_system, idempotency_key)
         VALUES ($1, $2, $3, 'reversed_unpaid', 'CLAIMED', 'REVERSED_UNPAID', 50, '2027-03-31', '2027-03-31', '2027-03', $4, 'event_entry', 'recorded', 'test:13b3', 'p13b3-ni4')`,
        [orgA, coA, c.id, je.id]);
    });
    const before = await events(c.id);
    const note = await creditNoteDraft(c.id, "P13B3-CN-NI4", "2027-04-02", 15);
    await expectRefusal(approve(note.id), 422, "input_vat_note_interaction_undecided");
    await nothingPosted(note.id, "P13B3-CN-NI4", c.id, before);
  });

  // Phase 13B S1 (0110) retired input_vat_note_opening_original: an opening payable's VAT
  // enters this ledger only through a DECLARATION (phase13b-s1-opening-payable-vat.test.ts).
  // Without one the note is still refused by name — never as an over-credit.
  it("🔴 the OPENING original, UNDECLARED: a credit note is refused by name — first for the supplier's document, then (with it attached) because the payable's VAT history is undeclared — never as an over-credit", async () => {
    const open = (await pool.query(
      `INSERT INTO bills (organization_id, company_id, vendor_id, bill_number, date, subtotal, vat_amount, total, status, is_opening)
       VALUES ($1, $2, $3, 'P13B3-OPEN-1', '2026-01-01', 1150, 0, 1150, 'approved', true) RETURNING id`, [orgA, coA, vendorA])).rows[0].id as number;
    expect(await reconcile(open)).toEqual({ doc: null, gl: null });
    const note = await creditNoteDraft(open, "P13B3-CN-OPEN", "2026-02-01", 15);
    await expectRefusal(approve(note.id), 422, "supplier_note_evidence_missing");
    await nothingPosted(note.id, "P13B3-CN-OPEN", open, []);
    await pool.query(
      `INSERT INTO captured_documents (organization_id, company_id, status, content_type, byte_size, sha256, source, bill_id)
       VALUES ($1, $2, 'staged', 'application/pdf', 10, repeat('b', 64), 'manual', $3)`, [orgA, coA, note.id]);
    const words = await expectRefusal(approve(note.id), 422, "input_vat_note_opening_undeclared");
    expect(words).toMatch(/opening balance migrated at cut-over/);
    await nothingPosted(note.id, "P13B3-CN-OPEN", open, []);
  });

  it("🔴 D-6 (O-4): a credit note dated BEFORE its original is refused (credit_note_before_original) — nothing posts", async () => {
    const c = await claimedBill("P13B3-C-D6", "2026-06-15");
    const before = await events(c.id);
    const early = await creditNoteDraft(c.id, "P13B3-CN-D6", "2026-06-14", 15);
    await expectRefusal(approve(early.id), 422, "credit_note_before_original");
    await nothingPosted(early.id, "P13B3-CN-D6", c.id, before);
    // The same day is fine.
    await creditNote(c.id, "P13B3-CN-D6-OK", "2026-06-15", 15);
  });

  // ════════════════════════════════════════════════════════════════════════
  // C. The database is the boundary — each with its mutation proof.
  // ════════════════════════════════════════════════════════════════════════
  it("🔴 O-2 IN THE DATABASE: an over-credit event is refused by ITS name at admission (writer bypassed); MUTATION — with CI-1 removed from the one definition, the same note is misnamed allocation-undecided", async () => {
    const c = await claimedBill("P13B3-C-DB", "2026-06-01");
    const cEntry = (await entryId(orgA, "BILL-P13B3-C-DB"))!;
    const plantOver = async (cl: PoolClient) => {
      const note = (await cl.query(
        `INSERT INTO bills (organization_id, company_id, vendor_id, bill_number, date, subtotal, vat_amount, total, status, document_type, credit_note_against_bill_id)
         VALUES ($1, $2, $3, 'P13B3-CN-DB', '2026-06-05', 1400, 210, 1610, 'received', 'credit_note', $4) RETURNING id`, [orgA, coA, vendorA, c.id])).rows[0].id;
      return cl.query(
        `INSERT INTO input_vat_events (organization_id, company_id, document_id, related_document_id, event_type, from_bucket, to_bucket, amount, occurred_on, posting_date,
                                       cause_type, cause_id, journal_entry_id, journal_role, provenance, actor_system, idempotency_key)
         VALUES ($1, $2, $3, $4, 'reduced_by_note', 'CLAIMED', 'NONE', 210, '2026-06-05', '2026-06-05', 'credit_note', $4, $5, 'note_entry', 'recorded', 'test:13b3', 'p13b3-db-over')`,
        [orgA, coA, c.id, note, cEntry]);
    };
    const refused = await dbRefusal(probe(plantOver));
    expect(refused.constraint).toBe("credit_note_exceeds_invoice_vat");
    const mutated = await dbRefusal(probe(async (cl) => {
      const def = (await cl.query(`SELECT pg_get_functiondef('input_vat_note_refusal(integer,integer,numeric)'::regprocedure) AS d`)).rows[0].d as string;
      const withoutCi1 = def.replace("IF p_amount > v_remaining THEN", "IF false THEN");
      expect(withoutCi1).not.toBe(def);
      await cl.query(withoutCi1);
      return plantOver(cl);
    }));
    expect(mutated.constraint, "without rule 1 the over-credit reads as an allocation question — the name is the guard's").toBe("input_vat_note_allocation_undecided");
  });

  it("🔴 NI-4 IN THE DATABASE, with its MUTATION: the history guard is what refuses a note after a reversal — removed, the same note is admitted from CLAIMED", async () => {
    const c = (await pool.query(`SELECT id FROM bills WHERE organization_id = $1 AND bill_number = 'P13B3-C-NI4'`, [orgA])).rows[0].id as number;
    const cEntry = (await entryId(orgA, "BILL-P13B3-C-NI4"))!;
    const plant = async (cl: PoolClient) => {
      const note = (await cl.query(
        `INSERT INTO bills (organization_id, company_id, vendor_id, bill_number, date, subtotal, vat_amount, total, status, document_type, credit_note_against_bill_id)
         VALUES ($1, $2, $3, 'P13B3-CN-NI4-DB', '2027-04-05', 100, 15, 115, 'received', 'credit_note', $4) RETURNING id`, [orgA, coA, vendorA, c])).rows[0].id;
      return cl.query(
        `INSERT INTO input_vat_events (organization_id, company_id, document_id, related_document_id, event_type, from_bucket, to_bucket, amount, occurred_on, posting_date,
                                       cause_type, cause_id, journal_entry_id, journal_role, provenance, actor_system, idempotency_key)
         VALUES ($1, $2, $3, $4, 'reduced_by_note', 'CLAIMED', 'NONE', 15, '2027-04-05', '2027-04-05', 'credit_note', $4, $5, 'note_entry', 'recorded', 'test:13b3', 'p13b3-db-ni4') RETURNING event_type`,
        [orgA, coA, c, note, cEntry]);
    };
    expect((await dbRefusal(probe(plant))).constraint).toBe("input_vat_note_interaction_undecided");
    const admitted = await probe(async (cl) => {
      const def = (await cl.query(`SELECT pg_get_functiondef('input_vat_note_refusal(integer,integer,numeric)'::regprocedure) AS d`)).rows[0].d as string;
      await cl.query(def.replace("IF EXISTS (SELECT 1 FROM input_vat_events v", "IF false AND EXISTS (SELECT 1 FROM input_vat_events v"));
      return (await plant(cl)).rows[0].event_type;
    });
    expect(admitted, "with the history rule removed nothing else stops it").toBe("reduced_by_note");
  });

  it("🔴 admission shapes (writer bypassed, owner probes): a recognition must state exactly the VAT net of advances on the document's date; no event on a credit note itself or on an opening payable; a note event must name a posted note of THIS document, on its date, from the bucket its VAT is in", async () => {
    const c = await claimedBill("P13B3-C-SHAPE", "2026-06-01");
    const cEntry = (await entryId(orgA, "BILL-P13B3-C-SHAPE"))!;
    const note = await creditNote(c.id, "P13B3-CN-SHAPE", "2026-06-04", 15);
    const noteEntry = (await entryId(orgA, "BILLCN-P13B3-CN-SHAPE"))!;
    const open = (await pool.query(`SELECT id FROM bills WHERE organization_id = $1 AND bill_number = 'P13B3-OPEN-1'`, [orgA])).rows[0].id as number;
    const other = await claimedBill("P13B3-C-SHAPE2", "2026-06-01");
    const ev = (cl: PoolClient, e: Record<string, unknown>) => {
      const row: Record<string, unknown> = { organization_id: orgA, company_id: coA, journal_entry_id: null, journal_role: null, related_document_id: null, cause_type: null, cause_id: null,
        provenance: "recorded", actor_system: "test:13b3", idempotency_key: `p13b3-shape-${Math.random()}`, ...e };
      row.posting_date ??= row.occurred_on;
      const cols = Object.keys(row);
      return cl.query(`INSERT INTO input_vat_events (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(row));
    };
    const noteEv = { document_id: c.id, related_document_id: note.id, event_type: "reduced_by_note", from_bucket: "CLAIMED", to_bucket: "NONE", amount: 15,
      occurred_on: "2026-06-04", cause_type: "credit_note", cause_id: note.id, journal_entry_id: noteEntry, journal_role: "note_entry" };
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["a second recognition", { document_id: c.id, event_type: "recognised_held", from_bucket: "NONE", to_bucket: "HELD", amount: 150, occurred_on: "2026-06-01", journal_entry_id: cEntry, journal_role: "own_entry" }, "input_vat_events_one_recognition_per_document_unq"],
      ["a recognition of the wrong amount", { document_id: other.id, event_type: "recognised_claimed", from_bucket: "NONE", to_bucket: "CLAIMED", amount: 149, occurred_on: "2026-06-01", journal_entry_id: cEntry, journal_role: "own_entry" }, "input_vat_event_amount"],
      ["an event on a credit note itself", { document_id: note.id, event_type: "exception_recorded", from_bucket: "NONE", to_bucket: "NONE", occurred_on: "2026-06-04" }, "input_vat_event_shape"],
      ["an event on an opening payable", { document_id: open, event_type: "exception_recorded", from_bucket: "NONE", to_bucket: "NONE", occurred_on: "2026-06-04" }, "input_vat_event_shape"],
      ["a second event for the same note (another entry, so only NI-5 can refuse it)", { ...noteEv, journal_entry_id: cEntry }, "input_vat_events_one_per_note_unq"],
      ["a second event naming the same note ENTRY", { ...noteEv, idempotency_key: "p13b3-entry" }, "input_vat_events_note_journal_unq"],
      ["a note of ANOTHER document", { ...noteEv, document_id: other.id, idempotency_key: "p13b3-other" }, "input_vat_event_shape"],
      ["increased_by_note (retired)", { document_id: c.id, event_type: "increased_by_note", from_bucket: "NONE", to_bucket: "CLAIMED", amount: 15, occurred_on: "2026-06-04", journal_entry_id: cEntry, journal_role: "own_entry" }, "input_vat_event_not_admitted"],
    ];
    for (const [name, e, constraint] of cases) {
      expect((await dbRefusal(probe((cl) => ev(cl, e)))).constraint, name).toBe(constraint);
    }
    // The date and bucket rules on a note not yet recorded (a fresh posted note row, inside the probe).
    const freshNote = async (cl: PoolClient, date: string) => (await cl.query(
      `INSERT INTO bills (organization_id, company_id, vendor_id, bill_number, date, subtotal, vat_amount, total, status, document_type, credit_note_against_bill_id)
       VALUES ($1, $2, $3, $4, $5, 100, 15, 115, 'received', 'credit_note', $6) RETURNING id`, [orgA, coA, vendorA, `P13B3-CN-F${date}`, date, c.id])).rows[0].id as number;
    const withFresh = (date: string, over: Record<string, unknown>) => probe(async (cl) => {
      const n = await freshNote(cl, date);
      return ev(cl, { ...noteEv, related_document_id: n, cause_id: n, occurred_on: date, idempotency_key: `p13b3-f-${date}`, ...over });
    });
    expect((await dbRefusal(withFresh("2026-06-07", { occurred_on: "2026-06-08" }))).constraint, "on the note's date").toBe("input_vat_event_dates");
    expect((await dbRefusal(withFresh("2026-05-30", {}))).constraint, "D-6 in the database").toBe("input_vat_note_before_original");
    expect((await dbRefusal(withFresh("2026-06-07", { from_bucket: "HELD" }))).constraint, "its VAT is CLAIMED, not HELD").toBe("input_vat_note_bucket");
    expect((await dbRefusal(withFresh("2026-06-07", { amount: 10 }))).constraint, "exactly the note's VAT").toBe("input_vat_event_amount");
  });

  it("🔴 journal linkage at COMMIT: a note event must reference the NOTE's own entry with its credit on the bucket's account; own_entry of an advance invoice is BILLADV-", async () => {
    const c = await claimedBill("P13B3-C-LINK", "2026-06-01");
    const cEntry = (await entryId(orgA, "BILL-P13B3-C-LINK"))!;
    const wrongEntry = await dbRefusal(probe(async (cl) => {
      const n = (await cl.query(
        `INSERT INTO bills (organization_id, company_id, vendor_id, bill_number, date, subtotal, vat_amount, total, status, document_type, credit_note_against_bill_id)
         VALUES ($1, $2, $3, 'P13B3-CN-LINK', '2026-06-02', 100, 15, 115, 'received', 'credit_note', $4) RETURNING id`, [orgA, coA, vendorA, c.id])).rows[0].id;
      await cl.query(
        `INSERT INTO input_vat_events (organization_id, company_id, document_id, related_document_id, event_type, from_bucket, to_bucket, amount, occurred_on, posting_date,
                                       cause_type, cause_id, journal_entry_id, journal_role, provenance, actor_system, idempotency_key)
         VALUES ($1, $2, $3, $4, 'reduced_by_note', 'CLAIMED', 'NONE', 15, '2026-06-02', '2026-06-02', 'credit_note', $4, $5, 'note_entry', 'recorded', 'test:13b3', 'p13b3-link')`,
        [orgA, coA, c.id, n, cEntry]);
      await cl.query("SET CONSTRAINTS input_vat_events_journal_link IMMEDIATE");
    }));
    expect(wrongEntry.constraint, "the ORIGINAL's entry is not the note's").toBe("input_vat_event_journal_link");
  });

  it("🔴 THE CACHE-CONSISTENCY TRIGGER: every direct write of a cache column is refused at commit; a posted VAT bill with no event is refused; consistent writes pass — MUTATION: with the trigger disabled the same writes commit", async () => {
    const c = await claimedBill("P13B3-C-CACHE", "2026-06-01");
    const h = await heldBill("P13B3-H-CACHE", "2026-06-01");
    const writes: Array<[string, string, unknown[]]> = [
      // The one state change bills_vat_evidence_gate (0106) ADMITS — held → claimed with the verdict evidenced,
      // nothing pending, a date in the window — written without its claim entry or event: only 0109 can see it.
      ["a claim with no event", `UPDATE bills SET vat_evidence_status = 'evidenced', input_vat_state = 'claimed', input_vat_pending = 0, input_vat_claimed_on = '2026-06-02' WHERE id = $1`, [h.id]],
      ["the claim date", `UPDATE bills SET input_vat_claimed_on = '2026-06-02' WHERE id = $1`, [c.id]],
      ["the held amount", `UPDATE bills SET input_vat_pending = 149 WHERE id = $1`, [h.id]],
      ["the claim entry", `UPDATE bills SET input_vat_claim_entry_id = (SELECT id FROM journal_entries WHERE entry_number = 'BILL-P13B3-C-CACHE' AND organization_id = '${orgA}') WHERE id = $1`, [c.id]],
      ["a posted VAT bill inserted with no event", `INSERT INTO bills (organization_id, company_id, vendor_id, bill_number, date, subtotal, vat_amount, total, status) VALUES ('${orgA}', '${coA}', $1, 'P13B3-RAW', '2026-06-01', 100, 15, 115, 'received')`, [vendorA]],
    ];
    for (const [name, sqlText, params] of writes) {
      const err = await dbRefusal(probe(async (cl) => { await cl.query(sqlText, params); await cl.query("SET CONSTRAINTS ALL IMMEDIATE"); }));
      expect([err.constraint, name]).toEqual(["bills_input_vat_cache_consistency", name]);
      expect(err.message, "the refusal names the document and both readings").toMatch(/require|must|no recognition event|events/);
      const mutated = await probe(async (cl) => {
        await cl.query("ALTER TABLE bills DISABLE TRIGGER bills_input_vat_cache_consistency");
        await cl.query(sqlText, params);
        await cl.query("SET CONSTRAINTS ALL IMMEDIATE");
        return "committed";
      });
      expect(mutated, `${name}: with the trigger out of the way the write goes through`).toBe("committed");
    }
    // …and the EVENT side: an event committed without its cache moving (a write-off of 40 held, the
    // pending left at 150) is refused by input_vat_events_cache_consistency — with it disabled, it commits.
    const lapseWithoutCache = async (cl: PoolClient) => {
      const acct = async (code: string) => (await cl.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgA, code])).rows[0];
      const [cost, held] = [await acct("PURCHASES"), await acct("VAT_AWAITING_EVIDENCE")];
      const { rows: [je] } = await cl.query(
        `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status, source, posted_at)
         VALUES ($1, $2, 'VATLAP-P13B3-CACHE', '2026-12-31', 'planted write-off', 'posted', 'input_vat_event', now()) RETURNING id`, [orgA, coA]);
      for (const [a, dr, cr] of [[cost, 40, 0], [held, 0, 40]] as const) {
        await cl.query(`INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [orgA, coA, je.id, a.id, a.name, dr, cr]);
      }
      await cl.query(
        `INSERT INTO input_vat_events (organization_id, company_id, document_id, event_type, from_bucket, to_bucket, amount, occurred_on, posting_date,
                                       journal_entry_id, journal_role, reason, provenance, actor_system, idempotency_key)
         VALUES ($1, $2, $3, 'lapsed_written_off', 'HELD', 'LAPSED', 40, '2026-12-31', '2026-12-31', $4, 'event_entry', 'supplier dissolved', 'recorded', 'test:13b3', 'p13b3-cache-lapse')`,
        [orgA, coA, h.id, je.id]);
      await cl.query("SET CONSTRAINTS ALL IMMEDIATE");
      return "committed";
    };
    const eventSide = await dbRefusal(probe(lapseWithoutCache));
    expect(eventSide.constraint).toBe("bills_input_vat_cache_consistency");
    expect(eventSide.message).toMatch(/pending 110\.00.*pending 150\.00/);
    expect(await probe(async (cl) => {
      await cl.query("ALTER TABLE input_vat_events DISABLE TRIGGER input_vat_events_cache_consistency");
      return lapseWithoutCache(cl);
    }), "with the event-side trigger out of the way it commits").toBe("committed");
    // Consistent writes pass: an unrelated column, and a payment that moves the status.
    await tx((cl) => cl.query(`UPDATE bills SET notes = 'p13b3 note' WHERE id = $1`, [c.id]));
    await inTenant(() => billsService.pay(c.id, { amount: 1150, paidAt: "2026-06-10", bankAccountId: bankA }, userId));
    expect((await cache(c.id)).status).toBe("paid");
    // A held credit note's row is NOT mapped (approved): claimNotesFollowing rewrites it with the original's claim.
    expect(await reconcile(h.id)).toEqual({ doc: null, gl: null });
  });

  it("🔴 isolation (presence, absence, movement): events carry the document's organisation and COMPANY; each tenant and each company reads only its own", async () => {
    const a2 = await post({ billNumber: "P13B3-A2", date: "2026-06-01", subtotal: 1000, vatAmount: 150, total: 1150, supplierDocumentKind: "tax_invoice", vendorId: vendorA2 }, orgA, coA2);
    const b = await post({ billNumber: "P13B3-B-ORG", date: "2026-06-01", subtotal: 1000, vatAmount: 150, total: 1150, supplierDocumentKind: "tax_invoice", vendorId: vendorB }, orgB, coB);
    expect((await eventRows(a2.id))[0]).toMatchObject({ organization_id: orgA, company_id: coA2 });
    expect((await eventRows(b.id))[0]).toMatchObject({ organization_id: orgB, company_id: coB });
    const seen = (org: string, co: string) => asApp(org, co, async (cl) => (await cl.query(`SELECT DISTINCT document_id FROM input_vat_events`)).rows.map((r) => r.document_id as number));
    const [inA1, inA2, inB] = [await seen(orgA, coA), await seen(orgA, coA2), await seen(orgB, coB)];
    expect(inA2, "company A2 reads its own").toEqual([a2.id]);
    expect(inB, "movement: org B reads ITS event").toEqual([b.id]);
    expect(inA1, "absence: company A1 reads neither").not.toContain(a2.id);
    expect(inA1).not.toContain(b.id);
    expect(inA1.length, "presence: A1 reads its own").toBeGreaterThan(5);
  });

  it("🔴 period locks: a credit note, or an evidence claim, into a closed month posts nothing and records nothing (423); the month reopened, both record", async () => {
    const h = await heldBill("P13B3-H-LOCK", "2026-07-01");
    const note = await creditNoteDraft(h.id, "P13B3-CN-LOCK", "2026-08-05", 15); // drafted while the month is open
    await inTenant(() => periodLocksService.lock({ period: "2026-08", userId }));
    try {
      const before = await events(h.id);
      let status = 0;
      try { await approve(note.id); } catch (e) { status = (e as { statusCode: number }).statusCode; }
      expect(status).toBe(423);
      try { await claimEvidence(h.id, "2026-08-06"); status = 0; } catch (e) { status = (e as { statusCode: number }).statusCode; }
      expect(status).toBe(423);
      expect(await events(h.id)).toEqual(before);
      expect(await cache(h.id)).toMatchObject({ state: "awaiting_evidence", pending: "150.00" });
    } finally {
      await pool.query(`DELETE FROM period_locks WHERE organization_id = $1 AND period = '2026-08'`, [orgA]);
    }
    await approve(note.id);
    await claimEvidence(h.id, "2026-08-06");
    expect((await events(h.id)).map((e) => [e[0], e[3]])).toEqual([["recognised_held", "150.00"], ["reduced_by_note", "15.00"], ["claimed", "135.00"]]);
  });

  it("🔴 idempotency: an approval cannot run twice, a claim cannot be made twice — the events are exactly once; every key names its act and document", async () => {
    const h = await heldBill("P13B3-H-IDEM", "2026-06-01");
    await claimEvidence(h.id, "2026-06-05");
    const before = await eventRows(h.id);
    let twice: unknown;
    try { await approve(h.id); } catch (e) { twice = e; }
    expect(twice, "a posted bill is not approved again").toBeTruthy();
    let again: { statusCode?: number } | undefined;
    try { await claimEvidence(h.id, "2026-06-06"); } catch (e) { again = e as typeof again; }
    expect(again?.statusCode).toBe(409);
    expect(await eventRows(h.id)).toEqual(before);
    expect(before.map((e) => e.idempotency_key)).toEqual([`recognised_held:${h.id}`, `claimed:${h.id}`]);
  });

  // ════════════════════════════════════════════════════════════════════════
  // D. 🔴 IDEMPOTENCY — a retry is harmless; a reused key for a different act is refused.
  // ════════════════════════════════════════════════════════════════════════
  it("🔴 IDEMPOTENT WRITER: (a) the first request records; (b) an EXACT retry records nothing, moves no balance, cache or journal; (c) the same key for a DIFFERENT act is refused (409) and changes nothing; (d) no duplicate event, balance or entry", async () => {
    const counts = async () => ({
      events: Number((await pool.query(`SELECT count(*) FROM input_vat_events WHERE organization_id = $1`, [orgA])).rows[0].count),
      entries: Number((await pool.query(`SELECT count(*) FROM journal_entries WHERE organization_id = $1`, [orgA])).rows[0].count),
    });
    const row = (id: number) => inTenant(async () => (await billsRepository.findById(id))[0]!);
    const held = await heldBill("P13B3-H-IDEMP", "2026-06-01");
    const noteDoc = await creditNote(held.id, "P13B3-CN-IDEMP", "2026-06-05", 15); // (a) first request: recorded by the approval
    const noteEntry = (await entryId(orgA, "BILLCN-P13B3-CN-IDEMP"))!;
    const heldEntry = (await entryId(orgA, "BILL-P13B3-H-IDEMP"))!;
    expect((await events(held.id)).map((e) => e[0])).toEqual(["recognised_held", "reduced_by_note"]);
    const before = { counts: await counts(), bal: await balances(held.id), heldCache: await cache(held.id), noteCache: await cache(noteDoc.id) };
    expect(before.heldCache).toMatchObject({ pending: "135.00" });
    const verdict = { status: "not_required" as const, basis: null, flags: [] };

    // (b) EXACT retries of both postings and of nothing else.
    const retryNote = async (over: { entryId?: number; vat?: number } = {}) => inTenant(async () => inputVatLedgerService.recordPosting({
      bill: await row(noteDoc.id), treatment: "awaiting_evidence", vatToClaim: over.vat ?? 15, entryId: over.entryId ?? noteEntry,
      original: await row(held.id), verdict, columns: { status: "received", reviewNote: null }, userId,
    }));
    const retryRecognition = async (over: { entryId?: number } = {}) => inTenant(async () => inputVatLedgerService.recordPosting({
      bill: await row(held.id), treatment: "awaiting_evidence", vatToClaim: 150, entryId: over.entryId ?? heldEntry,
      verdict: { status: "awaiting_evidence", basis: null, flags: [] }, columns: { status: "received", reviewNote: null }, userId,
    }));
    await retryNote();
    await retryNote();
    await retryRecognition();
    expect(await counts(), "no event, no entry").toEqual(before.counts);
    expect(await balances(held.id), "no balance moved").toEqual(before.bal);
    expect(await cache(held.id), "the held amount is NOT lowered a second time, nor reset to 150").toEqual(before.heldCache);
    expect(await cache(noteDoc.id)).toEqual(before.noteCache);

    // (c) the same act's KEY with different content: another amount, another entry — refused, nothing changes.
    for (const [what, attempt] of [
      ["the note restated with another amount", () => retryNote({ vat: 14 })],
      ["the note restated inside another entry", () => retryNote({ entryId: heldEntry })],
      ["the recognition restated inside another entry", () => retryRecognition({ entryId: noteEntry })],
    ] as const) {
      const words = await expectRefusal(attempt(), 409, "input_vat_idempotency_conflict");
      expect(words, what).toMatch(/different|already/);
    }
    expect(await counts()).toEqual(before.counts);
    expect(await balances(held.id)).toEqual(before.bal);
    expect(await cache(held.id)).toEqual(before.heldCache);

    // The CLAIM: first, an exact retry, a conflicting one.
    await claimEvidence(held.id, "2026-06-20");
    const vatev = (await entryId(orgA, "VATEV-P13B3-H-IDEMP"))!;
    const afterClaim = { counts: await counts(), bal: await balances(held.id), cache: await cache(held.id) };
    const retryClaim = (on: string, entry: number | null, amount = 135) => inTenant(async () =>
      inputVatLedgerService.recordClaim({ bill: await row(held.id), amount, claimedOn: on, entryId: entry, verdict: null, userId }));
    await retryClaim("2026-06-20", vatev);
    expect({ counts: await counts(), bal: await balances(held.id), cache: await cache(held.id) }).toEqual(afterClaim);
    await expectRefusal(retryClaim("2026-06-21", vatev), 409, "input_vat_idempotency_conflict");
    await expectRefusal(retryClaim("2026-06-20", vatev, 134), 409, "input_vat_idempotency_conflict");
    expect({ counts: await counts(), bal: await balances(held.id), cache: await cache(held.id) }).toEqual(afterClaim);
  });

  it("🔴 IN THE DATABASE: ON CONFLICT DO NOTHING swallows only an IDENTICAL restatement — a different act under the same key is refused by name; MUTATION: without the comparison it is silently swallowed", async () => {
    const c = await claimedBill("P13B3-C-IDEMDB", "2026-06-01");
    const cEntry = (await entryId(orgA, "BILL-P13B3-C-IDEMDB"))!;
    const key = `recognised_claimed:${c.id}`;
    const restate = (cl: PoolClient, amount: number) => cl.query(
      `INSERT INTO input_vat_events (organization_id, company_id, document_id, event_type, from_bucket, to_bucket, amount, occurred_on, posting_date,
                                     journal_entry_id, journal_role, provenance, actor_system, reason, idempotency_key)
       VALUES ($1, $2, $3, 'recognised_claimed', 'NONE', 'CLAIMED', $4, '2026-06-01', '2026-06-01', $5, 'own_entry', 'recorded', 'test:13b3', 'a retry', $6)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING RETURNING id`, [orgA, coA, c.id, amount, cEntry, key]);
    expect((await probe((cl) => restate(cl, 150))).rowCount, "an identical restatement (another actor, another reason) records nothing").toBe(0);
    const conflict = await dbRefusal(probe((cl) => restate(cl, 149)));
    expect(conflict.constraint).toBe("input_vat_event_idempotency_conflict");
    const swallowed = await probe(async (cl) => {
      // The ONE definition of "the same act" (0109 §3b), made to say yes to anything.
      await cl.query(`CREATE OR REPLACE FUNCTION input_vat_event_restates(prev input_vat_events, candidate input_vat_events) RETURNS boolean LANGUAGE sql AS 'SELECT true'`);
      return (await restate(cl, 149)).rowCount;
    });
    expect(swallowed, "with the comparison removed the different act would have been swallowed silently").toBe(0);
    expect(await events(c.id)).toEqual([["recognised_claimed", "NONE", "CLAIMED", "150.00", "BILL-P13B3-C-IDEMDB", null]]);
  });

  it("🔴 ONE WRITER: no production file but the writer inserts an event or writes the input-VAT cache columns (planted positives prove the detector sees them)", () => {
    const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const WRITER = join("services", "accounting", "inputVatLedger.service.ts");
    const REPOSITORY = join("repositories", "bills.repository.ts"); // claimNotesFollowing — the query the writer calls
    const eventInsert = /insert\(\s*inputVatEventsTable\b|INSERT\s+INTO\s+"?input_vat_events"?/i;
    // An object-literal key (drizzle .set / .update), or an SQL assignment after SET — not a comparison in a WHERE.
    const cacheWrite = /\binputVat(State|Pending|ClaimedOn|ClaimEntryId)\s*:|\bSET\b[^;`]*?\binput_vat_(state|pending|claimed_on|claim_entry_id)\s*=/i;
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== "tests") walk(p); continue; }
        if (!/\.tsx?$/.test(name)) continue;
        const rel = p.slice(src.length + 1);
        const text = readFileSync(p, "utf8")
          // audit payloads describe the columns, they do not write them
          .replace(/(before|after):\s*\{[^}]*\}/g, "");
        if (eventInsert.test(text) && rel !== WRITER) hits.push(`${rel}: inserts an event`);
        if (cacheWrite.test(text) && rel !== WRITER && rel !== REPOSITORY) hits.push(`${rel}: writes the cache`);
      }
    };
    walk(src);
    expect(eventInsert.test("db.insert(inputVatEventsTable).values(x)")).toBe(true);
    expect(cacheWrite.test(`billsRepository.update(id, { inputVatState: "claimed" })`)).toBe(true);
    expect(cacheWrite.test(`UPDATE bills SET input_vat_pending = 0`)).toBe(true);
    expect(hits, "the writer is the only writer").toEqual([]);
  });
});
