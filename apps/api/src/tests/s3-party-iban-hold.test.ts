/**
 * 🔴 19B S3 (v4 §6.3, D2; owner 2026-11-23) — 19B-S3: A SUPPLIER'S AND AN EMPLOYEE'S IBAN IS HELD AT ENTRY AND ON
 * EVERY CHANGE.
 *
 *  - Entry holds: a supplier created with an IBAN, a supplier's IBAN changed, an employee's IBAN entered by a bookkeeper
 *    — each record keeps its IBAN (or none), and the request waits.
 *  - Approve: the requester refused; a bookkeeper and a viewer refused at the API, and the database refuses a
 *    non-approver's decision made around the API; an accountant who is not the requester approves, and the IBAN applies.
 *  - A1: an approver the requester created within 30 days is refused, and still counts as an approver — so the IBAN is
 *    HELD for them, never applied by the fallback.
 *  - The fallback: in a sole-admin organisation the admin's IBAN applies at once, the request closed as
 *    applied_without_second_approver with its reason, the line on the record, and the security trail; a requester who
 *    cannot approve (a bookkeeper beside that admin) is held.
 *  - The write boundary: an IBAN inserted with the record, or changed without a matching request in the transaction, is
 *    refused by the database.
 *  - The held-change list: an employee's IBAN is decided by the employees grants (the bookkeeper its last four, a viewer
 *    nothing); a supplier's by the vendors grants (today every role reads it, until S2b).
 *  - The company's own bank details stay an admin's (DR-23): an accountant's decision on one is refused by name.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { businessToday } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s3-party-iban-hold-password-2026";
const h = g04Harness("s3-iban");
const CHANGES = "/companies/current/bank-detail-changes";

/** A valid Saudi IBAN for a 20-digit account part (the ISO 13616 check digits computed here). */
function saIban(bban: string): string {
  const n = BigInt(`${bban}281000`); // S=28 A=10, then "00"
  return `SA${String(98n - (n % 97n)).padStart(2, "0")}${bban}`;
}
const IBAN_1 = saIban("80000000608010167519");
const IBAN_2 = saIban("10000000123456789012");
const IBAN_3 = saIban("20000000987654321098");
const IBAN_4 = saIban("30000000555555555555");

type Change = { id: number; kind: string; status: string; ibanBefore?: string | null; ibanAfter?: string | null; reason: string | null; employeeId: number | null; vendorId: number | null };

const asActor = async (userId: number, sql: string, params: unknown[]) => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [String(userId)]);
    await c.query(sql, params);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
};

/** One statement as the declared actor, ALWAYS rolled back: "accepted", or "refused:<constraint>". */
const tryAsActor = async (userId: number, sql: string, params: unknown[]) => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [String(userId)]);
    const r = await c.query(sql, params);
    return r.rowCount === 1 ? "accepted" : `rowCount ${r.rowCount}`;
  } catch (e) {
    return `refused:${(e as { constraint?: string }).constraint}`;
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
};

/** Several statements in ONE transaction, each as its own declared actor, ALWAYS rolled back: "accepted", or "refused:<constraint>". */
const txAsActors = async (steps: Array<[number, string, unknown[]]>) => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const [userId, sql, params] of steps) {
      await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [String(userId)]);
      const r = await c.query(sql, params);
      if (r.rowCount !== 1) return `rowCount ${r.rowCount}`;
    }
    return "accepted";
  } catch (e) {
    return `refused:${(e as { constraint?: string }).constraint}`;
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
};

