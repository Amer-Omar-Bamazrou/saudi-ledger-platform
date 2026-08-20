/**
 * M12.1b — THE GAP M12.4 LEFT OPEN.
 *
 * M12.4 validated credit and debit notes against ZATCA's live compliance API,
 * but only from **directly-constructed** inputs. It could not do otherwise:
 * `issueInvoice()` never wrote `icv`/`zatca_uuid`, so every invoice issued at
 * runtime carried NULLs and the assembler rejected it — the Phase-2 pipeline was
 * unreachable from real data.
 *
 * M12.1b assigns ICV/UUID at issuance and resolves `billingReference` from the
 * `original_invoice_id` FK. So this test does what M12.4 could not:
 *
 *   create → approve → read the ROW BACK OUT OF POSTGRES → assemble → sign →
 *   submit to ZATCA.
 *
 * Nothing here is hand-built. If the DB→note path is broken, ZATCA says so.
 *
 * Skips loudly when ZATCA is unreachable or there is no database, so an outage
 * cannot red-build unrelated work.
 */
process.env.SESSION_SECRET ??= "credit-notes-live-test-session-secret-0123456789";
process.env.PORT ??= "3000";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { loadEInvoiceInput } from "../services/einvoice/einvoiceInput.loader";
import { invoicesRepository } from "../repositories/invoices.repository";
import { buildInvoiceXml } from "../services/einvoice/ubl/buildInvoiceXml";
import { assembleSignedInvoice } from "../services/einvoice/crypto/assembleSignedInvoice";
import { generateZatcaKeyPair } from "../services/einvoice/crypto/keys";
import { buildZatcaCsr } from "../services/einvoice/crypto/csr";

const BASE =
  process.env.ZATCA_SANDBOX_BASE ?? "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal";
const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const LIVE_DISABLED = process.env.ZATCA_LIVE_TESTS === "0";

// The seller VAT that goes on the documents AND into the CSR — ZATCA requires
// they match, so the fixture company and the certificate agree.
const SELLER_VAT = "310123456789013";
const SLUG = "cn-live";

let certPem = "";
let auth = "";
let keyPair: ReturnType<typeof generateZatcaKeyPair>;
let ready = false;
let skipReason = "";

let orgId = "";
let companyId = "";
let userId = 0;
let customerId = 0;
let originalId = 0;
let creditNoteId = 0;
let debitNoteId = 0;

async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
  try {
    const out = await conn.run(() =>
      auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.55" }, fn),
    );
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

const cleanup = async () => {
  const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
  const usr = `(SELECT id FROM users WHERE email = 'cn-live@test.local')`;
  await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
  await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
  await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
  await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org} AND document_type <> 'invoice'`);
  await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
  await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
  await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
  await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
  await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
  await pool.query(`DELETE FROM users WHERE email = 'cn-live@test.local'`);
  await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
  await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
};

async function obtainCsid(): Promise<void> {
  keyPair = generateZatcaKeyPair();
  const csrPem = buildZatcaCsr(
    {
      commonName: "SLP-EGS-CN-LIVE",
      organizationName: "Al-Rashid Trading Est.",
      organizationalUnitName: "Head Office",
      countryName: "SA",
      invoiceType: "1100",
      locationAddress: "Riyadh",
      industryBusinessCategory: "Trading",
      organizationIdentifier: SELLER_VAT,
      egsSerialNumber: "1-SLP|2-Platform|3-CN-LIVE",
      production: false,
    },
    keyPair.privateKey,
    keyPair.publicKey,
  );
  const res = await fetch(`${BASE}/compliance`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Version": "V2",
      OTP: "123456",
    },
    body: JSON.stringify({ csr: Buffer.from(csrPem, "utf8").toString("base64") }),
  });
  const body = (await res.json()) as Record<string, string>;
  if (res.status !== 200 || !body.binarySecurityToken) {
    throw new Error(`no compliance CSID: ${res.status}`);
  }
  const inner = Buffer.from(body.binarySecurityToken, "base64").toString();
  certPem = `-----BEGIN CERTIFICATE-----\n${inner.replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
  auth = "Basic " + Buffer.from(`${body.binarySecurityToken}:${body.secret}`).toString("base64");
}

interface Validation {
  status?: string;
  errorMessages?: { code: string; message: string }[];
  warningMessages?: { code: string; message: string }[];
}

/**
 * Resolve the ZATCA chain head the way issuance does, then build the model.
 *
 * M12.8 made `previousInvoiceHash` an explicit parameter of the loader so the
 * read cannot drift outside the per-company sequence lock. This mirrors the
 * production path rather than hardcoding genesis, so the test keeps exercising
 * the real chain lookup.
 */
async function loadFromLedger(invoiceId: number) {
  return inTenant(async () => {
    const [inv] = await invoicesRepository.findById(invoiceId);
    const pih = await invoicesRepository.zatcaPreviousInvoiceHash(inv.companyId, invoiceId);
    return loadEInvoiceInput(invoiceId, pih);
  });
}

/** Load an ISSUED row from Postgres, sign it, and ask ZATCA. */
async function submitFromLedger(invoiceId: number): Promise<Validation> {
  const input = await loadFromLedger(invoiceId);

  const assembled = assembleSignedInvoice({
    xml: buildInvoiceXml(input),
    certificatePem: certPem,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    qr: {
      sellerName: input.seller.legalName,
      vatNumber: input.seller.vatNumber ?? SELLER_VAT,
      issuedAt: input.issuedAt,
      totalWithVat: input.taxInclusiveTotal,
      vatTotal: input.taxTotal,
    },
  });

  const res = await fetch(`${BASE}/compliance/invoices`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Version": "V2",
      "Accept-Language": "en",
      Authorization: auth,
    },
    body: JSON.stringify({
      invoiceHash: assembled.invoiceHash,
      uuid: input.uuid,
      invoice: Buffer.from(assembled.signedXml, "utf8").toString("base64"),
    }),
  });
  return ((await res.json()) as { validationResults?: Validation }).validationResults ?? {};
}

