/**
 * 🔴 19B S2b — CUSTOMERS, SUPPLIERS, PICKERS AND WITHHOLDING TAX, EVERY ROLE × PATH × FIELD (v4 §6.1 D2; D9 (a), (d);
 * plan §14 S2b: "as S2a, plus the CSV and PDF text of the two exports").
 *
 * Run with TODAY's matrix (S2b merges with every grant in place: nothing changes for anyone) and with S2b's seven
 * planned removals primed (S2B_REMOVALS):
 *
 *  - the VIEWER reads no customer contact or national ID and no supplier contact or IBAN — not even its last four — on
 *    the lists, the records, the withholding-tax return, schedule, annual return and beneficiary statement, and in the
 *    two withholding-tax exports (CSV as served; PDF as built);
 *  - the BOOKKEEPER keeps contact, reads a supplier IBAN's last four digits only, and writes a customer's national ID
 *    without reading it back;
 *  - PICKERS (D9 (a)) serve id, name, Arabic name and VAT number to every role — never a protected field — with the
 *    list's own predicate, its total, a residency filter for suppliers, and only the reader's own organization;
 *  - the per-field access a page asks for names exactly that (never a value).
 * Presence: the accountant reads every planted value where it belongs. Movement: under today's matrix the viewer does.
 *
 * 🔴 STAND-IN, named: the export PDFs are built from HTML handed to the one renderer (`document/htmlToPdf`, Chromium);
 * here it RECORDS that HTML and returns a fixed PDF, so the check is of exactly what each PDF is built from and runs
 * where Chromium is absent (CI's test job). The CSV is checked as served.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, PERMISSION_MATRIX, S2B_REMOVALS } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { g04Harness } from "./helpers/g04Harness";
import { approveHeldIbans } from "./helpers/approveHeldIbans";

const pdfHtml = vi.hoisted(() => [] as string[]);
vi.mock("../services/document/htmlToPdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/document/htmlToPdf")>();
  return { ...real, htmlToPdf: vi.fn(async (html: string) => { pdfHtml.push(html); return Buffer.from("%PDF-1.4 stand-in"); }) };
});

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s2b-cv-password-2026";
const h = g04Harness("s2b-cv");
const key = (r: { role: string; resource: string; action: string }) => `${r.role}:${r.resource}:${r.action}`;
// Restated for the removal: the seven are out of PERMISSION_MATRIX itself; BEFORE is the matrix with them (re-added),
// so the movement half — every role served while they are granted — stays.
const PENDING = new Set(S2B_REMOVALS.map(key));
const S2B_MATRIX = PERMISSION_MATRIX.filter((r) => !PENDING.has(key(r)));
const BEFORE = [...PERMISSION_MATRIX, ...S2B_REMOVALS.map(({ role, resource, action }) => ({ role, resource, action }))];
const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;

/** A valid Saudi IBAN from its 20-digit BBAN (the check digits computed, so the product accepts it). */
function saIban(bban: string): string {
  const rearranged = `${bban}2810` + "00"; // "SA" → 28 10, check digits 00
  const mod = [...rearranged].reduce((acc, d) => (acc * 10 + Number(d)) % 97, 0);
  return `SA${String(98 - mod).padStart(2, "0")}${bban}`;
}

/** Every planted value, with the class and resource that protect it. */
const C = { nationalId: "1084215599", phone: "+966500071311", email: "s2b.customer.11@example.sa", street: "S2B-CUST-STREET-4471", district: "S2B-CUST-DISTRICT", notes: "S2B-CUST-NOTE-8812" };
const V = { phone: "+966500082422", email: "s2b.supplier.22@example.sa", address: "S2B-SUPP-ADDRESS-5532", city: "S2B-SUPP-CITY", iban: saIban("80000000991234598712") };
const PLANTED: { what: string; value: string; cls: "contact" | "identity" | "bank_account"; resource: "customers" | "vendors" }[] = [
  { what: "customer national ID", value: C.nationalId, cls: "identity", resource: "customers" },
  { what: "customer phone", value: C.phone, cls: "contact", resource: "customers" },
  { what: "customer email", value: C.email, cls: "contact", resource: "customers" },
  { what: "customer street", value: C.street, cls: "contact", resource: "customers" },
  { what: "customer district", value: C.district, cls: "contact", resource: "customers" },
  { what: "customer notes", value: C.notes, cls: "contact", resource: "customers" },
  { what: "supplier phone", value: V.phone, cls: "contact", resource: "vendors" },
  { what: "supplier email", value: V.email, cls: "contact", resource: "vendors" },
  { what: "supplier address", value: V.address, cls: "contact", resource: "vendors" },
  { what: "supplier city", value: V.city, cls: "contact", resource: "vendors" },
  { what: "supplier IBAN", value: V.iban, cls: "bank_account", resource: "vendors" },
  { what: "supplier IBAN, all but the last four", value: V.iban.slice(0, -4), cls: "bank_account", resource: "vendors" },
];
const PERIOD = "2026-10";

