/**
 * B3 — a captured document's ROW must never outlive its BYTES.
 *
 * ── The bug these tests exist for ──────────────────────────────────────────
 * `stagingStore.remove` deleted files on `local-fs` and **returned silently**
 * on every other backend. `purgeOnce` then deleted the metadata row regardless
 * of what had happened to the object. On cloud storage the result was
 * photographs left in a bucket AND the destruction of the only index to them:
 * nothing to enumerate, nothing to retry, no way to state what had been left
 * behind. The same shape ran through promotion, where `markPromoted` nulled
 * `staging_path` in the same statement that recorded the archive copy.
 *
 * 🔴 Every one of those failures was INVISIBLE in a local-fs test run, because
 * local-fs was the one backend that worked. So the important tests here inject
 * a backend that CANNOT delete — the cloud case, reproduced without a cloud —
 * and assert on what survives.
 *
 * The invariant is the one `capture.service.stage` already states for the other
 * direction — *never orphan bytes without metadata*. A purge that drops the
 * metadata first breaks it just as thoroughly, and is harder to notice because
 * it looks like success.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginTenantConnection, pool } from "@workspace/db";
import { resetEnvCache } from "@workspace/config";
import { auditContext } from "../lib/auditContext";
import { captureService } from "../services/capture/capture.service";
import { capturePromotionService } from "../services/capture/promotion.service";
import { capturedDocumentsJobRepository } from "../repositories/capturedDocuments.repository";
import { resetArchiveStoreForTests } from "../services/einvoice/archive/resolveArchiveStore";
import {
  StagingDeleteFailed,
  resetStagingBackendForTests,
  type StagingBackend,
} from "../services/capture/stagingBackend";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[capture-purge-integrity] no real DATABASE_URL — skipping.");

const SLUG = "b3-purge";
const EMAIL = "b3-purge@test.local";

/** A 1x1 PNG — real magic bytes, so the sniffer accepts it. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A backend that cannot delete — i.e. what `supabase-storage` effectively was
 * before this fix, except that it now says so instead of pretending.
 */
const brokenBackend: StagingBackend = {
  provider: "test-cannot-delete",
  async remove(path) {
    throw new StagingDeleteFailed("test-cannot-delete", path, "storage refused");
  },
};

