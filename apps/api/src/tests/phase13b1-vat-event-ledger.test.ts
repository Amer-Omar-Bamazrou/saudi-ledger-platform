/**
 * PHASE 13B-1 — THE INPUT-VAT EVENT LEDGER, FOUNDATION (2026-09-28).
 * Contract: docs/product/phase-13b-vat-claim-ledger-architecture.md §25.
 *
 * What is under test is the DATABASE (migration 0107): 13B-1 ships no
 * production writer, so every event here is written by the test, directly —
 * as the OWNER when the property is an invariant (the triggers bind the owner
 * too), and as the APP ROLE when the property is a grant or tenancy.
 *
 * The documents and their journal entries are the PRODUCT's own rows: bills
 * created and approved through `billsService`, an evidence claim made through
 * `attachEvidence` (CLAUDE.md §3, standing rule 2 — validate from real rows).
 * Only the entries a future writer would post itself (VATADJ-/VATCOR-/VATLAP-,
 * `source = 'input_vat_event'`) are built here, beside their events.
 *
 * Mutation proofs: each database refusal is shown to come from the named
 * trigger/constraint, and — where a trigger is the guard — the same act is
 * shown to SUCCEED with triggers out of the way (`session_replication_role =
 * replica`, inside a rolled-back transaction), so the test goes red if the
 * guard is removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { withinClaimWindow } from "../services/purchaseEvidence/vatEvidence";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase13b1-vat-event-ledger] no real DATABASE_URL — skipping.");

type PgError = { code?: string; constraint?: string; message: string };
/** The owner pool's client, structurally (the API package does not depend on `pg`'s types). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PoolClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; release: () => void };

describeMaybe("Phase 13B-1 — the input-VAT event ledger foundation", () => {
  const SLUG_A = "p13b1-ledger-a", SLUG_B = "p13b1-ledger-b";
  const EMAIL = "p13b1-ledger@test.local";
  let orgA = "", coA = "", coA2 = "", orgB = "", coB = "", userId = 0;
  let vendorA = 0, vendorB = 0;
  /** Product-written documents: C claimed, H/H3 held, H2 held then claimed by evidence, CB claimed in org B. */
  const doc = { C: 0, H: 0, H2: 0, H3: 0, CB: 0 };
  const entry = { C: 0, H: 0, H2: 0, H2claim: 0, H3: 0, CB: 0 };

  const inTenant = async <T,>(fn: () => Promise<T>, org = orgA, co = coA): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };

  /** One owner transaction; deferred (commit-time) checks throw from COMMIT. */
  const tx = async <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) { await c.query("ROLLBACK").catch(() => undefined); throw err; } finally { c.release(); }
  };
  /** One owner transaction that is ALWAYS rolled back — for probes and mutation proofs. */
  const probe = async <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try { await c.query("BEGIN"); return await fn(c); } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  };
  /** The same, as the APP role inside a tenant. */
  const asApp = async <T,>(org: string, co: string, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('app.current_org_id', $1, true)", [org]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [co]);
      return await fn(c);
    } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  };
  const refusal = async (p: Promise<unknown>): Promise<PgError> => {
    let err: PgError | undefined;
    try { await p; } catch (e) { err = e as PgError; }
    expect(err, "expected the database to refuse").toBeTruthy();
    return err!;
  };

  let keySeq = 0;
  type Ev = {
    document_id: number; event_type: string; from_bucket: string; to_bucket: string; amount?: number | null;
    occurred_on: string; posting_date?: string; journal_entry_id?: number | null; journal_role?: string | null;
    trigger_month?: string | null; follows_event_id?: number | null; cause_id?: number | null; related_document_id?: number | null;
    provenance?: string; backfill_migration?: string | null; backfill_source?: string | null; source_record_ref?: string | null;
    actor_user_id?: number | null; actor_system?: string | null; reason?: string | null; idempotency_key?: string;
    organization_id?: string; company_id?: string; buckets_after?: string;
  };
  /** Insert one event (owner by default). Returns the row. */
  const ev = async (c: PoolClient, e: Ev, suffix = "") => {
    const row = {
      organization_id: orgA, company_id: coA, amount: null, posting_date: e.occurred_on, journal_entry_id: null, journal_role: null,
      trigger_month: null, follows_event_id: null, cause_id: null, related_document_id: null, provenance: "recorded",
      backfill_migration: null, backfill_source: null, source_record_ref: null, actor_user_id: null, actor_system: "test:13b1",
      reason: null, idempotency_key: `t13b1-${Date.now()}-${++keySeq}`, ...e,
    };
    const cols = Object.keys(row);
    const { rows } = await c.query(
      `INSERT INTO input_vat_events (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ${suffix} RETURNING *`,
      Object.values(row),
    );
    return rows[0];
  };
  const acct = async (org: string, code: string) =>
    (await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND system_code = $2`, [org, code])).rows[0] as { id: number; name: string };
  /** A posted entry the ledger would post itself — `source = 'input_vat_event'`. */
  const ledgerEntry = async (c: PoolClient, number: string, date: string, lines: Array<[string, number, number]>, opts: { source?: string | null; org?: string; co?: string } = {}) => {
    const org = opts.org ?? orgA, co = opts.co ?? coA;
    const { rows: [je] } = await c.query(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status, source, posted_at)
       VALUES ($1, $2, $3, $4, 'Phase 13B-1 test entry', 'posted', $5, now()) RETURNING id`,
      [org, co, number, date, opts.source === undefined ? "input_vat_event" : opts.source]);
    for (const [code, dr, cr] of lines) {
      const a = await acct(org, code);
      await c.query(
        `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [org, co, je.id, a.id, a.name, dr, cr]);
    }
    return je.id as number;
  };
  const balances = async (docId: number) =>
    (await pool.query(`SELECT held::text, claimed::text, reversed_unpaid::text, blocked::text, corrected_blocked::text, lapsed::text
                         FROM input_vat_balances WHERE document_id = $1`, [docId])).rows[0] ?? null;
  const entryIdOf = async (org: string, number: string) =>
    (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [org, number])).rows[0].id as number;

  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const slug of [SLUG_A, SLUG_B]) {
        const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
        for (const t of ["input_vat_events", "input_vat_balances", "captured_documents", "bill_payments", "bill_items", "bills",
                         "journal_entry_lines", "journal_entries", "audit_logs", "organization_memberships", "vendors", "categories", "companies"]) {
          await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
        }
        await client.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
      }
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };

  const postedBill = async (org: string, co: string, vendorId: number, number: string, evidenced: boolean) => {
    const b = await inTenant(() => billsService.create({
      billNumber: number, vendorId, vendorReference: `SUP-${number}`, date: "2026-05-10", subtotal: 1000, vatAmount: 150, total: 1150, items: [],
      ...(evidenced ? { supplierDocumentKind: "tax_invoice" } : {}),
    }, userId), org, co);
    await inTenant(() => billsService.approve(b.id, {}, userId), org, co);
    return b.id as number;
  };

  beforeAll(async () => {
    await cleanup();
    orgA = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P13B1 Ledger A', '${SLUG_A}') RETURNING id`)).rows[0].id;
    coA = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1, 'P13B1 A1') RETURNING id`, [orgA])).rows[0].id;
    coA2 = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1, 'P13B1 A2') RETURNING id`, [orgA])).rows[0].id;
    orgB = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P13B1 Ledger B', '${SLUG_B}') RETURNING id`)).rows[0].id;
    coB = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1, 'P13B1 B1') RETURNING id`, [orgB])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}', 'P', ' ', 'admin', true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1, $2, 'admin', 'active'), ($1, $3, 'admin', 'active')`, [userId, orgA, orgB]);
    vendorA = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1, 'Riyadh Stationers', '399999999999993') RETURNING id`, [orgA])).rows[0].id;
    vendorB = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1, 'Jeddah Supplies', '311111111111113') RETURNING id`, [orgB])).rows[0].id;

    doc.C = await postedBill(orgA, coA, vendorA, "P13B1-C", true);
    doc.H = await postedBill(orgA, coA, vendorA, "P13B1-H", false);
    doc.H2 = await postedBill(orgA, coA, vendorA, "P13B1-H2", false);
    doc.H3 = await postedBill(orgA, coA, vendorA, "P13B1-H3", false);
    await inTenant(() => billsService.attachEvidence(doc.H2, { supplierDocumentKind: "tax_invoice", evidenceDate: "2026-07-15" }, userId));
    doc.CB = await postedBill(orgB, coB, vendorB, "P13B1-CB", true);
    entry.C = await entryIdOf(orgA, "BILL-P13B1-C");
    entry.H = await entryIdOf(orgA, "BILL-P13B1-H");
    entry.H2 = await entryIdOf(orgA, "BILL-P13B1-H2");
    entry.H2claim = await entryIdOf(orgA, "VATEV-P13B1-H2");
    entry.H3 = await entryIdOf(orgA, "BILL-P13B1-H3");
    entry.CB = await entryIdOf(orgB, "BILL-P13B1-CB");
  }, 120_000);
  afterAll(cleanup);

  // ════════════════════════════════════════════════════════════════════════
  it("🔴 the two adjustment accounts exist for a NEW organisation with the owner-approved strings, verbatim, as protected system assets", async () => {
    const rows = (await pool.query(
      `SELECT system_code, name, name_ar, type, is_system, vat_applicable, liquidity_class FROM categories
        WHERE organization_id = $1 AND system_code IN ('VAT_ADJ_NONPAYMENT', 'VAT_ADJ_BLOCKED') ORDER BY system_code`, [orgA])).rows;
    expect(rows).toEqual([
      { system_code: "VAT_ADJ_BLOCKED", name: "VAT Adjustment – Blocked (Art. 50)", name_ar: "تعديل ضريبة المدخلات – غير قابلة للخصم (المادة 50)", type: "asset", is_system: true, vat_applicable: false, liquidity_class: "current" },
      { system_code: "VAT_ADJ_NONPAYMENT", name: "VAT Adjustment – Non-Payment (Art. 40(10))", name_ar: "تعديل ضريبة المدخلات – عدم السداد (المادة 40(10))", type: "asset", is_system: true, vat_applicable: false, liquidity_class: "current" },
    ]);
    // Existing organisations got them from the migration's INSERT … SELECT: none is missing anywhere.
    const missing = (await pool.query(
      `SELECT o.id FROM organizations o
        WHERE (SELECT count(*) FROM categories c WHERE c.organization_id = o.id AND c.system_code IN ('VAT_ADJ_NONPAYMENT', 'VAT_ADJ_BLOCKED')) <> 2`)).rows;
    expect(missing, "every organisation holds both accounts").toEqual([]);
    // Nothing posts to them in 13B-1.
    const posted = (await pool.query(
      `SELECT count(*)::int n FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
        WHERE c.organization_id = $1 AND c.system_code IN ('VAT_ADJ_NONPAYMENT', 'VAT_ADJ_BLOCKED')`, [orgA])).rows[0].n;
    expect(posted).toBe(0);
  });

  it("🔴 the transitions: every triple is stated; the database ADMITS exactly the foundation set — never a credit-note transition, supply_date_changed or correction_withdrawn", async () => {
    const rows = (await pool.query(`SELECT event_type, from_bucket, to_bucket, admitted FROM input_vat_event_transitions ORDER BY 1, 2, 3`)).rows;
    expect(rows).toHaveLength(20);
    const admitted = rows.filter((r) => r.admitted).map((r) => r.event_type).sort();
    expect(admitted).toEqual([
      "advance_deducted", "claimed", "corrected_blocked", "exception_recorded", "exception_withdrawn", "lapsed_expired",
      "lapsed_written_off", "recognised_blocked", "recognised_claimed", "recognised_held", "restored_on_payment", "reversed_unpaid",
    ]);
    const refused = [...new Set(rows.filter((r) => !r.admitted).map((r) => r.event_type))].sort();
    expect(refused).toEqual(["correction_withdrawn", "increased_by_note", "reduced_by_note", "supply_date_changed"]);
  });

  it("🔴 a transition that is NOT admitted is refused by name; one that does not exist is refused by the FK — claiming BLOCKED VAT cannot be said", async () => {
    await tx((c) => ev(c, { document_id: doc.C, event_type: "recognised_claimed", from_bucket: "NONE", to_bucket: "CLAIMED", amount: 150, occurred_on: "2026-05-10", journal_entry_id: entry.C, journal_role: "own_entry" }));
    const note = await refusal(probe((c) => ev(c, { document_id: doc.C, event_type: "reduced_by_note", from_bucket: "CLAIMED", to_bucket: "NONE", amount: 10, occurred_on: "2026-06-01", journal_entry_id: entry.C, journal_role: "own_entry" })));
    expect(note.constraint).toBe("input_vat_event_not_admitted");
    const withdraw = await refusal(probe((c) => ev(c, { document_id: doc.C, event_type: "correction_withdrawn", from_bucket: "CORRECTED_BLOCKED", to_bucket: "CLAIMED", amount: 10, occurred_on: "2026-06-01", journal_entry_id: entry.C, journal_role: "event_entry" })));
    expect(withdraw.constraint).toBe("input_vat_event_not_admitted");
    const invented = await refusal(probe((c) => ev(c, { document_id: doc.C, event_type: "claimed", from_bucket: "BLOCKED", to_bucket: "CLAIMED", amount: 10, occurred_on: "2026-06-01", journal_entry_id: entry.C, journal_role: "claim_entry" })));
    // The admission trigger runs first and refuses an unknown triple by name; the composite FK
    // to the transitions table is the backstop behind it (present in the catalog, validated).
    expect(invented.constraint, invented.message).toBe("input_vat_event_not_admitted");
    const fk = (await pool.query(`SELECT convalidated FROM pg_constraint WHERE conname = 'input_vat_events_transition_fk' AND contype = 'f'`)).rows;
    expect(fk).toEqual([{ convalidated: true }]);
    expect(await balances(doc.C)).toMatchObject({ claimed: "150.00", held: "0.00" });
  });

  it("🔴 buckets never go negative; the trigger — not the caller — states buckets_after; double reversal and over-restoration are unwritable", async () => {
    // C holds CLAIMED 150 (previous test).
    const over = await refusal(tx(async (c) => {
      const je = await ledgerEntry(c, "VATADJ-T-OVER", "2027-05-31", [["PURCHASES", 200, 0], ["VAT_ADJ_NONPAYMENT", 0, 200]]);
      return ev(c, { document_id: doc.C, event_type: "reversed_unpaid", from_bucket: "CLAIMED", to_bucket: "REVERSED_UNPAID", amount: 200, occurred_on: "2027-05-31", trigger_month: "2027-05", journal_entry_id: je, journal_role: "event_entry" });
    }));
    expect(over.constraint).toBe("input_vat_bucket_negative");

    const reversal = await tx(async (c) => {
      const je = await ledgerEntry(c, "VATADJ-T-REV", "2027-05-31", [["PURCHASES", 50, 0], ["VAT_ADJ_NONPAYMENT", 0, 50]]);
      return ev(c, { document_id: doc.C, event_type: "reversed_unpaid", from_bucket: "CLAIMED", to_bucket: "REVERSED_UNPAID", amount: 50, occurred_on: "2027-05-31", trigger_month: "2027-05", journal_entry_id: je, journal_role: "event_entry", buckets_after: JSON.stringify({ claimed: 999 }) });
    });
    expect(reversal.buckets_after, "the caller's buckets_after is overwritten by the trigger").toMatchObject({ claimed: 100, reversed_unpaid: 50 });
    expect(await balances(doc.C)).toMatchObject({ claimed: "100.00", reversed_unpaid: "50.00" });

    const again = await refusal(tx(async (c) => {
      const je = await ledgerEntry(c, "VATADJ-T-REV2", "2027-05-31", [["PURCHASES", 10, 0], ["VAT_ADJ_NONPAYMENT", 0, 10]]);
      return ev(c, { document_id: doc.C, event_type: "reversed_unpaid", from_bucket: "CLAIMED", to_bucket: "REVERSED_UNPAID", amount: 10, occurred_on: "2027-05-31", trigger_month: "2027-05", journal_entry_id: je, journal_role: "event_entry" });
    }));
    expect(again.constraint, "no double reversal for the same trigger month").toBe("input_vat_events_one_reversal_unq");

    const restore = (amount: number, payment: number, number: string) => tx(async (c) => {
      const je = await ledgerEntry(c, number, "2027-08-01", [["VAT_ADJ_NONPAYMENT", amount, 0], ["PURCHASES", 0, amount]]);
      return ev(c, { document_id: doc.C, event_type: "restored_on_payment", from_bucket: "REVERSED_UNPAID", to_bucket: "CLAIMED", amount, occurred_on: "2027-07-20", posting_date: "2027-08-01", follows_event_id: reversal.id, cause_id: payment, journal_entry_id: je, journal_role: "event_entry" });
    });
    await restore(30, 9001, "VATADJ-T-RES1"); // a 40(11) restoration may post later than the payment
    const tooMuch = await refusal(restore(30, 9002, "VATADJ-T-RES2"));
    expect(tooMuch.constraint, "restoration beyond the reversed VAT").toBe("input_vat_bucket_negative");
    const unsourced = await refusal(tx(async (c) => {
      const je = await ledgerEntry(c, "VATADJ-T-RES3", "2027-08-01", [["VAT_ADJ_NONPAYMENT", 5, 0], ["PURCHASES", 0, 5]]);
      return ev(c, { document_id: doc.C, event_type: "restored_on_payment", from_bucket: "REVERSED_UNPAID", to_bucket: "CLAIMED", amount: 5, occurred_on: "2027-08-01", cause_id: 9003, journal_entry_id: je, journal_role: "event_entry" });
    }));
    expect(unsourced.constraint, "a restoration must follow a reversal").toBe("input_vat_event_shape");
    expect(await balances(doc.C)).toMatchObject({ claimed: "130.00", reversed_unpaid: "20.00" });
  });

  it("🔴 no partial claim, no double claim; the claim references the product's own evidence entry (VATEV-) and releases the holding account", async () => {
    await tx((c) => ev(c, { document_id: doc.H2, event_type: "recognised_held", from_bucket: "NONE", to_bucket: "HELD", amount: 150, occurred_on: "2026-05-10", journal_entry_id: entry.H2, journal_role: "own_entry" }));
    const partial = await refusal(probe((c) => ev(c, { document_id: doc.H2, event_type: "claimed", from_bucket: "HELD", to_bucket: "CLAIMED", amount: 100, occurred_on: "2026-07-15", journal_entry_id: entry.H2claim, journal_role: "claim_entry" })));
    expect(partial.constraint).toBe("input_vat_event_partial_claim");
    const claimKey = `t13b1-claim-h2-${Date.now()}`;
    const claim = { document_id: doc.H2, event_type: "claimed", from_bucket: "HELD", to_bucket: "CLAIMED", amount: 150, occurred_on: "2026-07-15", journal_entry_id: entry.H2claim, journal_role: "claim_entry", idempotency_key: claimKey };
    await tx((c) => ev(c, claim));
    expect(await balances(doc.H2)).toMatchObject({ held: "0.00", claimed: "150.00" });
    // 🔴 An idempotent RETRY of the whole-held claim — judged against the balance the first attempt
    // already moved, it would read as a partial claim. It is recognised as a retry instead:
    // swallowed by ON CONFLICT DO NOTHING, refused as a duplicate key by a plain INSERT.
    const retried = await tx((c) => ev(c, claim, "ON CONFLICT (organization_id, idempotency_key) DO NOTHING"));
    expect(retried, "the retry inserted nothing and raised nothing").toBeUndefined();
    const plainRetry = await refusal(probe((c) => ev(c, claim)));
    expect(plainRetry.constraint, "a plain retry is a duplicate key — not a partial claim").toBe("input_vat_events_idempotency_unq");
    expect(await balances(doc.H2), "the retry moved nothing").toMatchObject({ held: "0.00", claimed: "150.00" });
    const twice = await refusal(probe((c) => ev(c, { document_id: doc.H2, event_type: "claimed", from_bucket: "HELD", to_bucket: "CLAIMED", amount: 150, occurred_on: "2026-07-15", journal_entry_id: entry.H2claim, journal_role: "claim_entry" })));
    expect(["input_vat_events_one_claim_unq", "input_vat_bucket_negative", "input_vat_event_partial_claim", "input_vat_events_own_journal_unq"]).toContain(twice.constraint);
  });

  it("🔴 dates: no event before its document; the claim window (mirrored against withinClaimWindow); a lapse posts ONLY on its real date (A-7 / G2)", async () => {
    await tx((c) => ev(c, { document_id: doc.H, event_type: "recognised_held", from_bucket: "NONE", to_bucket: "HELD", amount: 150, occurred_on: "2026-05-10", journal_entry_id: entry.H, journal_role: "own_entry" }));
    const before = await refusal(probe((c) => ev(c, { document_id: doc.H, event_type: "exception_recorded", from_bucket: "NONE", to_bucket: "NONE", occurred_on: "2026-05-09" })));
    expect(before.constraint).toBe("input_vat_event_dates");

    // The window: the trigger's admission agrees with the application's one definition, at the boundary.
    for (const [claimDate, inside] of [["2031-12-31", true], ["2032-01-01", false]] as const) {
      expect(withinClaimWindow("2026-05-10", claimDate)).toBe(inside);
      // Admission only (the probe rolls back before the commit-time linkage check runs).
      const outcome = await probe(async (c) => {
        try { await ev(c, { document_id: doc.H, event_type: "claimed", from_bucket: "HELD", to_bucket: "CLAIMED", amount: 150, occurred_on: claimDate, journal_entry_id: entry.H3, journal_role: "claim_entry" }); return null; }
        catch (e) { return (e as PgError).constraint ?? (e as PgError).message; }
      });
      expect(outcome, `${claimDate}: the trigger and withinClaimWindow must agree`).toBe(inside ? null : "input_vat_event_window");
    }

    const moved = await refusal(tx(async (c) => {
      const je = await ledgerEntry(c, "VATLAP-T-MOVE", "2032-02-01", [["PURCHASES", 150, 0], ["VAT_AWAITING_EVIDENCE", 0, 150]]);
      return ev(c, { document_id: doc.H, event_type: "lapsed_expired", from_bucket: "HELD", to_bucket: "LAPSED", amount: 150, occurred_on: "2031-12-31", posting_date: "2032-02-01", journal_entry_id: je, journal_role: "event_entry" });
    }));
    expect(moved.constraint, "a lapse is never posted on the first open date").toBe("input_vat_event_dates");
    const wrongExpiry = await refusal(tx(async (c) => {
      const je = await ledgerEntry(c, "VATLAP-T-WRONG", "2030-12-31", [["PURCHASES", 150, 0], ["VAT_AWAITING_EVIDENCE", 0, 150]]);
      return ev(c, { document_id: doc.H, event_type: "lapsed_expired", from_bucket: "HELD", to_bucket: "LAPSED", amount: 150, occurred_on: "2030-12-31", journal_entry_id: je, journal_role: "event_entry" });
    }));
    expect(wrongExpiry.constraint, "an expiry is the window end, 31/12 of year + 5").toBe("input_vat_event_window");
    expect(await balances(doc.H)).toMatchObject({ held: "150.00", lapsed: "0.00" });
  });

  it("🔴 provenance: a RECONSTRUCTED event must name its migration, source and record, under a migration: system actor; a RECORDED one may carry none of them", async () => {
    const base = { document_id: doc.H, event_type: "exception_recorded", from_bucket: "NONE", to_bucket: "NONE", occurred_on: "2026-06-01" };
    const bare = await refusal(probe((c) => ev(c, { ...base, provenance: "reconstructed", actor_system: "migration:0999" })));
    expect(bare.constraint).toBe("input_vat_events_provenance_chk");
    const byPerson = await refusal(probe((c) => ev(c, { ...base, provenance: "reconstructed", backfill_migration: "0999", backfill_source: "bills.input_vat_state", source_record_ref: `bills:${doc.H}`, actor_system: null, actor_user_id: userId, reason: "x" })));
    expect(["input_vat_events_provenance_chk", "input_vat_events_actor_chk"]).toContain(byPerson.constraint);
    const recordedWithBackfill = await refusal(probe((c) => ev(c, { ...base, provenance: "recorded", backfill_migration: "0999" })));
    expect(recordedWithBackfill.constraint).toBe("input_vat_events_provenance_chk");
    const personNoReason = await refusal(probe((c) => ev(c, { ...base, actor_system: null, actor_user_id: userId })));
    expect(personNoReason.constraint).toBe("input_vat_events_actor_chk");
    const ok = await probe((c) => ev(c, { ...base, provenance: "reconstructed", backfill_migration: "0999", backfill_source: "bills.input_vat_state", source_record_ref: `bills:${doc.H}`, actor_system: "migration:0999" }));
    expect(ok.provenance).toBe("reconstructed");
  });

  it("🔴 idempotency: a retried key is refused; ON CONFLICT DO NOTHING moves no balance; a RACE of two claims on one document leaves exactly one", async () => {
    const key = `t13b1-idem-${Date.now()}`;
    await tx((c) => ev(c, { document_id: doc.H3, event_type: "recognised_held", from_bucket: "NONE", to_bucket: "HELD", amount: 150, occurred_on: "2026-05-10", journal_entry_id: entry.H3, journal_role: "own_entry", idempotency_key: key }));
    const dup = await refusal(probe((c) => ev(c, { document_id: doc.H3, event_type: "exception_recorded", from_bucket: "NONE", to_bucket: "NONE", occurred_on: "2026-06-01", idempotency_key: key })));
    expect(dup.constraint).toBe("input_vat_events_idempotency_unq");

    // A skipped duplicate (the 13B-3 writer's retry shape) must not move a bucket.
    const lapseKey = `t13b1-lapse-${Date.now()}`;
    await tx(async (c) => {
      const je = await ledgerEntry(c, "VATLAP-T-WO1", "2026-12-31", [["PURCHASES", 40, 0], ["VAT_AWAITING_EVIDENCE", 0, 40]]);
      return ev(c, { document_id: doc.H3, event_type: "lapsed_written_off", from_bucket: "HELD", to_bucket: "LAPSED", amount: 40, occurred_on: "2026-12-31", journal_entry_id: je, journal_role: "event_entry", reason: "supplier dissolved", idempotency_key: lapseKey });
    });
    const skipped = await tx(async (c) => {
      const je = (await c.query(`SELECT journal_entry_id FROM input_vat_events WHERE idempotency_key = $1`, [lapseKey])).rows[0].journal_entry_id;
      return ev(c, { document_id: doc.H3, event_type: "lapsed_written_off", from_bucket: "HELD", to_bucket: "LAPSED", amount: 40, occurred_on: "2026-12-31", journal_entry_id: je, journal_role: "event_entry", idempotency_key: lapseKey }, "ON CONFLICT (organization_id, idempotency_key) DO NOTHING");
    });
    expect(skipped, "the retry inserted nothing").toBeUndefined();
    expect(await balances(doc.H3)).toMatchObject({ held: "110.00", lapsed: "40.00" });

    // The race: two transactions, each with its own valid entry, both lapse the SAME remaining 110.
    // The balance-row lock serialises them; the second then finds HELD empty.
    const raceOk = (n: number) => tx(async (c) => {
      const je = await ledgerEntry(c, `VATLAP-T-RACEOK${n}`, "2031-12-31", [["PURCHASES", 110, 0], ["VAT_AWAITING_EVIDENCE", 0, 110]]);
      return ev(c, { document_id: doc.H3, event_type: "lapsed_expired", from_bucket: "HELD", to_bucket: "LAPSED", amount: 110, occurred_on: "2031-12-31", journal_entry_id: je, journal_role: "event_entry" });
    }).then(() => "ok", (e: PgError) => e.constraint ?? e.message);
    const both = await Promise.all([raceOk(1), raceOk(2)]);
    expect(both.filter((o) => o === "ok"), `exactly one winner: ${JSON.stringify(both)}`).toHaveLength(1);
    expect(await balances(doc.H3)).toMatchObject({ held: "0.00", lapsed: "150.00" });
  });

  it("🔴 journal linkage, at COMMIT: the role's entry and nothing else, its amount, never an opening entry; an input_vat_event entry must be referenced; M1b refuses a correction crediting VAT_INPUT", async () => {
    // C is claimed 130 at this point.
    const wrongEntry = await refusal(tx((c) => ev(c, { document_id: doc.H, event_type: "exception_recorded", from_bucket: "NONE", to_bucket: "NONE", occurred_on: "2026-06-01", journal_entry_id: entry.C, journal_role: "own_entry" })));
    expect(wrongEntry.constraint, "an annotation carries no journal role").toBe("input_vat_event_journal_role");
    const otherDocsEntry = await refusal(tx((c) => ev(c, { document_id: doc.C, event_type: "advance_deducted", from_bucket: "NONE", to_bucket: "NONE", amount: 10, related_document_id: doc.H, occurred_on: "2026-05-10", journal_entry_id: entry.H, journal_role: "own_entry" })));
    expect(otherDocsEntry.constraint, "own_entry must be THIS document's BILL-").toBe("input_vat_event_journal_link");
    const wrongAmount = await refusal(tx(async (c) => {
      const je = await ledgerEntry(c, "VATCOR-T-AMT", "2027-09-01", [["PURCHASES", 20, 0], ["VAT_ADJ_BLOCKED", 0, 20]]);
      return ev(c, { document_id: doc.C, event_type: "corrected_blocked", from_bucket: "CLAIMED", to_bucket: "CORRECTED_BLOCKED", amount: 25, occurred_on: "2027-09-01", journal_entry_id: je, journal_role: "event_entry", reason: "Art. 50", actor_system: "test:13b1" });
    }));
    expect(wrongAmount.constraint).toBe("input_vat_event_journal_amount");
    const m1b = await refusal(tx(async (c) => {
      const je = await ledgerEntry(c, "VATCOR-T-M1B", "2027-09-01", [["PURCHASES", 20, 0], ["VAT_ADJ_BLOCKED", 0, 20], ["VAT_INPUT", 0, 20], ["PURCHASES", 20, 0]]);
      return ev(c, { document_id: doc.C, event_type: "corrected_blocked", from_bucket: "CLAIMED", to_bucket: "CORRECTED_BLOCKED", amount: 20, occurred_on: "2027-09-01", journal_entry_id: je, journal_role: "event_entry" });
    }));
    expect(m1b.constraint, "M1b: an Art. 50 correction never credits Input VAT Receivable").toBe("input_vat_event_m1b");
    const dateMismatch = await refusal(tx(async (c) => {
      const je = await ledgerEntry(c, "VATCOR-T-DATE", "2027-09-02", [["PURCHASES", 20, 0], ["VAT_ADJ_BLOCKED", 0, 20]]);
      return ev(c, { document_id: doc.C, event_type: "corrected_blocked", from_bucket: "CLAIMED", to_bucket: "CORRECTED_BLOCKED", amount: 20, occurred_on: "2027-09-01", journal_entry_id: je, journal_role: "event_entry" });
    }));
    expect(dateMismatch.constraint).toBe("input_vat_event_journal_link");
    const opening = await refusal(tx(async (c) => {
      const je = await ledgerEntry(c, "OPEN-T-1", "2027-09-01", [["PURCHASES", 20, 0], ["VAT_ADJ_BLOCKED", 0, 20]], { source: "opening" });
      return ev(c, { document_id: doc.C, event_type: "corrected_blocked", from_bucket: "CLAIMED", to_bucket: "CORRECTED_BLOCKED", amount: 20, occurred_on: "2027-09-01", journal_entry_id: je, journal_role: "event_entry" });
    }));
    expect(opening.constraint, "an opening (Batch 1C) entry is never an event's entry").toBe("input_vat_event_journal_link");
    const orphan = await refusal(tx((c) => ledgerEntry(c, "VATADJ-T-ORPHAN", "2027-09-01", [["PURCHASES", 5, 0], ["VAT_ADJ_NONPAYMENT", 0, 5]])));
    expect(orphan.constraint, "an input_vat_event entry no event references").toBe("journal_entries_input_vat_link");

    // …and the correct correction lands.
    await tx(async (c) => {
      const je = await ledgerEntry(c, "VATCOR-T-OK", "2027-09-01", [["PURCHASES", 20, 0], ["VAT_ADJ_BLOCKED", 0, 20]]);
      return ev(c, { document_id: doc.C, event_type: "corrected_blocked", from_bucket: "CLAIMED", to_bucket: "CORRECTED_BLOCKED", amount: 20, occurred_on: "2027-09-01", journal_entry_id: je, journal_role: "event_entry" });
    });
    expect(await balances(doc.C)).toMatchObject({ claimed: "110.00", reversed_unpaid: "20.00", corrected_blocked: "20.00" });
  });

  it("🔴 ONE event per document per statement (a multi-row insert would admit the second row against a stale balance); other documents in one statement are fine", async () => {
    const before = { h: await balances(doc.H), h2: await balances(doc.H2) };
    const rows = (docs: number[]) => docs.map((d, i) => ({ document_id: d, key: `t13b1-multi-${Date.now()}-${i}` }));
    const insertMany = (c: PoolClient, list: Array<{ document_id: number; key: string }>) => c.query(
      `INSERT INTO input_vat_events (organization_id, company_id, document_id, event_type, from_bucket, to_bucket, occurred_on, posting_date, provenance, actor_system, idempotency_key)
       SELECT $1, $2, d, 'exception_recorded', 'NONE', 'NONE', '2026-06-01', '2026-06-01', 'recorded', 'test:13b1', k
         FROM unnest($3::int[], $4::text[]) AS x(d, k)`,
      [orgA, coA, list.map((r) => r.document_id), list.map((r) => r.key)]);
    const same = await refusal(probe((c) => insertMany(c, rows([doc.H, doc.H]))));
    expect(same.constraint).toBe("input_vat_events_one_per_statement");
    const different = await probe(async (c) => (await insertMany(c, rows([doc.H, doc.H2]))).rowCount);
    expect(different, "two documents in one statement are admitted").toBe(2);
    expect({ h: await balances(doc.H), h2: await balances(doc.H2) }).toEqual(before);
  });

  it("🔴 an entry's input_vat_event source is fixed when written — it cannot be put on, or taken off, afterwards", async () => {
    const onBill = await refusal(probe((c) => c.query(`UPDATE journal_entries SET source = 'input_vat_event' WHERE id = $1`, [entry.C])));
    expect(onBill.constraint).toBe("journal_entries_input_vat_source_frozen");
    const eventEntry = (await pool.query(`SELECT journal_entry_id FROM input_vat_events WHERE document_id = $1 AND journal_role = 'event_entry' ORDER BY id LIMIT 1`, [doc.C])).rows[0].journal_entry_id;
    const offEvent = await refusal(probe((c) => c.query(`UPDATE journal_entries SET source = NULL WHERE id = $1`, [eventEntry])));
    expect(offEvent.constraint).toBe("journal_entries_input_vat_source_frozen");
  });

  it("🔴 events are APPEND-ONLY for every role: the app role holds no UPDATE/DELETE; the OWNER is refused by the trigger — and only the trigger (mutation proof)", async () => {
    const id = (await pool.query(`SELECT id FROM input_vat_events WHERE document_id = $1 ORDER BY id LIMIT 1`, [doc.C])).rows[0].id;
    const appUpdate = await refusal(asApp(orgA, coA, (c) => c.query(`UPDATE input_vat_events SET amount = 1 WHERE id = $1`, [id])));
    expect(appUpdate.code).toBe("42501");
    const appDelete = await refusal(asApp(orgA, coA, (c) => c.query(`DELETE FROM input_vat_events WHERE id = $1`, [id])));
    expect(appDelete.code).toBe("42501");
    const appBalances = await refusal(asApp(orgA, coA, (c) => c.query(`UPDATE input_vat_balances SET claimed = 0 WHERE document_id = $1`, [doc.C])));
    expect(appBalances.code, "balances are written only by the trigger").toBe("42501");

    for (const sqlText of [`UPDATE input_vat_events SET amount = 1 WHERE id = ${id}`, `DELETE FROM input_vat_events WHERE id = ${id}`, `TRUNCATE input_vat_events CASCADE`]) {
      const owner = await refusal(probe((c) => c.query(sqlText)));
      expect(owner.constraint, sqlText).toBe("input_vat_events_append_only");
    }
    // Mutation proof: with triggers out of the way the same UPDATE succeeds — so the refusal above IS the trigger.
    const mutated = await probe(async (c) => {
      await c.query("SET LOCAL session_replication_role = replica");
      return (await c.query(`UPDATE input_vat_events SET amount = 1 WHERE id = $1`, [id])).rowCount;
    });
    expect(mutated).toBe(1);
    expect((await pool.query(`SELECT amount::text FROM input_vat_events WHERE id = $1`, [id])).rows[0].amount, "and it was rolled back").toBe("150.00");
  });

  it("🔴 tenancy (presence, absence, movement): an event on ANOTHER tenant's or ANOTHER company's document is refused; each tenant reads only its own", async () => {
    await tx((c) => ev(c, { document_id: doc.CB, organization_id: orgB, company_id: coB, event_type: "recognised_claimed", from_bucket: "NONE", to_bucket: "CLAIMED", amount: 150, occurred_on: "2026-05-10", journal_entry_id: entry.CB, journal_role: "own_entry" }));

    // As the APP ROLE in org B, naming org A's document: RLS admits the row (it is org B's), the trigger refuses it.
    const cross = await refusal(asApp(orgB, coB, (c) => c.query(
      `INSERT INTO input_vat_events (document_id, event_type, from_bucket, to_bucket, occurred_on, posting_date, provenance, actor_system, idempotency_key)
       VALUES ($1, 'exception_recorded', 'NONE', 'NONE', '2026-06-01', '2026-06-01', 'recorded', 'test:13b1', 'cross-tenant')`, [doc.H])));
    expect(cross.constraint).toBe("input_vat_event_tenant");
    // Same organisation, the OTHER company.
    const crossCompany = await refusal(asApp(orgA, coA2, (c) => c.query(
      `INSERT INTO input_vat_events (document_id, event_type, from_bucket, to_bucket, occurred_on, posting_date, provenance, actor_system, idempotency_key)
       VALUES ($1, 'exception_recorded', 'NONE', 'NONE', '2026-06-01', '2026-06-01', 'recorded', 'test:13b1', 'cross-company')`, [doc.H])));
    expect(crossCompany.constraint).toBe("input_vat_event_tenant");
    // A foreign journal entry, named from inside org A.
    const foreignEntry = await refusal(probe((c) => ev(c, { document_id: doc.C, event_type: "advance_deducted", from_bucket: "NONE", to_bucket: "NONE", amount: 10, related_document_id: doc.H, occurred_on: "2026-05-10", journal_entry_id: entry.CB, journal_role: "own_entry" })));
    expect(foreignEntry.constraint).toBe("input_vat_event_tenant");
    // …and the app role CAN write a valid event in its own tenant (the grant is real).
    const own = await asApp(orgA, coA, (c) => c.query(
      `INSERT INTO input_vat_events (document_id, event_type, from_bucket, to_bucket, occurred_on, posting_date, provenance, actor_system, idempotency_key)
       VALUES ($1, 'exception_recorded', 'NONE', 'NONE', '2026-06-01', '2026-06-01', 'recorded', 'test:13b1', 'own-tenant') RETURNING organization_id::text, company_id::text`, [doc.H]));
    expect(own.rows[0]).toEqual({ organization_id: orgA, company_id: coA });

    const seen = async (org: string, co: string) => asApp(org, co, async (c) => (await c.query(`SELECT DISTINCT document_id FROM input_vat_events ORDER BY 1`)).rows.map((r) => r.document_id));
    const seenA = await seen(orgA, coA), seenB = await seen(orgB, coB), seenA2 = await seen(orgA, coA2);
    expect(seenA, "presence: A reads its own").toEqual(expect.arrayContaining([doc.C, doc.H, doc.H2, doc.H3]));
    expect(seenA, "absence: A never reads B's").not.toContain(doc.CB);
    expect(seenB, "movement: B reads ITS event, so the absence above is not vacuous").toEqual([doc.CB]);
    expect(seenA2, "company scope: A's other company reads none of company A1's").toEqual([]);
    const balB = await asApp(orgB, coB, async (c) => (await c.query(`SELECT document_id FROM input_vat_balances`)).rows.map((r) => r.document_id));
    expect(balB).toEqual([doc.CB]);
  });

  it("🔴 13B-1 ships NO production writer: nothing outside tests inserts into input_vat_events (this assertion EXPIRES in 13B-3 — delete it there)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = resolve(here, "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== "tests") walk(p); continue; }
        if (!/\.tsx?$/.test(name)) continue;
        const text = readFileSync(p, "utf8");
        if (/insert\(\s*inputVatEventsTable\b/.test(text) || /INSERT\s+INTO\s+"?input_vat_events"?/i.test(text)) hits.push(p);
      }
    };
    walk(src);
    // Planted positive: the detector sees a writer when one is written.
    expect(/insert\(\s*inputVatEventsTable\b/.test("db.insert(inputVatEventsTable).values(x)")).toBe(true);
    expect(/INSERT\s+INTO\s+"?input_vat_events"?/i.test(`INSERT INTO input_vat_events (a) VALUES (1)`)).toBe(true);
    expect(hits, "a production writer exists — 13B-1 must have none").toEqual([]);
  });
});
