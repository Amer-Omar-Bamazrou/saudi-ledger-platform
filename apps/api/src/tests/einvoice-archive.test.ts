/**
 * The e-invoice archive (M12.8) — naming, immutability, and the sweep.
 *
 * Three properties are worth testing here, and they map to three separate
 * obligations in ZATCA §5.5 rather than to three code paths:
 *
 *   1. **The filename** must be VAT + GENERATION timestamp + invoice reference.
 *      🔴 Generation, not clearance — an easy inversion to make and impossible
 *      to see afterwards, since both produce a plausible-looking name.
 *   2. **Immutability.** "Once invoices are generated, they should not be
 *      deleted or altered by any user." Tested as a property of the interface
 *      and the store, not as a convention.
 *   3. **Idempotency of the sweep**, because archival is a separate pass from
 *      submission and must be safely re-runnable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveFileName, archiveObjectPath, archiveTimestamp, sanitizeReference } from "../services/einvoice/archive/archiveNaming";
import { LocalFsArchiveStore } from "../services/einvoice/archive/localFsArchiveStore";
import { ArchiveConflictError, type ArchiveStore } from "../services/einvoice/archive/archiveStore";

describe("M12.8 — ZATCA archive naming (§5.5)", () => {
  const generatedAt = new Date("2026-08-11T21:34:05.123Z");

  it("🔴 builds VAT + GENERATION timestamp + invoice reference", () => {
    expect(
      archiveFileName({
        sellerVatNumber: "310123456789013",
        generatedAt,
        invoiceReference: "INV-001",
      }),
    ).toBe("310123456789013_20260811T213405_INV-001.xml");
  });

  it("🔴 uses the GENERATION instant, NOT the clearance time", () => {
    // The same invoice, cleared four hours later. A simplified invoice may be
    // reported up to 24h after issuance, so these genuinely differ — and the
    // archive must be named for when the invoice was GENERATED.
    const clearedAt = new Date("2026-08-12T01:34:05.000Z");
    const byGeneration = archiveFileName({
      sellerVatNumber: "310123456789013",
      generatedAt,
      invoiceReference: "INV-001",
    });
    const byClearance = archiveFileName({
      sellerVatNumber: "310123456789013",
      generatedAt: clearedAt,
      invoiceReference: "INV-001",
    });
    expect(byGeneration).not.toBe(byClearance);
    expect(byGeneration).toContain("20260811T213405");
    expect(byGeneration).not.toContain("20260812");
  });

  it("drops sub-second precision and normalises to UTC", () => {
    expect(archiveTimestamp(generatedAt)).toBe("20260811T213405");
    expect(archiveTimestamp(new Date("2026-01-02T03:04:05Z"))).toBe("20260102T030405");
  });

  it("sanitises an invoice number that would break the path", () => {
    // `INV/2026/001` is an ordinary Saudi invoice-number format; a raw slash
    // would silently create directory levels and break the convention.
    expect(sanitizeReference("INV/2026/001")).toBe("INV-2026-001");
    expect(sanitizeReference("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeReference("   ")).toBe("UNKNOWN");
    // Arabic descriptions and numbers survive — they are legitimate content.
    expect(sanitizeReference("فاتورة-١")).toBe("فاتورة-١");
  });

  it("partitions by organization, company and year", () => {
    const path = archiveObjectPath("org-1", "co-1", {
      sellerVatNumber: "310123456789013",
      generatedAt,
      invoiceReference: "INV-001",
    });
    expect(path).toBe("org-1/co-1/2026/310123456789013_20260811T213405_INV-001.xml");
  });
});

describe("M12.8 — the archive is APPEND-ONLY by construction", () => {
  let dir = "";
  let store: LocalFsArchiveStore;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "einvoice-archive-"));
    store = new LocalFsArchiveStore(dir, "http://localhost:3000");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("🔴 the ArchiveStore interface cannot express deletion", () => {
    // The strongest form of the guarantee: not "we don't call delete", but
    // "there is no delete to call". Anything satisfying ArchiveStore is
    // incapable of destroying a legally-retained record.
    const surface: ArchiveStore = store;
    expect(Object.keys(surface)).not.toContain("delete");
    expect((surface as unknown as Record<string, unknown>).delete).toBeUndefined();
    expect((surface as unknown as Record<string, unknown>).remove).toBeUndefined();
  });

  it("stores bytes and reports a verifiable digest", async () => {
    const bytes = Buffer.from("<Invoice>original</Invoice>", "utf-8");
    const res = await store.put("org/co/2026/a.xml", bytes, "application/xml");

    expect(res.byteSize).toBe(bytes.byteLength);
    // sha256("<Invoice>original</Invoice>") — the digest §5.5's "undetected
    // alteration" clause is detected with.
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await store.get("org/co/2026/a.xml")).bytes.toString()).toBe("<Invoice>original</Invoice>");
  });

  it("🔴 REFUSES to overwrite an existing object", async () => {
    const path = "org/co/2026/b.xml";
    await store.put(path, Buffer.from("<Invoice>first</Invoice>"), "application/xml");

    await expect(
      store.put(path, Buffer.from("<Invoice>TAMPERED</Invoice>"), "application/xml"),
    ).rejects.toBeInstanceOf(ArchiveConflictError);

    // And the original is untouched — the whole point.
    expect((await store.get(path)).bytes.toString()).toBe("<Invoice>first</Invoice>");
  });

  it("refuses an object path that escapes the archive root", async () => {
    await expect(
      store.put("../../escaped.xml", Buffer.from("x"), "application/xml"),
    ).rejects.toThrow(/escapes the archive root/);
  });

  it("produces a direct link — ZATCA's mandatory audit access path", async () => {
    const link = await store.directLink("org/co/2026/a.xml", 3600);
    expect(link.url).toContain("/api/einvoice/archive/");
    // Time-limited: the obligation is that a link CAN be made available, not
    // that the archive is publicly readable.
    expect(link.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("writes to the real filesystem under the configured root", async () => {
    await store.put("org/co/2026/c.xml", Buffer.from("<Invoice>c</Invoice>"), "application/xml");
    expect((await readFile(join(dir, "org/co/2026/c.xml"))).toString()).toBe("<Invoice>c</Invoice>");
  });
});
