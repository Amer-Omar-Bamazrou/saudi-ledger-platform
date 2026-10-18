/**
 * 🔴 B-G08R-P (b) — PROOF ONLY (owner-approved 2026-10-18). Known-failing BY DESIGN
 * while a defect exists: every assertion states the CORRECT behaviour, so a red
 * test is the evidence. No product code is changed by this file.
 *
 * Residual R4 (register DR-49): every forced G08 race so far ran in a company
 * with NO ZATCA credential, where issuance skips the e-invoice. An ONBOARDED
 * company also builds, signs and queues the UBL document (`einvoice_documents`,
 * the legal chain) inside the same sequence lock. The same races, forced the
 * same way (`g08-invoice-approval-race.test.ts`), on an onboarded company:
 *   - two approvals at once; a reject queued behind an approval; an approval
 *     that loses to a reject at the sequence lock (the G08 (a)/(b) shapes);
 *   - R2: a send-back, and a submit, queued behind an approval, then a PATCH;
 *   - the legal chain afterwards: one document per issued invoice, contiguous.
 * Soft assertions, so every consequence is reported, not only the first.
 *
 * Onboarding is the established test fixture (`invoice-icv-concurrency.test.ts`):
 * a sandbox credential activated with a SELF-SIGNED certificate, signed under
 * the local-dev KMS. Stand-ins, named: no real PCSID, no ZATCA call, and the
 * outbox worker is not running (nothing is transmitted).
 *
 * DB-backed (sl_test); skips on the DB-free placeholder. Run through the pre-flight gate.
 */

process.env.PORT ??= "3172";
process.env.SESSION_SECRET ??= "g08r-b-onboarded-proof-00000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness, type Res } from "./helpers/g04Harness";
import { signingService } from "../services/einvoice/signing/signing.service";
import { GENESIS_PIH } from "../services/einvoice/crypto/invoiceHash";
import type { ZatcaCsrInput } from "../services/einvoice/crypto/csr";
import { selfSignedCertificate } from "./helpers/selfSignedCert";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "G08rProofPw123!";
const VAT = "399999999999987";
const REMOVED_WHILE_APPROVING = "This invoice was rejected or deleted while it was being approved — nothing was issued.";
const EDIT = { items: [{ description: "Edited after issue", quantity: 1, unitPrice: 9_999, vatRate: 15 }] };

