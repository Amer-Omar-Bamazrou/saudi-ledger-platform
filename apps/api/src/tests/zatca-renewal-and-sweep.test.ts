/**
 * PCSID renewal reminders and the archive sweep, end-to-end (M12.8).
 *
 * Both are driven from REAL rows rather than fixtures — the acceptance
 * criterion M12.1b established and M12.8 is applying to itself. The sweep in
 * particular is only meaningful if it archives a document that issuance
 * actually produced, so this test issues one through `invoicesService`, marks
 * it accepted the way the worker would, and then sweeps.
 *
 * ── Why the reminder thresholds are tested as buckets ───────────────────────
 * ZATCA certificates last exactly 5 years with NO grace period, and renewal
 * needs an OTP only the TENANT can obtain from their own Fatoora portal. A late
 * reminder therefore cannot be fixed by us at all — which is why there are three
 * windows rather than one, and why an ALREADY-EXPIRED certificate must still
 * report rather than fall out of the query.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { signingService } from "../services/einvoice/signing/signing.service";
import type { ZatcaCsrInput } from "../services/einvoice/crypto/csr";
import { selfSignedCertificate } from "./helpers/selfSignedCert";
import { renewalService, REMINDER_THRESHOLDS_DAYS } from "../services/einvoice/renewal/renewal.service";
import { archiveService } from "../services/einvoice/archive/archive.service";
import { LocalFsArchiveStore } from "../services/einvoice/archive/localFsArchiveStore";
import { einvoiceOutboxRepository } from "../repositories/einvoiceOutbox.repository";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[renewal-sweep] no real DATABASE_URL — skipping.");

const SLUG = "rn-m128";
const EMAIL = "rn-m128@test.local";
const SELLER_VAT = "399999999999983";
const DAY_MS = 86_400_000;

const csr = (): ZatcaCsrInput => ({
  commonName: "SLP-EGS-RN",
  organizationName: "Renewal Test Co",
  organizationalUnitName: "HQ",
  countryName: "SA",
  invoiceType: "1100",
  locationAddress: "Riyadh",
  industryBusinessCategory: "Software",
  organizationIdentifier: SELLER_VAT,
  egsSerialNumber: "1-SLP|2-RN|3-EGS001",
  production: false,
});

describeMaybe("M12.8 — renewal reminders and the archive sweep", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let archiveDir = "";
  let store: LocalFsArchiveStore;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.77" }, fn),
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
    const comps = `(SELECT id FROM companies WHERE organization_id IN ${org})`;
    await pool.query(`DELETE FROM einvoice_archive WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM zatca_credential_reminders WHERE company_id IN ${comps}`);
    await pool.query(`DELETE FROM zatca_credentials WHERE company_id IN ${comps}`);
    await pool.query(`DELETE FROM einvoice_documents WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  /** Onboard with a certificate expiring `days` from now. */
  async function onboard(notAfterDays: number): Promise<string> {
    const { credentialId } = await signingService.createCredential({
      companyId,
      environment: "sandbox",
      csr: csr(),
    });
    const certificatePem = await signingService.withCredentialKey(credentialId, ({ privateKey, publicKey }) =>
      selfSignedCertificate(privateKey, publicKey),
    );
    await signingService.activateCredential({
      credentialId,
      certificatePem,
      csidSecret: "csid-secret",
      notBefore: new Date(Date.now() - 365 * DAY_MS),
      notAfter: new Date(Date.now() + notAfterDays * DAY_MS),
    });
    return credentialId;
  }

  beforeAll(async () => {
    await cleanup();
    archiveDir = await mkdtemp(join(tmpdir(), "sweep-archive-"));
    store = new LocalFsArchiveStore(archiveDir, "http://localhost:3000");

    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Renewal Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies
           (organization_id, name, name_ar, cr_number, vat_number,
            building_number, street, district, city, postal_code, additional_number)
         VALUES ($1,'Renewal Test Co','شركة','1010101010',$2,'1234','King Fahd Rd','Olaya','Riyadh','12345','1234')
         RETURNING id`,
        [orgId, SELLER_VAT],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','RN',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'Client','عميل') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await rm(archiveDir, { recursive: true, force: true });
  });

  // ── Renewal reminders ────────────────────────────────────────────────────

  describe("renewal reminders", () => {
    it("raises nothing for a certificate outside every window", async () => {
      await onboard(200); // ~6.5 months out — beyond T-90
      const result = await renewalService.runOnce(new Date(), orgId);
      const raised = await remindersFor();
      expect(raised).toHaveLength(0);
      expect(result.remindersRaised).toBe(0);
    });

    it("raises the T-90 reminder once, and is idempotent on the next pass", async () => {
      await revokeAll();
      await onboard(60); // inside 90, outside 30

      const first = await renewalService.runOnce(new Date(), orgId);
      expect(first.remindersRaised).toBe(1);
      expect((await remindersFor()).map((r) => r.threshold_days)).toEqual([90]);

      // 🔴 The second pass must add nothing. Duplicate warnings about a
      // certificate that stops signing train the tenant to ignore them, and the
      // guarantee is a UNIQUE INDEX rather than a scheduling assumption.
      const second = await renewalService.runOnce(new Date(), orgId);
      expect(second.remindersRaised).toBe(0);
      expect(second.alreadyRaised).toBe(1);
      expect(await remindersFor()).toHaveLength(1);
    });

    it("escalates to the tighter window as the expiry approaches", async () => {
      await revokeAll();
      const credentialId = await onboard(5); // inside all three

      await renewalService.runOnce(new Date(), orgId);
      // The TIGHTEST crossed window is announced — 7, not 90.
      expect((await remindersFor()).map((r) => r.threshold_days)).toEqual([7]);

      // And a second credential state cannot silently reuse the row.
      expect((await remindersFor())[0].credential_id).toBe(credentialId);
    });

    it("🔴 still reports an ALREADY-EXPIRED certificate — silence after expiry is the worst case", async () => {
      await revokeAll();
      await onboard(-3); // expired three days ago

      const result = await renewalService.runOnce(new Date(), orgId);
      expect(result.remindersRaised).toBe(1);
      expect((await remindersFor()).map((r) => r.threshold_days)).toEqual([7]);

      const expiring = await renewalService.listExpiring(90, orgId);
      expect(expiring.length).toBeGreaterThan(0);
    });

    it("records that email was NOT delivered (the mailer is still a no-op)", async () => {
      // Recorded rather than assumed: an absent reminder is worse than a late
      // one, so the platform must not report a delivery it did not make.
      const rows = await remindersFor();
      expect(rows[0].email_delivered).toBe("false");
    });

    it("exposes the thresholds in descending order", () => {
      expect([...REMINDER_THRESHOLDS_DAYS]).toEqual([90, 30, 7]);
    });
  });

  // ── Archive sweep ────────────────────────────────────────────────────────

  describe("the archive sweep, from a real issued invoice", () => {
    let invoiceId = 0;
    let documentId = "";

    beforeAll(async () => {
      await revokeAll();
      await onboard(3650);

      const inv = await inTenant(() =>
        invoicesService.create(
          {
            invoiceNumber: "ARCH/2026/001",
            date: "2026-09-10",
            customerId,
            items: [{ description: "Item", quantity: 1, unitPrice: 100, vatRate: 15 }],
          },
          userId),
      );
      invoiceId = inv.id;
      await inTenant(() => invoicesService.approve(invoiceId, userId));

      const doc = (
        await pool.query(`SELECT id FROM einvoice_documents WHERE invoice_id = $1`, [invoiceId])
      ).rows[0];
      documentId = doc.id;
    });

    it("archives nothing while the document is still pending", async () => {
      const result = await archiveService.runOnce(store, orgId);
      const rows = await archiveRows();
      expect(rows).toHaveLength(0);
      expect(result.archived).toBe(0);
    });

    it("archives once ZATCA has accepted it, under the §5.5 filename", async () => {
      // Exactly what the worker does on a successful reporting response.
      // REPORTING returns no stamped XML, so `cleared_xml` is null and the
      // artifact to retain is our signed XML — not a fallback, the real answer.
      await einvoiceOutboxRepository.markAccepted(documentId, {
        status: "reported",
        zatcaStatus: "REPORTED",
        warnings: null,
        clearedXml: null,
      });

      const result = await archiveService.runOnce(store, orgId);
      expect(result.archived).toBe(1);

      const [row] = await archiveRows();
      expect(row.artifact).toBe("signed");
      expect(row.storage_provider).toBe("local-fs");

      // VAT + GENERATION timestamp + invoice reference, with the slashes in
      // `ARCH/2026/001` sanitised so they cannot create directory levels.
      expect(row.file_name).toMatch(new RegExp(`^${SELLER_VAT}_\\d{8}T\\d{6}_ARCH-2026-001\\.xml$`));

      // The timestamp is the invoice's issued_at, not the archival time.
      const issuedAt: Date = (
        await pool.query(`SELECT issued_at FROM invoices WHERE id = $1`, [invoiceId])
      ).rows[0].issued_at;
      expect(row.generated_at.toISOString()).toBe(issuedAt.toISOString());

      // Retention is stored per row so a later config change cannot retroactively
      // shorten it. 6 years by VAT regulation.
      expect(row.retain_until.getUTCFullYear()).toBe(issuedAt.getUTCFullYear() + 6);

      // And the bytes really are in the store, byte-identical to the signed XML.
      const stored = await store.get(row.object_path);
      const signedXml = (
        await pool.query(`SELECT signed_xml FROM einvoice_documents WHERE id = $1`, [documentId])
      ).rows[0].signed_xml;
      expect(stored.bytes.toString("utf-8")).toBe(signedXml);
    });

    it("🔴 is idempotent — a second sweep adds nothing and does not overwrite", async () => {
      const result = await archiveService.runOnce(store, orgId);
      expect(result.archived).toBe(0);
      expect(result.scanned).toBe(0); // already indexed, so not even picked up
      expect(await archiveRows()).toHaveLength(1);
    });

    it("reports archive coverage for the operator dashboard", async () => {
      const stats = await archiveService.stats();
      expect(stats.archived).toBeGreaterThanOrEqual(1);
      expect(stats.pendingArchive).toBe(0);
    });
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function remindersFor() {
    const { rows } = await pool.query(
      `SELECT * FROM zatca_credential_reminders WHERE company_id = $1 ORDER BY threshold_days DESC`,
      [companyId],
    );
    return rows;
  }

  async function archiveRows() {
    const { rows } = await pool.query(
      `SELECT * FROM einvoice_archive WHERE company_id = $1 ORDER BY archived_at`,
      [companyId],
    );
    return rows;
  }

  /** Clear credentials + reminders so each renewal case starts clean. */
  async function revokeAll() {
    await pool.query(`DELETE FROM zatca_credential_reminders WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM zatca_credentials WHERE company_id = $1`, [companyId]);
  }
});
