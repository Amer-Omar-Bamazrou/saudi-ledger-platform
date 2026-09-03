import { test, expect } from "@playwright/test";
import { E2E } from "./global-setup";

/**
 * L1 — THE INVOICE LEAVES THE PRODUCT, PROVEN BY LEAVING IT.
 *
 * §3: assume any completed backend is unreachable until someone has CLICKED
 * it. This spec clicks: the PDF anchor on an issued invoice row must produce
 * an actual browser DOWNLOAD whose bytes start with %PDF — the whole pipeline
 * (session cookie on a same-origin GET → controller → Chromium render →
 * PDF/A-3 post-processing → Content-Disposition) exercised the way a tenant
 * exercises it.
 *
 * Both renderings are downloaded: `ar` (THE tax invoice) and `en` (the
 * labelled translation). Draft rows must OFFER no link at all — the control
 * is absent, not broken, because a draft has no QR and no legal existence
 * (and the server would refuse with a 409 that says so).
 */

test.use({ storageState: E2E.storageState });

test("🔴 an issued invoice's PDF downloads — both renderings — and a draft offers no link", async ({ page }) => {
  await page.goto("/invoices", { waitUntil: "networkidle" });

  // E2E-INV-002 is seeded 'sent' — an issued document.
  const issuedRow = page.locator("tr", { hasText: "E2E-INV-002" });
  await expect(issuedRow).toBeVisible();

  for (const lang of ["ar", "en"] as const) {
    const link = issuedRow.locator(`a[href$="lang=${lang}"]`);
    await expect(link, `the ${lang} download control on an issued row`).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toBe(`E2E-INV-002-${lang}.pdf`);
    const stream = await download.createReadStream();
    const first = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => {
        chunks.push(c);
        if (Buffer.concat(chunks).length >= 5) {
          stream.destroy();
          resolve(Buffer.concat(chunks));
        }
      });
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
    expect(first.subarray(0, 5).toString(), `${lang} download is a real PDF`).toBe("%PDF-");
  }

  // The draft row (E2E-INV-004): the control is ABSENT — offering a download
  // that the server refuses would be a dead button, the omit-rather-than-
  // promise rule.
  const draftRow = page.locator("tr", { hasText: "E2E-INV-004" });
  await expect(draftRow).toBeVisible();
  await expect(draftRow.locator('a[href*="/document"]')).toHaveCount(0);
});
