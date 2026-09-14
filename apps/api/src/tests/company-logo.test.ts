/**
 * L1 level-1 branding — the company logo (design-invoice-document.md §2).
 *
 * What matters here:
 *   1. The bytes are TRUSTED ONLY AFTER SNIFFING (M-5's rule): a PNG uploads,
 *      garbage is refused whatever its name, an SVG with active content is
 *      refused — the validator is proven to FAIL, not only to pass.
 *   2. Absence is a first-class state: no logo → 404 on the read, and
 *      `hasLogo: false` — the invoice header then carries the registered name
 *      alone (asserted at the template layer in invoice-document-render).
 *   3. Replace and remove leave no dangling reference: the row points at the
 *      new object (or null) and the read agrees.
 *
 * DB + Storage backed (the documents.test.ts pattern); skips without both.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { companiesService } from "../services/companies.service";
import { validateLogoBytes, MAX_LOGO_BYTES } from "../lib/fileValidation";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const STORAGE = REAL_DB && !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
const describeDb = STORAGE ? describe : describe.skip;
if (!STORAGE) console.warn("[company-logo] DATABASE_URL + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required — skipping DB half.");

/** A 1x1 PNG — real magic bytes. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
const SVG_SCRIPTED = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const SVG_HANDLER = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>');

// ── The validator, pure — proven to fail ────────────────────────────────────

describe("validateLogoBytes — the sniff, both directions", () => {
  it("accepts PNG by magic bytes and clean SVG structurally", () => {
    expect(validateLogoBytes(PNG)).toBe("image/png");
    expect(validateLogoBytes(SVG)).toBe("image/svg+xml");
  });

  it("🔴 refuses garbage whatever the name claims, and refuses PDF (a document, not a logo)", () => {
    expect(() => validateLogoBytes(Buffer.from("#!/bin/sh\nrm -rf /"))).toThrow(/Unsupported logo type/);
    expect(() => validateLogoBytes(Buffer.from("%PDF-1.7 fake"))).toThrow(/Unsupported logo type/);
  });

  it("🔴 refuses SVG active content — script and event handler alike", () => {
    expect(() => validateLogoBytes(SVG_SCRIPTED)).toThrow(/scripts or event handlers/);
    expect(() => validateLogoBytes(SVG_HANDLER)).toThrow(/scripts or event handlers/);
  });

  it("caps the size, naming the limit", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES)]);
    expect(() => validateLogoBytes(big)).toThrow(/2 MB/);
  });
});

// ── The service, against real storage ───────────────────────────────────────

const SLUG = "l1-logo";

describeDb("companiesService logo — upload, read, replace, remove", () => {
  let orgId = "";
  let companyId = "";

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId: null, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Logo Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'Logo Co','1010101031','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    // Remove the stored object too, not only the rows.
    await inTenant(() => companiesService.removeLogo()).catch(() => {});
    await cleanup();
  });

  it("no logo: getLogo is a 404 and the profile says hasLogo=false — absence is a state, not an error swallowed", async () => {
    await expect(inTenant(() => companiesService.getLogo())).rejects.toMatchObject({ statusCode: 404 });
    const profile = await inTenant(() => companiesService.getCurrent());
    expect(profile.hasLogo).toBe(false);
  });

  it("🔴 upload stores the real bytes and the profile flips; the read returns them byte-for-byte", async () => {
    const r = await inTenant(() => companiesService.uploadLogo(orgId, { buffer: PNG }));
    expect(r.hasLogo).toBe(true);
    const profile = await inTenant(() => companiesService.getCurrent());
    expect(profile.hasLogo).toBe(true);
    const { bytes, contentType } = await inTenant(() => companiesService.getLogo());
    expect(contentType).toBe("image/png");
    expect(bytes.equals(PNG)).toBe(true);
  });

  it("replace: the row points at the NEW object and the read agrees (SVG this time)", async () => {
    await inTenant(() => companiesService.uploadLogo(orgId, { buffer: SVG }));
    const { bytes, contentType } = await inTenant(() => companiesService.getLogo());
    expect(contentType).toBe("image/svg+xml");
    expect(bytes.equals(SVG)).toBe(true);
  });

  it("🔴 a rejected upload changes NOTHING — the previous logo survives a garbage attempt", async () => {
    await expect(
      inTenant(() => companiesService.uploadLogo(orgId, { buffer: Buffer.from("not an image") })),
    ).rejects.toMatchObject({ statusCode: 400 });
    const { contentType } = await inTenant(() => companiesService.getLogo());
    expect(contentType).toBe("image/svg+xml"); // still the SVG from the test above
  });

  it("remove: back to the first-class absence — 404 on read, hasLogo=false, idempotent", async () => {
    expect((await inTenant(() => companiesService.removeLogo())).hasLogo).toBe(false);
    await expect(inTenant(() => companiesService.getLogo())).rejects.toMatchObject({ statusCode: 404 });
    // Removing again is a no-op, not an error.
    expect((await inTenant(() => companiesService.removeLogo())).hasLogo).toBe(false);
  });
});
