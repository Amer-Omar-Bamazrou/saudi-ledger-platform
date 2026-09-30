/**
 * PHASE 13B S1 — AN OPENING PAYABLE'S HISTORICAL VAT, AND SINGLE-STATE CREDIT
 * NOTES AGAINST IT (2026-09-30).
 * Records: docs/product/phase-13b-level-policy-implementation-contract.md §1,
 *          §15, §16 (owner decisions D1–D7); decision paper §0, §B, §D, §F,
 *          §G, §M.4; migration 0110.
 *
 * REAL ROWS (CLAUDE.md §3, standing rule 2): the opening payables are written
 * by the product's own migration commit, the declarations by the declaration
 * service, the credit notes by the bills approval, and the VAT return is read
 * back through the reports service. The database is probed directly only
 * where the property IS the database (admission, append-only, completeness at
 * commit), and each such guard carries a mutation proof inside a rolled-back
 * transaction, so the test goes red if the guard is removed.
 *
 * Every accepted S1 credit note resolves to ONE bucket: the FULL note VAT
 * reduces input VAT (deducted history) or NOTHING does (never deducted,
 * Art. 50, fully reversed with nothing restored). Nothing here approximates a
 * multi-state split (S2).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { hashPassword } from "../lib/password";
import { billsService } from "../services/bills.service";
import { migrationService } from "../services/migration.service";
import { migrationStagingService } from "../services/migrationStaging.service";
import { migrationValidationService } from "../services/migrationValidation.service";
import { migrationCommitService } from "../services/migrationCommit.service";
import { migrationCorrectionService } from "../services/migrationCorrection.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { reportsService } from "../services/reports.service";
import { openingVatDeclarationsService, art4010TriggerDate } from "../services/openingVatDeclarations.service";
import { inputVatLedgerService } from "../services/accounting/inputVatLedger.service";
import { inputVatTreatment } from "../services/purchaseEvidence/vatEvidence";
import { __resetRateLimitsForTests } from "../routes/auth";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase13b-s1] no real DATABASE_URL — skipping.");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PoolClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; release: () => void };
type PgError = { code?: string; constraint?: string; message: string };

const SLUG = "s1-opening-vat";
const SLUG_OTHER = "s1-opening-vat-other";
const PW = "S1OpeningVat123!";
const EMAIL = { admin: "s1-admin@test.local", accountant: "s1-accountant@test.local", bookkeeper: "s1-bookkeeper@test.local" };
const CUTOVER = "2026-07-01";

describeMaybe("Phase 13B S1 — opening-payable historical VAT and single-state credit notes (real rows)", () => {
  let orgId = "", coA = "", coB = "", otherOrg = "", otherCo = "";
  let adminId = 0, accountantId = 0, bookkeeperId = 0, userId = 0;
  let expenseAccount = 0;
  let batchA = 0, batchB = 0;
  const item: Record<string, number> = {};
  const bill: Record<string, number> = {};
  let server: http.Server; let base = "";
  const jar: Record<string, string> = {};

  const inTenant = async <T,>(fn: () => Promise<T>, co = coA, uid = userId): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId: uid, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  /** One owner transaction that is ALWAYS rolled back — for probes and mutation proofs. */
  const probe = async <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = (await pool.connect()) as unknown as PoolClient;
    try { await c.query("BEGIN"); return await fn(c); } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
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

  const ORGS = `(SELECT id FROM organizations WHERE slug IN ('${SLUG}','${SLUG_OTHER}'))`;
  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      for (const t of ["input_vat_events", "input_vat_balances", "opening_payable_vat_declaration_evidence", "opening_payable_vat_declarations",
                       "supplier_payment_allocation_reversals", "supplier_payment_allocations", "captured_documents", "bill_payments", "bill_items", "bills",
                       "payments", "migration_advances", "migration_open_items", "migration_parties", "migration_chart_rows", "migration_batches",
                       "cash_line_bank_attributions", "journal_entry_lines", "journal_entries", "period_locks", "audit_logs", "security_audit_logs",
                       "organization_memberships", "vendors", "customers", "bank_accounts", "categories", "companies"]) {
        await c.query(`DELETE FROM ${t} WHERE organization_id IN ${ORGS}`).catch(async (e: Error) => {
          if (!/column "organization_id" does not exist/.test(e.message)) throw e;
        });
      }
      await c.query(`DELETE FROM organizations WHERE slug IN ('${SLUG}','${SLUG_OTHER}')`);
      await c.query(`DELETE FROM users WHERE email IN ('${EMAIL.admin}','${EMAIL.accountant}','${EMAIL.bookkeeper}')`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };

  /** A captured document (a staged upload), as the capture pipeline leaves one. */
  const capture = async (co = coA) =>
    (await pool.query(
      `INSERT INTO captured_documents (organization_id, company_id, status, content_type, byte_size, sha256, source)
       VALUES ($1, $2, 'staged', 'application/pdf', 1024, $3, 'manual') RETURNING id`,
      [orgId, co, randomBytes(32).toString("hex")])).rows[0].id as string;
  const captureRow = async (id: string) => (await pool.query(`SELECT status, bill_id, sha256 FROM captured_documents WHERE id = $1`, [id])).rows[0];

  const declare = (key: string, body: Record<string, unknown>, co = coA, uid = userId) =>
    inTenant(() => openingVatDeclarationsService.declare({ itemId: item[key]!, evidence: [], ...body } as never, uid), co, uid);
  const events = async (docId: number) =>
    (await pool.query(
      `SELECT v.event_type, v.from_bucket, v.to_bucket, v.amount::text AS amount, e.entry_number
         FROM input_vat_events v LEFT JOIN journal_entries e ON e.id = v.journal_entry_id
        WHERE v.document_id = $1 ORDER BY v.id`, [docId])).rows.map((r) => [r.event_type, r.from_bucket, r.to_bucket, r.amount, r.entry_number]);
  const balances = async (docId: number) =>
    (await pool.query(`SELECT claimed::text, blocked::text, reversed_unpaid::text, not_deducted::text FROM input_vat_balances WHERE document_id = $1`, [docId])).rows[0] ?? null;
  const reconcile = async (docId: number) =>
    (await pool.query(`SELECT input_vat_document_mismatch($1) AS doc, input_vat_gl_mismatch($1) AS gl`, [docId])).rows[0];
  /** The note entry's lines on the VAT accounts and on its expense account. */
  const noteLines = async (billNumber: string) =>
    (await pool.query(
      `SELECT c.system_code, l.account_id, l.debit_amount::text AS dr, l.credit_amount::text AS cr
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND e.entry_number = $2 ORDER BY l.id`, [orgId, `BILLCN-${billNumber}`])).rows;
  const inputVatOf = async (month: string) => (await inTenant(() => reportsService.vatReturn(month, month))).purchasesSection.box13_recoverableInputVat;
  const noteDraft = (originalKey: string, n: string, date: string, vat: number, opts: { capture?: string | null; total?: number } = {}) =>
    inTenant(() => billsService.create({
      documentType: "credit_note", creditNoteAgainstBillId: bill[originalKey], billNumber: n, date, vendorReference: `SUP-${n}`,
      subtotal: vat === 0 ? (opts.total ?? 1000) : vat / 0.15, vatAmount: vat, total: opts.total ?? (vat === 0 ? 1000 : vat / 0.15 + vat),
      expenseAccountId: expenseAccount, items: [], ...(opts.capture ? { captureId: opts.capture } : {}),
    }, userId)) as Promise<{ id: number; billNumber: string }>;
  const approve = (id: number) => inTenant(() => billsService.approve(id, {}, userId));
  const note = async (originalKey: string, n: string, date: string, vat: number, opts: { capture?: string | null; total?: number } = {}) => {
    const d = await noteDraft(originalKey, n, date, vat, opts);
    await approve(d.id);
    return d;
  };
  const notePosted = async (id: number) => (await pool.query(`SELECT status FROM bills WHERE id = $1`, [id])).rows[0].status as string;

  async function api(who: keyof typeof EMAIL, method: string, path: string, body?: unknown) {
    const cookie = jar[who] ?? "";
    const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sid = ((res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []).find((c: string) => c.startsWith("ksa_ledger_sid="));
    if (sid) jar[who] = sid.split(";")[0]!;
    let json: unknown; try { json = await res.json(); } catch { json = undefined; }
    return { status: res.status, body: json as Record<string, unknown> };
  }

  /** One migration through the PRODUCT: chart → parties → open items (payables) → validate → commit. */
  async function commitMigration(co: string, bankName: string, rows: Array<Record<string, unknown>>): Promise<number> {
    const bank = (await inTenant(() => bankAccountsService.create({ name: bankName, bankName: "Riyad Bank", currency: "SAR" }), co)).id;
    const total = rows.reduce((s, r) => s + Number(r.outstandingAmount), 0);
    const b = await inTenant(() => migrationService.createBatch({ sourceSystem: "PreviousERP", cutoverDate: CUTOVER }, userId), co);
    await inTenant(() => migrationService.importChart(b.id, { rows: [
      { sourceCode: "1100", sourceName: "Bank", sourceType: "asset", openingDebit: total, sourceRole: "bank", evidenceNote: "statement" },
      { sourceCode: "2100", sourceName: "Creditors", sourceType: "liability", openingCredit: total, sourceRole: "payable" },
    ] }, userId), co);
    const chart = await inTenant(() => migrationService.getChart(b.id), co);
    const row = (code: string) => chart.rows.find((r) => r.sourceCode === code)!;
    await inTenant(() => migrationService.decideChartRow(b.id, row("1100").id, { decision: "map_to_bank", targetBankAccountId: bank }, userId), co);
    await inTenant(() => migrationService.decideChartRow(b.id, row("2100").id, { decision: "map_to_system", targetSystemCode: "AP" }, userId), co);
    await inTenant(() => migrationStagingService.importParties(b.id, { rows: [{ partyType: "vendor", sourceId: "V1", name: "Gamma Supplies" }] }, userId), co);
    await inTenant(() => migrationStagingService.importOpenItems(b.id, { rows: rows as never }, userId), co);
    const v = await inTenant(() => migrationValidationService.validate(b.id, userId), co);
    expect(v.ok, JSON.stringify(v.checks.filter((c) => c.status === "fail"))).toBe(true);
    await inTenant(() => migrationCommitService.commit(b.id, userId), co);
    const staged = await inTenant(() => migrationStagingService.getOpenItems(b.id), co);
    for (const r of staged.rows) { item[r.sourceId] = r.id; bill[r.sourceId] = r.resolvedId!; }
    return b.id;
  }
  const ap = (sourceId: string, issueDate: string, original: number, outstanding: number, historicalVat: Record<string, unknown> | null) =>
    ({ itemType: "ap", sourceId, partySourceId: "V1", documentNumber: `OLD-${sourceId}`, issueDate, dueDate: issueDate, originalAmount: original, outstandingAmount: outstanding, historicalVat });

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    const { seedPermissions } = await import("@workspace/db");
    await seedPermissions();
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('S1 Opening VAT', '${SLUG}', 'approved') RETURNING id`)).rows[0].id;
    coA = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number) VALUES ($1, 'S1 Co A', '1010868391', '310123456789013', 1, '1234', 'King Fahd Road', 'Al Olaya', 'Riyadh', '12345', '6789') RETURNING id`, [orgId])).rows[0].id;
    // A second company, created AFTER A (tenant resolution picks the first), for the whole-batch reversal.
    await new Promise((r) => setTimeout(r, 20));
    coB = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start) VALUES ($1, 'S1 Co B', 1) RETURNING id`, [orgId])).rows[0].id;
    otherOrg = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('S1 Other', '${SLUG_OTHER}', 'approved') RETURNING id`)).rows[0].id;
    otherCo = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1, 'S1 Other Co') RETURNING id`, [otherOrg])).rows[0].id;
    const hash = await hashPassword(PW);
    adminId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1, 'S1 Admin', $2, 'admin', true) RETURNING id`, [EMAIL.admin, hash])).rows[0].id;
    accountantId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1, 'S1 Accountant', $2, 'viewer', true) RETURNING id`, [EMAIL.accountant, hash])).rows[0].id;
    bookkeeperId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1, 'S1 Bookkeeper', $2, 'viewer', true) RETURNING id`, [EMAIL.bookkeeper, hash])).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1, $4, 'admin', 'active'), ($2, $4, 'accountant', 'active'), ($3, $4, 'bookkeeper', 'active')`,
      [adminId, accountantId, bookkeeperId, orgId]);
    userId = adminId;
    expenseAccount = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'PURCHASES'`, [orgId])).rows[0].id;

    batchA = await commitMigration(coA, "S1 Main", [
      ap("DED", "2026-05-01", 11500, 11500, { category: "S", rate: 15, amount: 1500 }),
      ap("ND", "2026-04-10", 11500, 11500, { category: "S" }),
      ap("BLK", "2026-03-15", 2300, 2300, { rate: 15, amount: 300 }),
      ap("REV", "2025-03-10", 11500, 11500, { rate: 15, amount: 1500 }),
      ap("OLD", "2025-02-01", 1150, 1150, { rate: 15, amount: 150 }),
      ap("UND", "2026-05-20", 1150, 1150, { rate: 15, amount: 150 }),
      ap("P5", "2020-05-01", 1050, 1050, { rate: 5, amount: 50 }),
      ap("OVP", "2025-01-15", 11500, 2300, { rate: 15, amount: 1500 }),
      ap("CORR", "2026-05-05", 1150, 1150, { rate: 15, amount: 150 }),
      ap("CORR2", "2026-05-06", 1150, 1150, { rate: 15, amount: 150 }),
      ap("ACC", "2026-05-07", 1150, 1150, { rate: 15, amount: 150 }),
      ap("EVI", "2026-05-08", 1150, 1150, { rate: 15, amount: 150 }),
      ap("MIX", "2026-05-09", 11500, 11500, { rate: 15, amount: 500 }), // a mixed supply: only part of it standard-rated
      ap("BIG", "2026-05-10", 1150, 1150, null),
      ap("RACE", "2026-05-11", 1150, 1150, { rate: 15, amount: 150 }),
    ]);
    batchB = await commitMigration(coB, "S1 B Main", [ap("B1", "2026-05-02", 1150, 1150, { rate: 15, amount: 150 })]);

    const app = (await import("../app")).default;
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    for (const who of Object.keys(EMAIL) as Array<keyof typeof EMAIL>) {
      const r = await api(who, "POST", "/auth/login", { email: EMAIL[who], password: PW });
      expect(r.status, `${who} login`).toBe(200);
    }
  }, 240_000);
  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  // ════════════════════════════════════════════════════════════════════════
  // A / E / I / F — a DEDUCTED history: the note reduces input VAT in FULL.
  // ════════════════════════════════════════════════════════════════════════
  it("🔴 A: DEDUCTED — declaration → ONE declared recognition (CLAIMED, provenance declared, no entry) → the note reduces input VAT by its FULL VAT in its own period (CN-1: before the 40(10) trigger)", async () => {
    const inv = await capture(), ret = await capture();
    const d = await declare("DED", { state: "DEDUCTED", deductedPeriod: "2026-05", evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: inv }, { kind: "DEDUCTION_RETURN", captureId: ret }] });
    expect(d).toMatchObject({ state: "DEDUCTED", historicalVat: 1500, vatRate: 15, deductedPeriod: "2026-05", billId: bill.DED });
    expect(await events(bill.DED!)).toEqual([["declared_opening", "NONE", "CLAIMED", "1500.00", null]]);
    const [ev] = (await pool.query(`SELECT * FROM input_vat_events WHERE document_id = $1`, [bill.DED])).rows;
    expect(ev).toMatchObject({ provenance: "declared", declaration_id: d.id, actor_user_id: adminId, journal_entry_id: null, journal_role: null, idempotency_key: `declared_opening:${d.id}` });
    expect(await balances(bill.DED!)).toMatchObject({ claimed: "1500.00" });
    // the evidence became evidence OF the opening payable — retained through the capture outbox, never purged
    expect(await captureRow(inv)).toMatchObject({ status: "promotion_pending", bill_id: bill.DED });
    expect(await reconcile(bill.DED!)).toEqual({ doc: null, gl: null });
    // the bill itself still carries no VAT (bills_opening_no_vat_chk) — the ceiling is the ledger's
    expect((await pool.query(`SELECT vat_amount::text FROM bills WHERE id = $1`, [bill.DED])).rows[0].vat_amount).toBe("0.00");

    // CN-1 (D1): the note is dated BEFORE the payable's 40(10) trigger — admitted under the settled treatment.
    expect(art4010TriggerDate("2026-05-01")).toBe("2027-05-31");
    const before = await inputVatOf("2026-08");
    const n = await note("DED", "S1-CN-DED", "2026-08-10", 300, { capture: await capture() });
    expect(await events(bill.DED!)).toEqual([["declared_opening", "NONE", "CLAIMED", "1500.00", null], ["reduced_by_note", "CLAIMED", "NONE", "300.00", "BILLCN-S1-CN-DED"]]);
    expect(await balances(bill.DED!)).toMatchObject({ claimed: "1200.00" });
    const vatLines = (await noteLines("S1-CN-DED")).filter((l) => l.system_code === "VAT_INPUT");
    expect(vatLines).toEqual([expect.objectContaining({ dr: "0.00", cr: "300.00" })]);
    expect((await pool.query(`SELECT input_vat_state FROM bills WHERE id = $1`, [n.id])).rows[0].input_vat_state).toBe("claimed");
    // 🔴 the property, not the number: the return moves by EXACTLY the note's VAT, in the note's month
    expect(round2(await inputVatOf("2026-08") - before)).toBe(-300);
    expect(await reconcile(bill.DED!)).toEqual({ doc: null, gl: null });
    expect(await reconcile(n.id)).toEqual({ doc: null, gl: null });
  });

  it("🔴 I: the ceiling is the DECLARED ledger VAT, never the opening bill's own VAT (0) — N(D) ≤ T(D), isolated from the gross ceiling on a mixed supply", async () => {
    // On a fully standard-rated payable the gross ceiling (credit_exceeds_bill) binds at the same moment as
    // the VAT one, so CI-1 is proven on a MIXED supply: gross 11,500, VAT 500.
    await declare("MIX", { state: "DEDUCTED", deductedPeriod: "2026-05", evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: await capture() }, { kind: "DEDUCTION_RETURN", captureId: await capture() }] });
    expect((await pool.query(`SELECT input_vat_document_ceiling($1)::text AS t, vat_amount::text AS own FROM bills WHERE id = $1`, [bill.MIX])).rows[0]).toEqual({ t: "500.00", own: "0.00" });
    const over = await noteDraft("MIX", "S1-CN-OVER", "2026-08-11", 600, { capture: await capture() }); // gross 4,600 — within the bill
    const words = await expectRefusal(approve(over.id), 422, "credit_note_exceeds_invoice_vat");
    expect(words).toMatch(/only 500\.00 of the 500\.00 VAT charged/);
    expect(await notePosted(over.id)).toBe("draft");
    expect(await events(bill.MIX!)).toEqual([["declared_opening", "NONE", "CLAIMED", "500.00", null]]);
    // exactly the ceiling is admitted (N = T), and then nothing more
    await note("MIX", "S1-CN-ALL", "2026-08-11", 500, { capture: await capture() });
    expect(await balances(bill.MIX!)).toMatchObject({ claimed: "0.00" });
    const more = await noteDraft("MIX", "S1-CN-MORE", "2026-08-12", 15, { capture: await capture() });
    await expectRefusal(approve(more.id), 422, "credit_note_exceeds_invoice_vat");
    expect(await reconcile(bill.MIX!)).toEqual({ doc: null, gl: null });
    // on the DED payable (300 already credited) the ledger ceiling still reads 1,500 while the bill says 0
    expect((await pool.query(`SELECT input_vat_document_ceiling($1)::text AS t`, [bill.DED])).rows[0].t).toBe("1500.00");
  });

  it("🔴 F: a VAT-bearing note against an opening payable WITHOUT the supplier's document is refused — nothing posts", async () => {
    const d = await noteDraft("DED", "S1-CN-NOEVI", "2026-08-12", 60);
    const words = await expectRefusal(approve(d.id), 422, "supplier_note_evidence_missing");
    expect(words).toMatch(/attach the supplier's document/);
    expect(await notePosted(d.id)).toBe("draft");
    expect(await balances(bill.DED!)).toMatchObject({ claimed: "1200.00" });
  });

  // ════════════════════════════════════════════════════════════════════════
  // B / J — NEVER DEDUCTED: the note reduces input VAT by 0; the stale cache is ignored.
  // ════════════════════════════════════════════════════════════════════════
  it("🔴 B + J: NOT_DEDUCTED — the note reduces input VAT by 0 and the COST by its gross, although the original's stale cache would have said 'claimed'", async () => {
    const d = await declare("ND", { state: "NOT_DEDUCTED", historicalVat: 1500, vatRate: 15, notDeductedReason: "No valid tax invoice held when the return was filed", carriedInCost: true,
      evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: await capture() }] });
    expect(d).toMatchObject({ state: "NOT_DEDUCTED", carriedInCost: true });
    expect(await events(bill.ND!)).toEqual([["declared_opening", "NONE", "NOT_DEDUCTED", "1500.00", null]]);
    // J: what the 13B-3 derivation from the ORIGINAL's cache would conclude — 'claimed' (an opening bill's cache is empty) …
    const orig = (await pool.query(`SELECT input_vat_state FROM bills WHERE id = $1`, [bill.ND])).rows[0];
    expect(inputVatTreatment({ status: "not_required" }, { state: orig.input_vat_state })).toBe("claimed");
    // … and what the LEDGER decides: nothing deducted, so nothing reduced.
    const before = await inputVatOf("2026-08");
    const n = await note("ND", "S1-CN-ND", "2026-08-13", 300, { capture: await capture() });
    expect(await events(bill.ND!)).toEqual([["declared_opening", "NONE", "NOT_DEDUCTED", "1500.00", null], ["reduced_by_note", "NOT_DEDUCTED", "NONE", "300.00", "BILLCN-S1-CN-ND"]]);
    const lines = await noteLines("S1-CN-ND");
    expect(lines.filter((l) => ["VAT_INPUT", "VAT_AWAITING_EVIDENCE"].includes(l.system_code))).toEqual([]);
    expect(lines.find((l) => l.account_id === expenseAccount)).toMatchObject({ cr: "2300.00" }); // AQ-2: the same cost, gross
    expect((await pool.query(`SELECT input_vat_state FROM bills WHERE id = $1`, [n.id])).rows[0].input_vat_state).toBe("not_deductible");
    expect(round2(await inputVatOf("2026-08") - before)).toBe(0);
    expect(await balances(bill.ND!)).toMatchObject({ not_deducted: "1200.00", claimed: "0.00" });
    expect(await reconcile(bill.ND!)).toEqual({ doc: null, gl: null });
  });

  it("🔴 C: BLOCKED_ART50 — the note reduces input VAT by 0 (the cost carries it); the classification evidence is required", async () => {
    await expectRefusal(declare("BLK", { state: "BLOCKED_ART50", art50Ground: "Entertainment (VAT IR Art. 50(1)(a))", evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: await capture() }] }),
      422, "opening_vat_declaration_evidence_missing");
    await declare("BLK", { state: "BLOCKED_ART50", art50Ground: "Entertainment (VAT IR Art. 50(1)(a))",
      evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: await capture() }, { kind: "CLASSIFICATION", captureId: await capture() }] });
    const before = await inputVatOf("2026-08");
    await note("BLK", "S1-CN-BLK", "2026-08-14", 150, { capture: await capture() });
    expect(await events(bill.BLK!)).toEqual([["declared_opening", "NONE", "BLOCKED", "300.00", null], ["reduced_by_note", "BLOCKED", "NONE", "150.00", "BILLCN-S1-CN-BLK"]]);
    expect((await noteLines("S1-CN-BLK")).filter((l) => l.system_code === "VAT_INPUT")).toEqual([]);
    expect(round2(await inputVatOf("2026-08") - before)).toBe(0);
    expect(await reconcile(bill.BLK!)).toEqual({ doc: null, gl: null });
  });

  it("🔴 D: REVERSED_ART40_10 (fully reversed, nothing restored, carried in COST) — the note reduces input VAT by 0; the location is never assumed (D7)", async () => {
    const ev = async () => [
      { kind: "ORIGINAL_TAX_INVOICE", captureId: await capture() }, { kind: "DEDUCTION_RETURN", captureId: await capture() },
      { kind: "REVERSAL_RETURN", captureId: await capture() }, { kind: "PAYMENT_RECORDS", captureId: await capture() }];
    const base = { state: "REVERSED_ART40_10", deductedPeriod: "2025-03", reversedPeriod: "2026-03" };
    await expectRefusal(declare("REV", { ...base, evidence: await ev() }), 422, "opening_vat_declaration_location_required");
    await expectRefusal(declare("REV", { ...base, reversedVatLocation: "adjustment_account", evidence: await ev() }), 422, "opening_vat_declaration_state_not_enabled");
    await declare("REV", { ...base, reversedVatLocation: "cost", evidence: await ev() });
    const before = await inputVatOf("2026-08");
    await note("REV", "S1-CN-REV", "2026-08-15", 300, { capture: await capture() });
    expect(await events(bill.REV!)).toEqual([["declared_opening", "NONE", "REVERSED_UNPAID", "1500.00", null], ["reduced_by_note", "REVERSED_UNPAID", "NONE", "300.00", "BILLCN-S1-CN-REV"]]);
    expect((await noteLines("S1-CN-REV")).filter((l) => ["VAT_INPUT", "VAT_AWAITING_EVIDENCE"].includes(l.system_code))).toEqual([]);
    expect(round2(await inputVatOf("2026-08") - before)).toBe(0);
    expect(await balances(bill.REV!)).toMatchObject({ reversed_unpaid: "1200.00" });
    expect(await reconcile(bill.REV!)).toEqual({ doc: null, gl: null });
  });

  it("🔴 the overpaid case stays REFUSED (reconciliation B8): a note settling what a fully-reversed payable still owes, while reversed VAT would remain restorable", async () => {
    const ev = async () => [
      { kind: "ORIGINAL_TAX_INVOICE", captureId: await capture() }, { kind: "DEDUCTION_RETURN", captureId: await capture() },
      { kind: "REVERSAL_RETURN", captureId: await capture() }, { kind: "PAYMENT_RECORDS", captureId: await capture() }];
    await declare("OVP", { state: "REVERSED_ART40_10", deductedPeriod: "2025-01", reversedPeriod: "2026-01", reversedVatLocation: "cost", evidence: await ev() });
    const settling = await noteDraft("OVP", "S1-CN-OVP", "2026-08-16", 300, { capture: await capture() }); // gross 2,300 = everything still owed
    await expectRefusal(approve(settling.id), 422, "input_vat_note_overpaid_reversed");
    expect(await notePosted(settling.id)).toBe("draft");
    await note("OVP", "S1-CN-OVP-SMALL", "2026-08-16", 150, { capture: await capture() }); // gross 1,150 — something is still owed
    expect(await balances(bill.OVP!)).toMatchObject({ reversed_unpaid: "1350.00" });
  });

  it("🔴 B8 asks the SAME question of a VAT-0 note (it strands the restorable remainder just the same), and counts an APPLIED note once, not twice", async () => {
    // Still owed: 2,300 less the small note's unapplied 1,150 = 1,150. A VAT-free note for all of it is refused too.
    const zero = await noteDraft("OVP", "S1-CN-OVP-ZERO", "2026-08-17", 0, { capture: await capture(), total: 1150 });
    await expectRefusal(approve(zero.id), 422, "input_vat_note_overpaid_reversed");
    expect(await notePosted(zero.id)).toBe("draft");
    // Apply the small note to the bill: the bill now OWES 1,150 (billPosition nets the application) and the note has
    // nothing unapplied — still owed stays 1,150, so a 115 note is admitted. (Counting the applied note's total again
    // would read 0 owed and refuse it.)
    const small = (await pool.query(`SELECT id FROM bills WHERE organization_id = $1 AND bill_number = 'S1-CN-OVP-SMALL'`, [orgId])).rows[0].id as number;
    const { supplierCreditNotesService } = await import("../services/accounting/supplierCreditNotes.service");
    await inTenant(() => supplierCreditNotesService.apply(small, { allocations: [{ billId: bill.OVP, amount: 1150 }] }, userId));
    await note("OVP", "S1-CN-OVP-AFTER", "2026-08-18", 15, { capture: await capture() });
    expect(await balances(bill.OVP!)).toMatchObject({ reversed_unpaid: "1335.00" });
    expect(await reconcile(bill.OVP!)).toEqual({ doc: null, gl: null });
  });

  // ════════════════════════════════════════════════════════════════════════
  // G / H — VAT 0 is not a bypass.
  // ════════════════════════════════════════════════════════════════════════
  it("🔴 G + H: a VAT-0 note needs the supplier's document AND a declared history; with both it posts, moving no VAT", async () => {
    const noEvidence = await noteDraft("DED", "S1-CN-ZERO-NOEVI", "2026-08-17", 0);
    await expectRefusal(approve(noEvidence.id), 422, "supplier_note_evidence_missing");
    const undeclared = await noteDraft("UND", "S1-CN-ZERO-UND", "2026-08-17", 0, { capture: await capture() });
    const words = await expectRefusal(approve(undeclared.id), 422, "input_vat_note_opening_undeclared");
    expect(words).toMatch(/declares it once, with its evidence/);
    const vatUnd = await noteDraft("UND", "S1-CN-VAT-UND", "2026-08-17", 30, { capture: await capture() });
    await expectRefusal(approve(vatUnd.id), 422, "input_vat_note_opening_undeclared");
    expect(await events(bill.UND!)).toEqual([]);

    const before = await events(bill.DED!);
    const ok = await note("DED", "S1-CN-ZERO-OK", "2026-08-17", 0, { capture: await capture() });
    expect(await notePosted(ok.id)).toBe("received");
    expect(await events(bill.DED!)).toEqual(before); // no event — a VAT-free note moves no VAT
    expect(await reconcile(ok.id)).toEqual({ doc: null, gl: null });
  });

  it("🔴 the database refuses what the service refuses: a posted VAT-0 note against an opening payable without the supplier's document cannot COMMIT (mutation: the precheck removed, it would)", async () => {
    const d = await noteDraft("DED", "S1-CN-DB", "2026-08-18", 0);
    // Skip the service: flip it posted directly, as a buggy path would.
    const err = await dbRefusal(probe(async (c) => {
      await c.query(`UPDATE bills SET status = 'received', input_vat_state = 'not_deductible' WHERE id = $1`, [d.id]);
      await c.query("SET CONSTRAINTS ALL IMMEDIATE");
    }));
    expect(err.message).toMatch(/supplier_note_evidence_missing/);
    // mutation proof: with the precheck neutralised, the same act passes
    await probe(async (c) => {
      await c.query(`CREATE OR REPLACE FUNCTION input_vat_opening_note_precheck(p_document_id integer, p_note_id integer) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$`);
      await c.query(`UPDATE bills SET status = 'received', input_vat_state = 'not_deductible' WHERE id = $1`, [d.id]);
      await c.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
  });

  it("🔴 a SPLIT position is refused by name (S2's LEVEL split is never approximated) — on an opening payable only; unreachable by any S1 path, so planted in a rolled-back probe", async () => {
    const noteId = (await pool.query(`SELECT id FROM bills WHERE organization_id = $1 AND bill_number = 'S1-CN-DED'`, [orgId])).rows[0].id as number;
    const refusalWith = (split: boolean, opening: boolean) => probe(async (c) => {
      await c.query("SET LOCAL session_replication_role = replica");
      if (split) await c.query(`UPDATE input_vat_balances SET claimed = 1000, reversed_unpaid = 200 WHERE document_id = $1`, [bill.DED]);
      // as an ordinary bill would carry it: its own VAT on the document (the ordinary ceiling)
      if (!opening) await c.query(`UPDATE bills SET is_opening = false, subtotal = 10000, vat_amount = 1500 WHERE id = $1`, [bill.DED]);
      return (await c.query(`SELECT refusal FROM input_vat_note_refusal($1, $2, 10)`, [bill.DED, noteId])).rows[0].refusal as string | null;
    });
    expect(await refusalWith(false, true), "the planted positive: one bucket, admitted").toBeNull();
    expect(await refusalWith(true, true)).toBe("input_vat_note_multistate");
    // an ordinary document keeps 13B-3's buckets and refusal exactly: REVERSED_UNPAID is NI-4's, not counted here
    expect(await refusalWith(true, false)).toBeNull();
  });

  it("🔴 a transitional supply (at 5 %) is refused — Q-OP-6 stays unknown", async () => {
    await declare("P5", { state: "NOT_DEDUCTED", notDeductedReason: "Deducted nowhere", carriedInCost: true, evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: await capture() }] });
    const d = await noteDraft("P5", "S1-CN-P5", "2026-08-19", 10, { capture: await capture() });
    await expectRefusal(approve(d.id), 422, "input_vat_note_transitional_supply");
  });

  // ════════════════════════════════════════════════════════════════════════
  // L — the declaration: evidence, facts, staged figures, histories S1 does not act on.
  // ════════════════════════════════════════════════════════════════════════
  it("🔴 L: no sufficient evidence → nothing is declared (UNKNOWN); a staged figure is not contradicted; a later history and a second declaration are refused by name", async () => {
    const inv = await capture();
    await expectRefusal(declare("EVI", { state: "DEDUCTED", deductedPeriod: "2026-05", evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: inv }] }), 422, "opening_vat_declaration_evidence_missing");
    expect(await captureRow(inv)).toMatchObject({ status: "staged", bill_id: null }); // nothing was bound
    expect((await pool.query(`SELECT count(*)::int AS n FROM opening_payable_vat_declarations WHERE migration_open_item_id = $1`, [item.EVI])).rows[0].n).toBe(0);
    await expectRefusal(declare("EVI", { state: "DEDUCTED", deductedPeriod: "2026-05", historicalVat: 999,
      evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: inv }, { kind: "DEDUCTION_RETURN", captureId: await capture() }] }), 422, "opening_vat_declaration_contradicts_staging");
    // one document is one kind of evidence: the same file as the invoice AND the return is refused — by the service …
    const one = await capture();
    await expectRefusal(declare("EVI", { state: "DEDUCTED", deductedPeriod: "2026-05", evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: one }, { kind: "DEDUCTION_RETURN", captureId: one }] }),
      422, "opening_vat_declaration_evidence_reused");
    // … and by the database (a writer that skips the service), with the planted positive: two documents are admitted
    const reuse = (second: string) => probe(async (c) => {
      const sha = (await c.query(`UPDATE captured_documents SET status = 'promotion_pending', bill_id = $2 WHERE id = ANY($1::uuid[]) RETURNING id, sha256`, [[one, second], bill.EVI])).rows;
      const shaOf = (id: string) => sha.find((r) => r.id === id)!.sha256;
      const d = (await c.query(
        `INSERT INTO opening_payable_vat_declarations (organization_id, company_id, migration_open_item_id, bill_id, state, historical_vat, vat_rate, art50_ground, statement, declared_by, declared_on)
         VALUES ($1, $2, $3, $4, 'BLOCKED_ART50', 150, 15, 'g', 's', $5, '2026-09-30') RETURNING id`, [orgId, coA, item.EVI, bill.EVI, adminId])).rows[0].id;
      for (const [kind, cid] of [["ORIGINAL_TAX_INVOICE", one], ["CLASSIFICATION", second]] as const) {
        await c.query(`INSERT INTO opening_payable_vat_declaration_evidence (organization_id, company_id, declaration_id, kind, capture_id, capture_sha256) VALUES ($1, $2, $3, $4, $5, $6)`,
          [orgId, coA, d, kind, cid, shaOf(cid)]);
      }
    });
    expect((await dbRefusal(reuse(one))).constraint).toBe("opening_vat_declaration_evidence_reused");
    await reuse(await capture());
    // unstaged, a figure the document cannot have carried: 1,150 gross at 15 % holds at most 150.00 — and the database agrees
    const big = await expectRefusal(declare("BIG", { state: "NOT_DEDUCTED", historicalVat: 200, vatRate: 15, notDeductedReason: "r", carriedInCost: true,
      evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: await capture() }] }), 422, "opening_vat_declaration_exceeds_document");
    expect(big).toMatch(/at most 150\.00 of VAT, not 200\.00/);
    const bigRow = (vat: number) => (c: PoolClient) => c.query(
      `INSERT INTO opening_payable_vat_declarations (organization_id, company_id, migration_open_item_id, bill_id, state, historical_vat, vat_rate, not_deducted_reason, carried_in_cost, statement, declared_by, declared_on)
       VALUES ($1, $2, $3, $4, 'NOT_DEDUCTED', $6, 15, 'r', true, 's', $5, '2026-09-30')`, [orgId, coA, item.BIG, bill.BIG, adminId, vat]);
    expect((await dbRefusal(probe(bigRow(150.01)))).constraint).toBe("opening_vat_declaration_exceeds_document");
    await probe(bigRow(150)); // the bound itself is admitted
    await expectRefusal(declare("EVI", { state: "PARTIALLY_DEDUCTED", evidence: [] }), 422, "opening_vat_declaration_state_not_enabled");
    await expectRefusal(declare("EVI", { state: "NOT_DEDUCTED", notDeductedReason: "x", carriedInCost: false, evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: inv }] }), 422, "opening_vat_declaration_premise_not_affirmed");
    await expectRefusal(declare("DED", { state: "DEDUCTED", deductedPeriod: "2026-05", evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: await capture() }, { kind: "DEDUCTION_RETURN", captureId: await capture() }] }),
      409, "opening_vat_declaration_exists");
  });

  it("🔴 a DEDUCTED history the Art. 40(10) trigger contradicts (unpaid past it before the cut-over) is not established — refused, and refused by the DATABASE too", async () => {
    expect(art4010TriggerDate("2025-02-01")).toBe("2026-02-28");
    const words = await expectRefusal(declare("OLD", { state: "DEDUCTED", deductedPeriod: "2025-02",
      evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: await capture() }, { kind: "DEDUCTION_RETURN", captureId: await capture() }] }), 422, "opening_vat_declaration_40_10_not_established");
    expect(words).toMatch(/declare the reversal/);
    const err = await dbRefusal(probe((c) => c.query(
      `INSERT INTO opening_payable_vat_declarations (organization_id, company_id, migration_open_item_id, bill_id, state, historical_vat, vat_rate, deducted_period, statement, declared_by, declared_on)
       VALUES ($1, $2, $3, $4, 'DEDUCTED', 150, 15, '2025-02', 's', $5, '2026-09-30')`, [orgId, coA, item.OLD, bill.OLD, adminId])));
    expect(err.constraint).toBe("opening_vat_declaration_40_10_not_established");
  });

  it("🔴 the database requires the evidence at COMMIT (mutation: the completeness trigger disabled, the evidence-less declaration passes)", async () => {
    const insert = async (c: PoolClient) => {
      const d = (await c.query(
        `INSERT INTO opening_payable_vat_declarations (organization_id, company_id, migration_open_item_id, bill_id, state, historical_vat, vat_rate, not_deducted_reason, carried_in_cost, statement, declared_by, declared_on)
         VALUES ($1, $2, $3, $4, 'NOT_DEDUCTED', 150, 15, 'r', true, 's', $5, '2026-09-30') RETURNING id`, [orgId, coA, item.EVI, bill.EVI, adminId])).rows[0].id;
      await c.query(`INSERT INTO input_vat_events (organization_id, company_id, document_id, event_type, from_bucket, to_bucket, amount, occurred_on, posting_date, actor_user_id, reason, provenance, declaration_id, idempotency_key)
                     VALUES ($1, $2, $3, 'declared_opening', 'NONE', 'NOT_DEDUCTED', 150, '2026-09-30', '2026-09-30', $4, 'test', 'declared', $5, $6)`, [orgId, coA, bill.EVI, adminId, d, `declared_opening:${d}`]);
      await c.query("SET CONSTRAINTS ALL IMMEDIATE");
    };
    const err = await dbRefusal(probe(insert));
    expect(err.constraint).toBe("opening_vat_declaration_evidence_missing");
    await probe(async (c) => { await c.query(`ALTER TABLE opening_payable_vat_declarations DISABLE TRIGGER opening_payable_vat_declarations_complete`); await insert(c); });
  });

  // ════════════════════════════════════════════════════════════════════════
  // O — append-only, provenance, idempotency, admission.
  // ════════════════════════════════════════════════════════════════════════
  it("🔴 O: declarations and their evidence are append-only for every role, the owner included; a restated declared recognition records nothing; a different act under its key is refused", async () => {
    const decl = (await pool.query(`SELECT * FROM opening_payable_vat_declarations WHERE migration_open_item_id = $1`, [item.DED])).rows[0];
    for (const sql of [`UPDATE opening_payable_vat_declarations SET historical_vat = 1 WHERE id = ${decl.id}`, `DELETE FROM opening_payable_vat_declarations WHERE id = ${decl.id}`,
                       `DELETE FROM opening_payable_vat_declaration_evidence WHERE declaration_id = ${decl.id}`,
                       // the LEAF table only: nothing references it and no other suite touches it. A TRUNCATE of the
                       // declarations would CASCADE into the shared input_vat_events under an ACCESS EXCLUSIVE lock
                       // and deadlock parallel suites (test-suite-notes: shared state) — its guard is read below.
                       `TRUNCATE opening_payable_vat_declaration_evidence`]) {
      const err = await dbRefusal(probe((c) => c.query(sql)));
      expect(err.constraint ?? err.message).toMatch(/opening_vat_declarations_append_only|append-only/);
    }
    const truncateGuards = (await pool.query(
      `SELECT tgrelid::regclass::text AS t FROM pg_trigger WHERE tgname IN ('opening_payable_vat_declarations_no_truncate', 'opening_payable_vat_declaration_evidence_no_truncate')
          AND NOT tgisinternal AND tgenabled = 'O' AND (tgtype & 32) <> 0 ORDER BY 1`)).rows.map((r) => r.t);
    expect(truncateGuards, "a BEFORE TRUNCATE guard on both tables, enabled").toEqual(["opening_payable_vat_declaration_evidence", "opening_payable_vat_declarations"]);
    // a retry of the same declared act: nothing recorded, nothing moved
    const b = (await pool.query(`SELECT * FROM bills WHERE id = $1`, [bill.DED])).rows[0];
    const recorded = await inTenant(() => inputVatLedgerService.recordDeclaredOpening({
      declaration: { ...decl, historicalVat: decl.historical_vat, declaredOn: decl.declared_on, state: decl.state, id: decl.id } as never,
      bill: { ...b, organizationId: b.organization_id, companyId: b.company_id, billNumber: b.bill_number } as never, userId: adminId }));
    expect(recorded).toBe(false);
    expect((await events(bill.DED!)).filter((e) => e[0] === "declared_opening")).toHaveLength(1);
    // a DIFFERENT act under the same key is refused by name
    const err = await dbRefusal(probe((c) => c.query(
      `INSERT INTO input_vat_events (organization_id, company_id, document_id, event_type, from_bucket, to_bucket, amount, occurred_on, posting_date, actor_user_id, reason, provenance, declaration_id, idempotency_key)
       VALUES ($1, $2, $3, 'declared_opening', 'NONE', 'CLAIMED', 999, $4, $4, $5, 't', 'declared', $6, $7)`, [orgId, coA, bill.DED, decl.declared_on, adminId, decl.id, `declared_opening:${decl.id}`])));
    expect(err.constraint).toBe("input_vat_event_idempotency_conflict");
  });

  it("🔴 CONCURRENT declarations of one payable: exactly one succeeds, the other gets the named 409 — one declaration, one recognition, one movement, nothing stranded", async () => {
    // Deterministic, not lucky: A declares inside a transaction held OPEN; B starts while A is uncommitted, so B's
    // pre-check (findByItem) sees nothing and only the DATABASE can stop it — B blocks on the unique index; A commits;
    // B must come back as the named conflict, never a raw 23505 / 500.
    const capA = await capture(), capB = await capture();
    const body = (cap: string) => ({ itemId: item.RACE!, state: "NOT_DEDUCTED", notDeductedReason: "race", carriedInCost: true, evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: cap }] });
    const connA = await beginTenantConnection({ organizationId: orgId, companyId: coA, role: "authenticated" });
    let aCommitted = false;
    try {
      const a = await connA.run(() => auditContext.run({ userId: adminId, organizationId: orgId, ipAddress: null },
        () => openingVatDeclarationsService.declare(body(capA) as never, adminId)));
      const b = inTenant(() => openingVatDeclarationsService.declare(body(capB) as never, accountantId), coA, accountantId)
        .then((v) => ({ ok: true as const, v }), (e: { statusCode?: number; payload?: { code?: string } }) => ({ ok: false as const, e }));
      // B is really WAITING on A (a lock), not already refused by the pre-check
      let waiting = 0;
      for (let i = 0; i < 100 && waiting === 0; i++) {
        waiting = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%insert into "opening_payable_vat_declarations"%'`)).rows[0].n;
        if (waiting === 0) await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiting, "B is blocked on A's uncommitted declaration").toBe(1);
      await connA.commit();
      aCommitted = true;
      const outB = await b;
      expect(a).toMatchObject({ state: "NOT_DEDUCTED", historicalVat: 150 });
      expect(outB.ok, "the second declaration did not succeed").toBe(false);
      if (!outB.ok) expect([outB.e.statusCode, outB.e.payload?.code]).toEqual([409, "opening_vat_declaration_exists"]);
    } finally {
      if (!aCommitted) await connA.rollback();
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM opening_payable_vat_declarations WHERE migration_open_item_id = $1`, [item.RACE])).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM opening_payable_vat_declaration_evidence e JOIN opening_payable_vat_declarations d ON d.id = e.declaration_id WHERE d.migration_open_item_id = $1`, [item.RACE])).rows[0].n).toBe(1);
    expect(await events(bill.RACE!)).toEqual([["declared_opening", "NONE", "NOT_DEDUCTED", "150.00", null]]);
    expect(await balances(bill.RACE!)).toMatchObject({ not_deducted: "150.00", claimed: "0.00" }); // not 300
    // the loser left nothing behind: its document is still an unbound staged capture, no audit row names it
    expect(await captureRow(capB)).toMatchObject({ status: "staged", bill_id: null });
    expect(await captureRow(capA)).toMatchObject({ status: "promotion_pending", bill_id: bill.RACE });
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND action = 'opening_vat_declaration_record' AND entity_id = $2`, [orgId, String(bill.RACE)])).rows[0].n).toBe(1);
    expect(await reconcile(bill.RACE!)).toEqual({ doc: null, gl: null });
  });

  it("🔴 admission: an opening payable carries only its declared recognition and notes; a declared recognition exists only on an opening payable and restates its declaration exactly", async () => {
    const decl = (await pool.query(`SELECT * FROM opening_payable_vat_declarations WHERE migration_open_item_id = $1`, [item.ND])).rows[0];
    // Dated as the probe needs: a declared recognition must restate its declaration's date (declared_on is
    // businessToday() when the suite ran), so the duplicate probe uses THAT date — otherwise the date rule, not
    // the one-per-document index, is what refuses it (and the test would depend on the day it runs).
    const ins = (c: PoolClient, doc: number, type: string, to: string, amount: number, prov: string, decId: number | null, key: string, on = "2026-09-30") => c.query(
      `INSERT INTO input_vat_events (organization_id, company_id, document_id, event_type, from_bucket, to_bucket, amount, occurred_on, posting_date, actor_user_id, reason, provenance, declaration_id, idempotency_key)
       VALUES ($1, $2, $3, $4, 'NONE', $5, $6, $11, $11, $7, 't', $8, $9, $10)`, [orgId, coA, doc, type, to, amount, adminId, prov, decId, key, on]);
    // any other event on an opening payable
    expect((await dbRefusal(probe((c) => ins(c, bill.UND!, "exception_recorded", "NONE", 0, "recorded", null, "x1")))).constraint).toBe("input_vat_event_shape");
    // a second declared recognition on a declared payable (one per document)
    expect((await dbRefusal(probe((c) => ins(c, bill.ND!, "declared_opening", "NOT_DEDUCTED", 1500, "declared", decl.id, "x2", String(decl.declared_on))))).code).toBe("23505");
    // the wrong bucket or amount for the declaration (on the still-undeclared EVI, borrowing ND's declaration — refused as not THIS payable's)
    expect((await dbRefusal(probe((c) => ins(c, bill.EVI!, "declared_opening", "NOT_DEDUCTED", 1500, "declared", decl.id, "x3")))).constraint).toBe("input_vat_event_shape");
    // provenance: a declared recognition cannot be 'recorded' — on a declaration of its OWN (made inside the probe),
    // so no other rule can be what refuses it; and the same row with 'declared' is admitted (the planted positive)
    const declareBig = async (c: PoolClient) => (await c.query(
      `INSERT INTO opening_payable_vat_declarations (organization_id, company_id, migration_open_item_id, bill_id, state, historical_vat, vat_rate, not_deducted_reason, carried_in_cost, statement, declared_by, declared_on)
       VALUES ($1, $2, $3, $4, 'NOT_DEDUCTED', 100, 15, 'r', true, 's', $5, '2026-09-30') RETURNING id`, [orgId, coA, item.BIG, bill.BIG, adminId])).rows[0].id as number;
    expect((await dbRefusal(probe(async (c) => ins(c, bill.BIG!, "declared_opening", "NOT_DEDUCTED", 100, "recorded", await declareBig(c), "x4")))).constraint).toBe("input_vat_events_provenance_chk");
    await probe(async (c) => ins(c, bill.BIG!, "declared_opening", "NOT_DEDUCTED", 100, "declared", await declareBig(c), "x4"));
    // another tenant's declaration named by an event of this one
    const err = await dbRefusal(probe((c) => c.query(
      `INSERT INTO input_vat_events (organization_id, company_id, document_id, event_type, from_bucket, to_bucket, amount, occurred_on, posting_date, actor_user_id, reason, provenance, declaration_id, idempotency_key)
       VALUES ($1, $2, $3, 'declared_opening', 'NONE', 'NOT_DEDUCTED', 150, '2026-09-30', '2026-09-30', $4, 't', 'declared', $5, 'x5')`, [otherOrg, otherCo, bill.EVI, adminId, decl.id])));
    expect(err.constraint).toBe("input_vat_event_tenant");
  });

  // ════════════════════════════════════════════════════════════════════════
  // M — a declaration is a TOUCH for item correction only (D2).
  // ════════════════════════════════════════════════════════════════════════
  it("🔴 M: a declared item's outstanding cannot be corrected (its bill carries the declaration); an undeclared one still can", async () => {
    await declare("CORR", { state: "NOT_DEDUCTED", notDeductedReason: "r", carriedInCost: true, evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: await capture() }] });
    await expectRefusal(inTenant(() => migrationCorrectionService.correctOpenItem(item.CORR!, { correctOutstanding: 1000, reason: "Supplier statement shows 1,000", date: "2026-09-30" }, userId)),
      409, "opening_item_vat_declared");
    const ok = await inTenant(() => migrationCorrectionService.correctOpenItem(item.CORR2!, { correctOutstanding: 1000, reason: "Supplier statement shows 1,000", date: "2026-09-30" }, userId));
    expect(ok).toBeTruthy();
  });

  it("🔴 M: a declaration does NOT block the whole-batch reversal; afterwards the declaration stays (append-only), its payable is no longer live, and the item cannot be declared again", async () => {
    await declare("B1", { state: "NOT_DEDUCTED", notDeductedReason: "r", carriedInCost: true, evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: await capture(coB) }] }, coB);
    const preview = await inTenant(() => migrationCommitService.reversalPreview(batchB), coB) as { blockers: string[] };
    expect(preview.blockers).toEqual([]);
    await inTenant(() => migrationCommitService.reverse(batchB, { reason: "Wrong cut-over figures from the previous system" }, userId), coB);
    expect((await pool.query(`SELECT count(*)::int AS n FROM opening_payable_vat_declarations WHERE migration_open_item_id = $1`, [item.B1])).rows[0].n).toBe(1);
    expect(await reconcile(bill.B1!)).toEqual({ doc: null, gl: null });
    await expectRefusal(declare("B1", { state: "NOT_DEDUCTED", notDeductedReason: "r", carriedInCost: true, evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: await capture(coB) }] }, coB),
      409, "opening_item_not_live");
    // 🔴 and its surviving declaration does NOT make the reversed payable correctable: a note against it is refused
    // (with the supplier's document attached, so no earlier rule is what refuses it)
    const cap = await capture(coB);
    // (a draft may be recorded — a draft moves nothing; POSTING it is what is refused)
    const draft = await inTenant(() => billsService.create({
      documentType: "credit_note", creditNoteAgainstBillId: bill.B1, billNumber: "S1-CN-B1-REV", date: "2026-08-20", vendorReference: "SUP-S1-CN-B1-REV",
      subtotal: 100, vatAmount: 0, total: 100, items: [], captureId: cap,
    } as never, userId), coB) as { id: number };
    const words = await expectRefusal(inTenant(() => billsService.approve(draft.id, {}, userId), coB), 422, "input_vat_note_opening_reversed");
    expect(words).toMatch(/its migration has since reversed/);
    expect((await pool.query(`SELECT status FROM bills WHERE id = $1`, [draft.id])).rows[0].status).toBe("draft");
  });

  // ════════════════════════════════════════════════════════════════════════
  // K — admin and accountant (a dedicated grant); nobody else. Through HTTP.
  // ════════════════════════════════════════════════════════════════════════
  it("🔴 K: the ADMIN and the ACCOUNTANT may read and declare (dedicated grant); a BOOKKEEPER is refused — through the real route and middleware", async () => {
    expect((await api("admin", "GET", "/opening-vat-declarations")).status).toBe(200);
    expect((await api("accountant", "GET", "/opening-vat-declarations")).status).toBe(200);
    expect((await api("bookkeeper", "GET", "/opening-vat-declarations")).status).toBe(403);
    const body = { itemId: item.ACC, state: "NOT_DEDUCTED", notDeductedReason: "Never claimed", carriedInCost: true, evidence: [{ kind: "ORIGINAL_TAX_INVOICE", captureId: await capture() }] };
    expect((await api("bookkeeper", "POST", "/opening-vat-declarations", body)).status).toBe(403);
    const r = await api("accountant", "POST", "/opening-vat-declarations", body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ state: "NOT_DEDUCTED", itemId: item.ACC, declaredBy: accountantId });
    // the accountant still has NO migration write (the grant was not widened)
    expect((await api("accountant", "POST", `/migration/batches`, { sourceSystem: "X", cutoverDate: CUTOVER })).status).toBe(403);
    // a missing fact over HTTP: a named 422, not a 500
    const bad = await api("admin", "POST", "/opening-vat-declarations", { itemId: item.EVI, state: "DEDUCTED", evidence: [] });
    expect([bad.status, bad.body.code]).toEqual([422, "opening_vat_declaration_period_required"]);
  });

  // ════════════════════════════════════════════════════════════════════════
  // Isolation and the whole-ledger invariant.
  // ════════════════════════════════════════════════════════════════════════
  it("🔴 isolation — presence, absence AND movement: another tenant sees none of this org's declarations and has its own count", async () => {
    const mine = await asApp(orgId, coA, async (c) => (await c.query(`SELECT count(*)::int AS n FROM opening_payable_vat_declarations`)).rows[0].n);
    const theirs = await asApp(otherOrg, otherCo, async (c) => (await c.query(`SELECT count(*)::int AS n FROM opening_payable_vat_declarations`)).rows[0].n);
    const theirsEvidence = await asApp(otherOrg, otherCo, async (c) => (await c.query(`SELECT count(*)::int AS n FROM opening_payable_vat_declaration_evidence`)).rows[0].n);
    expect(mine).toBeGreaterThan(5);
    expect([theirs, theirsEvidence]).toEqual([0, 0]);
    // N1 — the same organisation's OTHER company: company B's declaration (B1) is in B's list and nowhere in A's,
    // while A's list still shows A's own (so the absence is not an empty answer)
    const listA = (await inTenant(() => openingVatDeclarationsService.list(), coA)).map((d) => d.itemId);
    const listB = (await inTenant(() => openingVatDeclarationsService.list(), coB)).map((d) => d.itemId);
    expect(listB).toEqual([item.B1]);
    expect(listA).not.toContain(item.B1);
    expect(listA).toContain(item.DED);
    // and a declaration cannot be made in A against B's item: the item is not found in A's books
    const notFound = await declare("B1", { state: "NOT_DEDUCTED", notDeductedReason: "r", carriedInCost: true, evidence: [] }, coA).catch((e: { statusCode?: number; message?: string }) => e);
    expect([(notFound as { statusCode?: number }).statusCode, (notFound as { message?: string }).message]).toEqual([404, "Migrated open item not found"]);
    // the app role may not UPDATE or DELETE (grants measured, not estimated)
    const grants = (await pool.query(
      `SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'authenticated' AND table_name = 'opening_payable_vat_declarations' ORDER BY 1`)).rows.map((r) => r.privilege_type);
    expect(grants).toEqual(["INSERT", "SELECT"]);
  });

  it("🔴 the whole organisation still reconciles — every document against its events, every balance row against the sum of its events", async () => {
    const problems = (await pool.query(`SELECT document_id, problem FROM input_vat_reconciliation($1)`, [orgId])).rows;
    expect(problems).toEqual([]);
  });
});

function round2(n: number) { return Math.round(n * 100) / 100; }
