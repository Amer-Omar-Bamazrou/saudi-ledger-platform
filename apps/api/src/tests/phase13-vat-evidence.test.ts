/**
 * PHASE 13A — EVIDENCE INTEGRITY (2026-09-24).
 *
 * The invariant under test: INSUFFICIENT EVIDENCE → NO INPUT-VAT CLAIM. The
 * accountant's answers (X1/X2/X3/X5, 2026-09-27) decide where such VAT goes:
 * the document POSTS, its VAT in the holding asset VAT_AWAITING_EVIDENCE —
 * never VAT_INPUT, never on a return — until the evidence entry (Dr VAT_INPUT
 * / Cr holding) claims it in the period the evidence is held, within five
 * calendar years; Art. 50 blocked VAT is COST; a credit note on held VAT
 * reduces the held amount and the later claim is the net.
 *
 *  A. the verdict (`vatEvidence.ts`, pure — no database): every case the
 *     research named — full invoice, simplified below / at SAR 1,000, the QR
 *     and its signature, the supplier's VAT number, Art. 50, the fixed-asset
 *     treatment, notes — and the one mapping to the books and the claim window;
 *  B. on real rows: a draft is judged and PERSISTED; its approval posts the
 *     VAT into the HOLDING account (VAT_INPUT and the return unmoved); the
 *     held list finds it and says why; evidence supplied later claims it in
 *     the evidence period (and only there); Art. 50 VAT posts into cost; a
 *     credit note on held VAT nets the later claim; the five-year window; the
 *     database trigger refuses what a path forgets; a scanned
 *     document becomes a DRAFT (never auto-posted), stays linked through
 *     posting, keeps its fieldSources and the reviewer's corrections beside
 *     the extraction; PDF and WEBP are accepted by their bytes; duplicates are
 *     WARNED about, scoped to the company and organisation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginTenantConnection, pool } from "@workspace/db";
import { QR_TAG, bytesToBase64, concatBytes, tlv, utf8Bytes } from "@workspace/zatca-tlv";
import { resetEnvCache } from "@workspace/config";
import { auditContext } from "../lib/auditContext";
import { evaluateVatEvidence, inputVatTreatment, withinClaimWindow, type VatEvidenceInput } from "../services/purchaseEvidence/vatEvidence";
import { billsService } from "../services/bills.service";
import { reportsService } from "../services/reports.service";
import { vendorsService } from "../services/vendors.service";
import { captureService } from "../services/capture/capture.service";
import { capturedDocumentsJobRepository } from "../repositories/capturedDocuments.repository";
import { resetArchiveStoreForTests } from "../services/einvoice/archive/resolveArchiveStore";
import { resetStagingBackendForTests } from "../services/capture/stagingBackend";

const VAT_A = "399999999999993";
const VAT_B = "311111111111113";

// ── signed and unsigned ZATCA QR payloads, built the way ZATCA builds them ──
function qr(opts: { vat?: string; total: string; vatTotal: string; date?: string; sign?: "valid" | "tampered" | "none" }): string {
  const base = [
    tlv(QR_TAG.SELLER_NAME, utf8Bytes("مورد")),
    tlv(QR_TAG.VAT_NUMBER, utf8Bytes(opts.vat ?? VAT_A)),
    tlv(QR_TAG.TIMESTAMP, utf8Bytes(`${opts.date ?? "2026-05-10"}T10:00:00`)),
    tlv(QR_TAG.TOTAL_WITH_VAT, utf8Bytes(opts.total)),
    tlv(QR_TAG.VAT_TOTAL, utf8Bytes(opts.vatTotal)),
  ];
  if ((opts.sign ?? "none") === "none") return bytesToBase64(concatBytes(base));
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const hash = createHash("sha256").update(`invoice ${opts.total}`).digest();
  const signer = createSign("SHA256"); signer.update(hash); signer.end();
  const sig = signer.sign({ key: privateKey, dsaEncoding: "der" });
  const shownHash = opts.sign === "tampered" ? createHash("sha256").update("another invoice").digest() : hash;
  return bytesToBase64(concatBytes([
    ...base,
    tlv(QR_TAG.INVOICE_HASH, utf8Bytes(shownHash.toString("base64"))),
    tlv(QR_TAG.SIGNATURE, utf8Bytes(sig.toString("base64"))),
    tlv(QR_TAG.PUBLIC_KEY, new Uint8Array(publicKey.export({ format: "der", type: "spki" }))),
    tlv(QR_TAG.CERTIFICATE_SIGNATURE, new Uint8Array([0x30, 0x44])),
  ]));
}

// ══════════════════════════════════════════════════════════════════════════
// A. THE VERDICT — pure
// ══════════════════════════════════════════════════════════════════════════
describe("Phase 13A — the VAT-evidence verdict (pure)", () => {
  const base: VatEvidenceInput = {
    documentType: "bill", subtotal: 1000, vatAmount: 150, total: 1150, vatToClaim: 150,
    supplierDocumentKind: "tax_invoice", supplier: { vatNumber: VAT_A }, supplierInvoiceNumber: "INV-7",
    date: "2026-05-10", capitalisesVat: false, blockedExpenseAccount: null, capture: null,
  };
  const codes = (i: Partial<VatEvidenceInput>) => evaluateVatEvidence({ ...base, ...i }).flags.filter((f) => f.severity === "blocking").map((f) => f.code);

  it("🔴 a full tax invoice with its facts is EVIDENCED — attested when no document is attached, and postable", () => {
    const v = evaluateVatEvidence(base);
    expect(v).toMatchObject({ status: "evidenced", basis: "attested" });
    expect(inputVatTreatment(v), "evidenced VAT is claimed").toBe("claimed");
    expect(v.flags.filter((f) => f.severity === "blocking")).toEqual([]);
  });

  it("🔴 insufficient evidence is HELD, never evidenced: kind not stated · no tax invoice · supplier missing · VAT number missing / invalid · invoice number missing", () => {
    expect(codes({ supplierDocumentKind: null })).toEqual(["document_kind_not_stated"]);
    expect(codes({ supplierDocumentKind: "no_tax_invoice" })).toEqual(["no_tax_invoice"]);
    expect(codes({ supplier: null })).toEqual(["supplier_not_identified"]);
    expect(codes({ supplier: { vatNumber: null } })).toEqual(["supplier_vat_number_missing"]);
    expect(codes({ supplier: { vatNumber: "123456789012345" } })).toEqual(["supplier_vat_number_invalid"]);
    expect(codes({ supplierInvoiceNumber: " " })).toEqual(["supplier_invoice_number_missing"]);
    for (const i of [{ supplierDocumentKind: null }, { supplier: null }, { supplierInvoiceNumber: null }] as Partial<VatEvidenceInput>[]) {
      const v = evaluateVatEvidence({ ...base, ...i });
      expect(v.status).toBe("awaiting_evidence");
      expect(inputVatTreatment(v), "held — never claimed").toBe("awaiting_evidence");
    }
  });

  it("🔴 a SIMPLIFIED invoice below SAR 1,000 with its QR read is evidenced; AT 1,000 it is held (IR Art. 53(1)(c), read on the total)", () => {
    const small = { supplierDocumentKind: "simplified_tax_invoice", subtotal: 800, vatAmount: 120, total: 920, vatToClaim: 120, supplierInvoiceNumber: null };
    const ok = evaluateVatEvidence({ ...base, ...small, capture: { qrPayload: qr({ total: "920.00", vatTotal: "120.00" }), signatureStatus: "unsigned" } });
    expect(ok).toMatchObject({ status: "evidenced", basis: "qr_unsigned" });
    // no invoice number is required on a simplified invoice (53(8))
    expect(ok.flags.map((f) => f.code)).not.toContain("supplier_invoice_number_missing");
    const at1000 = { ...small, subtotal: 869.57, vatAmount: 130.43, total: 1000, vatToClaim: 130.43 };
    expect(codes({ ...at1000, capture: { qrPayload: qr({ total: "1000.00", vatTotal: "130.43" }), signatureStatus: "unsigned" } }))
      .toEqual(["simplified_invoice_at_or_above_1000"]);
    const justBelow = { ...small, subtotal: 869.56, vatAmount: 130.43, total: 999.99, vatToClaim: 130.43 };
    expect(codes({ ...justBelow, capture: { qrPayload: qr({ total: "999.99", vatTotal: "130.43" }), signatureStatus: "unsigned" } })).toEqual([]);
  });

  it("🔴 OCR is never evidence: a simplified invoice needs its QR READ — no document, or a document with no QR, is held whatever the figures", () => {
    const s = { supplierDocumentKind: "simplified_tax_invoice", subtotal: 100, vatAmount: 15, total: 115, vatToClaim: 15 };
    expect(codes({ ...s, capture: null })).toEqual(["simplified_invoice_document_missing"]);
    expect(codes({ ...s, capture: { qrPayload: null, signatureStatus: null } })).toEqual(["simplified_invoice_qr_missing"]);
    expect(codes({ ...s, capture: { qrPayload: "bm90LWEtcXI=", signatureStatus: null } })).toEqual(["qr_unreadable"]);
  });

  it("🔴 the QR is compared with the bill, and its server-checked signature counts: verified → basis; FAILED → held; a mismatch → held", () => {
    const withQr = (payload: string, sig: string) => ({ capture: { qrPayload: payload, signatureStatus: sig } });
    expect(evaluateVatEvidence({ ...base, ...withQr(qr({ total: "1150.00", vatTotal: "150.00" }), "verified") }))
      .toMatchObject({ status: "evidenced", basis: "qr_signature_verified" });
    expect(codes(withQr(qr({ total: "1150.00", vatTotal: "150.00" }), "failed"))).toEqual(["qr_signature_failed"]);
    expect(codes(withQr(qr({ total: "1250.00", vatTotal: "150.00" }), "unsigned"))).toEqual(["qr_total_mismatch"]);
    expect(codes(withQr(qr({ total: "1150.00", vatTotal: "140.00" }), "unsigned"))).toEqual(["qr_vat_mismatch"]);
    expect(codes(withQr(qr({ vat: VAT_B, total: "1150.00", vatTotal: "150.00" }), "unsigned"))).toEqual(["qr_supplier_vat_mismatch"]);
    // a signature that could not be CHECKED is a warning, not a hold
    const unchecked = evaluateVatEvidence({ ...base, ...withQr(qr({ total: "1150.00", vatTotal: "150.00" }), "error") });
    expect(unchecked.status).toBe("evidenced");
    expect(unchecked.flags.map((f) => f.code)).toContain("qr_signature_unchecked");
  });

  it("🔴 Art. 50: a blocked expense account is NOT DEDUCTIBLE — its VAT is COST (X5), not a hold", () => {
    const v = evaluateVatEvidence({ ...base, blockedExpenseAccount: { name: "Meals & Entertainment" } });
    expect(v).toMatchObject({ status: "not_deductible" });
    expect(v.flags[0]).toMatchObject({ code: "art50_blocked_expense_account", severity: "info" });
    expect(inputVatTreatment(v)).toBe("not_deductible");
  });

  it("the EXISTING fixed-asset treatment (0 % recovery → VAT capitalised, none claimed) is not deductible; notes and nil claims need no evidence", () => {
    expect(evaluateVatEvidence({ ...base, supplierDocumentKind: null, capitalisesVat: true })).toMatchObject({ status: "not_deductible" });
    expect(evaluateVatEvidence({ ...base, documentType: "credit_note", supplierDocumentKind: null })).toMatchObject({ status: "not_required" });
    expect(evaluateVatEvidence({ ...base, vatAmount: 0, vatToClaim: 0, supplierDocumentKind: null })).toMatchObject({ status: "not_required" });
    // a final bill whose VAT the supplier's advance invoice already claimed in full (Z-AP1)
    expect(evaluateVatEvidence({ ...base, vatToClaim: 0, supplierDocumentKind: null })).toMatchObject({ status: "not_required" });
  });

  it("🔴 X3: a supplier CREDIT note's VAT follows the original it corrects — held, cost or claimed — whatever its own verdict", () => {
    const note = evaluateVatEvidence({ ...base, documentType: "credit_note", supplierDocumentKind: null });
    expect(inputVatTreatment(note, { state: "awaiting_evidence" })).toBe("awaiting_evidence");
    expect(inputVatTreatment(note, { state: "not_deductible" })).toBe("not_deductible");
    expect(inputVatTreatment(note, { state: "claimed" })).toBe("claimed");
    // an original posted before Phase 13 carries no state: it was claimed on its own date
    expect(inputVatTreatment(note, { state: null })).toBe("claimed");
    expect(inputVatTreatment(note)).toBe("claimed");
  });

  it("🔴 IR Art. 49(8): a claim within FIVE calendar years after the supply's year — never before the supply", () => {
    expect(withinClaimWindow("2026-03-15", "2026-03-15")).toBe(true);
    expect(withinClaimWindow("2026-03-15", "2031-12-31"), "2026 + 5 = the whole of 2031").toBe(true);
    expect(withinClaimWindow("2026-03-15", "2032-01-01"), "the sixth calendar year").toBe(false);
    expect(withinClaimWindow("2026-12-31", "2031-01-01")).toBe(true);
    expect(withinClaimWindow("2026-03-15", "2026-03-14"), "before the supply").toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B. REAL ROWS
// ══════════════════════════════════════════════════════════════════════════
const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8 ", "latin1"), Buffer.alloc(14, 1)]);

describeMaybe("Phase 13A — evidence integrity on real rows", () => {
  const SLUG = "p13-evidence", SLUG_B = "p13-evidence-other";
  const EMAIL = "p13-evidence@test.local";
  let orgId = "", companyId = "", company2 = "", orgB = "", companyB = "", userId = 0;
  let vendorA = 0, vendorNoVat = 0, vendorA2 = 0, vendorOtherOrg = 0, mealsId = 0;
  let archiveDir = "";

  const inTenant = async <T,>(fn: () => Promise<T>, org = orgId, co = companyId): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const slug of [SLUG, SLUG_B]) {
        const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
        for (const t of ["captured_documents", "bill_prepayments", "bill_payments", "bill_items", "bills", "journal_entry_lines", "journal_entries",
                         "period_locks", "audit_logs", "organization_memberships", "vendors", "bank_accounts", "categories", "companies"]) {
          await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
        }
        await client.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
      }
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    let err: { statusCode?: number; status?: number; payload?: { code?: string; flags?: Array<{ code: string }> }; message?: string } | undefined;
    try { await p; } catch (e) { err = e as typeof err; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err!.statusCode ?? err!.status, err!.message).toBe(status);
    if (code) expect(err!.payload?.code, err!.message).toBe(code);
    return err!;
  };
  const gl = async (code: string) => Number((await pool.query(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [orgId, code])).rows[0].v);
  const inputVat = async (from: string, to: string) =>
    Number((await inTenant(() => reportsService.vatReturn(from, to))).purchasesSection.box13_recoverableInputVat);
  /** The lines of one entry, by account system code: [code, debit, credit]. */
  const entryLines = async (entryNumber: string) =>
    (await pool.query(
      `SELECT c.system_code, c.name, l.debit_amount::text d, l.credit_amount::text c, e.date::text AS date FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND e.entry_number = $2 ORDER BY l.id`, [orgId, entryNumber])).rows
      .map((r) => [r.system_code ?? r.name, r.d, r.c, r.date]);
  const stateOf = async (id: number) =>
    (await pool.query(`SELECT status, input_vat_state, input_vat_pending::text AS pending, input_vat_claimed_on, input_vat_claim_entry_id FROM bills WHERE id = $1`, [id])).rows[0];
  const capture = (over: Partial<Parameters<typeof captureService.capture>[0]> = {}, org = orgId, co = companyId) =>
    inTenant(() => captureService.capture({ bytes: PNG, fileName: "receipt.png", source: "ocr", ...over }, { organizationId: org, companyId: co, userId }), org, co);
  const bill = (body: Record<string, unknown>, org = orgId, co = companyId) =>
    inTenant(() => billsService.create({ date: "2026-05-10", subtotal: 1000, vatAmount: 150, total: 1150, items: [], ...body }, userId), org, co);

  beforeAll(async () => {
    archiveDir = await mkdtemp(join(tmpdir(), "p13-evidence-"));
    process.env.ZATCA_ARCHIVE_PROVIDER = "local-fs";
    process.env.ZATCA_ARCHIVE_DIR = archiveDir;
    resetEnvCache(); resetArchiveStoreForTests(); resetStagingBackendForTests();
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P13 Evidence','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P13 Co') RETURNING id`, [orgId])).rows[0].id;
    company2 = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P13 Second Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorA = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'Riyadh Stationers',$2) RETURNING id`, [orgId, VAT_A])).rows[0].id;
    vendorA2 = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'Riyadh Stationers (branch)',$2) RETURNING id`, [orgId, VAT_A])).rows[0].id;
    vendorNoVat = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Corner Shop') RETURNING id`, [orgId])).rows[0].id;
    mealsId = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'FOOD_MEALS'`, [orgId])).rows[0].id;
    orgB = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P13 Other','${SLUG_B}') RETURNING id`)).rows[0].id;
    companyB = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P13 Other Co') RETURNING id`, [orgB])).rows[0].id;
    vendorOtherOrg = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'Riyadh Stationers',$2) RETURNING id`, [orgB, VAT_A])).rows[0].id;
  }, 120_000);
  afterAll(async () => {
    await cleanup();
    await rm(archiveDir, { recursive: true, force: true });
    delete process.env.ZATCA_ARCHIVE_PROVIDER; delete process.env.ZATCA_ARCHIVE_DIR;
    resetEnvCache(); resetArchiveStoreForTests(); resetStagingBackendForTests();
  });

  let heldId = 0;

  it("🔴 X1: a draft with no stated document is judged AND PERSISTED as awaiting evidence; its approval POSTS it with the VAT in the HOLDING account — VAT_INPUT and the return do not move", async () => {
    const before = { vat: await gl("VAT_INPUT"), hold: await gl("VAT_AWAITING_EVIDENCE"), ap: await gl("AP"), box: await inputVat("2026-05", "2026-05") };
    const b = await bill({ vendorId: vendorA, vendorReference: "INV-100" });
    heldId = b.id;
    expect(b.status).toBe("draft");
    expect(b.vatEvidence.status).toBe("awaiting_evidence");
    expect(b.vatEvidence.flags.map((f) => f.code)).toEqual(["document_kind_not_stated"]);
    const stored = (await pool.query(`SELECT vat_evidence_status, vat_evidence_flags, vat_evidence_checked_at FROM bills WHERE id = $1`, [b.id])).rows[0];
    expect(stored.vat_evidence_status).toBe("awaiting_evidence");
    expect(stored.vat_evidence_flags[0].code).toBe("document_kind_not_stated");
    expect(stored.vat_evidence_checked_at).not.toBeNull();

    const posted = await inTenant(() => billsService.approve(b.id, {}, userId));
    expect(posted.status, "it POSTS — the answer to X1").toBe("received");
    expect(posted.inputVat).toMatchObject({ state: "awaiting_evidence", pending: 150, claimedOn: null, claimEntryId: null });
    expect(await entryLines(`BILL-${b.billNumber}`), "Dr expense / Dr the HOLDING asset / Cr AP — never VAT_INPUT").toEqual([
      ["PURCHASES", "1000.00", "0.00", "2026-05-10"],
      ["VAT_AWAITING_EVIDENCE", "150.00", "0.00", "2026-05-10"],
      ["AP", "0.00", "1150.00", "2026-05-10"],
    ]);
    expect(await gl("VAT_INPUT"), "no input VAT claimed").toBe(before.vat);
    expect(await gl("VAT_AWAITING_EVIDENCE") - before.hold, "the VAT is held").toBeCloseTo(150, 2);
    expect(await gl("AP") - before.ap, "the supplier is owed the gross").toBeCloseTo(-1150, 2);
    expect(await inputVat("2026-05", "2026-05"), "the VAT return is unmoved").toBe(before.box);
    expect((await pool.query(`SELECT vat_evidence_status FROM bills WHERE id = $1`, [b.id])).rows[0].vat_evidence_status).toBe("awaiting_evidence");
  });

  it("🔴 the held list FINDS it and says why — filterable by reason, searchable, set-wide counts", async () => {
    const page = await inTenant(() => billsService.heldForEvidence({ limit: 50, offset: 0 }));
    expect(page.items.map((i) => i.id)).toContain(heldId);
    expect(page.totals.byReason.find((r) => r.code === "document_kind_not_stated")?.count).toBeGreaterThanOrEqual(1);
    expect(page.totals.heldVat).toBeGreaterThanOrEqual(150);
    const byReason = await inTenant(() => billsService.heldForEvidence({ reason: "document_kind_not_stated", limit: 50, offset: 0 }));
    expect(byReason.items.map((i) => i.id)).toContain(heldId);
    const otherReason = await inTenant(() => billsService.heldForEvidence({ reason: "qr_signature_failed", limit: 50, offset: 0 }));
    expect(otherReason.items.map((i) => i.id)).not.toContain(heldId);
    const search = await inTenant(() => billsService.heldForEvidence({ q: "INV-100", limit: 50, offset: 0 }));
    expect(search.items.map((i) => i.id)).toEqual([heldId]);
    // company-scoped: the second company of the same organisation sees none of it
    const other = await inTenant(() => billsService.heldForEvidence({ limit: 50, offset: 0 }), orgId, company2);
    expect(other.items.map((i) => i.id)).not.toContain(heldId);
  });

  it("🔴 X1/X2: evidence supplied LATER claims the held VAT — Dr VAT_INPUT / Cr holding, dated the EVIDENCE day, on THAT period's return only; it leaves the list", async () => {
    const before = { vat: await gl("VAT_INPUT"), hold: await gl("VAT_AWAITING_EVIDENCE"), may: await inputVat("2026-05", "2026-05"), july: await inputVat("2026-07", "2026-07") };
    // a figure on a posted document cannot be edited — only its evidence
    await expectRefusal(inTenant(() => billsService.update(heldId, { supplierDocumentKind: "tax_invoice" })), 409);
    const after = await inTenant(() => billsService.attachEvidence(heldId, { supplierDocumentKind: "tax_invoice", evidenceDate: "2026-07-15" }, userId));
    expect(after.vatEvidence).toMatchObject({ status: "evidenced", basis: "attested" });
    expect(after.inputVat).toMatchObject({ state: "claimed", pending: 0, claimedOn: "2026-07-15" });
    expect(after.inputVat.claimEntryId).not.toBeNull();
    expect(await entryLines(`VATEV-${after.billNumber}`), "the evidence entry, dated the evidence day").toEqual([
      ["VAT_INPUT", "150.00", "0.00", "2026-07-15"],
      ["VAT_AWAITING_EVIDENCE", "0.00", "150.00", "2026-07-15"],
    ]);
    expect(await gl("VAT_INPUT") - before.vat).toBeCloseTo(150, 2);
    expect(await gl("VAT_AWAITING_EVIDENCE") - before.hold, "nothing left held").toBeCloseTo(-150, 2);
    expect(await inputVat("2026-05", "2026-05"), "X2: no prior-period correction — the supply's period is unmoved").toBe(before.may);
    expect(await inputVat("2026-07", "2026-07") - before.july, "claimed in the EVIDENCE period").toBeCloseTo(150, 2);
    const page = await inTenant(() => billsService.heldForEvidence({ limit: 50, offset: 0 }));
    expect(page.items.map((i) => i.id)).not.toContain(heldId);
    // and a second claim finds nothing held
    await expectRefusal(inTenant(() => billsService.attachEvidence(heldId, { evidenceDate: "2026-07-16" }, userId)), 409);
    const audit = (await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE entity_type = 'bill' AND entity_id = $1 AND action = 'input_vat_claimed'`, [String(heldId)])).rows[0].n;
    expect(audit).toBe(1);
  });

  it("🔴 an EVIDENCED bill is still claimed where it always was — on its own entry, in its own period (presence and movement)", async () => {
    const before = { vat: await gl("VAT_INPUT"), aug: await inputVat("2026-08", "2026-08") };
    const b = await bill({ vendorId: vendorA, vendorReference: "AUG-1", supplierDocumentKind: "tax_invoice", date: "2026-08-10" });
    const posted = await inTenant(() => billsService.approve(b.id, {}, userId));
    expect(posted.inputVat).toMatchObject({ state: "claimed", pending: 0, claimedOn: "2026-08-10", claimEntryId: null });
    expect(await entryLines(`BILL-${b.billNumber}`)).toEqual([
      ["PURCHASES", "1000.00", "0.00", "2026-08-10"], ["VAT_INPUT", "150.00", "0.00", "2026-08-10"], ["AP", "0.00", "1150.00", "2026-08-10"],
    ]);
    expect(await gl("VAT_INPUT") - before.vat).toBeCloseTo(150, 2);
    expect(await inputVat("2026-08", "2026-08") - before.aug).toBeCloseTo(150, 2);
  });

  it("🔴 insufficient evidence that is SUPPLIED but still insufficient claims NOTHING — the new verdict is stored, no entry posts", async () => {
    const b = await bill({ vendorId: vendorA, vendorReference: "", date: "2026-05-12", supplierDocumentKind: "no_tax_invoice" });
    await inTenant(() => billsService.approve(b.id, {}, userId));
    const vatBefore = await gl("VAT_INPUT");
    // a tax invoice with no number is still not evidence (Art. 53(5)(b))
    const after = await inTenant(() => billsService.attachEvidence(b.id, { supplierDocumentKind: "tax_invoice", evidenceDate: "2026-07-20" }, userId));
    expect(after.vatEvidence.status).toBe("awaiting_evidence");
    expect(after.vatEvidence.flags.map((f) => f.code)).toEqual(["supplier_invoice_number_missing"]);
    expect(after.inputVat).toMatchObject({ state: "awaiting_evidence", pending: 150 });
    expect(await gl("VAT_INPUT")).toBe(vatBefore);
    expect(await entryLines(`VATEV-${b.billNumber}`)).toEqual([]);
  });

  it("🔴 X2: the claim window — never before the supply, never in the future, never more than five calendar years after the supply's year (IR Art. 49(8))", async () => {
    const b = await bill({ vendorId: vendorA, vendorReference: "OLD-1", date: "2020-03-01" });
    await inTenant(() => billsService.approve(b.id, {}, userId));
    expect((await stateOf(b.id)).input_vat_state).toBe("awaiting_evidence");
    const vatBefore = await gl("VAT_INPUT");
    await expectRefusal(inTenant(() => billsService.attachEvidence(b.id, { supplierDocumentKind: "tax_invoice", evidenceDate: "2026-09-01" }, userId)), 422, "input_vat_claim_window");
    await expectRefusal(inTenant(() => billsService.attachEvidence(b.id, { supplierDocumentKind: "tax_invoice", evidenceDate: "2020-02-28" }, userId)), 422, "input_vat_claim_window");
    await expectRefusal(inTenant(() => billsService.attachEvidence(b.id, { supplierDocumentKind: "tax_invoice", evidenceDate: "2099-01-01" }, userId)), 422, "evidence_date_in_future");
    expect(await gl("VAT_INPUT"), "nothing claimed by any refusal").toBe(vatBefore);
    expect((await stateOf(b.id)).input_vat_state, "still held").toBe("awaiting_evidence");
    // movement: inside the window the same act claims it
    const ok = await inTenant(() => billsService.attachEvidence(b.id, { supplierDocumentKind: "tax_invoice", evidenceDate: "2025-12-31" }, userId));
    expect(ok.inputVat).toMatchObject({ state: "claimed", claimedOn: "2025-12-31" });
  });

  it("🔴 X3: a credit note on HELD VAT reduces the holding account — never VAT_INPUT, never the return — and the later claim is the NET, the note following it into that period", async () => {
    const orig = await bill({ vendorId: vendorA, vendorReference: "", date: "2026-06-05" });
    await inTenant(() => billsService.approve(orig.id, {}, userId));
    const before = { vat: await gl("VAT_INPUT"), hold: await gl("VAT_AWAITING_EVIDENCE"), june: await inputVat("2026-06", "2026-06"), aug: await inputVat("2026-08", "2026-08") };
    const note = await inTenant(() => billsService.create({ documentType: "credit_note", creditNoteAgainstBillId: orig.id, date: "2026-06-20", subtotal: 100, vatAmount: 15, total: 115, items: [] }, userId));
    const postedNote = await inTenant(() => billsService.approve(note.id, {}, userId));
    expect(postedNote.inputVat.state, "the note follows its held original").toBe("awaiting_evidence");
    expect(await entryLines(`BILLCN-${note.billNumber}`)).toEqual([
      ["PURCHASES", "0.00", "100.00", "2026-06-20"], ["VAT_AWAITING_EVIDENCE", "0.00", "15.00", "2026-06-20"], ["AP", "115.00", "0.00", "2026-06-20"],
    ]);
    expect(await gl("VAT_INPUT"), "a reduction of VAT never claimed does not touch VAT_INPUT").toBe(before.vat);
    expect(await gl("VAT_AWAITING_EVIDENCE") - before.hold).toBeCloseTo(-15, 2);
    expect(await inputVat("2026-06", "2026-06"), "no VAT-return entry for the note").toBe(before.june);
    expect((await stateOf(orig.id)).pending, "the original now holds the net").toBe("135.00");
    // a second note beyond what is held is refused, naming both figures
    const tooMuch = await inTenant(() => billsService.create({ documentType: "credit_note", creditNoteAgainstBillId: orig.id, date: "2026-06-21", subtotal: 10, vatAmount: 140, total: 150, items: [] }, userId));
    await expectRefusal(inTenant(() => billsService.approve(tooMuch.id, {}, userId)), 422, "credit_note_exceeds_held_vat");
    // the evidence cannot be dated before the note that already reduced what is held
    await expectRefusal(inTenant(() => billsService.attachEvidence(orig.id, { supplierDocumentKind: "tax_invoice", vendorReference: "INV-X3", evidenceDate: "2026-06-19" }, userId)), 422, "evidence_date_before_credit_note");
    expect((await stateOf(orig.id)).input_vat_state, "still held").toBe("awaiting_evidence");
    // the evidence arrives: the NET is claimed, in the evidence period, and the note follows
    const claimed = await inTenant(() => billsService.attachEvidence(orig.id, { supplierDocumentKind: "tax_invoice", vendorReference: "INV-X3", evidenceDate: "2026-08-03" }, userId));
    expect(claimed.inputVat).toMatchObject({ state: "claimed", pending: 0, claimedOn: "2026-08-03" });
    expect(await entryLines(`VATEV-${orig.billNumber}`)).toEqual([["VAT_INPUT", "135.00", "0.00", "2026-08-03"], ["VAT_AWAITING_EVIDENCE", "0.00", "135.00", "2026-08-03"]]);
    expect(await gl("VAT_INPUT") - before.vat).toBeCloseTo(135, 2);
    expect(await gl("VAT_AWAITING_EVIDENCE") - before.hold, "nothing left held").toBeCloseTo(-150, 2);
    expect(await inputVat("2026-08", "2026-08") - before.aug, "the return claims the NET, in the evidence period").toBeCloseTo(135, 2);
    expect(await inputVat("2026-06", "2026-06")).toBe(before.june);
    expect(await stateOf(note.id)).toMatchObject({ input_vat_state: "claimed", input_vat_claimed_on: "2026-08-03" });
  });

  it("🔴 the ledger sweep ties the HOLDING account to the documents' held VAT — clean after every scenario above, and it SEES a planted divergence", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const run = (name: string) => {
      const out = joinPath(mkdtempSync(joinPath(tmpdir(), "p13-inv-")), `${name}.json`);
      try { execFileSync(process.execPath, ["--import", "tsx", "src/scripts/ledgerInvariants.ts", "--json", out], { cwd: joinPath(__dirname, "..", ".."), env: process.env, stdio: "pipe", timeout: 120_000 }); } catch { /* exit 2 is fine; the report is written */ }
      expect(existsSync(out)).toBe(true);
      const report = JSON.parse(readFileSync(out, "utf8")) as Record<string, Array<Record<string, unknown>>>;
      return (Object.entries(report).find(([k]) => k.startsWith("vat_awaiting_evidence_gl_vs_bills"))?.[1] ?? []).filter((r) => r.org === orgId);
    };
    expect(run("clean"), "every held, noted and claimed document above reconciles").toEqual([]);
    const held = await bill({ vendorId: vendorA, vendorReference: "", date: "2026-05-18" });
    await inTenant(() => billsService.approve(held.id, {}, userId));
    await pool.query(`UPDATE bills SET input_vat_pending = input_vat_pending + 1 WHERE id = $1`, [held.id]);
    try {
      expect(run("planted").map((r) => [r.gl, r.documents]), "a held amount no entry carries is SEEN").toHaveLength(1);
    } finally {
      await pool.query(`UPDATE bills SET input_vat_pending = input_vat_pending - 1 WHERE id = $1`, [held.id]);
    }
    expect(run("restored")).toEqual([]);
  }, 120_000);

  it("🔴 an INVALID QR cannot produce a claim: the document posts with its VAT held, and supplying the same failed document again claims nothing", async () => {
    const bad = await capture({ source: "qr", qrPayload: qr({ total: "345.00", vatTotal: "45.00", sign: "tampered" }), extraction: { total: 345 }, bytes: Buffer.concat([PNG, Buffer.from([5, 5])]) });
    const b = await bill({ vendorId: vendorA, supplierDocumentKind: "simplified_tax_invoice", date: "2026-05-14", subtotal: 300, vatAmount: 45, total: 345, captureId: bad.captureId });
    expect(b.vatEvidence.flags.map((f) => f.code)).toContain("qr_signature_failed");
    const before = { vat: await gl("VAT_INPUT"), box: await inputVat("2026-05", "2026-05") };
    const posted = await inTenant(() => billsService.approve(b.id, {}, userId));
    expect(posted.inputVat).toMatchObject({ state: "awaiting_evidence", pending: 45 });
    const again = await inTenant(() => billsService.attachEvidence(b.id, { evidenceDate: "2026-07-01" }, userId));
    expect(again.inputVat.state).toBe("awaiting_evidence");
    expect(await gl("VAT_INPUT")).toBe(before.vat);
    expect(await inputVat("2026-05", "2026-05")).toBe(before.box);
  });

  it("🔴 THE DATABASE refuses what a path forgets: posting without stating where the VAT sits, CLAIMING held VAT without evidence, and any other change of a posted document's VAT state", async () => {
    /** Run statements in a transaction that is always rolled back; the SQLSTATE of the first failure, or "ok". */
    const attempt = async (...stmts: Array<[string, unknown[]]>) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        for (const [q, v] of stmts) await c.query(q, v);
        return "ok";
      } catch (e) { return (e as { code?: string }).code ?? "error"; } finally { await c.query("ROLLBACK"); c.release(); }
    };
    const held = await bill({ vendorId: vendorA, vendorReference: "INV-TRIG" });
    expect(held.vatEvidence.status).toBe("awaiting_evidence");
    expect(await attempt([`UPDATE bills SET status = 'received' WHERE id = $1`, [held.id]]), "a posting that states no VAT treatment").toBe("23514");
    expect(await attempt([`UPDATE bills SET status = 'received', input_vat_state = 'claimed', input_vat_claimed_on = date WHERE id = $1`, [held.id]]), "held evidence posted as CLAIMED").toBe("23514");
    // positive control: the same held draft posted AS HELD is admitted
    expect(await attempt([`UPDATE bills SET status = 'received', input_vat_state = 'awaiting_evidence', input_vat_pending = 150 WHERE id = $1`, [held.id]])).toBe("ok");
    const ok = await bill({ vendorId: vendorA, vendorReference: "INV-TRIG-OK", supplierDocumentKind: "tax_invoice" });
    expect(await attempt([`UPDATE bills SET status = 'received', input_vat_state = 'claimed', input_vat_claimed_on = date WHERE id = $1`, [ok.id]]), "evidenced → claimed is admitted").toBe("ok");

    // a POSTED held document: claiming it needs the evidence, nothing left pending, and the window
    const posted = await bill({ vendorId: vendorA, vendorReference: "INV-TRIG-P", date: "2026-05-16" });
    await inTenant(() => billsService.approve(posted.id, {}, userId));
    const claim = (on: string) => [`UPDATE bills SET input_vat_state = 'claimed', input_vat_pending = 0, input_vat_claimed_on = '${on}' WHERE id = $1`, [posted.id]] as [string, unknown[]];
    const evidenced: [string, unknown[]] = [`UPDATE bills SET vat_evidence_status = 'evidenced' WHERE id = $1`, [posted.id]];
    expect(await attempt(claim("2026-07-01")), "claimed while the verdict is still awaiting").toBe("23514");
    expect(await attempt(evidenced, claim("2032-01-01")), "the sixth calendar year").toBe("23514");
    expect(await attempt(evidenced, claim("2026-05-15")), "before the supply").toBe("23514");
    expect(await attempt(evidenced, [`UPDATE bills SET input_vat_state = 'not_deductible', input_vat_pending = 0 WHERE id = $1`, [posted.id]]), "held → cost is no transition").toBe("23514");
    expect(await attempt(evidenced, claim("2031-12-31")), "positive control: evidenced, inside the window").toBe("ok");
    // the CHECKs: held VAT only while held; a claim names its period
    expect(await attempt([`UPDATE bills SET input_vat_pending = -1 WHERE id = $1`, [posted.id]])).toBe("23514");
  });

  it("🔴 X5 Art. 50: a bill on a BLOCKED expense account POSTS with its VAT in the expense's COST — never VAT_INPUT, never the holding account, never the return, never the held list", async () => {
    const before = { vat: await gl("VAT_INPUT"), hold: await gl("VAT_AWAITING_EVIDENCE"), ap: await gl("AP"), box: await inputVat("2026-05", "2026-05") };
    const mealsBalance = async () => Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE e.organization_id = $1 AND l.account_id = $2 AND e.status IN ('posted','reversed')`, [orgId, mealsId])).rows[0].v);
    const mealsBefore = await mealsBalance();
    const b = await bill({ vendorId: vendorA, vendorReference: "MEAL-1", supplierDocumentKind: "tax_invoice", expenseAccountId: mealsId });
    expect(b.vatEvidence.status).toBe("not_deductible");
    const posted = await inTenant(() => billsService.approve(b.id, {}, userId));
    expect(posted.inputVat).toMatchObject({ state: "not_deductible", pending: 0, claimedOn: null });
    const lines = await entryLines(`BILL-${b.billNumber}`);
    expect(lines.map((l) => [l[1], l[2]]), "two lines: the gross into the expense, the gross to AP").toEqual([["1150.00", "0.00"], ["0.00", "1150.00"]]);
    expect(lines[1]![0]).toBe("AP");
    expect(await mealsBalance() - mealsBefore, "the VAT is part of the expense").toBeCloseTo(1150, 2);
    expect(await gl("VAT_INPUT")).toBe(before.vat);
    expect(await gl("VAT_AWAITING_EVIDENCE")).toBe(before.hold);
    expect(await inputVat("2026-05", "2026-05"), "not input VAT on the return").toBe(before.box);
    const held = await inTenant(() => billsService.heldForEvidence({ limit: 200, offset: 0 }));
    expect(held.items.map((i) => i.id), "blocked VAT is not waiting for anything").not.toContain(b.id);
    // the body cannot override its way past it: a blocked account named AT approval is judged too
    const b2 = await bill({ vendorId: vendorA, vendorReference: "MEAL-2", supplierDocumentKind: "tax_invoice" });
    expect(b2.vatEvidence.status).toBe("evidenced");
    const vatBefore2 = await gl("VAT_INPUT");
    const posted2 = await inTenant(() => billsService.approve(b2.id, { debitAccountId: mealsId }, userId));
    expect(posted2.inputVat.state).toBe("not_deductible");
    expect(await gl("VAT_INPUT"), "the override did not claim the blocked VAT").toBe(vatBefore2);
  });

  it("🔴 the supplier's VAT number IS evidence: adding it to the supplier re-decides their unposted bills", async () => {
    const b = await bill({ vendorId: vendorNoVat, vendorReference: "CS-1", supplierDocumentKind: "tax_invoice" });
    expect(b.vatEvidence.flags.map((f) => f.code)).toEqual(["supplier_vat_number_missing"]);
    await inTenant(() => vendorsService.update(vendorNoVat, { taxNumber: VAT_B }));
    const after = await inTenant(() => billsService.getById(b.id));
    expect(after.vatEvidence.status).toBe("evidenced");
  });

  it("a supplier credit note needs no evidence — holding back a REDUCTION would keep an over-claim alive", async () => {
    const orig = await bill({ vendorId: vendorA, vendorReference: "INV-CN", supplierDocumentKind: "tax_invoice" });
    await inTenant(() => billsService.approve(orig.id, {}, userId));
    const note = await inTenant(() => billsService.create({ documentType: "credit_note", creditNoteAgainstBillId: orig.id, date: "2026-05-12", subtotal: 100, vatAmount: 15, total: 115, items: [] }, userId));
    expect(note.vatEvidence.status).toBe("not_required");
    const posted = await inTenant(() => billsService.approve(note.id, {}, userId));
    expect(posted.status).toBe("received");
  });

  // ── the scan path ─────────────────────────────────────────────────────────

  let scanned = { captureId: "", billId: 0 };

  it("🔴 a scanned receipt becomes a DRAFT — never posted by the capture or the save; its document is linked, fieldSources kept, corrections kept BESIDE the extraction", async () => {
    const vatBefore = await gl("VAT_INPUT");
    const payload = qr({ total: "575.00", vatTotal: "75.00", sign: "valid" });
    const cap = await capture({
      source: "qr", qrPayload: payload,
      extraction: { vendorName: "مورد", supplierVatNumber: VAT_A, vendorReference: "", date: "2026-05-10", subtotal: 500, vatAmount: 75, total: 575 },
      fieldSources: { supplierVatNumber: "qr", total: "qr", vatAmount: "qr", subtotal: "qr_derived", date: "qr", vendorReference: "manual" },
    });
    expect(cap.signatureStatus).toBe("verified");
    const b = await bill({ vendorId: vendorA, vendorReference: "S-551", supplierDocumentKind: "simplified_tax_invoice", subtotal: 500, vatAmount: 75, total: 575, captureId: cap.captureId });
    scanned = { captureId: cap.captureId, billId: b.id };
    expect(b.status, "saved as a DRAFT — nothing posts until approval").toBe("draft");
    expect(await gl("VAT_INPUT"), "the save claimed nothing").toBe(vatBefore);
    expect(b.vatEvidence).toMatchObject({ status: "evidenced", basis: "qr_signature_verified" });
    expect(b.evidenceDocument).toMatchObject({ captureId: cap.captureId, status: "staged", source: "qr" });
    expect(b.evidenceDocument?.fieldSources).toMatchObject({ total: "qr", subtotal: "qr_derived", vendorReference: "manual" });
    // the reviewer typed the invoice number the QR does not carry — recorded as a correction, extraction untouched
    expect(b.evidenceDocument?.reviewCorrections).toEqual([]); // extraction had no invoice number to correct
    const row = (await pool.query(`SELECT status, bill_id, extraction, review_corrections FROM captured_documents WHERE id = $1`, [cap.captureId])).rows[0];
    expect(row).toMatchObject({ status: "staged", bill_id: b.id });
    expect(row.extraction.vendorReference).toBe("");
  });

  it("🔴 a reviewer's change to an extracted figure is recorded against the extraction, which is never overwritten", async () => {
    await inTenant(() => billsService.update(scanned.billId, { date: "2026-05-11" }));
    const after = await inTenant(() => billsService.getById(scanned.billId));
    expect(after.evidenceDocument?.reviewCorrections).toEqual([{ field: "date", extracted: "2026-05-10", final: "2026-05-11" }]);
    expect((await pool.query(`SELECT extraction->>'date' d FROM captured_documents WHERE id = $1`, [scanned.captureId])).rows[0].d).toBe("2026-05-10");
    // the QR's date now differs from the bill: noted, not a hold
    expect(after.vatEvidence.flags.map((f) => f.code)).toContain("qr_date_differs");
    expect(after.vatEvidence.status).toBe("evidenced");
  });

  it("🔴 posting promotes the linked document to evidence and it STAYS linked to the posted bill", async () => {
    const posted = await inTenant(() => billsService.approve(scanned.billId, {}, userId));
    expect(posted.status).toBe("received");
    const row = (await pool.query(`SELECT status, bill_id, retain_until FROM captured_documents WHERE id = $1`, [scanned.captureId])).rows[0];
    expect(row.status).toBe("promotion_pending");
    expect(row.bill_id).toBe(scanned.billId);
    expect(row.retain_until).not.toBeNull();
    const read = await inTenant(() => billsService.getById(scanned.billId));
    expect(read.evidenceDocument?.captureId).toBe(scanned.captureId);
  });

  it("🔴 a document whose signature FAILED holds the draft; discarding a draft's document re-decides it; a staged linked document is not purged, and is once its draft is deleted", async () => {
    const bad = await capture({ source: "qr", qrPayload: qr({ total: "230.00", vatTotal: "30.00", sign: "tampered" }), extraction: { total: 230 } });
    expect(bad.signatureFailed).toBe(true);
    const b = await bill({ vendorId: vendorA, supplierDocumentKind: "simplified_tax_invoice", subtotal: 200, vatAmount: 30, total: 230, captureId: bad.captureId });
    expect(b.vatEvidence.flags.map((f) => f.code)).toContain("qr_signature_failed");
    expect(b.vatEvidence.status, "held — what its APPROVAL does is the invalid-QR test above").toBe("awaiting_evidence");

    // the linked staged document is the draft's evidence: never purgeable while linked
    await pool.query(`UPDATE captured_documents SET captured_at = now() - interval '90 days' WHERE id = $1`, [bad.captureId]);
    const purgeable = async () => (await capturedDocumentsJobRepository.listPurgeable(30, 500, orgId)).map((r) => r.id);
    expect(await purgeable()).not.toContain(bad.captureId);
    // an UNLINKED old staged capture IS purgeable — the probe can see a present case
    const loose = await capture({ bytes: Buffer.concat([PNG, Buffer.from([1])]) });
    await pool.query(`UPDATE captured_documents SET captured_at = now() - interval '90 days' WHERE id = $1`, [loose.captureId]);
    expect(await purgeable()).toContain(loose.captureId);

    // discarding the draft's document re-decides the draft at once
    await inTenant(() => captureService.discard(bad.captureId));
    const after = await inTenant(() => billsService.getById(b.id));
    expect(after.vatEvidence.flags.map((f) => f.code)).toEqual(["simplified_invoice_document_missing"]);

    // deleting a draft unlinks its still-staged document (the FK would otherwise refuse the delete)
    const cap2 = await capture({ bytes: Buffer.concat([PNG, Buffer.from([2])]) });
    const d = await bill({ vendorId: vendorA, vendorReference: "DEL-1", supplierDocumentKind: "tax_invoice", captureId: cap2.captureId });
    await inTenant(() => billsService.deleteDraft(d.id));
    expect((await pool.query(`SELECT bill_id FROM captured_documents WHERE id = $1`, [cap2.captureId])).rows[0].bill_id).toBeNull();
  });

  it("a document already another bill's evidence cannot be attached to a second one", async () => {
    const cap = await capture({ bytes: Buffer.concat([PNG, Buffer.from([3])]) });
    await bill({ vendorId: vendorA, vendorReference: "ONE-1", supplierDocumentKind: "tax_invoice", captureId: cap.captureId });
    await expectRefusal(bill({ vendorId: vendorA, vendorReference: "ONE-2", supplierDocumentKind: "tax_invoice", captureId: cap.captureId }), 422, "capture_unavailable");
  });

  it("🔴 PDF and WEBP are accepted BY THEIR BYTES and preserved; a file that is neither is still refused", async () => {
    const pdf = await capture({ bytes: PDF, fileName: "invoice.pdf", source: "manual" });
    const webp = await capture({ bytes: WEBP, fileName: "photo.webp", source: "ocr" });
    const rows = (await pool.query(`SELECT id, content_type, sha256, byte_size FROM captured_documents WHERE id = ANY($1)`, [[pdf.captureId, webp.captureId]])).rows;
    expect(rows.find((r) => r.id === pdf.captureId)).toMatchObject({ content_type: "application/pdf", sha256: createHash("sha256").update(PDF).digest("hex"), byte_size: PDF.length });
    expect(rows.find((r) => r.id === webp.captureId)).toMatchObject({ content_type: "image/webp", byte_size: WEBP.length });
    const img = await inTenant(() => captureService.image(webp.captureId));
    expect(Buffer.compare(img.bytes, WEBP), "the original bytes come back unchanged").toBe(0);
    await expectRefusal(capture({ bytes: Buffer.from("GIF89a-not-allowed"), fileName: "x.webp" }), 400);
    // a WEBP renamed .pdf is stored as what its bytes are
    const renamed = await capture({ bytes: Buffer.concat([WEBP, Buffer.from([9])]), fileName: "lies.pdf" });
    expect((await pool.query(`SELECT content_type FROM captured_documents WHERE id = $1`, [renamed.captureId])).rows[0].content_type).toBe("image/webp");
  });

  it("an unknown fieldSources label is refused rather than stored as provenance", async () => {
    await expectRefusal(capture({ bytes: Buffer.concat([PNG, Buffer.from([4])]), fieldSources: { total: "ai-guess" } }), 400);
  });

  // ── duplicates: WARN, never refuse; company- and organisation-scoped ────

  it("🔴 duplicates are WARNED about — the same file, the same supplier invoice number (across supplier records sharing a VAT number), the same supplier/date/total — and nothing is refused", async () => {
    const bytes = Buffer.concat([PNG, Buffer.from([7, 7])]);
    const first = await capture({ bytes });
    expect(first.duplicates).toEqual([]);
    const b1 = await bill({ vendorId: vendorA, vendorReference: "DUP-9", supplierDocumentKind: "tax_invoice", date: "2026-05-20", captureId: first.captureId });
    const second = await capture({ bytes });
    expect(second.duplicates.map((d) => [d.reason, d.billId])).toEqual([["same_file", b1.id]]);

    // the same supplier invoice number, entered against ANOTHER record of the same supplier (same VAT number)
    const b2 = await bill({ vendorId: vendorA2, vendorReference: " dup-9 ", supplierDocumentKind: "tax_invoice", date: "2026-05-21", captureId: second.captureId });
    expect(b2.status, "a warning, never a refusal — the second document saved").toBe("draft");
    const d = await inTenant(() => billsService.duplicates({ billId: b2.id, vendorId: vendorA2, vendorReference: "dup-9", date: "2026-05-21", total: 1150, captureId: second.captureId }));
    const reasons = d.items.map((x) => `${x.reason}:${x.billId}`);
    expect(reasons).toContain(`same_supplier_invoice:${b1.id}`);
    expect(reasons).toContain(`same_file:${b1.id}`);
    expect(reasons, "never itself").not.toContain(`same_supplier_invoice:${b2.id}`);

    const d2 = await inTenant(() => billsService.duplicates({ vendorId: vendorA, date: "2026-05-20", total: 1150 }));
    expect(d2.items.map((x) => `${x.reason}:${x.billId}`)).toContain(`same_supplier_date_amount:${b1.id}`);
  });

  it("🔴 duplicate detection is scoped: another company of the same organisation, and another organisation, are never 'duplicates' — and each sees its own", async () => {
    const other = await bill({ vendorId: vendorA, vendorReference: "ISO-1", supplierDocumentKind: "tax_invoice" }, orgId, company2);
    const orgBBill = await bill({ vendorId: vendorOtherOrg, vendorReference: "ISO-1", supplierDocumentKind: "tax_invoice" }, orgB, companyB);
    const mine = await bill({ vendorId: vendorA, vendorReference: "ISO-1", supplierDocumentKind: "tax_invoice" });
    const seen = await inTenant(() => billsService.duplicates({ billId: mine.id, vendorId: vendorA, vendorReference: "ISO-1" }));
    expect(seen.items.map((x) => x.billId)).not.toContain(other.id);
    expect(seen.items.map((x) => x.billId)).not.toContain(orgBBill.id);
    // movement: the second company DOES see its own document as a duplicate of a second entry there
    const again = await bill({ vendorId: vendorA, vendorReference: "ISO-1", supplierDocumentKind: "tax_invoice" }, orgId, company2);
    const inCo2 = await inTenant(() => billsService.duplicates({ billId: again.id, vendorId: vendorA, vendorReference: "ISO-1" }), orgId, company2);
    expect(inCo2.items.map((x) => x.billId)).toEqual([other.id]);
    // and the other organisation sees its own, never ours
    const againB = await bill({ vendorId: vendorOtherOrg, vendorReference: "ISO-1", supplierDocumentKind: "tax_invoice" }, orgB, companyB);
    const inB = await inTenant(() => billsService.duplicates({ billId: againB.id, vendorId: vendorOtherOrg, vendorReference: "ISO-1" }), orgB, companyB);
    expect(inB.items.map((x) => x.billId)).toEqual([orgBBill.id]);
    // same-file captures are scoped too
    const bytes = Buffer.concat([PNG, Buffer.from([8, 8])]);
    await capture({ bytes }, orgB, companyB);
    const ours = await capture({ bytes });
    expect(ours.duplicates, "the other organisation's copy of the same file is not ours").toEqual([]);

    // 🔴 The explicit company predicate is what is under test here, not RLS:
    // on an ORG-WIDE connection (no company set) RLS lets every company's rows
    // through, so a query WITHOUT its own predicate would return both
    // companies' ISO-1 bills. With it, the answer is EMPTY — withheld, never
    // merged (CLAUDE.md §3, "make the layers disagree").
    const orgWide = await beginTenantConnection({ organizationId: orgId, companyId: null, role: "authenticated" });
    try {
      const wide = await orgWide.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, () =>
        billsService.duplicates({ vendorId: vendorA, vendorReference: "ISO-1" })));
      expect(wide.items, "no company in scope → nothing, never another company's documents").toEqual([]);
      const held = await orgWide.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, () =>
        billsService.heldForEvidence({ limit: 50, offset: 0 })));
      expect(held.page.total).toBe(0);
    } finally { await orgWide.rollback(); }
  });

  it("the preview gives the same verdict a save writes — and writes nothing", async () => {
    const n = Number((await pool.query(`SELECT count(*) n FROM bills WHERE organization_id = $1`, [orgId])).rows[0].n);
    const v = await inTenant(() => billsService.evidencePreview({ vendorId: vendorA, vendorReference: "PV-1", supplierDocumentKind: "no_tax_invoice", subtotal: 100, vatAmount: 15, total: 115, date: "2026-05-10" }));
    expect(v).toMatchObject({ status: "awaiting_evidence" });
    expect(v.flags.map((f) => f.code)).toEqual(["no_tax_invoice"]);
    expect(Number((await pool.query(`SELECT count(*) n FROM bills WHERE organization_id = $1`, [orgId])).rows[0].n)).toBe(n);
  });
});
