/**
 * A1 part 2 — capture persistence, provenance, verification and promotion.
 *
 * The properties that matter here are not "it stores a file". They are:
 *   1. **Provenance survives** — "was this decoded, OCR'd, or typed?" is
 *      answerable after the fact, which it was not before A1.
 *   2. **Signature verification is SERVER-side** and a failure is visible.
 *   3. **Neither wrong state is reachable**: evidence for a bill that does not
 *      exist, or a bill whose evidence never promoted.
 *   4. **The purge job never touches evidence.**
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginTenantConnection, pool } from "@workspace/db";
import { QR_TAG, bytesToBase64, concatBytes, tlv, utf8Bytes } from "@workspace/zatca-tlv";
import { auditContext } from "../lib/auditContext";
import { captureService } from "../services/capture/capture.service";
import { capturePromotionService } from "../services/capture/promotion.service";
import { verifyQrSignature } from "../services/capture/signatureVerification";
import { resetArchiveStoreForTests } from "../services/einvoice/archive/resolveArchiveStore";
import { resetStagingBackendForTests } from "../services/capture/stagingBackend";
import { resetEnvCache } from "@workspace/config";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[document-capture] no real DATABASE_URL — skipping.");

const SLUG = "a1-capture";
const EMAIL = "a1-capture@test.local";

/** A 1x1 PNG — real magic bytes, so the sniffer accepts it. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describeMaybe("A1 — document capture, provenance and promotion", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let vendorId = 0;
  let archiveDir = "";

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.1" }, fn),
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
    await pool.query(`DELETE FROM captured_documents WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bill_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bills WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM vendors WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    archiveDir = await mkdtemp(join(tmpdir(), "a1-capture-"));
    process.env.ZATCA_ARCHIVE_PROVIDER = "local-fs";
    process.env.ZATCA_ARCHIVE_DIR = archiveDir;
    resetEnvCache();
    resetArchiveStoreForTests();
    // B3: the staging backend memoizes its root too — a stale one would point
    // this suite at another test's temp directory.
    resetStagingBackendForTests();

    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Capture Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'Capture Co','1010101010','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','CAP',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    vendorId = (
      await pool.query(`INSERT INTO vendors (organization_id, name, name_ar) VALUES ($1,'Supplier','مورد') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await rm(archiveDir, { recursive: true, force: true });
    delete process.env.ZATCA_ARCHIVE_PROVIDER;
    delete process.env.ZATCA_ARCHIVE_DIR;
    resetEnvCache();
    resetArchiveStoreForTests();
    resetStagingBackendForTests();
  });

  const capture = (over: Partial<Parameters<typeof captureService.capture>[0]> = {}) =>
    inTenant(() =>
      captureService.capture(
        { bytes: PNG, fileName: "receipt.png", source: "ocr", ...over },
        { organizationId: orgId, companyId, userId },
      ),
    );

  // ── Provenance ───────────────────────────────────────────────────────────

  describe("provenance survives the capture", () => {
    it("🔴 records HOW each figure was obtained — the question a dispute raises", async () => {
      const res = await capture({
        source: "qr",
        extraction: { total: 1150, vatAmount: 150 },
        fieldSources: { total: "qr", vatAmount: "qr", vendorName: "manual" },
      });

      const doc = await inTenant(() => captureService.get(res.captureId));
      expect(doc.source).toBe("qr");
      // A user who corrected one field must not leave it claiming to be decoded.
      expect(doc.fieldSources).toEqual({ total: "qr", vatAmount: "qr", vendorName: "manual" });
      expect(doc.extraction).toEqual({ total: 1150, vatAmount: 150 });
    });

    it("survives a refresh — the sessionStorage gap A1 closes", async () => {
      const res = await capture({ extraction: { total: 99 } });
      // A fresh read with no client state at all.
      const doc = await inTenant(() => captureService.get(res.captureId));
      expect(doc.extraction).toEqual({ total: 99 });
      expect(doc.status).toBe("staged");
    });

    it("retains the document itself, so a bill can be traced to its photograph", async () => {
      const res = await capture();
      const img = await inTenant(() => captureService.image(res.captureId));
      expect(img.bytes.equals(PNG)).toBe(true);
      expect(img.contentType).toBe("image/png");
    });

    it("rejects bytes that are not an allowed type, whatever the filename claims", async () => {
      await expect(
        capture({ bytes: Buffer.from("#!/bin/sh\nrm -rf /"), fileName: "receipt.png" }),
      ).rejects.toBeTruthy();
    });
  });

  // ── Signature verification ───────────────────────────────────────────────

  describe("🔴 signature verification is SERVER-side and failure is visible", () => {
    const phase1Payload = bytesToBase64(
      concatBytes([
        tlv(QR_TAG.SELLER_NAME, utf8Bytes("مورد")),
        tlv(QR_TAG.VAT_NUMBER, utf8Bytes("399999999999993")),
        tlv(QR_TAG.TIMESTAMP, utf8Bytes("2026-08-12T10:00:00")),
        tlv(QR_TAG.TOTAL_WITH_VAT, utf8Bytes("1150.00")),
        tlv(QR_TAG.VAT_TOTAL, utf8Bytes("150.00")),
      ]),
    );

    it("a Phase 1 QR is `unsigned` — nothing to verify, and that is normal", async () => {
      const res = await capture({ source: "qr", qrPayload: phase1Payload });
      expect(res.signatureStatus).toBe("unsigned");
      expect(res.signatureFailed).toBe(false);
    });

    it("🔴 a Phase 2 QR whose signature does NOT verify is reported as FAILED", () => {
      // Signature tags present but the signature is nonsense — a tampered or
      // fabricated document. This is the one case where the system knows
      // something the user cannot see: the invoice looks entirely normal.
      const forged = bytesToBase64(
        concatBytes([
          tlv(QR_TAG.SELLER_NAME, utf8Bytes("مورد")),
          tlv(QR_TAG.VAT_NUMBER, utf8Bytes("399999999999993")),
          tlv(QR_TAG.TIMESTAMP, utf8Bytes("2026-08-12T10:00:00")),
          tlv(QR_TAG.TOTAL_WITH_VAT, utf8Bytes("1150.00")),
          tlv(QR_TAG.VAT_TOTAL, utf8Bytes("150.00")),
          tlv(QR_TAG.INVOICE_HASH, utf8Bytes("aGFzaA==")),
          tlv(QR_TAG.SIGNATURE, utf8Bytes("bm90LWEtc2lnbmF0dXJl")),
          tlv(QR_TAG.PUBLIC_KEY, new Uint8Array([0x30, 0x59, 0x30, 0x13])),
          tlv(QR_TAG.CERTIFICATE_SIGNATURE, new Uint8Array([0x30, 0x44])),
        ]),
      );
      const verdict = verifyQrSignature(forged);
      expect(["failed", "error"]).toContain(verdict.status);
      // The message must be actionable, not an opaque code — this is what the
      // user is being asked to override.
      expect(verdict.detail.length).toBeGreaterThan(20);
    });

    it("never throws on a malformed payload — one odd document must not fail capture", () => {
      for (const junk of ["", "not-base64!!", bytesToBase64(utf8Bytes("nonsense"))]) {
        expect(() => verifyQrSignature(junk)).not.toThrow();
      }
    });
  });

  // ── The two wrong states ─────────────────────────────────────────────────

  describe("🔴 neither wrong state is reachable", () => {
    async function makeBill(): Promise<number> {
      const { rows } = await pool.query(
        `INSERT INTO bills (organization_id, company_id, vendor_id, bill_number, date, subtotal, vat_amount, total, status)
         VALUES ($1,$2,$3,$4,'2026-08-01','1000.00','150.00','1150.00','draft') RETURNING id`,
        [orgId, companyId, vendorId, `CAP-${Date.now()}`],
      );
      return rows[0].id;
    }

    it("evidence for a bill that does NOT exist is impossible — the link rolls back with it", async () => {
      const res = await capture();
      const billId = await makeBill();

      // Attach, then fail the surrounding transaction. The capture must not be
      // left claiming to be evidence for a bill that was never posted.
      const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
      await conn
        .run(() =>
          auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.1" }, async () => {
            await captureService.attachToBill(res.captureId, billId);
            throw new Error("simulated failure after attach");
          }),
        )
        .catch(() => {});
      await conn.rollback();

      const { rows } = await pool.query(
        `SELECT status, bill_id FROM captured_documents WHERE id = $1`,
        [res.captureId],
      );
      expect(rows[0].status).toBe("staged");
      expect(rows[0].bill_id).toBeNull();
    });

    it("a bill whose evidence never promoted is VISIBLE, not silent", async () => {
      const res = await capture();
      const billId = await makeBill();
      await inTenant(() => captureService.attachToBill(res.captureId, billId));

      // Committed as pending: the intent is durable even though the bytes have
      // not moved. That is the outbox pattern, not a lost write.
      const { rows } = await pool.query(
        `SELECT status, bill_id, retain_until FROM captured_documents WHERE id = $1`,
        [res.captureId],
      );
      expect(rows[0].status).toBe("promotion_pending");
      expect(rows[0].bill_id).toBe(billId);
      // 🔴 retain_until is the conservative default (queue C7).
      expect(rows[0].retain_until).toBeTruthy();

      const promoted = await capturePromotionService.runOnce(orgId);
      expect(promoted.promoted).toBeGreaterThanOrEqual(1);

      const after = await pool.query(
        `SELECT status, archive_path, staging_path FROM captured_documents WHERE id = $1`,
        [res.captureId],
      );
      expect(after.rows[0].status).toBe("promoted");
      expect(after.rows[0].archive_path).toBeTruthy();
      expect(after.rows[0].staging_path).toBeNull();
    });

    it("promotion is idempotent — a second pass changes nothing", async () => {
      const again = await capturePromotionService.runOnce(orgId);
      expect(again.pending).toBe(0);
      expect(again.failed).toBe(0);
    });

    it("a capture cannot be attached to two bills", async () => {
      const res = await capture();
      const first = await makeBill();
      const second = await makeBill();
      await inTenant(() => captureService.attachToBill(res.captureId, first));
      await expect(inTenant(() => captureService.attachToBill(res.captureId, second))).rejects.toMatchObject({
        statusCode: 400,
      });
    });
  });

  // ── Purge ────────────────────────────────────────────────────────────────

  describe("🔴 the purge job never touches evidence", () => {
    it("removes abandoned captures but NOT anything posted to a bill", async () => {
      const abandoned = await capture();
      const evidence = await capture();
      const billId = (
        await pool.query(
          `INSERT INTO bills (organization_id, company_id, vendor_id, bill_number, date, subtotal, vat_amount, total, status)
           VALUES ($1,$2,$3,$4,'2026-08-01','10.00','1.50','11.50','draft') RETURNING id`,
          [orgId, companyId, vendorId, `CAP-EV-${Date.now()}`],
        )
      ).rows[0].id;
      await inTenant(() => captureService.attachToBill(evidence.captureId, billId));

      // Age BOTH past the purge window. The evidence one must survive on its
      // STATUS, not on its age — otherwise the guarantee is an accident of
      // timing.
      await pool.query(
        `UPDATE captured_documents SET captured_at = now() - interval '400 days' WHERE id = ANY($1)`,
        [[abandoned.captureId, evidence.captureId]],
      );

      const result = await capturePromotionService.purgeOnce(orgId);
      expect(result.purged).toBeGreaterThanOrEqual(1);

      const rows = await pool.query(`SELECT id, status FROM captured_documents WHERE id = ANY($1)`, [
        [abandoned.captureId, evidence.captureId],
      ]);
      const ids = rows.rows.map((r: { id: string }) => r.id);
      expect(ids).not.toContain(abandoned.captureId);
      expect(ids).toContain(evidence.captureId);
    });
  });
});