describeMaybe("B-G08R-P (b) — the G08 races on a ZATCA-ONBOARDED company", () => {
  const h = g04Harness("g08rb");
  let orgId = "";
  let companyId = "";
  let customerId = 0;
  let seq = 0;
  const sequential = { approveAgain: "", rejectIssued: "", submitIssued: "", sendBackIssued: "", patchIssued: "" };

  type Inv = { id: number; no: string };

  async function draftInvoice(unitPrice = 1_000): Promise<Inv> {
    seq += 1;
    const no = `G08RB-INV-${String(seq).padStart(3, "0")}`;
    const created = await h.api("bookkeeper", "POST", "/invoices", {
      invoiceNumber: no, date: "2026-10-05", customerId,
      items: [{ description: "Service", quantity: 1, unitPrice, vatRate: 15 }],
    });
    expect(created.status, `create invoice ${no}: ${JSON.stringify(created.body)}`).toBe(201);
    return { id: created.body.id as number, no };
  }

  const maxIcv = async () => Number((await pool.query(`SELECT coalesce(max(icv), 0)::int AS m FROM invoices WHERE company_id = $1`, [companyId])).rows[0].m);
  async function missingIcvsAbove(from: number): Promise<number[]> {
    const icvs = new Set((await pool.query(`SELECT icv FROM invoices WHERE company_id = $1 AND icv > $2`, [companyId, from])).rows.map((r) => Number(r.icv)));
    const top = Math.max(from, ...icvs);
    const missing: number[] = [];
    for (let i = from + 1; i <= top; i++) if (!icvs.has(i)) missing.push(i);
    return missing;
  }

  async function evidence(inv: Inv) {
    const row = (await pool.query(
      `SELECT status, icv, (invoice_hash IS NOT NULL) AS issued, total::text FROM invoices WHERE id = $1`, [inv.id],
    )).rows[0] ?? null;
    const docs = (await pool.query(`SELECT id, status FROM einvoice_documents WHERE invoice_id = $1 ORDER BY id`, [inv.id])).rows;
    const gl = (await pool.query(
      `SELECT je.id, je.status, coalesce(sum(l.debit_amount), 0)::text AS debits
         FROM journal_entries je LEFT JOIN journal_entry_lines l ON l.journal_entry_id = je.id
        WHERE je.organization_id = $1 AND je.entry_number = $2 GROUP BY je.id, je.status`, [orgId, `GL-${inv.no}`],
    )).rows;
    const audits = (await pool.query(
      `SELECT action, count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND entity_type = 'invoice' AND entity_id = $2 GROUP BY action ORDER BY action`,
      [orgId, String(inv.id)],
    )).rows.map((r) => `${r.action}:${r.n}`);
    return { invoice: row, inBooks: row ? ["sent", "paid"].includes(row.status) : false, docs, gl, audits };
  }

  const waitersOnSequenceLock = async () => Number((await pool.query(
    `SELECT count(*)::int AS n FROM pg_locks l, (SELECT hashtextextended($1::text, 0) AS k) x
      WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
        AND l.classid::bigint = ((x.k >> 32) & 4294967295) AND l.objid::bigint = (x.k & 4294967295)`, [companyId],
  )).rows[0].n);
  const waitingOn = async (statementStart: string) => Number((await pool.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND ltrim(query) ILIKE $1`, [`${statementStart}%`],
  )).rows[0].n);
  async function until(label: string, check: () => Promise<boolean>) {
    const deadline = Date.now() + 20_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`${label} — the race was not established`);
      await new Promise((res) => setTimeout(res, 50));
    }
  }

  /** Acts queued on the invoice ROW in the given order; the holder then commits and they run in that order. */
  async function queuedOnRow(id: number, acts: Array<{ send: () => Promise<Res>; waitsOn: string }>): Promise<Res[]> {
    const holder = await pool.connect();
    let open = false;
    try {
      await holder.query("BEGIN");
      open = true;
      await holder.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [id]);
      const sent: Promise<Res>[] = [];
      const queued = new Map<string, number>();
      for (const act of acts) {
        sent.push(act.send());
        const n = (queued.get(act.waitsOn) ?? 0) + 1;
        queued.set(act.waitsOn, n);
        await until(`act ${sent.length} did not queue on ${act.waitsOn}`, async () => (await waitingOn(act.waitsOn)) >= n);
      }
      await holder.query("COMMIT");
      open = false;
      return await Promise.all(sent);
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
    }
  }

  const approve = (who: string, id: number) => h.api(who, "POST", `/invoices/${id}/approve`, {});
  const reject = (who: string, id: number) => h.api(who, "POST", `/invoices/${id}/reject`, {});
  const submit = (id: number) => h.api("bookkeeper", "POST", `/invoices/${id}/submit`, {});
  const sendBack = (id: number) => h.api("accountant", "POST", `/invoices/${id}/send-back`, { note: "please correct" });
  const patch = (id: number) => h.api("bookkeeper", "PATCH", `/invoices/${id}`, EDIT);
  const brief = (r: Res) => [r.status, r.body?.code ?? null, r.body?.error ?? null];
  const statuses = (rs: Res[]) => rs.map((r) => r.status).sort((x, y) => x - y);

  async function purgeCredentials() {
    const comps = `(SELECT id FROM companies WHERE organization_id IN ${h.ORGS})`;
    await pool.query(`DELETE FROM zatca_credential_reminders WHERE company_id IN ${comps}`);
    await pool.query(`DELETE FROM zatca_credentials WHERE company_id IN ${comps}`);
  }

  beforeAll(async () => {
    await purgeCredentials();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = (await pool.query(
      `INSERT INTO companies
         (organization_id, name, name_ar, cr_number, vat_number, fiscal_year_start,
          building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'G08R-b Onboarded Co','شركة','1010101010',$2,1,'1234','King Fahd Rd','Olaya','Riyadh','12345','1234')
       RETURNING id`, [orgId, VAT],
    )).rows[0].id;
    const csr: ZatcaCsrInput = {
      commonName: "SLP-EGS-G08RB", organizationName: "G08R-b Onboarded Co", organizationalUnitName: "Riyadh Branch",
      countryName: "SA", invoiceType: "1100", locationAddress: "Riyadh", industryBusinessCategory: "Software",
      organizationIdentifier: VAT, egsSerialNumber: "1-SLP|2-G08RB|3-EGS001", production: false,
    };
    const { credentialId } = await signingService.createCredential({ companyId, environment: "sandbox", csr });
    const certificatePem = await signingService.withCredentialKey(credentialId, ({ privateKey, publicKey }) => selfSignedCertificate(privateKey, publicKey));
    await signingService.activateCredential({
      credentialId, certificatePem, csidSecret: "csid-secret",
      notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2031-01-01T00:00:00Z"),
    });
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'G08R-b Client','عميل') RETURNING id`, [orgId])).rows[0].id;
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("accountant", PW, orgId, "accountant");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await purgeCredentials();
    await h.cleanup();
  });

  it("CONTROL (sequential, onboarded): an approval issues AND queues one signed document rooted at ZATCA's genesis; an issued invoice refuses a second approve, a reject, a submit, a send-back and a PATCH", async () => {
    const inv = await draftInvoice();
    const ok = await approve("admin", inv.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const ev = await evidence(inv);
    expect(ev.invoice?.issued).toBe(true);
    expect(ev.docs, "anti-vacuity: the company really is onboarded — a document is queued").toHaveLength(1);
    const [doc] = (await pool.query(`SELECT previous_invoice_hash FROM einvoice_documents WHERE invoice_id = $1`, [inv.id])).rows;
    expect(doc.previous_invoice_hash).toBe(GENESIS_PIH);

    const again = await approve("accountant", inv.id);
    const rej = await reject("accountant", inv.id);
    const s = await submit(inv.id);
    const b = await sendBack(inv.id);
    const p = await patch(inv.id);
    expect([again.status, rej.status, s.status, b.status, p.status]).toEqual([409, 409, 409, 409, 409]);
    expect(await evidence(inv), "the issued invoice is untouched by the five refusals").toEqual(ev);
    Object.assign(sequential, { approveAgain: again.body?.error, rejectIssued: rej.body?.error, submitIssued: s.body?.error, sendBackIssued: b.body?.error, patchIssued: p.body?.error });
  }, 60_000);

  it("🔴 R4 — two approvals at once (held at the sequence lock): one 200, the other the sequential 409; one ICV, none lost; ONE signed document", async () => {
    const before = await maxIcv();
    const inv = await draftInvoice();
    const holder = await pool.connect();
    let held = false;
    let results: Res[] = [];
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1::text, 0))`, [companyId]);
      held = true;
      const racing = Promise.all([approve("admin", inv.id), approve("accountant", inv.id)]);
      await until("both approvals did not reach the company sequence lock", async () => (await waitersOnSequenceLock()) >= 2);
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [companyId]);
      held = false;
      results = await racing;
    } finally {
      if (held) await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [companyId]);
      holder.release();
    }
    const ev = await evidence(inv);
    const missing = await missingIcvsAbove(before);
    // eslint-disable-next-line no-console
    console.warn("[G08R-b] double approve", JSON.stringify({ results: results.map(brief), icvBefore: before, missing, ...ev }));
    expect.soft(statuses(results)).toEqual([200, 409]);
    expect.soft(results.find((r) => r.status === 409)?.body?.error, "the loser gets the sequential refusal").toBe(sequential.approveAgain);
    expect.soft(Number(ev.invoice?.icv)).toBe(before + 1);
    expect.soft(missing, "no ICV is lost").toEqual([]);
    expect.soft(ev.docs, "ONE signed document for the invoice").toHaveLength(1);
    expect.soft(ev.gl).toHaveLength(1);
  }, 60_000);

  it("🔴 R4 — a REJECT queued behind an approval: the approval 200, the reject the sequential 409; the issued invoice and its signed document survive", async () => {
    const inv = await draftInvoice();
    const [approved, rejected] = await queuedOnRow(inv.id, [
      { send: () => approve("admin", inv.id), waitsOn: `update "invoices"` },
      { send: () => reject("accountant", inv.id), waitsOn: `delete from "invoices"` },
    ]);
    const ev = await evidence(inv);
    // eslint-disable-next-line no-console
    console.warn("[G08R-b] reject behind approve", JSON.stringify({ approve: brief(approved), reject: brief(rejected), ...ev }));
    expect.soft(approved.status).toBe(200);
    expect.soft(rejected.status).toBe(409);
    expect.soft(rejected.body?.error).toBe(sequential.rejectIssued);
    expect.soft(ev.invoice?.issued).toBe(true);
    expect.soft(ev.invoice?.status).toBe("sent");
    expect.soft(ev.docs).toHaveLength(1);
    expect.soft(ev.gl).toHaveLength(1);
    expect.soft(ev.audits, "no reject is recorded").toEqual(["approve:1", "create:1"]);
  }, 60_000);

  it("🔴 R4 — an approval that loses to a reject at the sequence lock: the reject 204, the approval 409; nothing issued — no document, no entry, no ICV", async () => {
    const before = await maxIcv();
    const inv = await draftInvoice();
    const holder = await pool.connect();
    let held = false;
    let approved!: Res;
    let rejected!: Res;
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1::text, 0))`, [companyId]);
      held = true;
      const approving = approve("admin", inv.id);
      await until("the approval did not reach the company sequence lock", async () => (await waitersOnSequenceLock()) >= 1);
      rejected = await reject("accountant", inv.id);
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [companyId]);
      held = false;
      approved = await approving;
    } finally {
      if (held) await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [companyId]);
      holder.release();
    }
    const ev = await evidence(inv);
    const docsForCompany = Number((await pool.query(`SELECT count(*)::int AS n FROM einvoice_documents WHERE company_id = $1 AND invoice_id = $2`, [companyId, inv.id])).rows[0].n);
    // eslint-disable-next-line no-console
    console.warn("[G08R-b] approve after reject", JSON.stringify({ reject: brief(rejected), approve: brief(approved), icvBefore: before, icvAfter: await maxIcv(), docsForCompany, ...ev }));
    expect.soft(rejected.status).toBe(204);
    expect.soft(approved.status).toBe(409);
    expect.soft(approved.body?.error).toBe(REMOVED_WHILE_APPROVING);
    expect.soft(ev.invoice).toBeNull();
    expect.soft(docsForCompany, "no signed document for an invoice that no longer exists").toBe(0);
    expect.soft(ev.gl).toHaveLength(0);
    expect.soft(await maxIcv(), "no ICV consumed").toBe(before);
  }, 60_000);

  it("🔴 R2 on an onboarded company — a SEND-BACK queued behind an approval: the send-back the sequential 409; the signed, queued invoice stays `sent` and cannot then be edited", async () => {
    const inv = await draftInvoice();
    expect((await submit(inv.id)).status).toBe(200);
    const [approved, sentBack] = await queuedOnRow(inv.id, [
      { send: () => approve("admin", inv.id), waitsOn: `update "invoices"` },
      { send: () => sendBack(inv.id), waitsOn: `update "invoices"` },
    ]);
    const afterRace = await evidence(inv);
    const edit = await patch(inv.id);
    const afterPatch = await evidence(inv);
    // eslint-disable-next-line no-console
    console.warn("[G08R-b] send-back behind approve", JSON.stringify({ approve: brief(approved), sendBack: brief(sentBack), afterRace, patch: brief(edit), afterPatch }));
    expect(approved.status).toBe(200);
    expect.soft(afterRace.docs, "the approval queued its signed document").toHaveLength(1);
    expect.soft(sentBack.status, "the send-back that lost to the approval").toBe(409);
    expect.soft(sentBack.body?.error).toBe(sequential.sendBackIssued);
    expect.soft(afterRace.invoice?.status, "a signed, queued invoice stays `sent`, never `draft`").toBe("sent");
    expect.soft(afterRace.inBooks).toBe(true);
    expect.soft(edit.status, "PATCH of the issued invoice is refused").toBe(409);
    expect.soft(afterPatch.invoice?.total, "the total the signed document states is unchanged").toBe(afterRace.invoice?.total);
  }, 60_000);

  it("🔴 R2 on an onboarded company — a SUBMIT queued behind an approval: the submit the sequential 409; the signed, queued invoice stays `sent`", async () => {
    const inv = await draftInvoice();
    const [approved, submitted] = await queuedOnRow(inv.id, [
      { send: () => approve("admin", inv.id), waitsOn: `update "invoices"` },
      { send: () => submit(inv.id), waitsOn: `update "invoices"` },
    ]);
    const afterRace = await evidence(inv);
    // eslint-disable-next-line no-console
    console.warn("[G08R-b] submit behind approve", JSON.stringify({ approve: brief(approved), submit: brief(submitted), afterRace }));
    expect(approved.status).toBe(200);
    expect.soft(afterRace.docs).toHaveLength(1);
    expect.soft(submitted.status, "the submit that lost to the approval").toBe(409);
    expect.soft(submitted.body?.error).toBe(sequential.submitIssued);
    expect.soft(afterRace.invoice?.status, "a signed, queued invoice stays `sent`, never `submitted`").toBe("sent");
  }, 60_000);

  it("THE LEGAL CHAIN after every race above: one signed document per issued invoice, contiguous in ICV order from ZATCA's genesis, no fork", async () => {
    const rows = (await pool.query(
      `SELECT i.icv, i.status, d.invoice_hash, d.previous_invoice_hash
         FROM einvoice_documents d JOIN invoices i ON i.id = d.invoice_id
        WHERE d.company_id = $1 ORDER BY i.icv`, [companyId],
    )).rows;
    const issued = Number((await pool.query(`SELECT count(*)::int AS n FROM invoices WHERE company_id = $1 AND invoice_hash IS NOT NULL`, [companyId])).rows[0].n);
    // eslint-disable-next-line no-console
    console.warn("[G08R-b] legal chain", JSON.stringify({ issued, documents: rows.map((r) => ({ icv: r.icv, status: r.status, links: r.previous_invoice_hash === GENESIS_PIH ? "GENESIS" : r.previous_invoice_hash.slice(0, 12), hash: r.invoice_hash.slice(0, 12) })) }));
    expect.soft(rows.length, "one document per issued invoice").toBe(issued);
    expect.soft(new Set(rows.map((r) => r.invoice_hash)).size).toBe(rows.length);
    expect.soft(new Set(rows.map((r) => r.previous_invoice_hash)).size, "two documents sharing a predecessor = a fork").toBe(rows.length);
    expect.soft(rows[0]?.previous_invoice_hash).toBe(GENESIS_PIH);
    for (let i = 1; i < rows.length; i++) expect.soft(rows[i].previous_invoice_hash, `PIH link at ICV ${rows[i].icv}`).toBe(rows[i - 1].invoice_hash);
    expect.soft(rows.filter((r) => !["sent", "paid"].includes(r.status)).map((r) => [r.icv, r.status]), "every invoice that has a signed document is in the books").toEqual([]);
  });
});
