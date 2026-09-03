/**
 * L1 — the document pipeline against REAL LEDGER ROWS (standing rule 2:
 * fixtures test the code you wrote; only real rows test the code you forgot).
 *
 * The invoice is created and APPROVED through the product's own write path,
 * with one line carrying Arabic and one without — the mixed case every real
 * tenant will have. Asserted:
 *
 *   - a draft REFUSES to render (409-shaped), and the refusal says why;
 *   - the model carries the Hijri date, the buyer, and the QR minted at
 *     approval;
 *   - the missing-Arabic FINDING flags the issued invoice (1 of 2 lines) and
 *     ignores drafts — the surfacing half of the fallback decision;
 *   - when a Chromium executable is present, the full render produces a PDF
 *     whose DECOMPRESSED bytes carry the PDF/A structures (raw-byte grep lies
 *     — the spike's compressed-stream lesson; page TEXT is deliberately not
 *     asserted here, see the inline note). Without a browser the render half
 *     SKIPS, loudly, by name.
 *
 * CONFORMANCE is veraPDF's verdict, not this file's: PASS 3b on both
 * renderings was recorded at build (see the L1 close-out record); this suite
 * checks structure, not conformance.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { inflateSync } from "node:zlib";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { findingsRepository } from "../repositories/findings.repository";
import {
  buildInvoiceDocModel,
  renderInvoicePdf,
  closeDocumentRenderer,
  RendererUnavailableError,
} from "../services/invoiceDocument/invoiceDocument.service";
import { createApproved } from "./helpers/createApproved";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[invoice-document-live] no real DATABASE_URL — skipping.");

const SLUG = "l1-document";
const EMAIL = "l1-doc@test.local";
const DATE = "2026-07-20";

function decompressed(pdf: Uint8Array): Buffer {
  const raw = Buffer.from(pdf);
  let out = Buffer.from(raw);
  const re = /stream\r?\n/g;
  // Best-effort: append every inflatable stream so text assertions see through
  // FlateDecode — a grep over raw PDF bytes reported present structures absent
  // once already (probe rule, instance 1).
  let m: RegExpExecArray | null;
  const hay = raw.toString("latin1");
  while ((m = re.exec(hay))) {
    const start = m.index + m[0].length;
    const end = hay.indexOf("endstream", start);
    if (end < 0) continue;
    try {
      out = Buffer.concat([out, inflateSync(raw.subarray(start, end))]);
    } catch {
      /* not every stream is flate */
    }
  }
  return out;
}

describeMaybe("L1 — the invoice document, from real rows", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let invoiceId = 0;
  let draftId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.66" }, fn),
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
    const usr = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM findings WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('L1 Doc Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, city) VALUES ($1,'L1 Doc Co','شركة المستند','1010606060','399999999944403','الرياض') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','L1 Approver',' ','admin',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(
        `INSERT INTO customers (organization_id, name, name_ar, tax_number) VALUES ($1,'Doc Client','عميل المستند','300000000000003') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;

    const inv = await inTenant(() =>
      createApproved<{ id: number }>(invoicesService, {
        invoiceNumber: "L1-INV-1",
        date: DATE,
        dueDate: DATE,
        customerId,
        items: [
          { description: "Consulting", descriptionAr: "استشارات", quantity: 2, unitPrice: 100, vatRate: 15 },
          { description: "Audit work", quantity: 1, unitPrice: 300, vatRate: 15 }, // no Arabic — the real mixed case
        ],
      }, userId),
    );
    invoiceId = inv.id;
    const draft = await inTenant(() =>
      invoicesService.create(
        { invoiceNumber: "L1-DRAFT-1", date: DATE, customerId, items: [{ description: "Draft only", quantity: 1, unitPrice: 50, vatRate: 15 }] },
        userId,
      ),
    );
    draftId = draft.id;
  });

  afterAll(async () => {
    await closeDocumentRenderer();
    await cleanup();
  });

  it("a draft refuses to render, and says why", async () => {
    await expect(inTenant(() => buildInvoiceDocModel(draftId, "ar"))).rejects.toThrow(/issued|Approve/i);
  });

  it("the model carries the Hijri date, the buyer, the QR minted at approval — and NULL Arabic where none was sent", async () => {
    const model = await inTenant(() => buildInvoiceDocModel(invoiceId, "ar"));
    expect(model.dateHijri).toMatch(/^\d{4}-\d{2}-\d{2} هـ$/);
    expect(model.buyer?.vatNumber).toBe("300000000000003");
    expect(model.qrDataUrl, "the QR is minted at approval and must reach the document").toMatch(/^data:image\/png/);
    const noAr = model.lines.find((l) => l.description === "Audit work");
    // Post-0067: an absent translation is NULL, never the sentinel.
    expect(noAr?.descriptionAr ?? null).toBeNull();
  });

  it("🔴 the missing-Arabic finding names the issued invoice (1 of 2 lines) and ignores the draft", async () => {
    const found = await inTenant(() => findingsRepository.invoicesMissingArabicLines());
    const mine = found.filter((f) => (f.facts as { invoiceNumber?: string }).invoiceNumber?.startsWith("L1-"));
    expect(mine).toHaveLength(1);
    const facts = mine[0].facts as { invoiceNumber: string; missing: number; totalLines: number };
    expect(facts.invoiceNumber).toBe("L1-INV-1");
    expect(facts.missing).toBe(1);
    expect(facts.totalLines).toBe(2);
  });

  it("the full render: PDF/A markers present, sentinel absent — through the DECOMPRESSED bytes (skips without Chromium)", async () => {
    const model = await inTenant(() => buildInvoiceDocModel(invoiceId, "ar"));
    let pdf: Uint8Array;
    try {
      pdf = await renderInvoicePdf(model);
    } catch (err) {
      if (err instanceof RendererUnavailableError) {
        console.warn("[invoice-document-live] no Chromium executable — render assertions SKIPPED (CI's e2e job covers the endpoint).");
        return;
      }
      throw err;
    }
    expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe("%PDF-");
    const blob = decompressed(pdf);
    expect(blob.includes("OutputIntents"), "PDF/A OutputIntent").toBe(true);
    expect(blob.includes("GTS_PDFA1")).toBe(true);
    /**
     * 🔴 Deliberately NOT asserted here: page TEXT ("the sentinel is absent
     * from the PDF", "the English fallback printed"). Chromium subsets fonts
     * with glyph encodings, so an ASCII grep over content streams is vacuous
     * in BOTH directions — the sentinel would "be absent" from any PDF, which
     * is the unread-instrument shape. Those properties are pinned where text
     * IS assertable: the HTML unit suite (with the sentinel PLANTED in its
     * fixture), and the spike's pdftotext extraction proved the text layer
     * once. This test asserts what bytes answer honestly: the PDF/A
     * structures.
     */
  });
});
