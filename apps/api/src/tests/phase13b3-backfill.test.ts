/**
 * PHASE 13B-3 — THE 13B-4 BACKFILL AND ITS RECONCILIATION GATE, pulled forward (owner, Option A, 2026-09-29).
 * Records: docs/product/phase-13b-vat-claim-ledger-architecture.md §15, §26; migration 0109 §6–§10.
 *
 * THE METHOD: every document shape the product can post today is written by
 * the PRODUCT, so the live writer records its events. Those recorded events
 * are captured, then deleted (triggers off — the state every document was in
 * before 0109), and the SAME function the migration runs
 * (`input_vat_backfill_gate`, scoped to this suite's organisation)
 * reconstructs them. The proof is an EQUALITY: for every document, the
 * reconstructed events equal the recorded ones — type, buckets, amount,
 * related document, cause, entry, dates, tenant, and the balances after each —
 * with only the provenance fields differing, and those set as R3 requires.
 *
 * Then: re-running writes nothing; a planted disagreement (a cache, a GL line,
 * a column that contradicts the entry) STOPS the gate naming the document and
 * both readings; and the reconstructed ledger carries on — held VAT can still
 * be claimed, claimed stays claimed, blocked stays blocked, credit notes
 * reduce, D-4a and O-2 hold, and the VAT return's input VAT per month equals
 * the events' claimed movements (the return reconciliation 0109 cannot run in
 * SQL — the return is computed in TypeScript — so it is proven here).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { reportsService } from "../services/reports.service";
import { assetsService } from "../services/assets.service";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { supplierAdvanceInvoicesService } from "../services/accounting/supplierAdvanceInvoices.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase13b3-backfill] no real DATABASE_URL — skipping.");

type PgError = { code?: string; constraint?: string; message: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PoolClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; release: () => void };
type Doc = { id: number; billNumber: string };

describeMaybe("Phase 13B-3 — the reconstructed backfill and its reconciliation gate", () => {
  const SLUG_A = "p13b3-backfill-a", SLUG_B = "p13b3-backfill-b";
  const EMAIL = "p13b3-backfill@test.local";
  const MIGRATION = "13b3-test";
  let orgA = "", coA = "", coA2 = "", orgB = "", coB = "", userId = 0;
  let vendorA = 0, vendorA2 = 0, vendorB = 0, bankA = 0, purchasesA = 0, mealsA = 0;
  const d: Record<string, Doc> = {};
  /** Every document of org A, in id order — the set the backfill must reconstruct exactly. */
  let docsA: number[] = [];
  let recorded: Map<number, unknown[]> = new Map();

  const inTenant = async <T,>(fn: () => Promise<T>, org = orgA, co = coA): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const probe = async <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = (await pool.connect()) as unknown as PoolClient;
    try { await c.query("BEGIN"); return await fn(c); } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  };
  /** Triggers OFF, committed — how a test reaches the state before 0109 (or plants a divergence). */
  const replica = async (fn: (c: PoolClient) => Promise<unknown>) => {
    const c = (await pool.connect()) as unknown as PoolClient;
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica");
      await fn(c);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK").catch(() => undefined); throw err; } finally { c.release(); }
  };
  const dbRefusal = async (p: Promise<unknown>): Promise<PgError> => {
    let err: PgError | undefined;
    try { await p; } catch (e) { err = e as PgError; }
    expect(err, "expected the database to refuse").toBeTruthy();
    return err!;
  };
  const expectRefusal = async (p: Promise<unknown>, status: number, code: string) => {
    let err: { statusCode?: number; payload?: { code?: string }; message?: string } | undefined;
    try { await p; } catch (e) { err = e as typeof err; }
    expect([err?.statusCode, err?.payload?.code], err?.message).toEqual([status, code]);
  };

  const ORGS = `(SELECT id FROM organizations WHERE slug IN ('${SLUG_A}','${SLUG_B}'))`;
  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      for (const t of ["input_vat_events", "input_vat_balances", "bill_prepayments", "supplier_refunds", "supplier_payment_allocation_reversals",
                       "supplier_payment_allocations", "supplier_payment_classifications", "supplier_payments", "asset_events", "asset_depreciation_schedule",
                       "fixed_assets", "asset_categories", "captured_documents", "bill_payments", "bill_items", "bills", "cash_line_bank_attributions",
                       "journal_entry_lines", "journal_entries", "period_locks", "audit_logs", "organization_memberships", "vendors", "bank_accounts",
                       "categories", "companies"]) {
        await c.query(`DELETE FROM ${t} WHERE organization_id IN ${ORGS}`);
      }
      await c.query(`DELETE FROM organizations WHERE slug IN ('${SLUG_A}','${SLUG_B}')`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };

  /** The accounting content of a document's events — everything but provenance, actor, key, reason, time and snapshot. */
  const content = async (docId: number) =>
    (await pool.query(
      `SELECT event_type, from_bucket, to_bucket, amount::text, related_document_id, cause_type, cause_id, journal_entry_id, journal_role,
              occurred_on, posting_date, organization_id::text, company_id::text, trigger_month, follows_event_id, buckets_after
         FROM input_vat_events WHERE document_id = $1 ORDER BY id`, [docId])).rows;
  const eventRows = async (docId: number) => (await pool.query(`SELECT * FROM input_vat_events WHERE document_id = $1 ORDER BY id`, [docId])).rows;
  const balances = async (docId: number) =>
    (await pool.query(`SELECT held::text, claimed::text, blocked::text FROM input_vat_balances WHERE document_id = $1`, [docId])).rows[0] ?? null;
  const problems = async (org = orgA) => (await pool.query(`SELECT document_id, problem FROM input_vat_reconciliation($1)`, [org])).rows as Array<{ document_id: number; problem: string }>;
  const gate = (org = orgA) => pool.query(`SELECT input_vat_backfill_gate($1, $2) AS written`, [MIGRATION, org]).then((r) => Number(r.rows[0].written));
  const countEvents = async (org = orgA) => Number((await pool.query(`SELECT count(*) FROM input_vat_events WHERE organization_id = $1`, [org])).rows[0].count);
  const deleteEvents = (org = orgA) => replica(async (c) => {
    await c.query(`DELETE FROM input_vat_events WHERE organization_id = $1`, [org]);
    await c.query(`DELETE FROM input_vat_balances WHERE organization_id = $1`, [org]);
  });
  const entryOf = async (number: string, org = orgA) =>
    (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [org, number])).rows[0]?.id as number;

  const create = (body: Record<string, unknown>, org = orgA, co = coA) =>
    inTenant(() => billsService.create({ vendorId: vendorA, vendorReference: `SUP-${String(body.billNumber ?? "x")}`, items: [], ...body }, userId), org, co) as Promise<Doc>;
  const approve = (id: number, org = orgA, co = coA) => inTenant(() => billsService.approve(id, {}, userId), org, co) as Promise<Doc>;
  const post = async (body: Record<string, unknown>, org = orgA, co = coA): Promise<Doc> => {
    const b = await create(body, org, co);
    await approve(b.id, org, co);
    return { id: b.id, billNumber: b.billNumber };
  };
  const bill = (n: string, date: string, opts: { vat?: number; evidenced?: boolean; account?: number } = {}) => {
    const vat = opts.vat ?? 150;
    const net = vat > 0 ? vat / 0.15 : 500; // a zero-VAT bill still records a supply
    return post({ billNumber: n, date, subtotal: net, vatAmount: vat, total: net + vat, expenseAccountId: opts.account ?? purchasesA, ...(opts.evidenced === false ? {} : { supplierDocumentKind: "tax_invoice" }) });
  };
  const note = (original: number, n: string, date: string, vat: number, type = "credit_note") =>
    post({ documentType: type, creditNoteAgainstBillId: original, billNumber: n, date, subtotal: vat / 0.15, vatAmount: vat, total: vat / 0.15 + vat, ...(type === "debit_note" ? { supplierDocumentKind: "tax_invoice", expenseAccountId: purchasesA } : {}) });
  const claim = (id: number, date: string) => inTenant(() => billsService.attachEvidence(id, { supplierDocumentKind: "tax_invoice", evidenceDate: date }, userId));
  const advance = async (amount: number, paidAt: string, date: string, ref: string) => {
    const p = await inTenant(() => supplierPaymentsService.create({ vendorId: vendorA, bankAccountId: bankA, amount, paidAt, classification: "advance" }, userId)) as { id: number };
    const draft = await inTenant(() => supplierAdvanceInvoicesService.createFromPayment(p.id, { amount, date, vendorReference: ref }, userId));
    return approve(draft.id);
  };

  beforeAll(async () => {
    const { seedPermissions } = await import("@workspace/db");
    await seedPermissions();
    await cleanup();
    orgA = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P13B3 Backfill A', '${SLUG_A}') RETURNING id`)).rows[0].id;
    coA = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start) VALUES ($1, 'P13B3 BF A1', 1) RETURNING id`, [orgA])).rows[0].id;
    coA2 = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1, 'P13B3 BF A2') RETURNING id`, [orgA])).rows[0].id;
    orgB = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P13B3 Backfill B', '${SLUG_B}') RETURNING id`)).rows[0].id;
    coB = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1, 'P13B3 BF B1') RETURNING id`, [orgB])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}', 'P', ' ', 'admin', true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1, $2, 'admin', 'active'), ($1, $3, 'admin', 'active')`, [userId, orgA, orgB]);
    vendorA = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1, 'Riyadh Stationers', '399999999999993') RETURNING id`, [orgA])).rows[0].id;
    vendorA2 = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1, 'Dammam Supplies', '311111111111113') RETURNING id`, [orgA])).rows[0].id;
    vendorB = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1, 'Jeddah Supplies', '311111111111113') RETURNING id`, [orgB])).rows[0].id;
    bankA = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1, $2, 'P13B3 BF Bank', 'SNB') RETURNING id`, [orgA, coA])).rows[0].id;
    purchasesA = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'PURCHASES'`, [orgA])).rows[0].id;
    mealsA = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'FOOD_MEALS' AND input_vat_blocked`, [orgA])).rows[0].id;

    // ── Every shape the product posts today (the pre-0109 population) ──
    // Z-AP1: an advance and the final bill deducting it; a second advance and its credit note.
    d.ADV = await advance(1_150, "2026-03-01", "2026-03-02", "BF-ADV-1");
    d.FIN = await post({ billNumber: "BF-FIN", date: "2026-03-20", supplierDocumentKind: "tax_invoice", items: [{ description: "Supply", quantity: 1, unitPrice: 2_000, vatRate: 15 }], prepayments: [{ advanceBillId: d.ADV.id }] });
    d.ADV2 = await advance(2_300, "2026-03-03", "2026-03-04", "BF-ADV-2");
    const advCn = await inTenant(() => supplierAdvanceInvoicesService.createCreditNote(d.ADV2.id, { amount: 1_150, date: "2026-03-25", vendorReference: "BF-ADV-CN" }, userId));
    d.ADVCN = await approve(advCn.id);
    // Claimed; a credit note; a debit note (claims on its own, O-3).
    d.C = await bill("BF-C", "2026-04-01");
    d.CN = await note(d.C.id, "BF-CN", "2026-04-10", 15);
    d.DNC = await note(d.C.id, "BF-DNC", "2026-04-12", 15, "debit_note");
    // Blocked (Art. 50); a credit note; a debit note (D-4a — blocked on its own).
    d.B = await bill("BF-B", "2026-04-02", { account: mealsA });
    d.BN = await note(d.B.id, "BF-BN", "2026-04-11", 15);
    d.DNB = await note(d.B.id, "BF-DNB", "2026-04-13", 15, "debit_note");
    // Held → held note → claimed → a note after the claim.
    d.HC = await bill("BF-HC", "2026-04-03", { evidenced: false });
    d.HCN1 = await note(d.HC.id, "BF-HCN1", "2026-04-15", 15);
    await claim(d.HC.id, "2026-05-10");
    d.HCN2 = await note(d.HC.id, "BF-HCN2", "2026-05-20", 15);
    // Still held, with a held note.
    d.H = await bill("BF-H", "2026-04-04", { evidenced: false });
    d.HN = await note(d.H.id, "BF-HN", "2026-04-16", 30);
    // O-6: a note consumes all held VAT; the claim writes no event.
    d.O6 = await bill("BF-O6", "2026-04-05", { evidenced: false });
    d.O6N = await note(d.O6.id, "BF-O6N", "2026-04-17", 150);
    await claim(d.O6.id, "2026-05-11");
    // Nothing to recognise.
    d.Z = await bill("BF-Z", "2026-04-06", { vat: 0 });
    // A fixed asset at 0 % recovery (Art. 50): its VAT capitalised — blocked.
    const cat = await inTenant(() => assetsService.createCategory({ name: "Vehicles", defaultUsefulLifeMonths: 60, incomeTaxGroup: 2, vatCapitalAssetClass: "movable" }, userId)) as { id: number };
    const van = await inTenant(() => assetsService.create({ name: "Delivery van", categoryId: cat.id, acquisitionDate: "2026-04-07", availableForUseDate: "2026-04-07", cost: 115_000, vatInitialRecoveryPct: 0, vatNonDeductibleReason: "Restricted motor vehicle — VAT IR Art. 50(1)(c)" }, userId)) as { id: number };
    d.CAP = await post({ billNumber: "BF-CAP", date: "2026-04-07", supplierDocumentKind: "tax_invoice", subtotal: 100_000, vatAmount: 15_000, total: 115_000, capitalisesAssetId: van.id, items: [{ description: "Van", quantity: 1, unitPrice: 100_000 }] });
    // An opening (Batch 1C) payable — no VAT, no event, ever.
    d.OPEN = { id: (await pool.query(
      `INSERT INTO bills (organization_id, company_id, vendor_id, bill_number, date, subtotal, vat_amount, total, status, is_opening)
       VALUES ($1, $2, $3, 'BF-OPEN', '2026-01-01', 1150, 0, 1150, 'approved', true) RETURNING id`, [orgA, coA, vendorA])).rows[0].id, billNumber: "BF-OPEN" };
    // The other company, and the other organisation.
    d.C2 = await post({ billNumber: "BF-C2", date: "2026-04-01", subtotal: 1000, vatAmount: 150, total: 1150, supplierDocumentKind: "tax_invoice", vendorId: vendorA2 }, orgA, coA2);
    d.CB = await post({ billNumber: "BF-CB", date: "2026-04-01", subtotal: 1000, vatAmount: 150, total: 1150, supplierDocumentKind: "tax_invoice", vendorId: vendorB }, orgB, coB);

    docsA = (await pool.query(`SELECT id FROM bills WHERE organization_id = $1 ORDER BY id`, [orgA])).rows.map((r) => r.id as number);
    recorded = new Map();
    for (const id of docsA) recorded.set(id, await content(id));
  }, 240_000);
  afterAll(cleanup);

  // ════════════════════════════════════════════════════════════════════════
  it("the population is what the proof needs: every shape recorded LIVE by the writer, and it reconciles", async () => {
    expect((await eventRows(d.HC.id)).every((e) => e.provenance === "recorded")).toBe(true);
    const types = new Set((await pool.query(`SELECT DISTINCT event_type || ':' || from_bucket || '>' || to_bucket AS t FROM input_vat_events WHERE organization_id = $1`, [orgA])).rows.map((r) => r.t));
    expect([...types].sort()).toEqual([
      "advance_deducted:NONE>NONE", "claimed:HELD>CLAIMED",
      "recognised_blocked:NONE>BLOCKED", "recognised_claimed:NONE>CLAIMED", "recognised_held:NONE>HELD",
      "reduced_by_note:BLOCKED>NONE", "reduced_by_note:CLAIMED>NONE", "reduced_by_note:HELD>NONE",
    ]);
    expect(await problems(), "the live writer's ledger reconciles").toEqual([]);
  });

  it("🔴 before the backfill, the gate SEES the absence: with the events gone (the pre-0109 state), every posted VAT document is named, nothing is guessed", async () => {
    await deleteEvents();
    expect(await countEvents()).toBe(0);
    const named = new Set((await problems()).map((p) => p.document_id));
    for (const k of ["C", "B", "HC", "H", "O6", "ADV", "FIN", "ADV2", "DNC", "DNB", "CAP", "C2", "CN", "BN", "HCN1", "HCN2", "HN", "O6N", "ADVCN"]) {
      expect(named.has(d[k]!.id), `${k} is named while it has no events`).toBe(true);
    }
    expect(named.has(d.Z.id), "a zero-VAT bill needs no event").toBe(false);
    expect(named.has(d.OPEN.id), "an opening payable needs no event").toBe(false);
  });

  it("🔴 THE RECONSTRUCTION IS EXACT: for every document, the reconstructed events equal what the live writer recorded — type, buckets, amount, related document, cause, entry, dates, tenant, balances after", async () => {
    const t0 = new Date();
    const written = await gate();
    expect(written).toBe([...recorded.values()].reduce((s, list) => s + list.length, 0));
    for (const id of docsA) {
      expect(await content(id), `document ${id}`).toEqual(recorded.get(id));
    }
    expect(await problems()).toEqual([]);
    // Provenance (R3), on every reconstructed row.
    const rows = (await pool.query(`SELECT * FROM input_vat_events WHERE organization_id = $1 ORDER BY id`, [orgA])).rows;
    expect(rows).toHaveLength(written);
    for (const e of rows) {
      expect(e).toMatchObject({
        provenance: "reconstructed", backfill_migration: MIGRATION, actor_system: `migration:${MIGRATION}`, actor_user_id: null,
        reason: "reconstructed at Phase 13B introduction",
      });
      expect(e.backfill_source.length, "names what it read").toBeGreaterThan(10);
      expect(e.source_record_ref).toContain(`bills:${e.document_id}`);
      expect(new Date(e.recorded_at).getTime(), "recorded at the backfill, never a historical time").toBeGreaterThanOrEqual(t0.getTime() - 1000);
      const key = e.event_type === "reduced_by_note" ? `backfill:reduced_by_note:${e.related_document_id}`
        : e.event_type === "advance_deducted" ? `backfill:advance_deducted:${e.document_id}:${e.related_document_id}`
        : `backfill:${e.event_type}:${e.document_id}`;
      expect(e.idempotency_key).toBe(key);
      if (e.event_type.startsWith("recognised_") || e.event_type === "claimed") {
        expect(e.evidence_snapshot).toMatchObject({ snapshot_source: "current_at_backfill" });
      }
    }
    // What the reconstruction says, in figures.
    expect(await balances(d.HC.id)).toEqual({ held: "0.00", claimed: "120.00", blocked: "0.00" });
    expect(await balances(d.H.id)).toEqual({ held: "120.00", claimed: "0.00", blocked: "0.00" });
    expect(await balances(d.O6.id)).toEqual({ held: "0.00", claimed: "0.00", blocked: "0.00" });
    expect(await balances(d.B.id)).toEqual({ held: "0.00", claimed: "0.00", blocked: "135.00" });
    expect(await balances(d.CAP.id)).toEqual({ held: "0.00", claimed: "0.00", blocked: "15000.00" });
    expect(await balances(d.ADV2.id)).toEqual({ held: "0.00", claimed: "150.00", blocked: "0.00" });
    expect(await balances(d.Z.id)).toBeNull();
    expect(await eventRows(d.OPEN.id)).toEqual([]);
  });

  it("🔴 TENANT-SAFE: a scoped gate touches only its organisation; each organisation's and each company's reconstructed events carry the document's own tenant", async () => {
    await deleteEvents(orgB);
    expect(await gate(orgA), "org A is complete — nothing to write").toBe(0);
    expect(await countEvents(orgB), "org A's gate wrote nothing for org B").toBe(0);
    expect(await gate(orgB)).toBe(1);
    expect((await eventRows(d.CB.id))[0]).toMatchObject({ organization_id: orgB, company_id: coB, provenance: "reconstructed" });
    expect((await eventRows(d.C2.id))[0]).toMatchObject({ organization_id: orgA, company_id: coA2 });
  });

  it("🔴 IDEMPOTENT: re-running the gate writes nothing and duplicates nothing — a document with events is never touched again", async () => {
    const before = await countEvents();
    expect(await gate()).toBe(0);
    expect(await gate()).toBe(0);
    expect(await countEvents()).toBe(before);
    const dupKeys = (await pool.query(`SELECT idempotency_key FROM input_vat_events WHERE organization_id = $1 GROUP BY 1 HAVING count(*) > 1`, [orgA])).rows;
    expect(dupKeys).toEqual([]);
  });

  it("🔴 FAILS CLOSED — a cache that disagrees: the gate names the document with what its events require and what its columns read, and writes nothing", async () => {
    await replica((c) => c.query(`UPDATE bills SET input_vat_pending = 119 WHERE id = $1`, [d.H.id]));
    try {
      const err = await dbRefusal(gate());
      expect(err.constraint).toBe("input_vat_backfill_gate");
      expect(err.message).toContain(`document ${d.H.id}:`);
      expect(err.message).toMatch(/require state awaiting_evidence, pending 120\.00.*its columns read state awaiting_evidence, pending 119\.00/);
    } finally {
      await replica((c) => c.query(`UPDATE bills SET input_vat_pending = 120 WHERE id = $1`, [d.H.id]));
    }
    expect(await problems()).toEqual([]);
  });

  it("🔴 FAILS CLOSED — a GL that disagrees: a VAT line changed underneath a document is named with both readings (ledger vs entries)", async () => {
    const line = (await pool.query(
      `SELECT l.id FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
        WHERE l.journal_entry_id = $1 AND c.system_code = 'VAT_INPUT'`, [await entryOf("BILL-BF-C")])).rows[0].id;
    await replica((c) => c.query(`UPDATE journal_entry_lines SET debit_amount = 149 WHERE id = $1`, [line]));
    try {
      const err = await dbRefusal(gate());
      expect(err.message).toContain(`document ${d.C.id}:`);
      expect(err.message).toMatch(/the ledger holds held 0\.00 \/ claimed 135\.00.*its GL entries hold held 0\.00 \/ claimed 134\.00/);
    } finally {
      await replica((c) => c.query(`UPDATE journal_entry_lines SET debit_amount = 150 WHERE id = $1`, [line]));
    }
    expect(await problems()).toEqual([]);
  });

  it("🔴 FAILS CLOSED — the backfill STOPS when the columns contradict the entry (never guesses which is right); the whole run is rolled back", async () => {
    await deleteEvents();
    // B's entry carries no VAT line (blocked); its column is made to say "claimed".
    await replica((c) => c.query(`UPDATE bills SET input_vat_state = 'claimed', input_vat_claimed_on = date WHERE id = $1`, [d.B.id]));
    try {
      const err = await dbRefusal(gate());
      expect(err.constraint).toBe("input_vat_backfill_gate");
      expect(err.message).toMatch(/BF-B \(id \d+\): its entry BILL-BF-B reads recognised_blocked .* but its columns read state claimed/);
      expect(await countEvents(), "nothing was written — the run is one transaction").toBe(0);
    } finally {
      await replica((c) => c.query(`UPDATE bills SET input_vat_state = 'not_deductible', input_vat_claimed_on = NULL WHERE id = $1`, [d.B.id]));
    }
    // A pre-existing over-credit (D-1) or a note dated before its original (D-6) STOPS it too, by name.
    await replica((c) => c.query(`UPDATE bills SET date = '2026-03-31' WHERE id = $1`, [d.CN.id])); // the day before C
    try {
      const err = await dbRefusal(gate());
      expect(err.message).toMatch(/credit note BF-CN .* is dated 2026-03-31, before BF-C .* \(D-6\)/);
    } finally {
      await replica((c) => c.query(`UPDATE bills SET date = '2026-04-10' WHERE id = $1`, [d.CN.id]));
    }
    // Clean again: the reconstruction is complete and exact once more.
    expect(await gate()).toBeGreaterThan(0);
    for (const id of docsA) expect(await content(id), `document ${id}`).toEqual(recorded.get(id));
    expect(await problems()).toEqual([]);
  });

  it("🔴 the own_entry link at COMMIT: a recognition naming another document's BILL- entry is refused (input_vat_event_journal_link)", async () => {
    const err = await dbRefusal(probe(async (c) => {
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`DELETE FROM input_vat_events WHERE document_id = $1`, [d.C2.id]);
      await c.query(`DELETE FROM input_vat_balances WHERE document_id = $1`, [d.C2.id]);
      await c.query("SET LOCAL session_replication_role = origin");
      const otherCompanyEntry = await entryOf("BILL-BF-C"); // right amount, WRONG document (and company)
      await c.query(
        `INSERT INTO input_vat_events (organization_id, company_id, document_id, event_type, from_bucket, to_bucket, amount, occurred_on, posting_date,
                                       journal_entry_id, journal_role, provenance, actor_system, idempotency_key)
         VALUES ($1, $2, $3, 'recognised_claimed', 'NONE', 'CLAIMED', 150, '2026-04-01', '2026-04-01', $4, 'own_entry', 'recorded', 'test:13b3', 'p13b3-own')`,
        [orgA, coA2, d.C2.id, otherCompanyEntry]);
      await c.query("SET CONSTRAINTS input_vat_events_journal_link IMMEDIATE");
    }));
    expect(["input_vat_event_journal_link", "input_vat_event_tenant"]).toContain(err.constraint);
    // Same company, another document's entry → the link rule itself.
    const sameCompany = await dbRefusal(probe(async (c) => {
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`DELETE FROM input_vat_events WHERE document_id = $1`, [d.C.id]);
      await c.query(`DELETE FROM input_vat_balances WHERE document_id = $1`, [d.C.id]);
      await c.query("SET LOCAL session_replication_role = origin");
      await c.query(
        `INSERT INTO input_vat_events (organization_id, company_id, document_id, event_type, from_bucket, to_bucket, amount, occurred_on, posting_date,
                                       journal_entry_id, journal_role, provenance, actor_system, idempotency_key)
         VALUES ($1, $2, $3, 'recognised_claimed', 'NONE', 'CLAIMED', 150, '2026-04-01', '2026-04-01', $4, 'own_entry', 'recorded', 'test:13b3', 'p13b3-own2')`,
        [orgA, coA, d.C.id, await entryOf("BILL-BF-DNC")]);
      await c.query("SET CONSTRAINTS input_vat_events_journal_link IMMEDIATE");
    }));
    expect(sameCompany.constraint).toBe("input_vat_event_journal_link");
  });

  // ════════════════════════════════════════════════════════════════════════
  // After the backfill, the ledger CARRIES ON — through the live writer.
  // ════════════════════════════════════════════════════════════════════════
  it("🔴 a HELD reconstructed document can still be claimed: the claim is the whole remaining held VAT, recorded live on top of the reconstructed history", async () => {
    await claim(d.H.id, "2026-06-01");
    const rows = await eventRows(d.H.id);
    expect(rows.map((e) => [e.event_type, e.amount, e.provenance])).toEqual([
      ["recognised_held", "150.00", "reconstructed"], ["reduced_by_note", "30.00", "reconstructed"], ["claimed", "120.00", "recorded"],
    ]);
    expect(await balances(d.H.id)).toEqual({ held: "0.00", claimed: "120.00", blocked: "0.00" });
    expect(await problems()).toEqual([]);
  });

  it("🔴 CLAIMED stays claimed and BLOCKED stays blocked: new credit notes reduce the right bucket; a blocked document cannot be claimed; a new debit note on it is still blocked (D-4a)", async () => {
    const cn = await note(d.C.id, "BF-CN-AFTER", "2026-06-02", 15);
    expect((await eventRows(d.C.id)).at(-1)).toMatchObject({ event_type: "reduced_by_note", from_bucket: "CLAIMED", amount: "15.00", related_document_id: cn.id, provenance: "recorded" });
    const bn = await note(d.B.id, "BF-BN-AFTER", "2026-06-02", 15);
    expect((await eventRows(d.B.id)).at(-1)).toMatchObject({ event_type: "reduced_by_note", from_bucket: "BLOCKED", amount: "15.00", related_document_id: bn.id });
    let blockedClaim: { statusCode?: number } | undefined;
    try { await claim(d.B.id, "2026-06-03"); } catch (e) { blockedClaim = e as typeof blockedClaim; }
    expect(blockedClaim?.statusCode, "blocked VAT is never claimed").toBe(409);
    const dn = await note(d.B.id, "BF-DNB-AFTER", "2026-06-04", 15, "debit_note");
    expect(await eventRows(dn.id).then((r) => r.map((e) => e.event_type))).toEqual(["recognised_blocked"]);
    expect(await balances(d.C.id)).toEqual({ held: "0.00", claimed: "120.00", blocked: "0.00" });
    expect(await balances(d.B.id)).toEqual({ held: "0.00", claimed: "0.00", blocked: "120.00" });
    expect(await problems()).toEqual([]);
  });

  it("🔴 O-2 holds on reconstructed history: an over-credit is refused by name; CN-7 on the final bill is allocation-undecided", async () => {
    const vatNote = (original: number, n: string, vat: number) =>
      create({ documentType: "credit_note", creditNoteAgainstBillId: original, billNumber: n, date: "2026-06-05", subtotal: 10, vatAmount: vat, total: 10 + vat });
    await expectRefusal(approve((await vatNote(d.C.id, "BF-CN-OVER", 121)).id), 422, "credit_note_exceeds_invoice_vat");
    // FIN charged 300; the advance carries 150 of it; FIN's own claimed is 150.
    await expectRefusal(approve((await vatNote(d.FIN.id, "BF-CN-CN7", 200)).id), 422, "input_vat_note_allocation_undecided");
    expect(await problems()).toEqual([]);
  });

  it("🔴 THE RETURN RECONCILES: for each month, the VAT return's recoverable input VAT equals the events' net movement into CLAIMED posted that month (company A1)", async () => {
    for (const month of ["2026-03", "2026-04", "2026-05", "2026-06"]) {
      // vatReturn takes MONTHS (YYYY-MM) and appends -01 / -31 itself.
      const ret = await inTenant(() => reportsService.vatReturn(month, month));
      const box = Number(ret.purchasesSection.box13_recoverableInputVat);
      const ev = Number((await pool.query(
        `SELECT coalesce(sum(CASE WHEN to_bucket = 'CLAIMED' THEN amount ELSE 0 END) - sum(CASE WHEN from_bucket = 'CLAIMED' THEN amount ELSE 0 END), 0)::text v
           FROM input_vat_events WHERE company_id = $1 AND posting_date LIKE $2`, [coA, `${month}-%`])).rows[0].v);
      expect(box, `${month}: return ${box} vs events ${ev}`).toBeCloseTo(ev, 2);
    }
  });
});
