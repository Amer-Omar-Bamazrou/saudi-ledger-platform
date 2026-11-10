/**
 * 🔴 Phase 18 audit (2026-11-09), finding A10 — G50's sibling: the signed XML's PARTIES are read once, at issue.
 *
 * G50 (PR C) fixed the seller's NAME and VAT number: the e-invoice loader takes them from the issuing write's
 * stamp. The rest of what the signed document states about its parties — the seller's CR number and address, and
 * the WHOLE buyer block (name, VAT number, CR, address, province, country, national id) — was still a second,
 * live read of the company and the customer, after the issuing write. A customer or company edit committed in
 * between made the signed, submitted, never-deletable XML disagree with the parties the invoice itself captured
 * (G32's `issued_seller` / `issued_buyer`). G50's control: "lock the company row FOR SHARE for the issuance, or
 * read once". This is the second: every party field the document builder uses is captured at issue, and the
 * loader reads the capture.
 *
 * The window is forced exactly as phase18-prc-g50-seller-window.test.ts forces W2: a holder takes ACCESS
 * EXCLUSIVE on einvoice_documents, the approval passes its issuing write and waits before the loader; the
 * customer's and the company's addresses are then changed through the product; the holder releases.
 *
 * ZATCA-onboarded company (self-signed sandbox credential, local-dev KMS; no ZATCA call). DB-backed (sl_test).
 */
process.env.PORT ??= "3392";
process.env.SESSION_SECRET ??= "phase18-audit-a10-xml-parties-read-once-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness, type Res } from "./helpers/g04Harness";
import { until } from "./helpers/g08rRace";
import { signingService } from "../services/einvoice/signing/signing.service";
import type { ZatcaCsrInput } from "../services/einvoice/crypto/csr";
import { selfSignedCertificate } from "./helpers/selfSignedCert";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "AuditA10PartiesPw123!";
const DATE = "2026-10-05";
const VAT = "399999999995043";
const BUYER_VAT = "300000000000003";

/** One party block of the signed XML, the fields the builder fills from the party records. */
function xmlParty(xml: string | null, tag: "AccountingSupplierParty" | "AccountingCustomerParty") {
  const party = xml?.match(new RegExp(`<cac:${tag}>([\\s\\S]*?)</cac:${tag}>`))?.[1] ?? "";
  const pick = (re: RegExp) => party.match(re)?.[1] ?? null;
  return {
    street: pick(/<cbc:StreetName>([^<]*)</),
    building: pick(/<cbc:BuildingNumber>([^<]*)</),
    city: pick(/<cbc:CityName>([^<]*)</),
    postal: pick(/<cbc:PostalZone>([^<]*)</),
    crn: pick(/<cbc:ID schemeID="CRN">([^<]*)</),
  };
}