describeMaybe("B3 — the row never outlives the bytes", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let vendorId = 0;
  let archiveDir = "";

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({
      organizationId: orgId,
      companyId,
      role: "authenticated",
    });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn),
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
    await pool.query(
      `DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`,
    );
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    archiveDir = await mkdtemp(join(tmpdir(), "b3-purge-"));
    process.env.ZATCA_ARCHIVE_PROVIDER = "local-fs";
    process.env.ZATCA_ARCHIVE_DIR = archiveDir;
    resetEnvCache();
    resetArchiveStoreForTests();
    resetStagingBackendForTests();

    await cleanup();
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug) VALUES ('B3 Org','${SLUG}') RETURNING id`,
      )
    ).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number)
         VALUES ($1,'B3 Co','1010101011','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active)
         VALUES ('${EMAIL}','B3',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status)
       VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    vendorId = (
      await pool.query(
        `INSERT INTO vendors (organization_id, name, name_ar) VALUES ($1,'Supplier','مورد') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
  });

  afterEach(() => {
    // Back to the real (working) backend unless a test asks otherwise.
    resetStagingBackendForTests();
  });

  afterAll(async () => {
    await cleanup();
    await rm(archiveDir, { recursive: true, force: true });
    delete process.env.ZATCA_ARCHIVE_PROVIDER;
    delete process.env.ZATCA_ARCHIVE_DIR;
    resetEnvCache();
    resetArchiveStoreForTests();
    resetStagingBackendForTests();
    await pool.end();
  });

  const capture = () =>
    inTenant(() =>
      captureService.capture(
        { bytes: PNG, fileName: "receipt.png", source: "ocr" },
        { organizationId: orgId, companyId, userId },
      ),
    );

  /** Every staged object currently on disk, whatever its name. */
  async function stagedFileCount(): Promise<number> {
    const walk = async (dir: string): Promise<number> => {
      let n = 0;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return 0;
      }
      for (const e of entries) {
        n += e.isDirectory() ? await walk(join(dir, e.name)) : 1;
      }
      return n;
    };
    return walk(join(archiveDir, "staging"));
  }

  const age = (id: string) =>
    pool.query(`UPDATE captured_documents SET captured_at = now() - interval '90 days' WHERE id = $1`, [id]);

  const rowOf = async (id: string) => {
    const { rows } = await pool.query(
      `SELECT status, staging_path AS "stagingPath", archive_path AS "archivePath"
         FROM captured_documents WHERE id = $1`,
      [id],
    );
    return rows[0] as { status: string; stagingPath: string | null; archivePath: string | null } | undefined;
  };

  // ── Purge ─────────────────────────────────────────────────────────────────

  describe("purgeOnce", () => {
    it("deletes the bytes AND the row when the backend can delete", async () => {
      const c = await capture();
      await age(c.captureId);
      expect(await stagedFileCount()).toBe(1);

      const res = await capturePromotionService.purgeOnce(orgId);

      expect(res.purged).toBe(1);
      expect(res.retained).toBe(0);
      expect(await stagedFileCount()).toBe(0);
      expect(await rowOf(c.captureId)).toBeUndefined();
    });

    it("🔴 KEEPS the row when the bytes could not be deleted", async () => {
      // The regression test. Before B3 this returned purged=1 with the file
      // still on disk and the row gone — orphaned bytes, no index, no retry.
      const c = await capture();
      await age(c.captureId);
      resetStagingBackendForTests(brokenBackend);

      const res = await capturePromotionService.purgeOnce(orgId);

      expect(res.retained).toBe(1);
      expect(res.purged).toBe(0);

      const row = await rowOf(c.captureId);
      expect(row, "the row is the only index to the orphaned bytes").toBeDefined();
      expect(row!.stagingPath, "and it still points at them").toBeTruthy();
      expect(await stagedFileCount()).toBe(1);
    });

    it("🔴 and the retained row is picked up again once deletion works", async () => {
      // Retention is only useful if something drains it. The row from the
      // previous test is still purgeable, so the next ordinary pass clears it.
      const res = await capturePromotionService.purgeOnce(orgId);
      expect(res.purged).toBe(1);
      expect(res.retained).toBe(0);
      expect(await stagedFileCount()).toBe(0);
    });
  });

  // ── Discard ───────────────────────────────────────────────────────────────

  describe("discard", () => {
    it("🔴 deletes the image IMMEDIATELY, not in thirty days", async () => {
      // "Discard" is an instruction, most often about a photograph that should
      // not have been taken. Waiting for the purge window is not what it means.
      const c = await capture();
      expect(await stagedFileCount()).toBe(1);

      const out = await inTenant(() => captureService.discard(c.captureId));

      expect(out.imageDeleted).toBe(true);
      expect(await stagedFileCount()).toBe(0);
      const row = await rowOf(c.captureId);
      expect(row!.status).toBe("discarded");
      expect(row!.stagingPath, "pointer cleared only because the bytes are gone").toBeNull();
    });

    it("🔴 reports imageDeleted:false rather than claiming a deletion that failed", async () => {
      const c = await capture();
      resetStagingBackendForTests(brokenBackend);

      const out = await inTenant(() => captureService.discard(c.captureId));

      expect(out.imageDeleted).toBe(false);
      // The instruction still stands — losing it would leave a capture the user
      // meant to abandon still attachable to a bill.
      const row = await rowOf(c.captureId);
      expect(row!.status).toBe("discarded");
      expect(row!.stagingPath, "still findable, so the purge job can retry").toBeTruthy();

      resetStagingBackendForTests();
      await age(c.captureId);
      await capturePromotionService.purgeOnce(orgId);
      expect(await stagedFileCount()).toBe(0);
    });
  });

  // ── Promotion ─────────────────────────────────────────────────────────────

  describe("promotion", () => {
    async function billWithCapture(): Promise<{ captureId: string; billId: number }> {
      const c = await capture();
      const { rows } = await pool.query(
        `INSERT INTO bills (organization_id, company_id, bill_number, date, vendor_id, subtotal, vat_amount, total, status)
         VALUES ($1,$2,$3,current_date,$4,'100.00','15.00','115.00','approved') RETURNING id`,
        [orgId, companyId, `B3-${c.captureId.slice(0, 8)}`, vendorId],
      );
      const billId = Number(rows[0].id);
      await inTenant(() => captureService.attachToBill(c.captureId, billId));
      return { captureId: c.captureId, billId };
    }

    it("🔴 keeps the staging pointer when the staged copy could not be removed", async () => {
      // The archive copy is authoritative, so nothing is LOST here — what was
      // lost before was the ability to find the leftover duplicate at all,
      // because markPromoted nulled the pointer in the same statement.
      const { captureId } = await billWithCapture();
      resetStagingBackendForTests(brokenBackend);

      const res = await capturePromotionService.runOnce(orgId);

      expect(res.promoted).toBe(1);
      expect(res.failed, "a leftover duplicate is a backlog, not a promotion failure").toBe(0);
      expect(res.stagedCopyRetained).toBe(1);

      const row = await rowOf(captureId);
      expect(row!.status).toBe("promoted");
      expect(row!.archivePath, "the evidence is safely archived").toBeTruthy();
      expect(row!.stagingPath, "and the leftover copy is still enumerable").toBeTruthy();

      const backlog = await capturedDocumentsJobRepository.listPromotedWithStagedCopy();
      expect(backlog.map((r) => r.id)).toContain(captureId);
    });

    it("🔴 the sweep drains that backlog once deletion works again", async () => {
      resetStagingBackendForTests();
      const swept = await capturePromotionService.sweepStagedLeftovers();

      expect(swept.cleared).toBeGreaterThan(0);
      expect(await capturedDocumentsJobRepository.listPromotedWithStagedCopy()).toEqual([]);
      expect(await stagedFileCount()).toBe(0);
    });

    it("a clean promotion clears the pointer in the same pass", async () => {
      const { captureId } = await billWithCapture();

      const res = await capturePromotionService.runOnce(orgId);

      expect(res.promoted).toBe(1);
      expect(res.stagedCopyRetained).toBe(0);
      const row = await rowOf(captureId);
      expect(row!.stagingPath).toBeNull();
      expect(await stagedFileCount()).toBe(0);
    });

    it("🔴 the image is still readable after promotion — by STATUS, not by column", async () => {
      // `image()` used to pick `stagingPath ?? archivePath`, which only worked
      // because markPromoted nulled the staging path. That implicit coupling is
      // gone; this asserts the replacement actually reads the archive copy.
      const { captureId } = await billWithCapture();
      await capturePromotionService.runOnce(orgId);
      const img = await inTenant(() => captureService.image(captureId));
      expect(img.bytes.equals(PNG)).toBe(true);
    });
  });

  // ── The guarantee this fix must NOT have weakened ─────────────────────────

  it("🔴 ArchiveStore still has no delete — deletion lives on the staging seam only", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      join(__dirname, "..", "services", "einvoice", "archive", "archiveStore.ts"),
      "utf8",
    );
    // ZATCA §5.5 forbids deleting a generated invoice, and M12.8 made that
    // absolute by removing deletion from the INTERFACE. B3 was fixed with a
    // separate deletable contract precisely so this stays true.
    expect(/\bdelete\s*[(:]/.test(src), "ArchiveStore must never gain a delete method").toBe(false);
  });
});
