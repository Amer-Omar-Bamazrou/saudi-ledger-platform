/**
 * D-4a — A DEBIT NOTE ON AN ART. 50-BLOCKED SUPPLY CANNOT CLAIM INPUT VAT (owner, 2026-09-29).
 * Record: docs/product/phase-13b2-credit-note-event-design.md §19.9.
 *
 * The defect: a debit note's VAT treatment was decided from the NOTE's own
 * expense account, ignoring its original. A debit note on an ordinary account,
 * against a bill whose VAT was blocked under IR Art. 50, therefore CLAIMED VAT
 * the regulation blocks (Dr VAT_INPUT, and on the return).
 *
 * The rule (AUTH + one short inference, §19.9): Art. 50 attaches to the
 * expenditure (IR 50(1)); a debit note references that same supply (IR 54(4));
 * 40(6) grants no deduction. So the debit note's VAT is blocked — part of the
 * cost, never VAT_INPUT, never the return. D-4b (a 0 %-recovery CAPITALISED
 * original) is deferred to G1 and deliberately not decided here.
 *
 * On product-written rows: the original and the debit note are created and
 * approved through `billsService`; the ledger's acceptance of the future
 * `recognised_blocked` event is proven against the note's real entry.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { reportsService } from "../services/reports.service";
import { evaluateVatEvidence, type VatEvidenceInput } from "../services/purchaseEvidence/vatEvidence";

type PgError = { code?: string; constraint?: string; message: string };
/** The owner pool's client, structurally (the API package does not depend on `pg`'s types). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PoolClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; release: () => void };

// ══════════════════════════════════════════════════════════════════════════
// A. The verdict — pure
// ══════════════════════════════════════════════════════════════════════════
describe("D-4a — the verdict (pure)", () => {
  const base: VatEvidenceInput = {
    documentType: "debit_note", subtotal: 100, vatAmount: 15, total: 115, vatToClaim: 15,
    supplierDocumentKind: "tax_invoice", supplier: { vatNumber: "399999999999993" }, supplierInvoiceNumber: "DN-1",
    date: "2026-05-20", capitalisesVat: false, blockedExpenseAccount: null, capture: null,
  };

  it("🔴 a debit note whose original is Art. 50-blocked is NOT deductible — whatever its own account and evidence", () => {
    const v = evaluateVatEvidence({ ...base, art50BlockedOriginal: { billNumber: "B-1" } });
    expect(v.status).toBe("not_deductible");
    expect(v.flags.map((f) => f.code)).toEqual(["art50_blocked_original"]);
  });

  it("🔴 without a blocked original the debit note is judged on its own, as before (planted positive)", () => {
    expect(evaluateVatEvidence({ ...base }).status).toBe("evidenced");
    expect(evaluateVatEvidence({ ...base, art50BlockedOriginal: null }).status).toBe("evidenced");
  });

  it("🔴 the rule is the DEBIT note's only — a bill carrying the same input is unaffected", () => {
    expect(evaluateVatEvidence({ ...base, documentType: "bill", art50BlockedOriginal: { billNumber: "B-1" } }).status).toBe("evidenced");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B. On real rows
// ══════════════════════════════════════════════════════════════════════════
const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[d4a-debit-note-art50-blocked] no real DATABASE_URL — skipping the real-row block.");

describeMaybe("D-4a — a debit note on an Art. 50-blocked supply, on real rows", () => {
  const SLUG = "d4a-debit-note";
  const EMAIL = "d4a-debit-note@test.local";
  let orgId = "", companyId = "", userId = 0, vendorId = 0, mealsId = 0, purchasesId = 0;
  let blockedOrig = { id: 0, billNumber: "" }, claimedOrig = { id: 0, billNumber: "" };
  let blockedDn = { id: 0, billNumber: "" };

  const inTenant = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const probe = async <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = (await pool.connect()) as unknown as PoolClient;
    try { await c.query("BEGIN"); return await fn(c); } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  };
  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      for (const t of ["input_vat_events", "input_vat_balances", "captured_documents", "bill_payments", "bill_items", "bills",
                       "journal_entry_lines", "journal_entries", "audit_logs", "organization_memberships", "vendors", "categories", "companies"]) {
        await c.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await c.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };
  const gl = async (code: string) => Number((await pool.query(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [orgId, code])).rows[0].v);
  const inputVat = async (month: string) => {
    // vatReturn takes MONTHS (YYYY-MM) and appends -01 / -31 itself — full dates would give "YYYY-MM-01-01",
    // which silently drops a document dated on the 1st (found by the 13B-3 return reconciliation).
    return Number((await inTenant(() => reportsService.vatReturn(month, month))).purchasesSection.box13_recoverableInputVat);
  };
  const entryLines = async (entryNumber: string) =>
    (await pool.query(
      `SELECT coalesce(c.system_code, c.name) AS acct, l.debit_amount::text d, l.credit_amount::text c FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND e.entry_number = $2 ORDER BY l.id`, [orgId, entryNumber])).rows.map((r) => [r.acct, r.d, r.c]);
  const stateOf = async (id: number) =>
    (await pool.query(`SELECT status, input_vat_state, vat_evidence_status, vat_evidence_flags FROM bills WHERE id = $1`, [id])).rows[0];
  const post = async (body: Record<string, unknown>) => {
    const b = await inTenant(() => billsService.create({ vendorId, vendorReference: `SUP-${body.billNumber}`, supplierDocumentKind: "tax_invoice", items: [], ...body }, userId)) as { id: number; billNumber: string };
    await inTenant(() => billsService.approve(b.id, {}, userId));
    return { id: b.id, billNumber: b.billNumber };
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('D4a Debit Notes', '${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1, 'D4a Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}', 'P', ' ', 'admin', true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1, $2, 'admin', 'active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1, 'Riyadh Caterers', '399999999999993') RETURNING id`, [orgId])).rows[0].id;
    mealsId = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'FOOD_MEALS' AND input_vat_blocked`, [orgId])).rows[0].id;
    purchasesId = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'PURCHASES' AND NOT input_vat_blocked`, [orgId])).rows[0].id;

    blockedOrig = await post({ billNumber: "D4A-ORIG-BLOCKED", date: "2026-05-10", subtotal: 1000, vatAmount: 150, total: 1150, expenseAccountId: mealsId });
    claimedOrig = await post({ billNumber: "D4A-ORIG-CLAIMED", date: "2026-05-10", subtotal: 1000, vatAmount: 150, total: 1150, expenseAccountId: purchasesId });
  }, 120_000);
  afterAll(cleanup);

  it("the originals are what the test needs: one Art. 50-blocked (FOOD_MEALS), one claimed (PURCHASES)", async () => {
    expect((await stateOf(blockedOrig.id)).input_vat_state).toBe("not_deductible");
    expect((await stateOf(claimedOrig.id)).input_vat_state).toBe("claimed");
  });

  it("🔴 the draft debit note — on an ORDINARY account — is judged not deductible from its blocked original, and the verdict is persisted", async () => {
    const dn = await inTenant(() => billsService.create({
      documentType: "debit_note", creditNoteAgainstBillId: blockedOrig.id, billNumber: "D4A-DN-BLOCKED", vendorId, vendorReference: "SUP-DN-1",
      supplierDocumentKind: "tax_invoice", date: "2026-05-20", subtotal: 100, vatAmount: 15, total: 115, items: [], expenseAccountId: purchasesId,
    }, userId)) as { id: number; billNumber: string };
    blockedDn = { id: dn.id, billNumber: dn.billNumber };
    const s = await stateOf(dn.id);
    expect(s.status).toBe("draft");
    expect(s.vat_evidence_status).toBe("not_deductible");
    expect((s.vat_evidence_flags as Array<{ code: string }>).map((f) => f.code)).toEqual(["art50_blocked_original"]);
  });

  it("🔴 approved, it CANNOT claim: no VAT_INPUT line, the VAT is cost (Dr expense net + VAT / Cr AP), VAT_INPUT and the return unmoved", async () => {
    const before = { vatInput: await gl("VAT_INPUT"), ap: await gl("AP"), may: await inputVat("2026-05") };
    await inTenant(() => billsService.approve(blockedDn.id, {}, userId));
    const s = await stateOf(blockedDn.id);
    expect(s.input_vat_state, "the debit note's VAT is blocked").toBe("not_deductible");
    const lines = await entryLines(`BILL-${blockedDn.billNumber}`);
    expect(lines.map((l) => l[0]), "never VAT_INPUT").not.toContain("VAT_INPUT");
    expect(lines, "Dr the expense for net + VAT, Cr AP for the total — the X5 blocked posting").toEqual([
      ["PURCHASES", "115.00", "0.00"],
      ["AP", "0.00", "115.00"],
    ]);
    expect(await gl("VAT_INPUT") - before.vatInput, "no input VAT claimed").toBeCloseTo(0, 2);
    expect(await gl("AP") - before.ap, "the supplier is owed the whole debit note").toBeCloseTo(-115, 2);
    expect(await inputVat("2026-05") - before.may, "the VAT return's input VAT is unmoved").toBeCloseTo(0, 2);
  });

  it("🔴 control: a debit note on a CLAIMED original still claims its VAT (unchanged behaviour — the fix is scoped to blocked originals)", async () => {
    const before = { vatInput: await gl("VAT_INPUT"), may: await inputVat("2026-05") };
    const dn = await post({
      documentType: "debit_note", creditNoteAgainstBillId: claimedOrig.id, billNumber: "D4A-DN-CLAIMED",
      date: "2026-05-21", subtotal: 100, vatAmount: 15, total: 115, expenseAccountId: purchasesId,
    });
    expect((await stateOf(dn.id)).input_vat_state).toBe("claimed");
    expect((await entryLines(`BILL-${dn.billNumber}`)).map((l) => l[0])).toContain("VAT_INPUT");
    expect(await gl("VAT_INPUT") - before.vatInput).toBeCloseTo(15, 2);
    expect(await inputVat("2026-05") - before.may).toBeCloseTo(15, 2);
  });

  it("🔴 the approval RECORDED recognised_blocked on the debit note itself (13B-3, O-3) — and the ledger refuses recognised_claimed from that entry (checked at commit, then rolled back)", async () => {
    const entryId = (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [orgId, `BILL-${blockedDn.billNumber}`])).rows[0].id as number;
    expect((await pool.query(
      `SELECT event_type, from_bucket, to_bucket, amount::text, journal_entry_id, provenance FROM input_vat_events WHERE document_id = $1`, [blockedDn.id])).rows)
      .toEqual([{ event_type: "recognised_blocked", from_bucket: "NONE", to_bucket: "BLOCKED", amount: "15.00", journal_entry_id: entryId, provenance: "recorded" }]);
    let claimedErr: PgError | undefined;
    await probe(async (c) => {
      // Take the recorded recognition out of the way (triggers off, rolled back) so a CLAIMED one can be tried in its place.
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`DELETE FROM input_vat_events WHERE document_id = $1`, [blockedDn.id]);
      await c.query(`DELETE FROM input_vat_balances WHERE document_id = $1`, [blockedDn.id]);
      await c.query("SET LOCAL session_replication_role = origin");
      try {
        await c.query(
          `INSERT INTO input_vat_events (organization_id, company_id, document_id, event_type, from_bucket, to_bucket, amount, occurred_on, posting_date,
                                         journal_entry_id, journal_role, provenance, actor_system, idempotency_key)
           VALUES ($1, $2, $3, 'recognised_claimed', 'NONE', 'CLAIMED', 15, '2026-05-20', '2026-05-20', $4, 'own_entry', 'recorded', 'test:d4a', 'd4a-claimed')`,
          [orgId, companyId, blockedDn.id, entryId]);
        await c.query("SET CONSTRAINTS input_vat_events_journal_link IMMEDIATE");
      } catch (e) { claimedErr = e as PgError; }
    });
    expect(claimedErr?.constraint, "the entry has no VAT_INPUT line to claim").toBe("input_vat_event_journal_amount");
  });
});
