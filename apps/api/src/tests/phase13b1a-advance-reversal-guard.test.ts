/**
 * PHASE 13B-1a — SUPPLIER ADVANCE VAT ENTRIES UNDER THE GENERIC-REVERSAL GUARD (D-2, 2026-09-29).
 * Record: docs/product/phase-13b2-credit-note-event-design.md §16A; migration 0108.
 *
 * 13B-1 (A-5) put a bill's and a supplier note's own entries beyond the
 * generic journal reverse, through ONE owner definition,
 * `input_vat_journal_owner()`, read by the service AND the database guards.
 * That definition matched `BILL-%` / `BILLCN-%` only, so a supplier advance
 * invoice's `BILLADV-<n>` (its input-VAT claim) and an advance credit note's
 * `BILLADVCN-<n>` escaped both layers. 0108 extends the one definition.
 *
 * Driven on entries the PRODUCT wrote (Z-AP1's own services), through the
 * real HTTP route, with each layer proven alone, a mutation proof that it is
 * 0108 (not something else) that protects them, the line guard, tenant
 * isolation, and the planted positives a guard must not catch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beginTenantConnection, pool } from "@workspace/db";
import { hashPassword } from "../lib/password";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { journalEntriesRepository } from "../repositories/journalEntries.repository";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { supplierAdvanceInvoicesService } from "../services/accounting/supplierAdvanceInvoices.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase13b1a-advance-reversal-guard] no real DATABASE_URL — skipping.");

type PgError = { code?: string; constraint?: string; message: string };
/** The owner pool's client, structurally (the API package does not depend on `pg`'s types). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PoolClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; release: () => void };
const PW = "p13b1a-Guard-pw-2026!";

describeMaybe("Phase 13B-1a — supplier advance VAT entries are owned (D-2)", () => {
  const SLUG_A = "p13b1a-guard-a", SLUG_B = "p13b1a-guard-b";
  const EMAIL_A = "p13b1a-guard-a@test.local", EMAIL_B = "p13b1a-guard-b@test.local";
  let server: http.Server;
  let base = "", cookieA = "";
  let orgA = "", coA = "", orgB = "", coB = "", userA = 0, vendorA = 0, bankA = 0;
  let advanceId = 0, advanceNoteId = 0;
  const id = { adv: 0, advCn: 0, supplierPayment: 0, manual: 0, billPayment: 0, fakeAdv: 0 };

  const ORGS = `(SELECT id FROM organizations WHERE slug IN ('${SLUG_A}','${SLUG_B}'))`;
  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      for (const t of ["input_vat_events", "input_vat_balances", "bill_prepayments", "supplier_refunds", "supplier_payment_allocation_reversals",
                       "supplier_payment_allocations", "supplier_payment_classifications", "supplier_payments", "bill_payments", "bill_items", "bills",
                       "cash_line_bank_attributions", "journal_entry_lines", "journal_entries", "period_locks", "audit_logs",
                       "organization_memberships", "vendors", "bank_accounts", "categories", "companies"]) {
        await c.query(`DELETE FROM ${t} WHERE organization_id IN ${ORGS}`);
      }
      await c.query(`DELETE FROM organizations WHERE slug IN ('${SLUG_A}','${SLUG_B}')`);
      await c.query(`DELETE FROM users WHERE email IN ('${EMAIL_A}','${EMAIL_B}')`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };
  const inTenant = async <T,>(fn: () => Promise<T>, org = orgA, co = coA): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId: userA, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
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
  const refusal = async (p: Promise<unknown>): Promise<PgError> => {
    let err: PgError | undefined;
    try { await p; } catch (e) { err = e as PgError; }
    expect(err, "expected a refusal").toBeTruthy();
    return err!;
  };
  const statusOf = async (entry: number) => (await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [entry])).rows[0].status as string;
  const mirrors = async (entry: number) => Number((await pool.query(`SELECT count(*) FROM journal_entries WHERE reversal_of = $1`, [entry])).rows[0].count);
  const billRow = async (bid: number) =>
    (await pool.query(`SELECT status, input_vat_state, input_vat_claimed_on, paid_amount::text FROM bills WHERE id = $1`, [bid])).rows[0];
  const entryOf = async (number: string) =>
    (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [orgA, number])).rows[0]?.id as number;
  const reverseHttp = async (entry: number) => {
    const res = await fetch(`${base}/journal-entries/${entry}/reverse`, { method: "POST", headers: { cookie: cookieA, "content-type": "application/json" }, body: JSON.stringify({ reason: "Phase 13B-1a guard test" }) });
    return { status: res.status, body: (await res.json().catch(() => null)) as { error?: string } | null };
  };

  beforeAll(async () => {
    const { seedPermissions } = await import("@workspace/db");
    await seedPermissions();
    await cleanup();
    const mk = async (slug: string, email: string) => {
      const org = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ($1, $1, 'approved') RETURNING id`, [slug])).rows[0].id as string;
      const co = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1, $2) RETURNING id`, [org, `${slug} Co`])).rows[0].id as string;
      const user = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1, $1, $2, 'viewer', true) RETURNING id`, [email, await hashPassword(PW)])).rows[0].id as number;
      await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1, $2, 'admin', 'active')`, [user, org]);
      return { org, co, user };
    };
    ({ org: orgA, co: coA, user: userA } = await mk(SLUG_A, EMAIL_A));
    ({ org: orgB, co: coB } = await mk(SLUG_B, EMAIL_B));
    vendorA = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1, 'Riyadh Stationers', '399999999999993') RETURNING id`, [orgA])).rows[0].id;
    bankA = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1, $2, 'P13B1a Bank', 'ANB') RETURNING id`, [orgA, coA])).rows[0].id;

    // ── Z-AP1's own services write every advance entry under test. ──
    const payment = await inTenant(() => supplierPaymentsService.create({ vendorId: vendorA, bankAccountId: bankA, amount: 2_300, paidAt: "2026-05-01", classification: "advance" }, userA)) as { id: number };
    const draftAdv = await inTenant(() => supplierAdvanceInvoicesService.createFromPayment(payment.id, { amount: 1_150, date: "2026-05-02", vendorReference: "ADV-INV-1" }, userA));
    const adv = await inTenant(() => billsService.approve(draftAdv.id, {}, userA)) as { id: number; billNumber: string };
    advanceId = adv.id;
    const draftCn = await inTenant(() => supplierAdvanceInvoicesService.createCreditNote(adv.id, { date: "2026-05-20", vendorReference: "ADV-CN-1" }, userA));
    const cn = await inTenant(() => billsService.approve(draftCn.id, {}, userA)) as { id: number; billNumber: string };
    advanceNoteId = cn.id;
    id.adv = await entryOf(`BILLADV-${adv.billNumber}`);
    id.advCn = await entryOf(`BILLADVCN-${cn.billNumber}`);
    id.supplierPayment = (await pool.query(`SELECT journal_entry_id FROM supplier_payments WHERE id = $1`, [payment.id])).rows[0]?.journal_entry_id ?? 0;

    // Planted positives: a manual entry and an ordinary bill PAYMENT (out of scope — CLAUDE.md §5 rank 2).
    const acct = async (code: string) => (await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgA, code])).rows[0] as { id: number; name: string };
    const [purchases, suspense] = [await acct("PURCHASES"), await acct("SUSPENSE")];
    const manual = await inTenant(() => journalEntriesService.create({
      entryNumber: "P13B1A-JE-1", date: "2026-05-15", description: "P13B1a manual entry",
      lines: [{ accountId: purchases.id, accountName: purchases.name, description: "x", debitAmount: 10, creditAmount: 0 },
              { accountId: suspense.id, accountName: suspense.name, description: "x", debitAmount: 0, creditAmount: 10 }],
    }, userA));
    await inTenant(() => journalEntriesService.post(manual.id, userA));
    id.manual = manual.id;
    const bill = await inTenant(() => billsService.create({ billNumber: "P13B1A-B1", vendorId: vendorA, vendorReference: "SUP-B1", supplierDocumentKind: "tax_invoice", date: "2026-05-10", subtotal: 100, vatAmount: 15, total: 115, items: [] }, userA));
    await inTenant(() => billsService.approve(bill.id, {}, userA));
    await inTenant(() => billsService.pay(bill.id, { amount: 115, paidAt: "2026-05-12", bankAccountId: bankA }, userA));
    id.billPayment = (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND entry_number LIKE 'BILL-P13B1A-B1-PAY-%'`, [orgA])).rows[0].id;
    // Precision: an entry whose NUMBER looks like an advance's but names an ordinary bill is not owned by it.
    const fake = await inTenant(() => journalEntriesService.create({
      entryNumber: "BILLADV-P13B1A-B1", date: "2026-05-16", description: "look-alike",
      lines: [{ accountId: purchases.id, accountName: purchases.name, description: "x", debitAmount: 5, creditAmount: 0 },
              { accountId: suspense.id, accountName: suspense.name, description: "x", debitAmount: 0, creditAmount: 5 }],
    }, userA));
    await inTenant(() => journalEntriesService.post(fake.id, userA));
    id.fakeAdv = fake.id;

    const app = (await import("../app")).default;
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    const res = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL_A, password: PW }) });
    expect(res.status).toBe(200);
    cookieA = ((res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []).find((c) => c.startsWith("ksa_ledger_sid="))!.split(";")[0]!;
  }, 120_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
  });

  it("the product wrote both advance entries under test (the fixture is real)", () => {
    expect(id.adv, "BILLADV- entry").toBeGreaterThan(0);
    expect(id.advCn, "BILLADVCN- entry").toBeGreaterThan(0);
  });

  it("🔴 the ONE owner definition names both advance entries — only inside its own tenant; a look-alike number and the unrelated entries stay unowned", async () => {
    const owners = await asApp(orgA, coA, async (c) => (await c.query(
      `SELECT input_vat_journal_owner($1) adv, input_vat_journal_owner($2) cn, input_vat_journal_owner($3) fake, input_vat_journal_owner($4) man, input_vat_journal_owner($5) pay`,
      [id.adv, id.advCn, id.fakeAdv, id.manual, id.billPayment])).rows[0]);
    expect(owners).toEqual({ adv: "advance_invoice", cn: "advance_credit_note", fake: null, man: null, pay: null });
    if (id.supplierPayment) {
      const sp = await asApp(orgA, coA, async (c) => (await c.query(`SELECT input_vat_journal_owner($1) o`, [id.supplierPayment])).rows[0].o);
      expect(sp, "the advance PAYMENT's own entry is not an advance document's").toBeNull();
    }
    const fromB = await asApp(orgB, coB, async (c) => (await c.query(`SELECT input_vat_journal_owner($1) a, input_vat_journal_owner($2) b`, [id.adv, id.advCn])).rows[0]);
    expect(fromB, "org B learns nothing about org A's entries").toEqual({ a: null, b: null });
  });

  it("🔴 over HTTP, the generic reverse REFUSES both advance entries — in words, with nothing written", async () => {
    const before = { adv: await billRow(advanceId), cn: await billRow(advanceNoteId) };
    for (const [entry, wording] of [[id.adv, "supplier advance invoice"], [id.advCn, "supplier advance credit note"]] as const) {
      const r = await reverseHttp(entry);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body?.error).toContain(wording);
      expect(await statusOf(entry), "the entry is still posted").toBe("posted");
      expect(await mirrors(entry), "no mirror entry was written").toBe(0);
    }
    expect({ adv: await billRow(advanceId), cn: await billRow(advanceNoteId) }).toEqual(before);
  });

  it("🔴 layer 1 alone: the SERVICE refuses before it writes anything — its 409, never the database's", async () => {
    for (const entry of [id.adv, id.advCn]) {
      const err = await refusal(inTenant(() => journalEntriesService.reverse(entry, { reason: "x" })));
      expect((err as unknown as { statusCode?: number }).statusCode).toBe(409);
      expect(err.constraint, "the service stopped first").toBeUndefined();
    }
  });

  it("🔴 layer 2 alone: with the SERVICE guard removed, the DATABASE refuses — and the request's mirror entry does not survive", async () => {
    const spy = vi.spyOn(journalEntriesRepository, "documentOwner").mockResolvedValue(null);
    try {
      for (const entry of [id.adv, id.advCn]) {
        const err = await refusal(inTenant(() => journalEntriesService.reverse(entry, { reason: "service guard removed" })));
        expect(err.constraint ?? (err as { cause?: PgError }).cause?.constraint, err.message).toBe("journal_entries_vat_reversal_guard");
        expect(await statusOf(entry)).toBe("posted");
        expect(await mirrors(entry), "the mirror rolled back with the refused status change").toBe(0);
      }
    } finally { spy.mockRestore(); }
  });

  it("🔴 mutation proof: with 0107's owner definition put back (inside a rolled-back transaction), the same status change SUCCEEDS — so 0108 is what protects them", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql0107 = readFileSync(resolve(here, "../../../../packages/db/migrations/0107_phase13b1_vat_event_ledger.sql"), "utf8");
    const piece = sql0107.split("--> statement-breakpoint").find((s) => s.includes("CREATE OR REPLACE FUNCTION input_vat_journal_owner("))!;
    const def0107 = piece.slice(piece.indexOf("CREATE OR REPLACE FUNCTION input_vat_journal_owner("));
    for (const entry of [id.adv, id.advCn]) {
      const guarded = await refusal(probe((c) => c.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [entry])));
      expect(guarded.constraint, "the database guard binds the owner role too").toBe("journal_entries_vat_reversal_guard");
      const escaped = await probe(async (c) => {
        await c.query(def0107);
        return (await c.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [entry])).rowCount;
      });
      expect(escaped, "under 0107 alone the advance entry escaped the guard").toBe(1);
      expect(await statusOf(entry), "rolled back").toBe("posted");
    }
  });

  it("🔴 the LINES of both advance entries cannot be rewritten underneath them; an unowned entry's lines are untouched by the guard", async () => {
    for (const entry of [id.adv, id.advCn]) {
      const line = (await pool.query(`SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY id LIMIT 1`, [entry])).rows[0].id;
      const err = await refusal(probe((c) => c.query(`UPDATE journal_entry_lines SET debit_amount = debit_amount + 1 WHERE id = $1`, [line])));
      expect(err.constraint).toBe("journal_entry_lines_vat_guard");
    }
    const manualLine = (await pool.query(`SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 LIMIT 1`, [id.manual])).rows[0].id;
    expect(await probe(async (c) => (await c.query(`UPDATE journal_entry_lines SET description = 'x' WHERE id = $1`, [manualLine])).rowCount)).toBe(1);
  });

  it("🔴 planted positives over HTTP: a manual entry, an ordinary bill PAYMENT and a look-alike number still reverse", async () => {
    for (const entry of [id.manual, id.billPayment, id.fakeAdv]) {
      const r = await reverseHttp(entry);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await statusOf(entry)).toBe("reversed");
    }
  });
});
