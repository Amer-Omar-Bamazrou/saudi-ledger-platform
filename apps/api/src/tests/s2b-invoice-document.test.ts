/**
 * 🔴 19B S2b — THE INVOICE DOCUMENT, REFUSED BY CLASS (v4 §11, D9 (b) = B2; plan §14: "the document refusal by class
 * (standard, education and healthcare, simplified)").
 *
 * A signed tax document is not altered per reader, so the PDF is served whole or refused by name. What it carries is
 * read from the document itself — the printed buyer block and the attached ZATCA XML — never from the invoice's kind:
 *
 *  - a STANDARD tax invoice prints the buyer's address → `contact`;
 *  - a private EDUCATION or HEALTHCARE invoice's XML names the buyer's national ID (BT-46, scheme NAT, #363) → `identity`;
 *  - a SIMPLIFIED invoice whose buyer has neither carries nothing protected and downloads whole — and one whose buyer
 *    has an address prints it, so it is `contact` too.
 *
 * Run twice: with TODAY's matrix (every role downloads every PDF — S2b merges with every grant in place) and with S2b's
 * seven planned removals primed (S2B_REMOVALS) — the viewer refused contact and identity, the bookkeeper
 * identity. A refusal answers before anything is rendered, names the classes, never carries a value, and is recorded as
 * a refused export (D6).
 *
 * 🔴 STAND-INS, named: (1) the renderer (`document/htmlToPdf`, Chromium) is replaced by one that RECORDS the HTML and
 * returns a one-page PDF made by pdf-lib, so the PDF/A-3 step runs and the check is of exactly what the PDF is built
 * from (CI's test job has no Chromium). (2) The education invoice's company has no ZATCA credential, so nothing signs
 * its XML; the XML attached here is built by the product's own builder FROM THE LEDGER ROWS (`loadEInvoiceInput` →
 * `buildInvoiceXml`) and stored unsigned as the signed copy. Signing adds a signature; it does not change the buyer.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, PERMISSION_MATRIX, S2B_REMOVALS } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { invoiceDocumentClasses, xmlBuyerClasses } from "../lib/fieldClasses/documentClasses";
import { invoicesRepository } from "../repositories/invoices.repository";
import { loadEInvoiceInput } from "../services/einvoice/einvoiceInput.loader";
import { buildInvoiceXml } from "../services/einvoice/ubl/buildInvoiceXml";
import { g04Harness } from "./helpers/g04Harness";

const pdfHtml = vi.hoisted(() => [] as string[]);
vi.mock("../services/document/htmlToPdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/document/htmlToPdf")>();
  const { PDFDocument } = await import("pdf-lib");
  return {
    ...real,
    htmlToPdf: vi.fn(async (html: string) => {
      pdfHtml.push(html);
      const d = await PDFDocument.create();
      d.addPage();
      return Buffer.from(await d.save());
    }),
  };
});

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s2b-document-password-2026";
const h = g04Harness("s2b-doc");
const key = (r: { role: string; resource: string; action: string }) => `${r.role}:${r.resource}:${r.action}`;
// Restated for the removal: the seven are out of PERMISSION_MATRIX itself; BEFORE is the matrix with them (re-added),
// so the movement half — every role served while they are granted — stays.
const PENDING = new Set(S2B_REMOVALS.map(key));
const S2B_MATRIX = PERMISSION_MATRIX.filter((r) => !PENDING.has(key(r)));
const BEFORE = [...PERMISSION_MATRIX, ...S2B_REMOVALS.map(({ role, resource, action }) => ({ role, resource, action }))];
const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;

/** Planted values: none may appear in a refusal, its record, or anything a refused role is served. */
const NATIONAL_ID = "1093847561";
const STREET = "Planted Street S2B";
const DISTRICT = "Planted District S2B";