describeMaybe("Phase 18 audit A10 — the signed XML's parties are the parties captured at issue", () => {
  const h = g04Harness("auda10");
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

  /** The parties the invoice captured, and the parties its signed XML states. */
  async function evidence(id: number) {
    const inv = (await pool.query(`SELECT invoice_hash, issued_seller, issued_buyer FROM invoices WHERE id = $1`, [id])).rows[0];
    const doc = (await pool.query(`SELECT signed_xml FROM einvoice_documents WHERE invoice_id = $1`, [id])).rows[0] ?? null;
    const s = inv.issued_seller ?? {};
    const b = inv.issued_buyer ?? {};
    return {
      issued: inv.invoice_hash != null,
      sellerCaptured: { street: s.street ?? null, building: s.buildingNumber ?? null, city: s.city ?? null, postal: s.postalCode ?? null, crn: s.crNumber ?? null },
      buyerCaptured: { street: b.street ?? null, building: b.buildingNumber ?? null, city: b.city ?? null, postal: b.postalCode ?? null },
      sellerXml: doc ? xmlParty(doc.signed_xml, "AccountingSupplierParty") : null,
      buyerXml: doc ? (({ crn: _crn, ...rest }) => rest)(xmlParty(doc.signed_xml, "AccountingCustomerParty")) : null,
      captured: { seller: s, buyer: b },
    };
  }
  function assertXmlStatesTheCapture(res: Res, ev: Awaited<ReturnType<typeof evidence>>, label: string) {
    expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(200);
    expect(ev.issued).toBe(true);
    expect(ev.sellerXml, `${label}: the signed XML's seller is the seller captured at issue`).toEqual(ev.sellerCaptured);
    expect(ev.buyerXml, `${label}: the signed XML's buyer is the buyer captured at issue`).toEqual(ev.buyerCaptured);
  }

  const waitingInTree = async (holderPid: number) => (await pool.query(
    `WITH RECURSIVE tree(pid) AS (
       SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a JOIN tree t ON t.pid = ANY (pg_blocking_pids(a.pid)))
     SELECT a.pid, a.wait_event_type, left(regexp_replace(a.query, '\\s+', ' ', 'g'), 160) AS query
       FROM pg_stat_activity a JOIN tree t ON t.pid = a.pid WHERE a.pid <> $1 AND a.wait_event_type = 'Lock'`, [holderPid],
  )).rows as Array<{ pid: number; wait_event_type: string; query: string }>;
  async function rowHeldByIssuer(id: number): Promise<boolean> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE NOWAIT`, [id]);
      return false;
    } catch (e) {
      return (e as { code?: string }).code === "55P03";
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }

  beforeAll(async () => {
    await purgeCredentials();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, fiscal_year_start,
                              building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Audit A10 Co','شركة','1010101010',$2,1,'1234','Seller Street','Olaya','Riyadh','12345','5678') RETURNING id`, [orgId, VAT],
    )).rows[0].id;
    const csr: ZatcaCsrInput = {
      commonName: "SLP-EGS-AUDA10", organizationName: "Audit A10 Co", organizationalUnitName: "Riyadh Branch",
      countryName: "SA", invoiceType: "1100", locationAddress: "Riyadh", industryBusinessCategory: "Software",
      organizationIdentifier: VAT, egsSerialNumber: "1-SLP|2-AUDA10|3-EGS001", production: false,
    };
    const { credentialId } = await signingService.createCredential({ companyId, environment: "sandbox", csr });
    const certificatePem = await signingService.withCredentialKey(credentialId, ({ privateKey, publicKey }) => selfSignedCertificate(privateKey, publicKey));
    await signingService.activateCredential({ credentialId, certificatePem, csidSecret: "csid-secret", notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2031-01-01T00:00:00Z") });
    customerId = (await pool.query(
      `INSERT INTO customers (organization_id, name, name_ar, tax_number, cr_number, building_number, street, district, city, postal_code, additional_number, country)
       VALUES ($1,'Audit A10 Buyer','مشتري',$2,'2020202020','4321','Buyer Street','Malaz','Riyadh','11564','8765','SA') RETURNING id`, [orgId, BUYER_VAT],
    )).rows[0].id;
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

  it("🔴 the capture holds EVERY party field the document builder uses (additional number; the buyer's province, country, national id)", async () => {
    const id = await draft();
    const res = await approve(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ev = await evidence(id);
    expect(ev.captured.seller).toMatchObject({ additionalNumber: "5678" });
    expect(ev.captured.buyer).toMatchObject({ additionalNumber: "8765", country: "SA" });
    expect(Object.keys(ev.captured.buyer)).toEqual(expect.arrayContaining(["province", "nationalId"]));
    assertXmlStatesTheCapture(res, ev, "sequential");
  }, 60_000);

  it("🔴 WINDOW: the customer's and the company's addresses change after the issuing write — the signed XML still states the parties captured at issue", async () => {
    const id = await draft();
    const holder = await pool.connect();
    let open = false;
    let res!: Res;
    let edits: [Res, Res];
    try {
      await holder.query("BEGIN");
      open = true;
      const holderPid = Number((await holder.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      await holder.query(`LOCK TABLE einvoice_documents IN ACCESS EXCLUSIVE MODE`);
      const approving = approve(id);
      await until("the approval did not reach the window (issuing write done, waiting on einvoice_documents)", async () =>
        (await waitingInTree(holderPid)).some((w) => /einvoice_documents/i.test(w.query)) && (await rowHeldByIssuer(id)));
      edits = await Promise.all([
        h.api("admin", "PATCH", `/customers/${customerId}`, { street: "Buyer Street Changed", buildingNumber: "9999", city: "Jeddah", postalCode: "21577" }),
        h.api("admin", "PATCH", "/companies/current", { street: "Seller Street Changed", buildingNumber: "8888", city: "Dammam", postalCode: "31411" }),
      ]);
      await holder.query("ROLLBACK");
      open = false;
      res = await approving;
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
    }
    expect(edits!.map((e) => e.status), `the window is established: both edits committed while the approval waited — ${JSON.stringify(edits!.map((e) => e.body))}`).toEqual([200, 200]);
    const ev = await evidence(id);
    expect(ev.buyerCaptured.street, "the capture is the buyer as it was at issue").toBe("Buyer Street");
    expect(ev.sellerCaptured.street, "the capture is the seller as it was at issue").toBe("Seller Street");
    assertXmlStatesTheCapture(res, ev, "window");
  }, 60_000);
});
