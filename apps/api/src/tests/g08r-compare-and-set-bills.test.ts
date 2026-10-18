/**
 * 🔴 G08 residuals, PR A — the BILL races the B-G08R-P proofs did not cover:
 *
 *  1. a 15%-VAT bill (a tax invoice from a VAT-registered supplier, so its VAT
 *     is claimed and its approval writes input-VAT events and balances that
 *     reference the bill): two approvals at once; a
 *     reject, a DELETE and a send-back queued behind an approval; an approval
 *     behind a reject. The proofs used zero-VAT bills only;
 *  2. M2 — a bill removed before its approval's first write that references
 *     it (an evidence capture attached at approval): the approval answers 409
 *     "rejected or deleted while it was being approved", never 422
 *     `reference_not_found`, and nothing is posted;
 *  3. a supplier ADVANCE invoice (its own entry `BILLADV-…`): two approvals at
 *     once (M1: the duplicate of its OWN entry number becomes the sequential
 *     "already approved"), and a reject behind an approval.
 *
 * Forced with `helpers/g08rRace.ts`. M2 is forced by a holder that SQUATS the
 * bill's entry number in an uncommitted transaction, so the approval is seen
 * waiting on that key while the reject commits. DB-backed; skips on the
 * DB-free placeholder.
 */
process.env.PORT ??= "3182";
process.env.SESSION_SECRET ??= "g08r-cas-bills-regression-0000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { auditsOf, brief, entriesNumbered, lockWaiters, queuedBehind, statuses, until } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G08rCasPw123!";
const DATE = "2026-10-05";
const ALREADY_APPROVED = "This bill is already approved.";
const GONE_WHILE_APPROVING = "This bill was rejected or deleted while it was being approved — nothing was posted.";