describeDb("19B S3 — a supplier's and an employee's IBAN is held (19B-S3)", () => {
  const ids: Record<string, number> = {};
  const orgs: Record<string, string> = {};

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgs.a = await h.mkOrg("a");
    await h.mkCompany(orgs.a, "S3 Two Approvers Co", "319191919191903");
    for (const [k, role] of [["admin", "admin"], ["admin2", "admin"], ["accountant", "accountant"], ["bookkeeper", "bookkeeper"], ["viewer", "viewer"]] as const) ids[k] = await h.mkUser(k, PW, orgs.a, role);
    orgs.solo = await h.mkOrg("solo");
    await h.mkCompany(orgs.solo, "S3 Sole Admin Co", "319191919191913");
    ids.soloAdmin = await h.mkUser("soloAdmin", PW, orgs.solo, "admin");
    ids.soloKeeper = await h.mkUser("soloKeeper", PW, orgs.solo, "bookkeeper");
    orgs.linked = await h.mkOrg("linked");
    await h.mkCompany(orgs.linked, "S3 Linked Approver Co", "319191919191923");
    ids.linkAdmin = await h.mkUser("linkAdmin", PW, orgs.linked, "admin");
    ids.linkAccountant = await h.mkUser("linkAccountant", PW, orgs.linked, "accountant");
    // an organisation with NO member who can approve bank details (its one member a bookkeeper)
    orgs.none = await h.mkOrg("none");
    await h.mkCompany(orgs.none, "S3 No Approver Co", "319191919191933");
    ids.noneKeeper = await h.mkUser("noneKeeper", PW, orgs.none, "bookkeeper");
    // A1: the admin CREATED the accountant's account within 30 days (the security trail's own fact)
    await pool.query(`INSERT INTO security_audit_logs (action, actor_user_id, target_user_id, organization_id) VALUES ('user.created', $1, $2, $3)`, [ids.linkAdmin, ids.linkAccountant, orgs.linked]);
    for (const k of ["admin", "admin2", "accountant", "bookkeeper", "viewer", "soloAdmin", "soloKeeper", "linkAdmin", "linkAccountant"]) expect(await h.login(k, h.email(k), PW), k).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  const ibanOf = async (table: "vendors" | "employees", id: number) => (await pool.query(`SELECT iban FROM ${table} WHERE id = $1`, [id])).rows[0]?.iban ?? null;
  const requestRow = async (id: number) => (await pool.query(`SELECT status, reason, requested_by, decided_by FROM bank_detail_change_requests WHERE id = $1`, [id])).rows[0];

  it("the matrix: bank_detail:approve is an accountant's and an admin's; every role reads the held changes", () => {
    const has = (role: string, action: string) => PERMISSION_MATRIX.some((r) => r.role === role && r.resource === "bank_detail" && r.action === action);
    expect(["admin", "accountant", "bookkeeper", "viewer"].map((r) => has(r, "approve"))).toEqual([true, true, false, false]);
    expect(["admin", "accountant", "bookkeeper", "viewer"].map((r) => has(r, "read"))).toEqual([true, true, true, true]);
  });

  it("🔴 entry holds: a supplier created WITH an IBAN is created without it, and the IBAN waits", async () => {
    const r = await h.api("admin", "POST", "/vendors", { name: "S3 Supplier One", iban: IBAN_1 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ids.v1 = r.body.id;
    expect([r.body.iban, r.body.ibanPending]).toEqual([null, true]);
    expect(r.body.pendingBankDetailChanges).toEqual([expect.objectContaining({ kind: "vendor_iban", status: "pending", ibanBefore: null, ibanAfter: IBAN_1, vendorId: ids.v1 })]);
    ids.req1 = r.body.pendingBankDetailChanges[0].id;
    expect(await ibanOf("vendors", ids.v1)).toBeNull();
  });

  it("🔴 entry holds: a supplier's IBAN CHANGE waits too, and a second change while one waits is refused by name", async () => {
    const created = await h.api("accountant", "POST", "/vendors", { name: "S3 Supplier Two" });
    ids.v2 = created.body.id;
    const r = await h.api("accountant", "PATCH", `/vendors/${ids.v2}`, { iban: IBAN_2, city: "Riyadh" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect([r.body.iban, r.body.city, r.body.ibanPending]).toEqual([null, "Riyadh", true]); // the rest is written
    ids.req2 = r.body.pendingBankDetailChanges[0].id;
    const again = await h.api("accountant", "PATCH", `/vendors/${ids.v2}`, { iban: IBAN_3 });
    expect([again.status, again.body.code]).toEqual([409, "bank_detail_change_pending"]);
    expect(await ibanOf("vendors", ids.v2)).toBeNull();
  });

  it("🔴 entry holds: a BOOKKEEPER's employee IBAN waits, and the bookkeeper is shown it as its last four only", async () => {
    const r = await h.api("bookkeeper", "POST", "/employees", { employeeNumber: "S3-E1", name: "S3 Employee", iban: IBAN_4 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ids.e1 = r.body.id;
    expect(r.body.ibanPending).toBe(true);
    expect(r.body.pendingBankDetailChanges).toEqual([expect.objectContaining({ kind: "employee_iban", status: "pending", employeeId: ids.e1, ibanAfter: `•••• ${IBAN_4.slice(-4)}` })]);
    ids.reqE = r.body.pendingBankDetailChanges[0].id;
    expect(await ibanOf("employees", ids.e1)).toBeNull();
    // entered on the create form: marked so, like a supplier's (the mark that keeps a first IBAN from reading as a change)
    expect((await pool.query(`SELECT at_creation FROM bank_detail_change_requests WHERE id = $1`, [ids.reqE])).rows[0].at_creation).toBe(true);
  });

  it("🔴 approve: the requester is refused; a bookkeeper and a viewer are refused at the API; nothing applies", async () => {
    const own = await h.api("admin", "PUT", `${CHANGES}/${ids.req1}/decision`, { decision: "approve" });
    expect([own.status, own.body.code]).toEqual([409, "second_admin_required"]);
    for (const who of ["bookkeeper", "viewer"]) {
      const r = await h.api(who, "PUT", `${CHANGES}/${ids.req1}/decision`, { decision: "approve" });
      expect([who, r.status, r.body.code]).toEqual([who, 403, "requires_approval_authority"]);
    }
    expect([await ibanOf("vendors", ids.v1), (await requestRow(ids.req1)).status]).toEqual([null, "pending"]);
  });

  it("🔴 the database refuses a non-approver's decision made around the API (a bookkeeper's, directly)", async () => {
    await expect(asActor(ids.bookkeeper, `UPDATE bank_detail_change_requests SET status = 'approved', decided_by = $1, decided_at = now() WHERE id = $2`, [ids.bookkeeper, ids.req1]))
      .rejects.toMatchObject({ constraint: "bank_detail_change_second_admin" });
    expect((await requestRow(ids.req1)).status).toBe("pending");
  });

  it("🔴 approve: an accountant who did not ask approves a supplier's IBAN and an employee's — each applies", async () => {
    const v = await h.api("accountant", "PUT", `${CHANGES}/${ids.req1}/decision`, { decision: "approve" });
    expect([v.status, v.body.status], JSON.stringify(v.body)).toEqual([200, "approved"]);
    expect(await ibanOf("vendors", ids.v1)).toBe(IBAN_1);
    const e = await h.api("accountant", "PUT", `${CHANGES}/${ids.reqE}/decision`, { decision: "approve" });
    expect([e.status, e.body.status], JSON.stringify(e.body)).toEqual([200, "approved"]);
    expect(await ibanOf("employees", ids.e1)).toBe(IBAN_4);
    const after = await h.api("bookkeeper", "GET", `/employees/${ids.e1}`);
    expect([after.body.iban, after.body.ibanPending]).toEqual([`•••• ${IBAN_4.slice(-4)}`, false]);
  });

  it("🔴 the write boundary: an IBAN inserted with the record, or changed without a request in the transaction, is refused", async () => {
    await expect(asActor(ids.admin, `UPDATE vendors SET iban = $1 WHERE id = $2`, [IBAN_3, ids.v1])).rejects.toMatchObject({ constraint: "party_iban_hold" });
    await expect(asActor(ids.admin, `UPDATE employees SET iban = $1 WHERE id = $2`, [IBAN_3, ids.e1])).rejects.toMatchObject({ constraint: "party_iban_hold" });
    await expect(asActor(ids.admin, `INSERT INTO vendors (organization_id, name, iban) SELECT organization_id, 'S3 Smuggled', $1 FROM vendors WHERE id = $2`, [IBAN_3, ids.v1]))
      .rejects.toMatchObject({ constraint: "party_iban_hold" });
    await expect(asActor(ids.admin, `INSERT INTO employees (organization_id, company_id, employee_number, name, iban) SELECT organization_id, company_id, 'S3-SMUG', 'S3 Smuggled', $1 FROM employees WHERE id = $2`, [IBAN_3, ids.e1]))
      .rejects.toMatchObject({ constraint: "party_iban_hold" });
    expect([await ibanOf("vendors", ids.v1), await ibanOf("employees", ids.e1)]).toEqual([IBAN_1, IBAN_4]); // presence: the approved ones stand
  });

  it("🔴 the held-change list: an employee's IBAN is the bookkeeper's last four and absent for a viewer; a supplier's as the vendors grants say", async () => {
    const keeper = await h.api("bookkeeper", "GET", CHANGES);
    const viewer = await h.api("viewer", "GET", CHANGES);
    const admin = await h.api("admin", "GET", CHANGES);
    const pick = (r: { body: { items: Change[] } }, id: number) => r.body.items.find((c) => c.id === id)!;
    expect(pick(keeper, ids.reqE).ibanAfter).toBe(`•••• ${IBAN_4.slice(-4)}`);
    expect("ibanAfter" in pick(viewer, ids.reqE)).toBe(false);
    expect(pick(admin, ids.reqE).ibanAfter).toBe(IBAN_4); // movement: an approver reads it
    // restated for S2b's removal (v4 §6.1): a supplier's IBAN now follows the same rule — the bookkeeper's last four, absent for a viewer
    expect(pick(keeper, ids.req1).ibanAfter).toBe(`•••• ${IBAN_1.slice(-4)}`);
    expect("ibanAfter" in pick(viewer, ids.req1)).toBe(false);
    expect(pick(admin, ids.req1).ibanAfter).toBe(IBAN_1); // movement: an approver reads it
  });

  it("🔴 the fallback: a sole admin's IBAN applies at once — the request closed, its reason, the record's line, the security trail", async () => {
    const r = await h.api("soloAdmin", "POST", "/vendors", { name: "S3 Solo Supplier", iban: IBAN_2 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect([r.body.iban, r.body.ibanPending, r.body.pendingBankDetailChanges]).toEqual([IBAN_2, false, []]);
    expect(r.body.ibanAppliedWithoutSecondApprover).toEqual({ at: expect.any(String), byName: expect.any(String) });
    const row = (await pool.query(`SELECT id, status, reason, requested_by, decided_by FROM bank_detail_change_requests WHERE vendor_id = $1`, [r.body.id])).rows;
    expect(row).toEqual([expect.objectContaining({ status: "applied_without_second_approver", reason: "no other member holds a role that can approve bank details", requested_by: ids.soloAdmin, decided_by: ids.soloAdmin })]);
    await expect.poll(async () => (await pool.query(`SELECT count(*)::int n FROM security_audit_logs WHERE action = 'bank_detail.applied_without_second_approver' AND actor_user_id = $1 AND metadata->>'requestId' = $2`, [ids.soloAdmin, String(row[0].id)])).rows[0].n).toBe(1);
    const detail = await h.api("soloAdmin", "GET", `/vendors/${r.body.id}`);
    expect(detail.body.ibanAppliedWithoutSecondApprover?.byName).toBeTruthy();
  });

  it("🔴 not the fallback: a requester who cannot approve (a bookkeeper beside the sole admin) is held", async () => {
    const r = await h.api("soloKeeper", "POST", "/employees", { employeeNumber: "S3-SOLO-E", name: "S3 Solo Employee", iban: IBAN_3 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect([r.body.ibanPending, r.body.pendingBankDetailChanges.length]).toEqual([true, 1]);
    expect(await ibanOf("employees", r.body.id)).toBeNull();
  });

  // Without this the guard's two fallback refusals were invisible: the service never asks for a fallback it should not
  // get, so nothing reached the database's backstop (mutants D2/D3, 2026-11-23).
  it("🔴 the database's own fallback rule, no service in front: accepted to the sole approver; refused to a requester who cannot approve, and where another approver exists", async () => {
    const bare = async (who: string) => { const r = await h.api(who, "POST", "/vendors", { name: `S3 Bare ${who}` }); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body.id as number; };
    const soloVendor = await bare("soloAdmin");
    const aVendor = await bare("admin");
    const fallback = (vendorId: number, actor: number) => tryAsActor(actor,
      `INSERT INTO bank_detail_change_requests (organization_id, company_id, kind, vendor_id, iban_before, iban_after, status, requested_by, decided_by, decided_at, reason)
       SELECT v.organization_id, c.id, 'vendor_iban', v.id, NULL, $3, 'applied_without_second_approver', $2, $2, now(), 'no other member holds a role that can approve bank details'
         FROM vendors v JOIN companies c ON c.organization_id = v.organization_id WHERE v.id = $1 ORDER BY c.id LIMIT 1`, [vendorId, actor, IBAN_4]);
    expect(await fallback(soloVendor, ids.soloAdmin)).toBe("accepted"); // control: the one member who could approve it
    expect(await fallback(soloVendor, ids.soloKeeper)).toBe("refused:bank_detail_fallback_not_sole_approver"); // cannot approve
    expect(await fallback(aVendor, ids.admin)).toBe("refused:bank_detail_fallback_not_sole_approver"); // others can
    // where NO member can approve, the other rule has nothing to see: only "the requester cannot approve" refuses (D3)
    const noneVendor = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1, 'S3 None Supplier') RETURNING id`, [orgs.none])).rows[0].id as number;
    expect((await pool.query(`SELECT count(*)::int n FROM org_bank_detail_approver_ids($1)`, [orgs.none])).rows[0].n).toBe(0);
    expect(await fallback(noneVendor, ids.noneKeeper)).toBe("refused:bank_detail_fallback_not_sole_approver");
    expect((await pool.query(`SELECT count(*)::int n FROM bank_detail_change_requests WHERE vendor_id = ANY($1)`, [[soloVendor, aVendor, noneVendor]])).rows[0].n).toBe(0);
  });

  it("🔴 not the fallback, and refused to approve: an approver the requester created within 30 days (A1) still counts — the IBAN waits", async () => {
    const r = await h.api("linkAdmin", "POST", "/vendors", { name: "S3 Linked Supplier", iban: IBAN_3 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect([r.body.iban, r.body.ibanPending]).toEqual([null, true]);
    const d = await h.api("linkAccountant", "PUT", `${CHANGES}/${r.body.pendingBankDetailChanges[0].id}/decision`, { decision: "approve" });
    expect([d.status, d.body.code]).toEqual([409, "bank_detail_approver_linked"]);
    expect(await ibanOf("vendors", r.body.id)).toBeNull();
  });

  it("the company's own bank details stay an admin's (DR-23): an accountant's decision is refused by name; a second admin approves", async () => {
    const acct = await h.api("admin", "POST", "/bank-accounts", { name: "S3 Main", bankName: "SNB", currency: "SAR" });
    expect(acct.status, JSON.stringify(acct.body)).toBe(201);
    const held = await h.api("admin", "PATCH", `/bank-accounts/${acct.body.id}`, { iban: IBAN_4 });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const reqId = held.body.pendingBankDetailChanges[0].id as number;
    const byAccountant = await h.api("accountant", "PUT", `${CHANGES}/${reqId}/decision`, { decision: "approve" });
    expect([byAccountant.status, byAccountant.body.code]).toEqual([403, "bank_detail_change_admin_only"]);
    const byAdmin2 = await h.api("admin2", "PUT", `${CHANGES}/${reqId}/decision`, { decision: "approve" });
    expect([byAdmin2.status, byAdmin2.body.status]).toEqual([200, "approved"]);
  });

  // 🔴 S3 must not change what H-9 / A23's change-then-pay finding counts (owner decisions): before S3 an IBAN entered
  // WITH the supplier was written in its creation and was never a change; one given later, and a change, were.
  it("🔴 the change-then-pay finding is as before S3: an IBAN entered with the supplier is not a change; one given later is, and so is a change", async () => {
    expect((await h.api("admin", "PUT", "/companies/current/control-settings", { bankChangePaymentWindowDays: 7 })).status).toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "S3 Payments", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    const today = businessToday();
    let seq = 0;
    const pay = async (vendorId: number) => {
      seq += 1;
      const b = await h.api("admin", "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: `S3-W-${seq}`, billNumber: `S3-W-${seq}`, date: today, dueDate: today, vendorId,
        items: [{ description: "Supplies", quantity: 1, unitPrice: 100, vatRate: 0 }] });
      expect(b.status, JSON.stringify(b.body)).toBe(201);
      expect((await h.api("admin", "POST", `/bills/${b.body.id}/approve`, {})).status).toBe(200);
      const p = await h.api("admin", "POST", `/bills/${b.body.id}/pay`, { amount: 100, paidAt: today, bankAccountId: bank.body.id });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
    };
    const approveHeld = async (r: { status: number; body: any }) => {
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
      const id = (r.body.pendingBankDetailChanges as Change[])[0]!.id;
      expect((await h.api("accountant", "PUT", `${CHANGES}/${id}/decision`, { decision: "approve" })).status).toBe(200);
    };
    const steady = await h.api("admin", "POST", "/vendors", { name: "S3 Steady Supplier", residency: "resident", iban: IBAN_1 });
    await approveHeld(steady);
    const later = await h.api("admin", "POST", "/vendors", { name: "S3 Later Supplier", residency: "resident" });
    await approveHeld(await h.api("admin", "PATCH", `/vendors/${later.body.id}`, { iban: IBAN_2 }));
    const changed = await h.api("admin", "POST", "/vendors", { name: "S3 Changed Supplier", residency: "resident", iban: IBAN_3 });
    await approveHeld(changed);
    await approveHeld(await h.api("admin", "PATCH", `/vendors/${changed.body.id}`, { iban: IBAN_4 }));
    const three = [steady.body.id, later.body.id, changed.body.id] as number[];
    expect([await ibanOf("vendors", three[0]!), await ibanOf("vendors", three[1]!), await ibanOf("vendors", three[2]!)]).toEqual([IBAN_1, IBAN_2, IBAN_4]);
    for (const v of three) await pay(v); // each paid today: the steady one too, so its absence below is not for want of a payment
    const f = await h.api("admin", "GET", "/companies/current/control-findings/payment-after-bank-change");
    expect([f.status, f.body.enabled], JSON.stringify(f.body)).toEqual([200, true]);
    const listed = new Set((f.body.items as { vendorId: number }[]).map((i) => i.vendorId));
    expect(three.map((v) => listed.has(v))).toEqual([false, true, true]);
    const marks = (await pool.query(`SELECT vendor_id, at_creation FROM bank_detail_change_requests WHERE vendor_id = ANY($1) ORDER BY id`, [three])).rows;
    expect(marks.map((m) => [m.vendor_id, m.at_creation])).toEqual([[three[0], true], [three[1], false], [three[2], true], [three[2], false]]);
  });

  it("🔴 the database: `at_creation` marks only a supplier's or employee's FIRST IBAN, and is fixed once written", async () => {
    const co = (await pool.query(`SELECT company_id FROM bank_detail_change_requests WHERE id = $1`, [ids.req2])).rows[0].company_id;
    const account = (await pool.query(`SELECT id FROM bank_accounts WHERE organization_id = $1 ORDER BY id LIMIT 1`, [orgs.a])).rows[0].id as number;
    const insert = (kind: string, subject: "vendor_id" | "bank_account_id", before: string | null) => asActor(ids.admin,
      `INSERT INTO bank_detail_change_requests (organization_id, company_id, kind, ${subject}, iban_before, iban_after, requested_by, at_creation) VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [orgs.a, co, kind, subject === "vendor_id" ? ids.v1 : account, before, IBAN_2, ids.admin]);
    await expect(insert("vendor_iban", "vendor_id", IBAN_1)).rejects.toMatchObject({ constraint: "bank_detail_change_at_creation_chk" });
    await expect(insert("bank_account_iban", "bank_account_id", null)).rejects.toMatchObject({ constraint: "bank_detail_change_at_creation_chk" });
    // req2 is a pending CHANGE (not at creation) of a supplier with no IBAN: the check would allow the mark, the guard does not.
    // A valid decision (the admin rejects it) is accepted ALONE — rolled back — and refused when it also sets the mark, so
    // the refusal is the mark's (mutant D4 survived the first form of this test, refused by an unrelated rule).
    const decision = `UPDATE bank_detail_change_requests SET status = 'rejected', decided_by = $2, decided_at = now()`;
    expect(await tryAsActor(ids.admin, `${decision} WHERE id = $1`, [ids.req2, ids.admin])).toBe("accepted");
    expect(await tryAsActor(ids.admin, `${decision}, at_creation = true WHERE id = $1`, [ids.req2, ids.admin])).toBe("refused:bank_detail_change_request_flow");
    expect((await pool.query(`SELECT at_creation, status FROM bank_detail_change_requests WHERE id = $1`, [ids.req2])).rows[0]).toEqual({ at_creation: false, status: "pending" });
  });

  // Without this, a decision let ANY member write the IBAN in its transaction (mutants T4/T5 survived, 2026-11-23).
  it("🔴 the write boundary: in the decision's transaction only its approver — or the fallback's own requester — writes the IBAN", async () => {
    const held = await h.api("accountant", "POST", "/vendors", { name: "S3 Same Transaction Supplier", iban: IBAN_3 });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    const reqId = (held.body.pendingBankDetailChanges as Change[])[0]!.id;
    const approve: [number, string, unknown[]] = [ids.admin2, `UPDATE bank_detail_change_requests SET status = 'approved', decided_by = $1, decided_at = now() WHERE id = $2`, [ids.admin2, reqId]];
    const write = (who: number): [number, string, unknown[]] => [who, `UPDATE vendors SET iban = $1 WHERE id = $2`, [IBAN_3, held.body.id]];
    expect(await txAsActors([approve, write(ids.admin2)])).toBe("accepted"); // control: the approver
    expect(await txAsActors([approve, write(ids.bookkeeper)])).toBe("refused:party_iban_hold");
    expect(await txAsActors([approve, write(ids.accountant)])).toBe("refused:party_iban_hold"); // not even the requester

    const solo = await h.api("soloAdmin", "POST", "/vendors", { name: "S3 Same Transaction Solo" });
    expect(solo.status, JSON.stringify(solo.body)).toBe(201);
    const fallback: [number, string, unknown[]] = [ids.soloAdmin,
      `INSERT INTO bank_detail_change_requests (organization_id, company_id, kind, vendor_id, iban_before, iban_after, status, requested_by, decided_by, decided_at, reason)
       SELECT v.organization_id, c.id, 'vendor_iban', v.id, NULL, $2, 'applied_without_second_approver', $3, $3, now(), 'no other member holds a role that can approve bank details'
         FROM vendors v JOIN companies c ON c.organization_id = v.organization_id WHERE v.id = $1 ORDER BY c.id LIMIT 1`, [solo.body.id, IBAN_4, ids.soloAdmin]];
    const writeSolo = (who: number): [number, string, unknown[]] => [who, `UPDATE vendors SET iban = $1 WHERE id = $2`, [IBAN_4, solo.body.id]];
    expect(await txAsActors([fallback, writeSolo(ids.soloAdmin)])).toBe("accepted"); // control: the fallback's requester
    expect(await txAsActors([fallback, writeSolo(ids.soloKeeper)])).toBe("refused:party_iban_hold");

    expect([await ibanOf("vendors", held.body.id), await ibanOf("vendors", solo.body.id), (await requestRow(reqId)).status]).toEqual([null, null, "pending"]); // all rolled back
  });

  // LAST: it blocks admin2 as an approver for 30 days.
  it("🔴 an approver whose second factor was reset within 30 days is refused (0166's rule, kept for the party kinds)", async () => {
    await pool.query(`INSERT INTO security_audit_logs (action, actor_user_id, target_user_id, organization_id) VALUES ('mfa.reset', NULL, $1, $2)`, [ids.admin2, orgs.a]);
    const r = await h.api("admin2", "PUT", `${CHANGES}/${ids.req2}/decision`, { decision: "approve" });
    expect([r.status, r.body.code]).toEqual([409, "bank_detail_approver_mfa_reset"]);
    expect(await ibanOf("vendors", ids.v2)).toBeNull();
  });
});
