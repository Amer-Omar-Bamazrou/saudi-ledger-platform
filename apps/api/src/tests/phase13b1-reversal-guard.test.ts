/**
 * PHASE 13B-1 — THE GENERIC REVERSAL CANNOT CANCEL AN OWNED ENTRY (A-5, 2026-09-28).
 * Contract: docs/product/phase-13b-vat-claim-ledger-architecture.md §19, §25.15.
 *
 * Before 13B-1, `POST /journal-entries/:id/reverse` refused only a bank
 * transfer's and a statement line's entries: a bill's own posting (BILL-), a
 * supplier note's (BILLCN-) and a bill's evidence claim (VATEV-) could be
 * cancelled generically — leaving the bill reading "posted"/"claimed" while its
 * entry was gone (CLAUDE.md §5 rank 2). 13B-1 closes that for bills and
 * supplier notes, in TWO layers, each proven to hold on its own:
 *
 *   1. the service (`documentOwner` → `input_vat_journal_owner()`), in words;
 *   2. the database (trigger `journal_entries_vat_reversal_guard`), for every
 *      path; plus `journal_entry_lines_vat_guard` so the entry cannot be
 *      rewritten underneath.
 *
 * Driven through the REAL app over HTTP, on entries the PRODUCT wrote. The
 * planted positives are the ones a guard must not catch: a manual entry, a
 * bill PAYMENT (out of 13B-1's scope — invoices and payments stay rank 2), an
 * opening (Batch 1C) entry.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { beginTenantConnection, pool } from "@workspace/db";
import { hashPassword } from "../lib/password";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { journalEntriesRepository } from "../repositories/journalEntries.repository";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase13b1-reversal-guard] no real DATABASE_URL — skipping.");

type PgError = { code?: string; constraint?: string; message: string };
/** The owner pool's client, structurally (the API package does not depend on `pg`'s types). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PoolClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; release: () => void };
const PW = "p13b1-Guard-pw-2026!";

describeMaybe("Phase 13B-1 — generic reversal protection (A-5)", () => {
  const SLUG_A = "p13b1-guard-a", SLUG_B = "p13b1-guard-b";
  const EMAIL_A = "p13b1-guard-a@test.local", EMAIL_B = "p13b1-guard-b@test.local";
  let server: http.Server;
  let base = "", cookieA = "";
  let orgA = "", coA = "", orgB = "", coB = "", userA = 0, userB = 0, vendorA = 0, bankA = 0;
  const id = { bill: 0, note: 0, claim: 0, manual: 0, payment: 0, opening: 0 };
  let billId = 0, heldId = 0;

  const ORGS = `(SELECT id FROM organizations WHERE slug IN ('${SLUG_A}','${SLUG_B}'))`;
  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      for (const t of ["input_vat_events", "input_vat_balances", "captured_documents", "bill_payments", "bill_items", "bills", "cash_line_bank_attributions",
                       "journal_entry_lines", "journal_entries", "audit_logs", "organization_memberships", "vendors", "bank_accounts", "categories", "companies"]) {
        await c.query(`DELETE FROM ${t} WHERE organization_id IN ${ORGS}`);
      }
      await c.query(`DELETE FROM organizations WHERE slug IN ('${SLUG_A}','${SLUG_B}')`);
      await c.query(`DELETE FROM users WHERE email IN ('${EMAIL_A}','${EMAIL_B}')`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };
  const inTenant = async <T,>(fn: () => Promise<T>, org = orgA, co = coA, user = userA): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId: user, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const probe = async <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try { await c.query("BEGIN"); return await fn(c); } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  };
  const asApp = async <T,>(org: string, co: string, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
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
  const entryId = async (number: string) =>
    (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [orgA, number])).rows[0].id as number;
  const statusOf = async (entry: number) => (await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [entry])).rows[0].status as string;
  const mirrors = async (entry: number) => Number((await pool.query(`SELECT count(*) FROM journal_entries WHERE reversal_of = $1`, [entry])).rows[0].count);
  const billRow = async (bid: number) =>
    (await pool.query(`SELECT status, input_vat_state, input_vat_claimed_on, input_vat_claim_entry_id, paid_amount::text FROM bills WHERE id = $1`, [bid])).rows[0];
  const reverseHttp = async (entry: number) => {
    const res = await fetch(`${base}/journal-entries/${entry}/reverse`, { method: "POST", headers: { cookie: cookieA, "content-type": "application/json" }, body: JSON.stringify({ reason: "Phase 13B-1 guard test" }) });
    return { status: res.status, body: (await res.json().catch(() => null)) as { error?: string; reversalId?: number } | null };
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
    ({ org: orgB, co: coB, user: userB } = await mk(SLUG_B, EMAIL_B));
    vendorA = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1, 'Riyadh Stationers', '399999999999993') RETURNING id`, [orgA])).rows[0].id;
    bankA = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name, account_number, currency) VALUES ($1, $2, 'P13B1 Bank', 'Test Bank', 'SA0000000000000000000001', 'SAR') RETURNING id`, [orgA, coA])).rows[0].id;

    // ── The PRODUCT writes every entry under test. ──
    const mkBill = async (number: string, evidenced: boolean) => {
      const b = await inTenant(() => billsService.create({ billNumber: number, vendorId: vendorA, vendorReference: `SUP-${number}`, date: "2026-05-10", dueDate: "2026-06-10", subtotal: 1000, vatAmount: 150, total: 1150, items: [], ...(evidenced ? { supplierDocumentKind: "tax_invoice" } : {}) }, userA));
      await inTenant(() => billsService.approve(b.id, {}, userA));
      return b.id as number;
    };
    billId = await mkBill("P13B1G-1", true);
    heldId = await mkBill("P13B1G-2", false);
    await inTenant(() => billsService.attachEvidence(heldId, { supplierDocumentKind: "tax_invoice", evidenceDate: "2026-07-15" }, userA));
    const note = await inTenant(() => billsService.create({ billNumber: "P13B1G-CN", documentType: "credit_note", creditNoteAgainstBillId: billId, date: "2026-06-20", subtotal: 100, vatAmount: 15, total: 115, items: [] }, userA));
    await inTenant(() => billsService.approve(note.id, {}, userA));
    const payBill = await mkBill("P13B1G-3", true);
    await inTenant(() => billsService.pay(payBill, { amount: 1150, paidAt: "2026-05-20", bankAccountId: bankA }, userA));
    const acct = async (code: string) => (await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgA, code])).rows[0] as { id: number; name: string };
    const [purchases, suspense] = [await acct("PURCHASES"), await acct("SUSPENSE")];
    const manual = await inTenant(() => journalEntriesService.create({
      entryNumber: "P13B1G-JE-1", date: "2026-05-15", description: "P13B1 manual entry",
      lines: [{ accountId: purchases.id, accountName: purchases.name, description: "x", debitAmount: 10, creditAmount: 0 },
              { accountId: suspense.id, accountName: suspense.name, description: "x", debitAmount: 0, creditAmount: 10 }],
    }, userA));
    await inTenant(() => journalEntriesService.post(manual.id, userA));

    id.bill = await entryId("BILL-P13B1G-1");
    id.note = await entryId("BILLCN-P13B1G-CN");
    id.claim = await entryId("VATEV-P13B1G-2");
    id.manual = manual.id;
    id.payment = (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND entry_number LIKE 'BILL-P13B1G-3-PAY-%'`, [orgA])).rows[0].id;
    const sus = (await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND system_code = 'SUSPENSE'`, [orgA])).rows[0];
    const pur = (await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND system_code = 'PURCHASES'`, [orgA])).rows[0];
    id.opening = (await pool.query(`INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status, source, posted_at)
                                    VALUES ($1, $2, 'P13B1G-OPEN', '2026-01-01', 'opening stand-in', 'posted', 'opening', now()) RETURNING id`, [orgA, coA])).rows[0].id;
    await pool.query(`INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
                      VALUES ($1, $2, $3, $4, $5, 5, 0), ($1, $2, $3, $6, $7, 0, 5)`, [orgA, coA, id.opening, pur.id, pur.name, sus.id, sus.name]);

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

  it("🔴 the owner of each entry is named by the ONE database definition — and only inside its own tenant (no cross-tenant oracle)", async () => {
    const owners = await asApp(orgA, coA, async (c) => (await c.query(
      `SELECT input_vat_journal_owner($1) b, input_vat_journal_owner($2) n, input_vat_journal_owner($3) v, input_vat_journal_owner($4) m, input_vat_journal_owner($5) p, input_vat_journal_owner($6) o`,
      [id.bill, id.note, id.claim, id.manual, id.payment, id.opening])).rows[0]);
    expect(owners).toEqual({ b: "bill", n: "supplier_note", v: "bill_vat_claim", m: null, p: null, o: null });
    const fromB = await asApp(orgB, coB, async (c) => (await c.query(`SELECT input_vat_journal_owner($1) o`, [id.bill])).rows[0].o);
    expect(fromB, "org B learns nothing about org A's entry").toBeNull();
    const oracle = await refusal(asApp(orgA, coA, (c) => c.query(`SELECT input_vat_journal_protected($1)`, [id.bill])));
    expect(oracle.code, "the SECURITY DEFINER predicate is not callable by the app").toBe("42501");
  });

  it("🔴 over HTTP, the generic reverse REFUSES a bill's own entry, a supplier note's and a bill's VAT claim — in words, with nothing written", async () => {
    const before = { bill: await billRow(billId), held: await billRow(heldId) };
    for (const [entry, wording] of [[id.bill, "bill P13B1G-1's own posting"], [id.note, "supplier note P13B1G-CN's own posting"], [id.claim, "claims bill P13B1G-2's input VAT"]] as const) {
      const r = await reverseHttp(entry);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body?.error).toContain(wording);
      expect(await statusOf(entry), "the entry is still posted").toBe("posted");
      expect(await mirrors(entry), "no mirror entry was written").toBe(0);
    }
    expect(await billRow(billId)).toEqual(before.bill);
    expect(await billRow(heldId)).toEqual(before.held);
  });

  it("🔴 planted positives over HTTP: a manual entry and a bill PAYMENT still reverse (payments are outside 13B-1's scope)", async () => {
    const manual = await reverseHttp(id.manual);
    expect(manual.status, JSON.stringify(manual.body)).toBe(200);
    expect(await statusOf(id.manual)).toBe("reversed");
    const payment = await reverseHttp(id.payment);
    expect(payment.status, JSON.stringify(payment.body)).toBe(200);
    expect(await statusOf(id.payment)).toBe("reversed");
  });

  it("🔴 layer 2 alone: with the SERVICE guard removed, the DATABASE still refuses — and the request's mirror entry does not survive", async () => {
    const spy = vi.spyOn(journalEntriesRepository, "documentOwner").mockResolvedValue(null);
    try {
      const err = await refusal(inTenant(() => journalEntriesService.reverse(id.bill, { reason: "service guard removed" })));
      expect(err.constraint ?? (err as { cause?: PgError }).cause?.constraint, err.message).toBe("journal_entries_vat_reversal_guard");
    } finally { spy.mockRestore(); }
    expect(await statusOf(id.bill)).toBe("posted");
    expect(await mirrors(id.bill), "the mirror posted before the refused UPDATE rolled back with it").toBe(0);
  });

  it("🔴 layer 1 alone: the SERVICE refuses before it writes anything — the refusal is its 409, never the database's", async () => {
    const err = await refusal(inTenant(() => journalEntriesService.reverse(id.note, { reason: "x" })));
    expect((err as unknown as { statusCode?: number }).statusCode).toBe(409);
    expect(err.constraint, "not the trigger — the service stopped first").toBeUndefined();
  });

  it("🔴 the database guard binds the OWNER too; with triggers out of the way the same UPDATE succeeds (mutation proof); an opening entry is never protected", async () => {
    for (const entry of [id.bill, id.note, id.claim]) {
      const err = await refusal(probe((c) => c.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [entry])));
      expect(err.constraint).toBe("journal_entries_vat_reversal_guard");
    }
    const mutated = await probe(async (c) => {
      await c.query("SET LOCAL session_replication_role = replica");
      return (await c.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [id.bill])).rowCount;
    });
    expect(mutated).toBe(1);
    expect(await statusOf(id.bill), "rolled back").toBe("posted");
    // Batch 1C compatibility: an opening entry is not an owned entry, so a committed migration can still reverse it.
    const opening = await probe(async (c) => (await c.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [id.opening])).rowCount);
    expect(opening).toBe(1);
  });

  it("🔴 the LINES of an owned entry cannot be rewritten underneath it; an unowned entry's lines are untouched by the guard (mutation proof)", async () => {
    const line = (await pool.query(`SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 AND debit_amount > 0 ORDER BY id LIMIT 1`, [id.claim])).rows[0].id;
    const err = await refusal(probe((c) => c.query(`UPDATE journal_entry_lines SET debit_amount = debit_amount + 1 WHERE id = $1`, [line])));
    expect(err.constraint).toBe("journal_entry_lines_vat_guard");
    const mutated = await probe(async (c) => {
      await c.query("SET LOCAL session_replication_role = replica");
      return (await c.query(`UPDATE journal_entry_lines SET debit_amount = debit_amount + 1 WHERE id = $1`, [line])).rowCount;
    });
    expect(mutated).toBe(1);
    const openingLine = (await pool.query(`SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 LIMIT 1`, [id.opening])).rows[0].id;
    expect(await probe(async (c) => (await c.query(`UPDATE journal_entry_lines SET description = 'x' WHERE id = $1`, [openingLine])).rowCount)).toBe(1);
  });
});