describeMaybe("G08 residuals, PR A — VAT-bearing bills, M2, and supplier advance invoices", () => {
  const h = g04Harness("g08rcas2");
  let orgId = "";
  let companyId = "";
  let vendorId = 0;
  let bankId = 0;
  let n = 0;
  const next = () => String(++n).padStart(3, "0");
  type Bill = { id: number; no: string };

  async function draftBill(vatRate: number): Promise<Bill> {
    const no = `CAS2-BL-${next()}`;
    const r = await h.api("bookkeeper", "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: `VR-${no}`, billNumber: no, date: DATE, dueDate: DATE, vendorId, items: [{ description: "Supply", quantity: 1, unitPrice: 1_000, vatRate }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: r.body.id, no };
  }
  async function evidence(b: Bill, prefix = "BILL") {
    const row = (await pool.query(`SELECT status, input_vat_state, input_vat_pending::text AS pending FROM bills WHERE id = $1`, [b.id])).rows[0] ?? null;
    const events = Number((await pool.query(`SELECT count(*)::int AS n FROM input_vat_events WHERE document_id = $1`, [b.id])).rows[0].n);
    return { bill: row, events, gl: await entriesNumbered(orgId, `${prefix}-${b.no}`), audits: await auditsOf(orgId, "bill", b.id) };
  }
  const approve = (who: string, id: number, body: Record<string, unknown> = {}) => () => h.api(who, "POST", `/bills/${id}/approve`, body);
  const reject = (id: number) => () => h.api("accountant", "POST", `/bills/${id}/reject`, {});
  const del = (id: number) => () => h.api("admin", "DELETE", `/bills/${id}`);
  const submit = (id: number) => () => h.api("bookkeeper", "POST", `/bills/${id}/submit`, {});
  const sendBack = (id: number) => () => h.api("accountant", "POST", `/bills/${id}/send-back`, { note: "correct it" });
  const log = (label: string, data: unknown) => console.warn(`[G08R-CAS2] ${label}`, JSON.stringify(data)); // eslint-disable-line no-console
  const stagedCapture = async () => (await pool.query(
    `INSERT INTO captured_documents (organization_id, company_id, content_type, byte_size, sha256, source, status)
     VALUES ($1,$2,'application/pdf',1024,$3,'upload','staged') RETURNING id`,
    [orgId, companyId, `${"ab".repeat(31)}${String(n).padStart(2, "0")}`],
  )).rows[0].id as string;

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "CAS2 Co", "318181818181882");
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'CAS2 Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    bankId = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'CAS2 Bank','SNB') RETURNING id`, [orgId, companyId])).rows[0].id;
    for (const [who, role] of [["admin", "admin"], ["accountant", "accountant"], ["bookkeeper", "bookkeeper"]]) await h.mkUser(who, PW, orgId, role);
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  // ── 1. a 15%-VAT bill ──────────────────────────────────────────────────────
  it("PREMISE: a 15%-VAT bill approves on its own; its VAT is claimed and its approval writes input-VAT events that reference it", async () => {
    const b = await draftBill(15);
    const ok = await approve("admin", b.id)();
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const ev = await evidence(b);
    expect(ev.bill?.status).toBe("received");
    expect(ev.bill?.input_vat_state).toBe("claimed");
    expect(ev.bill?.pending).toBe("0.00");
    expect(ev.events, "the approval wrote input-VAT events referencing the bill").toBeGreaterThan(0);
    expect(ev.gl).toHaveLength(1);
  }, 60_000);

  it("🔴 15%-VAT bill — two approvals at once: one 200, the other the sequential 409 \"already approved\"; one entry, one set of events", async () => {
    const b = await draftBill(15);
    const rs = await queuedBehind("bills", b.id, [approve("admin", b.id), approve("accountant", b.id)]);
    const ev = await evidence(b);
    log("vat double approve", { results: rs.map(brief), ...ev });
    expect(statuses(rs)).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)?.body?.error).toBe(ALREADY_APPROVED);
    expect(ev.gl).toHaveLength(1);
    expect(ev.audits.filter((a) => a.startsWith("approve:"))).toEqual(["approve:1"]);
  }, 60_000);

  for (const [label, loser, message] of [
    ["REJECT", reject, "An approved bill cannot be rejected — reverse it instead."],
    ["DELETE", del, "Only draft bills can be deleted."],
  ] as const) {
    it(`🔴 15%-VAT bill — a ${label} queued behind an approval: the approval 200, the ${label.toLowerCase()} 409; the posted bill, its events and its entry survive`, async () => {
      const b = await draftBill(15);
      const [ap, lost] = await queuedBehind("bills", b.id, [approve("admin", b.id), loser(b.id)]);
      const ev = await evidence(b);
      log(`vat ${label.toLowerCase()} behind approve`, { approve: brief(ap), lost: brief(lost), ...ev });
      expect(ap.status).toBe(200);
      expect(lost.status).toBe(409);
      expect(lost.body?.error).toBe(message);
      expect(ev.bill?.status).toBe("received");
      expect(ev.events).toBeGreaterThan(0);
      expect(ev.gl.map((g) => g.status)).toEqual(["posted"]);
    }, 60_000);
  }

  it("🔴 15%-VAT bill — a SEND-BACK queued behind an approval: the send-back 409 \"Only a submitted bill can be sent back.\", never a 500; the bill stays posted", async () => {
    const b = await draftBill(15);
    expect((await submit(b.id)()).status).toBe(200);
    const [ap, back] = await queuedBehind("bills", b.id, [approve("admin", b.id), sendBack(b.id)]);
    const ev = await evidence(b);
    log("vat send-back behind approve", { approve: brief(ap), sendBack: brief(back), ...ev });
    expect(ap.status).toBe(200);
    expect(back.status).toBe(409);
    expect(back.body?.error).toBe("Only a submitted bill can be sent back.");
    expect(ev.bill?.status).toBe("received");
  }, 60_000);

  it("🔴 15%-VAT bill — an approval behind a REJECT: the reject 204, the approval 409; no entry, no input-VAT event", async () => {
    const b = await draftBill(15);
    const [rej, ap] = await queuedBehind("bills", b.id, [reject(b.id), approve("admin", b.id)]);
    const ev = await evidence(b);
    log("vat approve behind reject", { reject: brief(rej), approve: brief(ap), ...ev });
    expect(rej.status).toBe(204);
    expect(ap.status).toBe(409);
    expect(ap.body?.error).toBe(GONE_WHILE_APPROVING);
    expect(ev.bill).toBeNull();
    expect(ev.events).toBe(0);
    expect(ev.gl).toHaveLength(0);
  }, 60_000);

  // ── 2. M2 ──────────────────────────────────────────────────────────────────
  it("PREMISE (M2): an approval that names a staged capture attaches it — the capture path the race below runs through is live", async () => {
    const b = await draftBill(0);
    const capture = await stagedCapture();
    const ok = await approve("admin", b.id, { captureId: capture })();
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const row = (await pool.query(`SELECT status, bill_id FROM captured_documents WHERE id = $1`, [capture])).rows[0];
    expect([row.status, row.bill_id]).toEqual(["promotion_pending", b.id]);
  }, 60_000);

  it("🔴 M2 — the bill is rejected while its approval waits, before the approval attaches its capture: the approval 409 \"rejected or deleted while it was being approved\" (never 422); nothing posted; the capture stays staged", async () => {
    const b = await draftBill(0);
    const capture = await stagedCapture();
    const holder = await pool.connect();
    let open = false;
    let ap!: Awaited<ReturnType<ReturnType<typeof approve>>>;
    let rej!: Awaited<ReturnType<ReturnType<typeof reject>>>;
    try {
      await holder.query("BEGIN");
      open = true;
      const holderPid = Number((await holder.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      // Squat the bill's own entry number: the approval is held at its entry insert, before it touches the bill.
      await holder.query(`INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status) VALUES ($1,$2,$3,$4,'M2 squat','draft')`, [orgId, companyId, `BILL-${b.no}`, DATE]);
      const approving = approve("admin", b.id, { captureId: capture })();
      await until("the approval did not wait on its entry number", async () => (await lockWaiters(holderPid)) >= 1);
      rej = await reject(b.id)();
      await holder.query("ROLLBACK");
      open = false;
      ap = await approving;
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
    }
    const cap = (await pool.query(`SELECT status, bill_id FROM captured_documents WHERE id = $1`, [capture])).rows[0];
    const ev = await evidence(b);
    log("M2 approve after reject", { reject: brief(rej), approve: brief(ap), capture: cap, ...ev });
    expect(rej.status).toBe(204);
    expect(ap.status).toBe(409);
    expect(ap.body?.error).toBe(GONE_WHILE_APPROVING);
    expect(ev.gl, "nothing posted").toHaveLength(0);
    expect([cap.status, cap.bill_id], "the capture is untouched").toEqual(["staged", null]);
  }, 60_000);

  // ── 3. a supplier advance invoice ─────────────────────────────────────────
  async function draftAdvanceInvoice(): Promise<Bill> {
    const p = await h.api("admin", "POST", "/supplier-payments", { vendorId, bankAccountId: bankId, amount: 1_150, paidAt: DATE, classification: "advance" });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const d = await h.api("admin", "POST", `/supplier-payments/${p.body.id}/advance-invoices`, { amount: 1_150, date: DATE, vendorReference: `ADV-${next()}` });
    expect([200, 201], JSON.stringify(d.body)).toContain(d.status);
    return { id: d.body.id, no: d.body.billNumber };
  }

  it("🔴 SUPPLIER ADVANCE INVOICE — two approvals at once: one 200, the other the sequential 409 \"already approved\" (M1 on its own BILLADV- entry); one entry", async () => {
    const a = await draftAdvanceInvoice();
    const rs = await queuedBehind("bills", a.id, [approve("admin", a.id), approve("accountant", a.id)]);
    const ev = await evidence(a, "BILLADV");
    log("advance double approve", { results: rs.map(brief), ...ev });
    expect(statuses(rs)).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)?.body?.error).toBe(ALREADY_APPROVED);
    expect(ev.gl).toHaveLength(1);
  }, 60_000);

  it("🔴 SUPPLIER ADVANCE INVOICE — a REJECT queued behind an approval: the reject 409; the advance invoice survives posted with its entry", async () => {
    const a = await draftAdvanceInvoice();
    const [ap, rej] = await queuedBehind("bills", a.id, [approve("admin", a.id), reject(a.id)]);
    const ev = await evidence(a, "BILLADV");
    log("advance reject behind approve", { approve: brief(ap), reject: brief(rej), ...ev });
    expect(ap.status).toBe(200);
    expect(rej.status).toBe(409);
    expect(rej.body?.error).toBe("An approved bill cannot be rejected — reverse it instead.");
    expect(ev.bill?.status).not.toBeNull();
    expect(ev.gl.map((g) => g.status)).toEqual(["posted"]);
  }, 60_000);
});