describeDb("19B S2b — customers, suppliers, pickers and withholding tax, every role × path × field", () => {
  let customerId = 0;
  let vendorId = 0;
  let foreignCustomer = "";
  const paths: Record<string, string> = {};

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    const orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S2b Parties Co", "319393939393983");
    for (const role of ROLES) await h.mkUser(role, PW, orgId, role);
    for (const role of ROLES) expect(await h.login(role, h.email(role), PW), role).toBe(200);
    // another organization's customer, for the picker's tenant check
    const other = await h.mkOrg("other");
    await h.mkCompany(other, "S2b Other Co", "319494949494983");
    await h.mkUser("other", PW, other, "admin");
    expect(await h.login("other", h.email("other"), PW)).toBe(200);
    foreignCustomer = "S2B Foreign Customer";
    expect((await h.api("other", "POST", "/customers", { name: foreignCustomer })).status).toBe(201);

    const cust = await h.api("accountant", "POST", "/customers", {
      name: "S2B Planted Customer", nameAr: "عميل مزروع", taxNumber: "300000000000003", nationalId: C.nationalId, phone: C.phone, email: C.email,
      buildingNumber: "4471", street: C.street, district: C.district, city: "Riyadh", postalCode: "12211", notes: C.notes,
    });
    expect(cust.status, JSON.stringify(cust.body)).toBe(201);
    customerId = cust.body.id;
    expect((await h.api("accountant", "POST", "/customers", { name: "S2B Inactive Customer", isActive: false })).status).toBe(201);
    const vend = await h.api("accountant", "POST", "/vendors", {
      name: "S2B Overseas Advisory", nameAr: "استشارات خارجية", residency: "non_resident", whtDefaultPaymentType: "technical_consulting", country: "GB",
      phone: V.phone, email: V.email, address: V.address, city: V.city, iban: V.iban,
    });
    expect(vend.status, JSON.stringify(vend.body)).toBe(201);
    vendorId = vend.body.id;
    expect((await h.api("accountant", "POST", "/vendors", { name: "S2B Local Supplier", residency: "resident" })).status).toBe(201);
    expect(await approveHeldIbans(h, "admin")).toBe(1); // the IBAN through the hold, as the product puts it in place (S3)
    // a withholding: an approved bill, paid — so the return, the annual return and the beneficiary statement name it
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    const bill = await h.api("admin", "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: "S2B-R-1", billNumber: "S2B-B-1", date: `${PERIOD}-10`, dueDate: `${PERIOD}-10`, vendorId, items: [{ description: "Consulting", quantity: 1, unitPrice: 10_000, vatRate: 0 }] });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    expect((await h.api("admin", "POST", `/bills/${bill.body.id}/approve`, {})).status).toBe(200);
    const paid = await h.api("admin", "POST", `/bills/${bill.body.id}/pay`, { amount: 10_000, paidAt: `${PERIOD}-10`, bankAccountId: bank.body.id });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const w = (await pool.query(`SELECT id FROM wht_withholdings WHERE bill_id = $1`, [bill.body.id])).rows[0];
    expect(w, "the payment withheld tax").toBeTruthy();
    Object.assign(paths, {
      customers: "/customers", customer: `/customers/${customerId}`, vendors: "/vendors", vendor: `/vendors/${vendorId}`,
      whtReturn: `/tax/wht/returns/${PERIOD}`, whtAnnual: "/tax/wht/annual?fiscal_year=2026", whtBeneficiary: `/tax/wht/beneficiaries/${vendorId}`,
      whtWithholding: `/tax/wht/withholdings/${w.id}`, heldChanges: "/companies/current/bank-detail-changes",
      customerPicker: "/customers/picker", vendorPicker: "/vendors/picker",
    });
  }, 180_000);
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); await h.stop(); await h.cleanup(); });

  /** Every planted value found in a role's view of every path, as served (raw text, nested and free text included). */
  async function seen(who: string): Promise<Map<string, string[]>> {
    const found = new Map<string, string[]>();
    const note = (what: string, where: string) => found.set(what, [...(found.get(what) ?? []), where]);
    for (const [name, path] of Object.entries(paths)) {
      const r = await h.api(who, "GET", path);
      expect([who, name, r.status]).toEqual([who, name, 200]);
      for (const p of PLANTED) if (r.text.includes(p.value)) note(p.what, name);
    }
    for (const report of ["wht-return", "wht-annual"]) {
      const q = report === "wht-return" ? `period=${PERIOD}` : "fiscal_year=2026";
      const csv = await h.api(who, "GET", `/reports/export/${report}?format=csv&${q}`);
      expect([who, report, "csv", csv.status]).toEqual([who, report, "csv", 200]);
      const before = pdfHtml.length;
      const pdf = await h.api(who, "GET", `/reports/export/${report}?format=pdf&${q}`);
      expect([who, report, "pdf", pdf.status, pdfHtml.length]).toEqual([who, report, "pdf", 200, before + 1]);
      for (const p of PLANTED) {
        if (csv.text.includes(p.value)) note(p.what, `${report}.csv`);
        if (pdfHtml.at(-1)!.includes(p.value)) note(p.what, `${report}.pdf`);
      }
    }
    return found;
  }

  it("BEFORE the removal (the seven granted): every role reads every planted value", async () => {
    primePermissionCache(BEFORE);
    for (const who of ["viewer", "bookkeeper"]) {
      const found = await seen(who);
      expect(PLANTED.filter((p) => !found.has(p.what)).map((p) => p.what), who).toEqual([]);
    }
  }, 180_000);

  describe("with S2b's seven planned removals primed", () => {
    beforeAll(() => { primePermissionCache(S2B_MATRIX); });
    afterAll(() => { primePermissionCache(PERMISSION_MATRIX); });

    const grants = () => new Set(S2B_MATRIX.map(key));

    for (const who of ["viewer", "bookkeeper"] as const) {
      it(`🔴 ${who}: no planted value it may not read appears on any path — the lists, the records, the held changes, the WHT return, annual return, beneficiary statement and withholding, and both WHT exports (CSV and PDF)`, async () => {
        const found = await seen(who);
        const g = grants();
        const leaks = PLANTED.filter((p) => !g.has(`${who}:${p.resource}:field.${p.cls}.read`) && found.has(p.what)).map((p) => `${p.what}: ${found.get(p.what)!.join(", ")}`);
        expect(leaks).toEqual([]);
        // and what it MAY read is still there (the bookkeeper keeps contact)
        const kept = PLANTED.filter((p) => g.has(`${who}:${p.resource}:field.${p.cls}.read`) && !found.has(p.what)).map((p) => p.what);
        expect(kept).toEqual([]);
      }, 180_000);
    }

    it("presence: the accountant reads every planted value, the supplier's address in both WHT exports included", async () => {
      const found = await seen("accountant");
      expect(PLANTED.filter((p) => !found.has(p.what)).map((p) => p.what)).toEqual([]);
      expect(found.get("supplier address")).toEqual(expect.arrayContaining(["whtReturn", "whtAnnual", "wht-annual.csv", "wht-annual.pdf"]));
    }, 180_000);

    it("🔴 the viewer is told what was withheld (D4): the key is absent, the X-Withheld header names it — never a blank", async () => {
      const r = await h.api("viewer", "GET", paths.customer);
      for (const k of ["nationalId", "phone", "email", "street", "district", "notes"]) expect([k, k in r.body]).toEqual([k, false]);
      expect([r.body.name, r.body.taxNumber]).toEqual(["S2B Planted Customer", "300000000000003"]);
      const named = JSON.parse(r.headers["x-withheld"] ?? "[]").map((x: { path: string; class: string }) => `${x.path}:${x.class}`);
      expect(named).toEqual(expect.arrayContaining(["nationalId:identity", "phone:contact", "street:contact", "notes:contact"]));
      const v = await h.api("viewer", "GET", paths.vendor);
      for (const k of ["phone", "email", "address", "city", "iban"]) expect([k, k in v.body]).toEqual([k, false]);
      expect([v.body.name, v.body.residency, v.body.ibanPending]).toEqual(["S2B Overseas Advisory", "non_resident", false]);
      const annual = await h.api("viewer", "GET", paths.whtAnnual);
      const b = annual.body.beneficiaries.find((x: { vendorId: number }) => x.vendorId === vendorId);
      expect([b?.name ?? b?.vendorName, "address" in b]).toEqual([expect.stringContaining("S2B Overseas"), false]);
      const csv = await h.api("viewer", "GET", "/reports/export/wht-annual?format=csv&fiscal_year=2026");
      expect(csv.text).toContain("[withheld: contact details]");
    });

    it("🔴 the bookkeeper: a supplier IBAN's last four digits only; a customer's national ID written, never read back", async () => {
      const v = await h.api("bookkeeper", "GET", paths.vendor);
      expect(typeof v.body.iban).toBe("string");
      expect(v.body.iban).toContain(V.iban.slice(-4));
      expect(v.body.iban).not.toContain(V.iban.slice(0, -4));
      const w = await h.api("bookkeeper", "PATCH", paths.customer, { nationalId: "1084215600" });
      expect(w.status, JSON.stringify(w.body)).toBe(200);
      expect("nationalId" in w.body).toBe(false);
      expect((await pool.query(`SELECT national_id FROM customers WHERE id = $1`, [customerId])).rows[0].national_id).toBe("1084215600");
      expect((await h.api("accountant", "PATCH", paths.customer, { nationalId: C.nationalId })).status).toBe(200); // put back
    });

    it("🔴 the viewer writes nothing (no write grant on either record)", async () => {
      expect((await h.api("viewer", "PATCH", paths.customer, { phone: "+966500000001" })).status).toBe(403);
      expect((await h.api("viewer", "PATCH", paths.vendor, { phone: "+966500000001" })).status).toBe(403);
    });

    it("🔴 the per-field access each page asks for (never a value)", async () => {
      const level = async (who: string, record: "customers" | "vendors", f: string) => {
        const r = await h.api(who, "GET", `/${record}/field-access`);
        expect(r.status).toBe(200);
        expect(r.text).not.toContain(C.nationalId);
        return [r.body.fields[f].read, r.body.fields[f].write];
      };
      expect(await level("viewer", "customers", "phone")).toEqual(["none", false]);
      expect(await level("viewer", "customers", "nationalId")).toEqual(["none", false]);
      expect(await level("bookkeeper", "customers", "phone")).toEqual(["read", true]);
      expect(await level("bookkeeper", "customers", "nationalId")).toEqual(["none", true]);
      expect(await level("accountant", "customers", "nationalId")).toEqual(["read", true]);
      expect(await level("viewer", "vendors", "iban")).toEqual(["none", false]);
      expect(await level("bookkeeper", "vendors", "iban")).toEqual(["last4", true]);
      expect(await level("bookkeeper", "vendors", "address")).toEqual(["read", true]);
      expect(await level("viewer", "vendors", "name")).toEqual(["read", false]);
    });
  });

  describe("🔴 PICKERS (D9 (a)) — id, name, Arabic name and VAT number, to every role, under either matrix", () => {
    for (const [label, matrix] of [["the matrix before the removal", BEFORE], ["S2b's removals", S2B_MATRIX]] as const) {
      it(`under ${label}: exactly those four keys, the list's predicate and total, the reader's own organization only`, async () => {
        primePermissionCache(matrix);
        for (const who of ROLES) {
          const c = await h.api(who, "GET", "/customers/picker?limit=200");
          expect([who, c.status]).toEqual([who, 200]);
          for (const row of c.body.items) expect(Object.keys(row).sort()).toEqual(["id", "name", "nameAr", "taxNumber"]);
          expect(c.body.items.find((x: { id: number }) => x.id === customerId)).toEqual({ id: customerId, name: "S2B Planted Customer", nameAr: "عميل مزروع", taxNumber: "300000000000003" });
          expect(c.body.items.map((x: { name: string }) => x.name)).not.toContain(foreignCustomer);
          expect(c.body.page.total).toBe(c.body.items.length);
          for (const p of PLANTED) expect([who, p.what, c.text.includes(p.value)]).toEqual([who, p.what, false]);
          const active = await h.api(who, "GET", "/customers/picker?is_active=true&limit=200");
          expect(active.body.items.map((x: { name: string }) => x.name)).not.toContain("S2B Inactive Customer");
          expect(c.body.items.map((x: { name: string }) => x.name)).toContain("S2B Inactive Customer");
          const v = await h.api(who, "GET", "/vendors/picker?limit=200");
          for (const row of v.body.items) expect(Object.keys(row).sort()).toEqual(["id", "name", "nameAr", "taxNumber"]);
          for (const p of PLANTED) expect([who, p.what, v.text.includes(p.value)]).toEqual([who, p.what, false]);
          const nonResident = await h.api(who, "GET", "/vendors/picker?residency=non_resident&limit=200");
          expect(nonResident.body.items.map((x: { id: number }) => x.id)).toEqual([vendorId]);
          expect(nonResident.body.page.total).toBe(1);
          const searched = await h.api(who, "GET", "/vendors/picker?search=Local");
          expect(searched.body.items.map((x: { name: string }) => x.name)).toEqual(["S2B Local Supplier"]);
        }
        const cut = await h.api("viewer", "GET", "/customers/picker?limit=1");
        expect([cut.body.items.length, cut.body.page.total >= 2]).toEqual([1, true]); // a cut list says so
        primePermissionCache(PERMISSION_MATRIX);
      });
    }
    it("a residency the product does not know is refused, not ignored", async () => {
      expect((await h.api("viewer", "GET", "/vendors/picker?residency=martian")).status).toBe(400);
    });
  });
});
