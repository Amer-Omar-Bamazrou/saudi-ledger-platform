import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * L1 — THE SHIPPED ICC PROFILE IS PINNED, LIKE THE ZATCA MANIFEST.
 *
 * The PDF/A-3 spike's veraPDF PASS was obtained with the Windows sRGB profile
 * — © 1998 Hewlett-Packard, licensed to Windows users, NOT redistributable by
 * us. "A correct result resting on an input that must be replaced, whose
 * failure mode is that the result looks finished" (findings, 2026-09-03).
 *
 * The shipped file is Debian's `icc-profiles-free` sRGB.icc — chosen (owner)
 * over a browser-driven registry fetch precisely because a packaged artefact
 * can carry a PINNED CHECKSUM. This test is the pin: replacing the file is a
 * deliberate act that edits this hash, never a silent swap. Its licence text
 * ships beside it (redistribution of the unmodified file with the ICC
 * copyright tag intact is permitted; see sRGB.icc.LICENSE.txt).
 *
 * The header assertions are the probe rule: they prove the bytes ARE an RGB
 * ICC profile, so the sha256 cannot vacuously pin an HTML error page — which
 * is exactly what three registry URLs returned to curl during the spike.
 */
const ICC = join(import.meta.dirname, "..", "services", "invoiceDocument", "assets", "sRGB.icc");
const PINNED_SHA256 = "2a92d4bae450b76d8b0aa42193df974d75f62738ecebf74f01c5e75b12a95796";

describe("L1 — the shipped sRGB ICC profile", () => {
  it("is byte-identical to the pinned Debian icc-profiles-free sRGB.icc", () => {
    const bytes = readFileSync(ICC);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(PINNED_SHA256);
  });

  it("is structurally an RGB ICC profile — the pin cannot hold an error page", () => {
    const bytes = readFileSync(ICC);
    expect(bytes.subarray(36, 40).toString("latin1"), "ICC signature").toBe("acsp");
    expect(bytes.subarray(16, 20).toString("latin1"), "colour space").toBe("RGB ");
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("ships with its licence text beside it", () => {
    const licence = readFileSync(join(ICC + ".LICENSE.txt"), "utf8");
    expect(licence.toLowerCase()).toContain("copyright");
  });
});
