/**
 * PHASE 18 · PR C (issued-invoice freeze) · G50 PROOF — issuance reads the company more
 * than once without a lock; a company change committed between the issuing write and the
 * e-invoice loader's read. PROOF ONLY, NOT A FIX. Untracked; never merged red.
 *
 * Audit row G50 (MEDIUM): "Issuance reads the company twice unlocked; XML/QR vs stamp can
 * disagree — narrower: the 0121 trigger refuses a mismatched seller at the issuing UPDATE;
 * the silent window is markIssued → the e-invoice loader's read".
 *
 * The reads (origin/main f10c2a6a):
 *  R1 `requireIssuanceSeller` (invoices.approvable.ts:232 → sellerIdentity.ts:69) — the
 *     stamp: seller_name / seller_vat_number, the homegrown hash, the Phase-1 QR;
 *  R2 the 0121 trigger inside the issuing UPDATE `markIssued` (approvable :328) — refuses a
 *     stamp that no longer equals the company;
 *  R3 `loadEInvoiceInput` (enqueue.ts:97 → einvoiceInput.loader.ts:52) — the signed XML
 *     and the Phase-2 QR, which then OVERWRITES invoices.qr_code (approvable :401-403).
 *  No lock is taken on the company row by any of them (READ COMMITTED: each statement
 *  sees what has committed by then).
 *
 * Forcing the interleavings (the helpers/g08rRace.ts shape — a holder, a waiter SEEN
 * waiting in the holder's own wait tree, then a release):
 *  W1 (control, the window 0121 closes): the holder takes the company's sequence advisory
 *     lock; the approval passes R1 and waits at `lockCompanySequence`; the company is
 *     renamed through the product (PATCH /companies/current); the holder releases.
 *  W2 (the G50 window): the holder takes ACCESS EXCLUSIVE on einvoice_documents; the
 *     approval passes markIssued and waits at the chain-head read just before R3 (proved:
 *     the invoice row is then locked by the issuing transaction — a NOWAIT probe fails);
 *     the company is renamed through the product; the holder releases.
 * The holder is a TEST stand-in for "something committed in that interval"; the change
 * itself goes through the product's own company-settings path.
 *
 * FIX-NEUTRAL invariant: an approval that answers 200 has issued ONE identity — the stamp
 * (seller_name/VAT), invoices.qr_code tags 1–2, einvoice_documents.qr_code tags 1–2 and the
 * signed XML's AccountingSupplierParty all name the same seller; an approval that does not
 * answer 200 issued nothing.
 *
 * ZATCA-onboarded company (self-signed sandbox credential, local-dev KMS; no ZATCA call;
 * worker not running): R3 runs only for an onboarded company.
 * 🔴 W2 is expected to FAIL while G50 exists. DB-backed (sl_test).
 */

process.env.PORT ??= "3184";
process.env.SESSION_SECRET ??= "phase18-prc-g50-proof-session-secret-00001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness, type Res } from "./helpers/g04Harness";
import { until } from "./helpers/g08rRace";
import { signingService } from "../services/einvoice/signing/signing.service";
import type { ZatcaCsrInput } from "../services/einvoice/crypto/csr";
import { selfSignedCertificate } from "./helpers/selfSignedCert";
import { computeInvoiceHash } from "../services/accounting/zatca";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "PrcG50ProofPw123!";
const DATE = "2026-10-05";
const ID0 = { name: "PRC G50 Co", vat: "399999999995013" };
const ID1 = { name: "PRC G50 Renamed One", vat: "399999999995023" };
const ID2 = { name: "PRC G50 Renamed Two", vat: "399999999995033" };

function qrSeller(b64: string | null): [string | null, string | null] {
  if (!b64) return [null, null];
  const buf = Buffer.from(b64, "base64");
  const tags: Record<number, string> = {};
  for (let i = 0; i + 2 <= buf.length; ) {
    const len = buf[i + 1];
    if (buf[i] <= 2) tags[buf[i]] = buf.subarray(i + 2, i + 2 + len).toString("utf-8");
    i += 2 + len;
  }
  return [tags[1] ?? null, tags[2] ?? null];
}
function xmlSeller(xml: string | null): [string | null, string | null] {
  const party = xml?.match(/<cac:AccountingSupplierParty>([\s\S]*?)<\/cac:AccountingSupplierParty>/)?.[1] ?? "";
  return [party.match(/<cbc:RegistrationName>([^<]*)</)?.[1] ?? null, party.match(/<cbc:CompanyID>([^<]*)</)?.[1] ?? null];
}