function expectClean(label: string, v: Validation): void {
  const errors = v.errorMessages ?? [];
  const warnings = v.warningMessages ?? [];
  const detail = [...errors, ...warnings].map((m) => `${m.code}: ${m.message}`).join("\n      ");
  expect(
    { label, status: v.status, errors: errors.map((e) => e.code), warnings: warnings.map((w) => w.code) },
    `ZATCA rejected the ${label} built from REAL LEDGER ROWS.\n      ${detail}\n` +
      "      DIAGNOSE the DB→document path — do not adjust inputs until it passes.",
  ).toEqual({ label, status: "PASS", errors: [], warnings: [] });
}

beforeAll(async () => {
  if (!REAL_DB) {
    skipReason = "no real DATABASE_URL";
    return;
  }
  await cleanup();

  orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('CN Live','${SLUG}') RETURNING id`)).rows[0].id;
  companyId = (
    await pool.query(
      `INSERT INTO companies
         (organization_id, name, name_ar, cr_number, vat_number,
          building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Al-Rashid Trading Est.','مؤسسة الراشد','1010101010',$2,
               '1234','King Fahd Road','Al Olaya','Riyadh','12345','6789')
       RETURNING id`,
      [orgId, SELLER_VAT],
    )
  ).rows[0].id;
  userId = (
    await pool.query(
      `INSERT INTO users (email, name, password_hash, role, is_active)
       VALUES ('cn-live@test.local','CN Live',' ','admin',true) RETURNING id`,
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
    [userId, orgId],
  );
  // A VAT-registered buyer with a full national address ⇒ STANDARD documents,
  // which is what BR-KSA-10 requires an address for.
  customerId = (
    await pool.query(
      `INSERT INTO customers
         (organization_id, name, name_ar, tax_number, cr_number,
          building_number, street, district, city, postal_code, additional_number, province, country)
       VALUES ($1,'Beta Logistics Co.','بيتا','311987654321003','2020202020',
               '4321','Prince Sultan Street','Al Rawdah','Jeddah','23456','9876','Makkah Region','SA')
       RETURNING id`,
      [orgId],
    )
  ).rows[0].id;

  const inv = await inTenant(() =>
    invoicesService.create(
      {
        invoiceNumber: "INV-LIVE-1",
        date: "2026-08-01",
        dueDate: "2026-08-31",
        customerId,
        items: [
          {
            description: "Freight services",
            quantity: 10,
            unitPrice: 100,
            vatRate: 15,
            taxCategoryCode: "S",
            unitCode: "PCE",
          },
        ],
      },
      userId,
      { autoApprove: true },
    ),
  );
  originalId = inv.id;

  const cn = await inTenant(() =>
    invoicesService.create(
      {
        invoiceNumber: "CN-LIVE-1",
        date: "2026-08-02",
        customerId,
        documentType: "credit_note",
        originalInvoiceId: originalId,
        noteReason: "Goods returned",
        items: [
          { description: "Returned freight", quantity: 2, unitPrice: 100, vatRate: 15, taxCategoryCode: "S", unitCode: "PCE" },
        ],
      },
      userId,
      { autoApprove: true },
    ),
  );
  creditNoteId = cn.id;

  const dn = await inTenant(() =>
    invoicesService.create(
      {
        invoiceNumber: "DN-LIVE-1",
        date: "2026-08-03",
        customerId,
        documentType: "debit_note",
        originalInvoiceId: originalId,
        noteReason: "Price correction — undercharged freight",
        items: [
          { description: "Freight adjustment", quantity: 1, unitPrice: 50, vatRate: 15, taxCategoryCode: "S", unitCode: "PCE" },
        ],
      },
      userId,
      { autoApprove: true },
    ),
  );
  debitNoteId = dn.id;

  if (LIVE_DISABLED) {
    skipReason = "ZATCA_LIVE_TESTS=0";
    return;
  }
  try {
    await obtainCsid();
    ready = true;
  } catch (err) {
    skipReason = String(err);
  }
  if (!ready) {
    console.warn(
      "\n" + "=".repeat(78) +
        "\n[M12.1b] SKIPPING the LIVE ZATCA check of notes built from REAL LEDGER ROWS." +
        "\n         This is the specific gap M12.4 left open. A green run WITHOUT it" +
        "\n         does NOT prove the database→document path works." +
        `\n         Reason: ${skipReason}` +
        "\n" + "=".repeat(78) + "\n",
    );
  }
}, 180_000);

afterAll(async () => {
  if (REAL_DB) await cleanup();
});

describe("M12.1b — notes built from REAL LEDGER ROWS pass ZATCA", () => {
  it("the ledger rows carry everything the ZATCA pipeline needs", async (ctx) => {
    // 🔴 SKIP, never silently pass (audit H3): these two DB-only tests reported
    // GREEN with no database at all, and the three live ones with no sandbox.
    if (!REAL_DB) ctx.skip();
    // The precondition M12.4 could not satisfy.
    const { rows } = await pool.query(
      `SELECT invoice_number, icv, zatca_uuid, issued_at, document_type, original_invoice_id, note_reason
         FROM invoices WHERE organization_id = $1 ORDER BY icv`,
      [orgId],
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.icv, `${r.invoice_number} ICV`).not.toBeNull();
      expect(r.zatca_uuid, `${r.invoice_number} UUID`).not.toBeNull();
      expect(r.issued_at, `${r.invoice_number} issuedAt`).not.toBeNull();
    }
    const cn = rows.find((r) => r.document_type === "credit_note");
    expect(cn.original_invoice_id).toBe(originalId);
    expect(cn.note_reason).toBe("Goods returned");
  });

  it("the billing reference is resolved from the FK, naming the real original", async (ctx) => {
    if (!REAL_DB) ctx.skip();
    const input = await loadFromLedger(creditNoteId);
    expect(input.documentType).toBe("credit_note");
    // Derived from the referenced ROW, never a stored string that could drift.
    expect(input.billingReference).toEqual({ invoiceNumber: "INV-LIVE-1" });
    expect(input.instructionNote).toBe("Goods returned");
  });

  it("the ORIGINAL invoice from the ledger passes ZATCA", async (ctx) => {
    if (!ready) ctx.skip();
    expectClean("ledger invoice", await submitFromLedger(originalId));
  }, 120_000);

  it("🔴 the CREDIT NOTE from the ledger passes ZATCA", async (ctx) => {
    if (!ready) ctx.skip();
    expectClean("ledger credit note", await submitFromLedger(creditNoteId));
  }, 120_000);

  it("🔴 the DEBIT NOTE from the ledger passes ZATCA", async (ctx) => {
    if (!ready) ctx.skip();
    expectClean("ledger debit note", await submitFromLedger(debitNoteId));
  }, 120_000);
});