describeDb("19B S2b — the invoice document is served whole or refused by the classes it carries", () => {
  let orgId = "";
  let companyId = "";
  let adminId = 0;
  const inv: Record<"standard" | "education" | "simplified" | "simplifiedWithAddress", number> = { standard: 0, education: 0, simplified: 0, simplifiedWithAddress: 0 };

  const line = (edu: boolean) => edu
    ? { description: "School tuition, term 1", quantity: 1, unitPrice: 1000, vatRate: 0, taxCategoryCode: "Z", taxExemptionReasonCode: "VATEX-SA-EDU", taxExemptionReasonText: "Private education to citizen", unitCode: "PCE" }
    : { description: "Stationery", quantity: 1, unitPrice: 100, vatRate: 15, taxCategoryCode: "S", unitCode: "PCE" };
  let seq = 0;
  async function issue(customerId: number, edu = false): Promise<number> {
    const created = await h.api("accountant", "POST", "/invoices", { invoiceNumber: `S2BDOC-${++seq}`, date: "2026-08-01", dueDate: "2026-08-31", customerId, items: [line(edu)] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as number;
    expect((await h.api("accountant", "POST", `/invoices/${id}/submit`, {})).status).toBe(200);
    const approved = await h.api("admin", "POST", `/invoices/${id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    return id;
  }
  async function customer(body: Record<string, unknown>): Promise<number> {
    const r = await h.api("accountant", "POST", "/customers", body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  }
  const download = (who: string, id: number) => h.api(who, "GET", `/invoices/${id}/document?lang=ar`);

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "S2b Document Co", "319292929292983");
    for (const role of ROLES) {
      const id = await h.mkUser(role, PW, orgId, role);
      if (role === "admin") adminId = id;
    }
    for (const role of ROLES) expect(await h.login(role, h.email(role), PW), role).toBe(200);
    const business = await customer({ name: "Buyer Business", taxNumber: "300000000000003", crNumber: "1010202020", buildingNumber: "4321", street: STREET, district: DISTRICT, city: "Riyadh", postalCode: "12211" });
    const citizen = await customer({ name: "Student Parent", nationalId: NATIONAL_ID });
    const walkIn = await customer({ name: "Walk-in Buyer" });
    const walkInAddressed = await customer({ name: "Walk-in With Address", street: STREET, district: DISTRICT, city: "Jeddah" });
    inv.standard = await issue(business);
    inv.simplified = await issue(walkIn);
    inv.simplifiedWithAddress = await issue(walkInAddressed);
    inv.education = await issue(citizen, true); // LAST: the database lets a document be filed only for the newest ICV
    // Stand-in (2), named above: the education invoice's XML from the ledger rows, stored as its signed copy — through
    // the same insert guard issuance meets (0160: the invoice's own UUID, the company's newest ICV)
    const xml = await h.inTenant(orgId, companyId, adminId, async () =>
      buildInvoiceXml(await loadEInvoiceInput(inv.education, await invoicesRepository.zatcaPreviousInvoiceHash(companyId, inv.education))));
    expect(xml, "the ledger rows put the national ID in the XML").toContain(`schemeID="NAT">${NATIONAL_ID}<`);
    await pool.query(
      `INSERT INTO einvoice_documents (organization_id, company_id, invoice_id, zatca_uuid, flow, status, signed_xml)
       SELECT organization_id, company_id, id, zatca_uuid, 'reporting', 'pending', $2 FROM invoices WHERE id = $1`, [inv.education, xml]);
  }, 180_000);
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); await h.stop(); await h.cleanup(); });

  const refusalRows = async () =>
    (await pool.query(`SELECT action, resource, refusal_code, field_names, field_classes, actor_user_id, row_to_json(e)::text AS raw FROM permission_refusal_events e WHERE organization_id = $1 ORDER BY id`, [orgId])).rows;

  it("what each document carries, read from the document itself", async () => {
    const xml = (await pool.query(`SELECT signed_xml FROM einvoice_documents WHERE invoice_id = $1`, [inv.education])).rows[0].signed_xml as string;
    expect(xmlBuyerClasses(xml)).toEqual(["identity"]);
    expect(invoiceDocumentClasses({ buyer: { address: "4321، Planted Street" } })).toEqual(["contact"]);
    expect(invoiceDocumentClasses({ buyer: { address: null } }, xml)).toEqual(["identity"]);
    expect(invoiceDocumentClasses({ buyer: { address: null } })).toEqual([]);
    expect(invoiceDocumentClasses({ buyer: null })).toEqual([]);
    // the safe errors: an unknown scheme is a person's ID; an XML that cannot be read carries what it might
    expect(xmlBuyerClasses(xml.replace(`schemeID="NAT"`, `schemeID="OTH"`))).toEqual(["identity"]);
    expect(xmlBuyerClasses(xml.replace(`schemeID="NAT"`, `schemeID="CRN"`))).toEqual([]);
    expect(xmlBuyerClasses("<not-xml")).toBeNull();
    expect(invoiceDocumentClasses({ buyer: null }, "<not-xml")).toEqual(["contact", "identity"]);
  });

  it("BEFORE the removal (the seven granted): every role downloads every invoice's PDF", async () => {
    primePermissionCache(BEFORE);
    for (const who of ROLES) for (const [kind, id] of Object.entries(inv)) {
      const r = await download(who, id);
      expect([who, kind, r.status, r.headers["content-type"]?.startsWith("application/pdf")]).toEqual([who, kind, 200, true]);
    }
    expect(await refusalRows()).toEqual([]);
    primePermissionCache(PERMISSION_MATRIX);
  });

  describe("with S2b's seven planned removals primed", () => {
    beforeAll(() => { primePermissionCache(S2B_MATRIX); });
    afterAll(() => { primePermissionCache(PERMISSION_MATRIX); });

    const EXPECT: Record<(typeof ROLES)[number], Record<keyof typeof inv, string[] | "pdf">> = {
      admin: { standard: "pdf", education: "pdf", simplified: "pdf", simplifiedWithAddress: "pdf" },
      accountant: { standard: "pdf", education: "pdf", simplified: "pdf", simplifiedWithAddress: "pdf" },
      bookkeeper: { standard: "pdf", education: ["identity"], simplified: "pdf", simplifiedWithAddress: "pdf" },
      viewer: { standard: ["contact"], education: ["identity"], simplified: "pdf", simplifiedWithAddress: ["contact"] },
    };

    for (const who of ROLES) {
      it(`🔴 ${who}: ${Object.entries(EXPECT[who]).map(([k, v]) => `${k} ${v === "pdf" ? "served" : `refused (${v.join(", ")})`}`).join("; ")}`, async () => {
        for (const [kind, id] of Object.entries(inv) as [keyof typeof inv, number][]) {
          const rendered = pdfHtml.length;
          const r = await download(who, id);
          const want = EXPECT[who][kind];
          if (want === "pdf") {
            expect([kind, r.status, r.headers["content-type"]?.startsWith("application/pdf")], `${who} ${kind}`).toEqual([kind, 200, true]);
            expect(pdfHtml.length, `${who} ${kind}: rendered`).toBe(rendered + 1);
          } else {
            expect([kind, r.status, r.body.code, r.body.classes], `${who} ${kind}`).toEqual([kind, 403, "document_field_withheld", want]);
            expect(pdfHtml.length, `${who} ${kind}: refused BEFORE anything is rendered`).toBe(rendered);
            for (const planted of [NATIONAL_ID, STREET, DISTRICT]) expect(r.text, `${who} ${kind}: the refusal carries no value`).not.toContain(planted);
          }
        }
      });
    }

    it("🔴 each refusal is recorded as a refused export (D6): who, the invoice resource, the code and the classes — never a value", async () => {
      const rows = await refusalRows();
      const summary = rows.map((r) => [r.action, r.resource, r.refusal_code, [...r.field_classes].sort().join("+")]);
      // bookkeeper: education; viewer: standard, education, simplified-with-address
      expect(summary).toEqual([
        ["export", "invoices", "document_field_withheld", "identity"],
        ["export", "invoices", "document_field_withheld", "contact"],
        ["export", "invoices", "document_field_withheld", "identity"],
        ["export", "invoices", "document_field_withheld", "contact"],
      ]);
      for (const r of rows) for (const planted of [NATIONAL_ID, STREET, DISTRICT]) expect(r.raw).not.toContain(planted);
    });

    it("presence: the accountant's PDF of the standard invoice is built from the buyer's address and the education one from its XML", async () => {
      const before = pdfHtml.length;
      expect((await download("accountant", inv.standard)).status).toBe(200);
      expect(pdfHtml.length).toBe(before + 1);
      expect(pdfHtml.at(-1)).toContain(STREET);
    });
  });
});