describeMaybe("PR C proof · G50 — a company change between the issuing write and the e-invoice loader", () => {
  const h = g04Harness("prcg50");
  let orgId = "";
  let companyId = "";
  let customerId = 0;

  async function purgeCredentials() {
    const comps = `(SELECT id FROM companies WHERE organization_id IN ${h.ORGS})`;
    await pool.query(`DELETE FROM zatca_credential_reminders WHERE company_id IN ${comps}`);
    await pool.query(`DELETE FROM zatca_credentials WHERE company_id IN ${comps}`);
  }

  async function draft(): Promise<number> {
    const r = await h.api("bookkeeper", "POST", "/invoices", { date: DATE, customerId, items: [{ description: "Professional services", quantity: 1, unitPrice: 1_000, vatRate: 15 }] });
    expect(r.status, `create: ${JSON.stringify(r.body)}`).toBe(201);
    return r.body.id as number;
  }
  const approve = (id: number) => h.api("accountant", "POST", `/invoices/${id}/approve`, {});
  const rename = (to: { name: string; vat: string }) => h.api("admin", "PATCH", "/companies/current", { name: to.name, vatNumber: to.vat });

  /** Every place the issued document states its seller, side by side. */
  async function evidence(id: number) {
    const inv = (await pool.query(
      `SELECT status, invoice_number, date, total::text, vat_amount::text, invoice_hash, previous_hash, qr_code, seller_name, seller_vat_number, icv FROM invoices WHERE id = $1`, [id],
    )).rows[0];
    const doc = (await pool.query(`SELECT qr_code, signed_xml FROM einvoice_documents WHERE invoice_id = $1`, [id])).rows[0] ?? null;
    const company = (await pool.query(`SELECT name, vat_number FROM companies WHERE id = $1`, [companyId])).rows[0];
    const gl = Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [orgId, `GL-${inv.invoice_number}`])).rows[0].n);
    const homegrownHashVat = inv.invoice_hash
      ? [ID0.vat, ID1.vat, ID2.vat].find((v) => computeInvoiceHash({ invoiceNumber: inv.invoice_number, date: inv.date, sellerVatNumber: v, total: Number(inv.total).toFixed(2), vatAmount: Number(inv.vat_amount).toFixed(2), previousHash: inv.previous_hash }) === inv.invoice_hash) ?? "none of the three"
      : null;
    return {
      status: inv.status,
      issued: inv.invoice_hash != null,
      icv: inv.icv,
      stamp: [inv.seller_name, inv.seller_vat_number],
      invoiceQr: qrSeller(inv.qr_code),
      documentQr: doc ? qrSeller(doc.qr_code) : null,
      signedXml: doc ? xmlSeller(doc.signed_xml) : null,
      homegrownHashComputedWithVat: homegrownHashVat,
      companyNow: [company.name, company.vat_number],
      gl,
    };
  }
  type Ev = Awaited<ReturnType<typeof evidence>>;
  /** The fix-neutral invariant: a 200 issued ONE seller identity everywhere; anything else issued nothing. */
  function assertOneIdentity(res: Res, ev: Ev, label: string) {
    if (res.status === 200) {
      expect.soft(ev.issued, `${label}: a 200 issued the invoice`).toBe(true);
      expect.soft(ev.invoiceQr, `${label}: invoices.qr_code names the stamped seller`).toEqual(ev.stamp);
      expect.soft(ev.documentQr, `${label}: einvoice_documents.qr_code names the stamped seller`).toEqual(ev.stamp);
      expect.soft(ev.signedXml, `${label}: the signed XML names the stamped seller`).toEqual(ev.stamp);
    } else {
      expect.soft([ev.issued, ev.documentQr, ev.gl], `${label}: a refused approval issued nothing`).toEqual([false, null, 0]);
    }
  }

  /** Sessions in the holder's wait tree that are waiting on a lock, with their statements. */
  const waitingInTree = async (holderPid: number) => (await pool.query(
    `WITH RECURSIVE tree(pid) AS (
       SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a JOIN tree t ON t.pid = ANY (pg_blocking_pids(a.pid)))
     SELECT a.pid, a.wait_event_type, left(regexp_replace(a.query, '\\s+', ' ', 'g'), 160) AS query
       FROM pg_stat_activity a JOIN tree t ON t.pid = a.pid WHERE a.pid <> $1 AND a.wait_event_type = 'Lock'`, [holderPid],
  )).rows as Array<{ pid: number; wait_event_type: string; query: string }>;

  /** Is the invoice row locked by another transaction right now (i.e. has the issuing UPDATE run)? */
  async function rowHeldByIssuer(id: number): Promise<{ held: boolean; code: string | null }> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE NOWAIT`, [id]);
      return { held: false, code: null };
    } catch (e) {
      return { held: (e as { code?: string }).code === "55P03", code: (e as { code?: string }).code ?? null };
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }
  const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<"TIMEOUT">((res) => setTimeout(() => res("TIMEOUT"), ms))]);

  beforeAll(async () => {
    await purgeCredentials();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, fiscal_year_start,
                              building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,$2,'شركة','1010101010',$3,1,'1234','King Fahd Rd','Olaya','Riyadh','12345','1234') RETURNING id`, [orgId, ID0.name, ID0.vat],
    )).rows[0].id;
    const csr: ZatcaCsrInput = {
      commonName: "SLP-EGS-PRCG50", organizationName: ID0.name, organizationalUnitName: "Riyadh Branch",
      countryName: "SA", invoiceType: "1100", locationAddress: "Riyadh", industryBusinessCategory: "Software",
      organizationIdentifier: ID0.vat, egsSerialNumber: "1-SLP|2-PRCG50|3-EGS001", production: false,
    };
    const { credentialId } = await signingService.createCredential({ companyId, environment: "sandbox", csr });
    const certificatePem = await signingService.withCredentialKey(credentialId, ({ privateKey, publicKey }) => selfSignedCertificate(privateKey, publicKey));
    await signingService.activateCredential({ credentialId, certificatePem, csidSecret: "csid-secret", notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2031-01-01T00:00:00Z") });
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'PRC G50 Client','عميل') RETURNING id`, [orgId])).rows[0].id;
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

  it("PREMISE (sequential, onboarded): one approval states ONE seller everywhere — stamp, invoice QR, document QR, signed XML — equal to the company", async () => {
    const id = await draft();
    const res = await approve(id);
    const ev = await evidence(id);
    // eslint-disable-next-line no-console
    console.warn("[PRC G50] PREMISE", JSON.stringify({ http: res.status, ...ev }));
    expect(res.status).toBe(200);
    expect(ev.stamp).toEqual([ID0.name, ID0.vat]);
    expect([ev.invoiceQr, ev.documentQr, ev.signedXml]).toEqual([ev.stamp, ev.stamp, ev.stamp]);
    expect(ev.homegrownHashComputedWithVat).toBe(ID0.vat);
  }, 60_000);

  it("CONTROL W1 (the window 0121 closes): a rename committed while the approval waits at the sequence lock, AFTER it read the seller — the approval is refused and nothing is issued", async () => {
    const id = await draft();
    const holder = await pool.connect();
    let locked = false;
    let res!: Res;
    let renamed!: Res | "TIMEOUT";
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1::text, 0))`, [companyId]);
      locked = true;
      const holderPid = Number((await holder.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      const approving = approve(id);
      await until("W1: the approval did not reach the company sequence lock", async () => (await waitingInTree(holderPid)).some((w) => /pg_advisory_xact_lock/i.test(w.query)));
      renamed = await within(rename(ID1), 15_000);
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [companyId]);
      locked = false;
      res = await approving;
    } finally {
      if (locked) await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [companyId]);
      holder.release();
    }
    const ev = await evidence(id);
    // eslint-disable-next-line no-console
    console.warn("[PRC G50] W1", JSON.stringify({ rename: renamed === "TIMEOUT" ? "TIMEOUT" : renamed.status, approve: { http: res.status, code: res.body?.code ?? null, error: String(res.body?.error ?? "").slice(0, 240) }, ...ev }));
    expect(renamed === "TIMEOUT" ? "TIMEOUT" : renamed.status, "W1 established: the rename committed while the approval waited").toBe(200);
    assertOneIdentity(res, ev, "W1");
  }, 60_000);

  it("🔴 PROOF W2 (the G50 window): a rename committed after the issuing write and before the e-invoice loader reads the company — an approval that answers 200 states ONE seller everywhere", async () => {
    const id = await draft();
    const holder = await pool.connect();
    let open = false;
    let res!: Res;
    let renamed!: Res | "TIMEOUT";
    let waiting: Array<{ pid: number; query: string }> = [];
    let position!: { held: boolean; code: string | null };
    try {
      await holder.query("BEGIN");
      open = true;
      const holderPid = Number((await holder.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      await holder.query(`LOCK TABLE einvoice_documents IN ACCESS EXCLUSIVE MODE`);
      const approving = approve(id);
      // AMENDED when this proof landed with its fix (PR C), setup only: under file parallelism the table
      // lock also queues OTHER suites' reads of einvoice_documents, so a queued read alone does not show
      // that THIS approval is in the window. Wait until the invoice row is also held by the issuing
      // transaction — the check below, made part of the wait. No assertion changed.
      await until("W2: the approval did not queue on einvoice_documents", async () => {
        waiting = await waitingInTree(holderPid);
        return waiting.some((w) => /einvoice_documents/i.test(w.query)) && (await rowHeldByIssuer(id)).held;
      });
      position = await rowHeldByIssuer(id);
      if (!position.held) throw new Error(`W2 NOT ESTABLISHED: the approval waits on einvoice_documents but the invoice row is not held (issuing UPDATE not yet run): ${JSON.stringify({ position, waiting })}`);
      renamed = await within(rename(ID2), 15_000);
      await holder.query("ROLLBACK");
      open = false;
      res = await approving;
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
    }
    const ev = await evidence(id);
    // eslint-disable-next-line no-console
    console.warn("[PRC G50] W2", JSON.stringify({ waitingAt: waiting.map((w) => w.query), invoiceRowHeldByIssuer: position, rename: renamed === "TIMEOUT" ? "TIMEOUT" : renamed.status, approve: { http: res.status, code: res.body?.code ?? null }, ...ev }));
    expect(renamed === "TIMEOUT" ? "TIMEOUT" : renamed.status, "W2 established: the rename committed while the approval waited after its issuing write").toBe(200);
    assertOneIdentity(res, ev, "W2");
  }, 60_000);
});
