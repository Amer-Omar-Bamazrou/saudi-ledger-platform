/**
 * Phase 16 + 17 — the gaps the manual QA (2026-10-04) left open that needed no
 * owner or accountant decision, closed and pinned over real HTTP.
 * Record: docs/history/phase-16-17-gap-closure-2026-10-04.md.
 *
 *   QA-15  the approvals inbox knew four entities: a bookkeeper SUBMITTED a
 *          Zakat computation, recorded a treaty relief, planned a payment — and
 *          no approver was ever told. The three join the ONE queue; every act
 *          still posts to the record's own route behind its own permission.
 *   QA-04  the Zakat classification page showed no balances — now each account
 *          carries its amount in the statement of financial position at a date,
 *          read from the balance sheet the computation itself reads.
 *   QA-16  an obligations row linked to the Zakat list, losing the year — the
 *          row now names the approved computation that dates it.
 *
 * Isolation is asserted the house way (CLAUDE.md §3): presence of this scope's
 * rows, absence of every other scope's, and the other scope SHOWING its own.
 */
process.env.PORT ??= "3000";
process.env.SESSION_SECRET ??= "test-secret-value-at-least-32-chars!!";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool, beginTenantConnection, PERMISSION_MATRIX } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { primePermissionCache } from "../lib/rbac";
import { auditContext } from "../lib/auditContext";
import { __resetRateLimitsForTests } from "../routes/auth";
import { addDays } from "../services/tax/taxComputations.service";
import { whtService } from "../services/tax/wht.service";
import { approvalsQueueService } from "../services/approvalsQueue.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase16-17-gap-closure] no real DATABASE_URL — skipping.");

const P = "p1617-gap";
const PASSWORD = "p1617-gap-pw-1";
const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;
type Role = (typeof ROLES)[number];
const email = (k: string) => `${P}-${k}@test.local`;
type Row = { entity: string; id: number; label: string; labelAr?: string | null; status: string; amount: number | null; parentId?: number | null; subtype?: string | null };

describeMaybe("Phase 16 + 17 gap closure — the approvals inbox, classification balances, the obligation link", () => {
  let server: http.Server;
  let base = "";
  let orgX = "", coX = "", coX2 = "", orgY = "";
  let adminX = 0;
  let bankLeaf = 0, bankId = 0, vendorNR = 0, billX = 0;
  const today = businessToday();
  const lastYear = Number(today.slice(0, 4)) - 1;

  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const O = `(SELECT id FROM organizations WHERE slug LIKE '${P}-%')`;
      const { rows } = await c.query(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${O}`);
      await c.query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${P}-%@test.local')`);
      await c.query(`DELETE FROM organization_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${P}-%@test.local')`);
      await c.query(`DELETE FROM users WHERE email LIKE '${P}-%@test.local'`);
      await c.query(`DELETE FROM organizations WHERE slug LIKE '${P}-%'`);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  };

  function client() {
    let cookie = "";
    return async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sid = ((res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []).find((c) => c.startsWith("ksa_ledger_sid="));
      if (sid) cookie = sid.split(";")[0];
      const text = await res.text();
      let json: any;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return { status: res.status, json, text };
    };
  }
  const as: Record<Role | "y", ReturnType<typeof client>> = { admin: client(), accountant: client(), bookkeeper: client(), viewer: client(), y: client() };
  const queue = async (who: Role | "y" = "accountant") => {
    const r = await as[who]("GET", "/approvals/pending");
    expect(r.status, r.text).toBe(200);
    return r.json as Row[];
  };
  const find = (rows: Row[], entity: string, id: number) => rows.find((r) => r.entity === entity && r.id === id);
  const inCo = async <T,>(company: string, fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgX, companyId: company, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId: adminX, organizationId: orgX, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  async function org(slug: string, name: string, cr: string) {
    const id = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ($1,$1,'approved') RETURNING id`, [slug])).rows[0].id as string;
    const co = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type, vat_tax_period) VALUES ($1,$2,1,'gregorian','399999999999993',$3,'SAUDI_GCC','quarterly') RETURNING id`, [id, name, cr])).rows[0].id as string;
    return { id, co };
  }
  async function user(key: string, orgId: string, role: string) {
    const hash = await bcrypt.hash(PASSWORD, 4);
    const id = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'P1617G',$2,'viewer',true) RETURNING id`, [email(key), hash])).rows[0].id as number;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,$3,'active')`, [id, orgId, role]);
    return id;
  }
  const relief = (vendorId: number, paymentType: string, reducedRate: number, ref: string) => ({
    vendorId, paymentType, reducedRate, treatyCountry: "IE", zatcaApprovalReference: `Z-${ref}`, residencyCertificateReference: `R-${ref}`, validFrom: addDays(today, -30), validTo: addDays(today, 300),
  });

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();
    ({ id: orgX, co: coX } = await org(`${P}-x`, "Gap X", "1010606061"));
    ({ id: orgY } = await org(`${P}-y`, "Gap Y", "1010606062"));
    await new Promise((r) => setTimeout(r, 20));
    // a SECOND company of org X, created after the first — the active company stays the first (tenant.ts)
    coX2 = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type) VALUES ($1,'Gap X2',1,'gregorian','399999999999993','1010606063','SAUDI_GCC') RETURNING id`, [orgX])).rows[0].id;
    for (const r of ROLES) { const id = await user(r, orgX, r); if (r === "admin") adminX = id; }
    await user("y", orgY, "admin");
    const app = (await import("../app")).default;
    primePermissionCache(PERMISSION_MATRIX);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    for (const k of [...ROLES, "y"] as const) expect((await as[k]("POST", "/auth/login", { email: email(k), password: PASSWORD })).status, k).toBe(200);

    // the fixture through the product's own routes: a bank, a capital injection last year, the bank classified
    const bank = (await as.admin("POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR" })).json.id;
    bankId = bank;
    bankLeaf = Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND bank_account_id = $2`, [orgX, bank])).rows[0].id);
    const capital = (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable) VALUES ($1,'Gap capital','رأس المال','equity',false) RETURNING id`, [orgX])).rows[0].id;
    const je = await as.admin("POST", "/journal-entries", { date: `${lastYear}-06-30`, description: "Capital paid in", lines: [
      { accountId: bankLeaf, accountName: "Ops", debitAmount: 100_000, creditAmount: 0 },
      { accountId: capital, accountName: "Gap capital", debitAmount: 0, creditAmount: 100_000 },
    ] });
    expect(je.status, je.text).toBe(201);
    expect((await as.admin("POST", `/journal-entries/${je.json.id}/approve`, {})).status).toBe(200);
    expect((await as.admin("PUT", `/tax/zakat/classifications/${bankLeaf}`, { classification: "current_asset_not_deducted" })).status).toBe(200);
    vendorNR = (await as.admin("POST", "/vendors", { name: "Gap Royalty Ltd", nameAr: "مورد الإتاوات", country: "IE", residency: "non_resident", whtDefaultPaymentType: "royalty", foreignTaxId: "IE9" })).json.id;
    const resident = (await as.admin("POST", "/vendors", { name: "Gap Supplies", residency: "resident" })).json.id;
    const bill = await as.admin("POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: "GS-1", billNumber: "GAP-B-1", date: addDays(today, -3), dueDate: addDays(today, 20), vendorId: resident,
      items: [{ description: "Supply", quantity: 1, unitPrice: 5_000, vatRate: 0 }] });
    expect(bill.status, bill.text).toBe(201);
    expect((await as.admin("POST", `/bills/${bill.json.id}/approve`, {})).status).toBe(200);
    billX = bill.json.id;
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await cleanup();
  });

  let computationId = 0, versionId = 0;

  it("🔴 QA-15 — a bookkeeper's SUBMITTED computation reaches the approver's queue (a draft does not); send-back and approval move it out; a second approval is refused; every act is audited", async () => {
    const c = await as.bookkeeper("POST", "/tax/computations", { kind: "zakat", fiscalYearLabel: lastYear });
    expect(c.status, c.text).toBe(201);
    computationId = c.json.id;
    versionId = c.json.version.id;
    expect(find(await queue(), "tax-computations", versionId), "a draft is the preparer's working paper — not listed").toBeUndefined();

    expect((await as.bookkeeper("POST", `/tax/computations/${computationId}/versions/${versionId}/submit`, {})).status).toBe(200);
    const row = find(await queue(), "tax-computations", versionId);
    expect(row, "the submitted version is in the approver's queue").toEqual({ entity: "tax-computations", id: versionId, parentId: computationId, subtype: "zakat", label: `${lastYear} · v1`, status: "submitted", amount: null });
    expect(find(await queue("bookkeeper"), "tax-computations", versionId), "the preparer sees it waiting too").toBeTruthy();

    // a bookkeeper never approves (the route, not the queue, decides) — and the row stays
    expect((await as.bookkeeper("POST", `/tax/computations/${computationId}/versions/${versionId}/approve`, {})).status).toBe(403);
    expect(find(await queue(), "tax-computations", versionId)).toBeTruthy();

    // sent back with a note → a draft again → out of the queue; re-submitted → back in
    expect((await as.accountant("POST", `/tax/computations/${computationId}/versions/${versionId}/send-back`, { note: "Check the capital account" })).status).toBe(200);
    expect(find(await queue(), "tax-computations", versionId)).toBeUndefined();
    expect((await as.bookkeeper("POST", `/tax/computations/${computationId}/versions/${versionId}/submit`, {})).status).toBe(200);
    expect(find(await queue(), "tax-computations", versionId)).toBeTruthy();

    // approved → out of the queue, the accrual posted once; a second approval is a 409, nothing posted twice
    const ok = await as.accountant("POST", `/tax/computations/${computationId}/versions/${versionId}/approve`, {});
    expect(ok.status, ok.text).toBe(200);
    expect(find(await queue(), "tax-computations", versionId)).toBeUndefined();
    const accruals = async () => Number((await pool.query(`SELECT count(*) n FROM journal_entries WHERE company_id = $1 AND entry_number LIKE 'ZAKAT-%'`, [coX])).rows[0].n);
    expect(await accruals()).toBe(1);
    const again = await as.accountant("POST", `/tax/computations/${computationId}/versions/${versionId}/approve`, {});
    expect([again.status, again.json?.code]).toEqual([409, "tax_version_approved"]);
    expect(await accruals()).toBe(1);

    const acts = (await pool.query(`SELECT action FROM audit_logs WHERE entity_type = 'tax_computation_version' AND entity_id = $1 ORDER BY id`, [String(versionId)])).rows.map((r) => r.action);
    expect(acts).toEqual(expect.arrayContaining(["submit", "send_back", "approve"]));
    expect(acts.filter((a) => a === "submit")).toHaveLength(2);
  });

  it("🔴 QA-15 — a pending treaty relief reaches the queue with its supplier (in Arabic too), nature and rate; revoking it needs a reason; approving it moves it out", async () => {
    const r1 = await as.bookkeeper("POST", "/tax/wht/reliefs", relief(vendorNR, "royalty", 0.1, "1"));
    expect(r1.status, r1.text).toBe(201);
    expect(find(await queue(), "wht-reliefs", r1.json.id)).toEqual({ entity: "wht-reliefs", id: r1.json.id, subtype: "royalty", label: "Gap Royalty Ltd · IE · 10%", labelAr: "مورد الإتاوات · IE · 10%", status: "pending", amount: null });

    // an empty reason fails the schema (400); a two-letter one, the service's rule (422 — the record keeps a reason)
    expect((await as.accountant("POST", `/tax/wht/reliefs/${r1.json.id}/reject`, { reason: "" })).status).toBe(400);
    const noReason = await as.accountant("POST", `/tax/wht/reliefs/${r1.json.id}/reject`, { reason: "no" });
    expect([noReason.status, noReason.json?.code]).toEqual([422, "reason_required"]);
    expect(find(await queue(), "wht-reliefs", r1.json.id), "a refused act leaves it waiting").toBeTruthy();
    expect((await as.accountant("POST", `/tax/wht/reliefs/${r1.json.id}/reject`, { reason: "Certificate expired" })).status).toBe(200);
    expect(find(await queue(), "wht-reliefs", r1.json.id)).toBeUndefined();

    const r2 = await as.bookkeeper("POST", "/tax/wht/reliefs", relief(vendorNR, "royalty", 0.05, "2"));
    expect((await as.accountant("POST", `/tax/wht/reliefs/${r2.json.id}/approve`, {})).status).toBe(200);
    expect(find(await queue(), "wht-reliefs", r2.json.id)).toBeUndefined();
    expect((await as.accountant("POST", `/tax/wht/reliefs/${r2.json.id}/approve`, {})).status, "approved once").toBe(409);
    const acts = (await pool.query(`SELECT action FROM audit_logs WHERE entity_type = 'wht_treaty_relief' AND entity_id IN ($1, $2) ORDER BY id`, [String(r1.json.id), String(r2.json.id)])).rows.map((r) => r.action);
    expect(acts).toEqual(expect.arrayContaining(["revoke", "approve"]));
  });

  it("🔴 QA-15 — a planned payment reaches the queue with what it would settle; approving or cancelling moves it out; an APPROVED plan waits for payment, not approval", async () => {
    const p1 = await as.bookkeeper("POST", "/treasury/payment-plans", { billId: billX, amount: 1_000, plannedDate: addDays(today, 5) });
    expect(p1.status, p1.text).toBe(201);
    const row = find(await queue(), "payment-plans", p1.json.id);
    expect([row?.status, row?.amount, row?.label]).toEqual(["planned", 1_000, `GAP-B-1 · ${addDays(today, 5)} · Gap Supplies`]);
    expect((await as.bookkeeper("POST", `/treasury/payment-plans/${p1.json.id}/approve`, {})).status, "a bookkeeper never approves").toBe(403);
    expect((await as.accountant("POST", `/treasury/payment-plans/${p1.json.id}/approve`, {})).status).toBe(200);
    expect(find(await queue(), "payment-plans", p1.json.id)).toBeUndefined();
    const twice = await as.accountant("POST", `/treasury/payment-plans/${p1.json.id}/approve`, {});
    expect([twice.status, twice.json?.code]).toEqual([409, "plan_not_planned"]);

    const p2 = await as.bookkeeper("POST", "/treasury/payment-plans", { billId: billX, amount: 500, plannedDate: addDays(today, 6) });
    expect(find(await queue(), "payment-plans", p2.json.id)).toBeTruthy();
    expect((await as.accountant("POST", `/treasury/payment-plans/${p2.json.id}/reject`, {})).status).toBe(400);
    const noReason = await as.accountant("POST", `/treasury/payment-plans/${p2.json.id}/reject`, { reason: "no" });
    expect([noReason.status, noReason.json?.code]).toEqual([422, "reason_required"]);
    expect(find(await queue(), "payment-plans", p2.json.id), "a refused act leaves it waiting").toBeTruthy();
    expect((await as.accountant("POST", `/treasury/payment-plans/${p2.json.id}/reject`, { reason: "Supplier asked to wait" })).status).toBe(200);
    expect(find(await queue(), "payment-plans", p2.json.id)).toBeUndefined();
  });

  it("🔴 a PAID plan shows the withholding its payment RECORDED — not a re-estimate that moves when the supplier's nature changes afterwards", async () => {
    const b = await as.admin("POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: "GR-9", billNumber: "GAP-NR-9", date: addDays(today, -3), dueDate: addDays(today, 20), vendorId: vendorNR,
      items: [{ description: "Licence", quantity: 1, unitPrice: 2_000, vatRate: 0 }] });
    expect((await as.admin("POST", `/bills/${b.json.id}/approve`, {})).status).toBe(200);
    const p = await as.admin("POST", "/treasury/payment-plans", { billId: b.json.id, amount: 2_000, plannedDate: addDays(today, 3) });
    // open: an estimate — royalty, the supplier's default, at the 5 % treaty rate the relief test approved
    expect([p.json.whtEstimate, p.json.whtWithheld], "open: an estimate").toEqual([100, null]);
    expect((await as.admin("POST", `/treasury/payment-plans/${p.json.id}/approve`, {})).status).toBe(200);
    expect((await as.admin("POST", `/treasury/payment-plans/${p.json.id}/pay`, { bankAccountId: bankId })).status).toBe(200);
    const recorded = Number((await pool.query(`SELECT w.wht_amount FROM wht_withholdings w JOIN scheduled_payments sp ON sp.paid_bill_payment_id = w.bill_payment_id WHERE sp.id = $1`, [p.json.id])).rows[0].wht_amount);
    const read = async () => (await as.admin("GET", "/treasury/payment-plans")).json.find((x: { id: number }) => x.id === p.json.id);
    expect([recorded, (await read()).whtWithheld, (await read()).whtEstimate, (await read()).cashEstimate]).toEqual([100, 100, null, 1_900]);
    // movement: the supplier's default nature changes AFTER payment, to one a re-estimate would price differently
    // (management fees, 20 % → 400) — the record does not move with it
    expect((await as.admin("PATCH", `/vendors/${vendorNR}`, { whtDefaultPaymentType: "management_fee" })).status).toBe(200);
    expect([(await read()).whtWithheld, (await read()).whtEstimate, (await read()).cashEstimate], "still what the payment withheld; nothing re-estimated").toEqual([100, null, 1_900]);
    expect((await as.admin("PATCH", `/vendors/${vendorNR}`, { whtDefaultPaymentType: "royalty" })).status).toBe(200);
  });

  it("the queue widens no read: a viewer sees the waiting items (READ on tax and treasury) and is refused every act", async () => {
    const p = await as.bookkeeper("POST", "/treasury/payment-plans", { billId: billX, amount: 250, plannedDate: addDays(today, 7) });
    expect(find(await queue("viewer"), "payment-plans", p.json.id)).toBeTruthy();
    expect((await as.viewer("POST", `/treasury/payment-plans/${p.json.id}/approve`, {})).status).toBe(403);
    expect(find(await queue(), "payment-plans", p.json.id), "still waiting").toBeTruthy();
  });

  it("🔴 isolation — another organisation's and another COMPANY's waiting items never appear; each scope shows its own (presence, absence, movement)", async () => {
    // org Y: its own supplier, relief and plan, through its own admin
    const vY = (await as.y("POST", "/vendors", { name: "Y Royalty", country: "IE", residency: "non_resident", whtDefaultPaymentType: "royalty", foreignTaxId: "IEY" })).json.id;
    const rY = await as.y("POST", "/tax/wht/reliefs", relief(vY, "royalty", 0.1, "Y"));
    expect(rY.status, rY.text).toBe(201);
    // org X, company 2: a relief (vendors are the organisation's) and a submitted computation version, in THAT company
    const rX2 = await inCo(coX2, () => whtService.createRelief(relief(vendorNR, "royalty", 0.1, "X2"), adminX));
    const c2 = (await pool.query(`INSERT INTO tax_computations (organization_id, company_id, kind, fiscal_calendar, fiscal_start_month, fiscal_label, fiscal_year_start, fiscal_year_end) VALUES ($1,$2,'zakat','gregorian',1,$3,$4,$5) RETURNING id`, [orgX, coX2, lastYear, `${lastYear}-01-01`, `${lastYear}-12-31`])).rows[0].id;
    // born a draft (the database insists), then submitted — company 2 has no books, so its submit path would refuse
    const v2 = (await pool.query(`INSERT INTO tax_computation_versions (organization_id, company_id, computation_id, version_no, status) VALUES ($1,$2,$3,1,'draft') RETURNING id`, [orgX, coX2, c2])).rows[0].id;
    await pool.query(`UPDATE tax_computation_versions SET status = 'submitted', submitted_at = now() WHERE id = $1`, [v2]);

    const key = (r: Row) => `${r.entity}:${r.id}`;
    const x = (await queue("accountant")).filter((r) => !["invoices", "bills", "journal-entries", "payroll"].includes(r.entity)).map(key);
    const y = (await queue("y")).map(key);
    const x2 = (await inCo(coX2, () => approvalsQueueService.pending("admin"))).map((r) => key(r as Row));
    const x1Plan = (await pool.query(`SELECT id FROM scheduled_payments WHERE company_id = $1 AND status = 'planned'`, [coX])).rows.map((r) => `payment-plans:${r.id}`);
    expect(x1Plan, "company 1 has exactly one plan waiting (the viewer case)").toHaveLength(1);
    // EXACT sets: each scope's own rows present, every other scope's absent
    expect(x, "company 1 of org X: its own plan, nothing of org Y's or of company 2's").toEqual(x1Plan);
    expect(y, "org Y: its own relief, nothing of org X's").toEqual([`wht-reliefs:${rY.json.id}`]);
    // movement — company 2's own queue SHOWS its items, so company 1's absence of them is not an empty answer
    expect(x2.sort(), "company 2: its relief and its submitted computation, not company 1's plan").toEqual([`tax-computations:${v2}`, `wht-reliefs:${rX2.id}`].sort());
  });

  it("🔴 QA-04 — each account carries its balance at the date asked, from the balance sheet the computation reads; 0 when it carries nothing then; no date → null", async () => {
    const at = async (asOf?: string) => {
      const r = await as.accountant("GET", `/tax/zakat/classifications${asOf ? `?asOf=${asOf}` : ""}`);
      expect(r.status, r.text).toBe(200);
      return r.json as Array<{ accountId: number; systemCode: string | null; balance: number | null; zakatReads: number | null; classification: string | null; isPosting: boolean }>;
    };
    const yearEnd = `${lastYear}-12-31`;
    const rows = await at(yearEnd);
    const bank = rows.find((a) => a.accountId === bankLeaf)!;
    const bs = await as.accountant("GET", `/reports/balance-sheet?as_of=${yearEnd}`);
    const bsBank = (bs.json.assets.items as Array<{ key: string; amount: number }>).find((i) => i.key === String(bankLeaf));
    expect([bank.balance, bank.isPosting]).toEqual([100_000, true]);
    expect(bank.balance, "the balance sheet's own row — one reading, not two").toBe(bsBank?.amount);
    expect(bank.zakatReads, "an ordinary account: the computation reads its balance").toBe(100_000);
    // 🔴 the Zakat payable carries the year's OWN accrual at the year-end — the computation leaves it out (Z-3), so
    // unclassified it blocks nothing (the page said it did); on a date no computation ends, it is read in full
    const zp = rows.find((a) => a.systemCode === "ZAKAT_PAYMENT")!;
    expect([zp.classification, zp.balance! > 0, zp.zakatReads]).toEqual([null, true, 0]);
    const zpLater = (await at(today)).find((a) => a.systemCode === "ZAKAT_PAYMENT")!;
    expect(zpLater.zakatReads, "no computation ends today: the payable is read as it stands").toBe(zpLater.balance);
    const ar = rows.find((a) => a.systemCode === "AR")!;
    expect(ar.balance, "an account with nothing on it reads 0, not blank").toBe(0);
    // movement: before the capital was paid in, the bank carried nothing
    expect((await at(`${lastYear}-06-29`)).find((a) => a.accountId === bankLeaf)?.balance).toBe(0);
    // no date → no balance claimed
    expect((await at()).every((a) => a.balance === null)).toBe(true);
    expect((await as.accountant("GET", "/tax/zakat/classifications?asOf=31-12-2025")).status).toBe(400);
  });

  it("🔴 QA-04 — a header listed because it carries pre-D-3 history is flagged (not a posting account) and shows that history's balance", async () => {
    const header = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'CASH'`, [orgX])).rows[0].id as number;
    const capital = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND name = 'Gap capital'`, [orgX])).rows[0].id as number;
    const c = await pool.connect();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica");
      const je = (await c.query(`INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status, posted_at) VALUES ($1,$2,'GAP-PRE-D3',$3,'pre-D-3 history','posted',now()) RETURNING id`, [orgX, coX, `${lastYear}-03-01`])).rows[0].id;
      await c.query(`INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount) VALUES ($1,$2,$3,$4,'Cash and Bank',7000,0), ($1,$2,$3,$5,'Gap capital',0,7000)`, [orgX, coX, je, header, capital]);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    const rows = (await as.accountant("GET", `/tax/zakat/classifications?asOf=${lastYear}-12-31`)).json as Array<{ accountId: number; balance: number | null; isPosting: boolean }>;
    const h = rows.find((a) => a.accountId === header);
    expect([h?.isPosting, h?.balance]).toEqual([false, 7_000]);
    expect(rows.filter((a) => a.isPosting === false).map((a) => a.accountId), "only the header that carries history").toEqual([header]);
  });

  it("🔴 QA-16 — the Zakat obligation names the approved computation that dates it, so its link opens THAT year", async () => {
    const ob = await as.accountant("GET", "/tax/obligations");
    const z = (ob.json.obligations as Array<{ kind: string; source: { computationId?: number | null } }>).find((o) => o.kind === "zakat");
    expect(z?.source.computationId).toBe(computationId);
  });
});
