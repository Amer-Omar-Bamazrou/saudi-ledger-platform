/**
 * 🔴 PROOF ONLY — NOT FOR MERGE. It lives on a draft PR that is closed without merging.
 *
 * `phase13-evidence-expenses.spec.ts:113` checks that a posted bill's evidence document is
 * `promotion_pending` straight after the post. The capture-promotion job (every 60 s, in the
 * server this suite starts) moves it to `promoted`, so a tick that lands between the post and the
 * check fails that test (CI run 39123868700, attempt 1).
 *
 * Each test below posts a scanned bill by clicking, as that test does, then FORCES the
 * interleaving: it waits until the job has ticked (the status reads `promoted`) and only then runs
 * the check.
 *   - "OLD check" runs the check as it is on `main`. Expected to FAIL, receiving "promoted".
 *   - "NEW check" runs the check as the fix PR writes it. Expected to PASS.
 * The file name sorts last, so its bills are created after every other spec has run.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const STAMP = Date.now();
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");

let api: APIRequestContext;

const bills = async (q: string) =>
  ((await (await api.get(`/api/bills?limit=200`)).json()).items as Array<{ id: number; billNumber: string; vendorReference: string | null; status: string }>)
    .filter((b) => b.vendorReference === q);
const bill = async (id: number) => (await api.get(`/api/bills/${id}`)).json();
const evidenceStatusOf = async (id: number): Promise<string> => (await bill(id)).evidenceDocument.status;

async function pick(page: Page, testId: string, option: RegExp) {
  await page.getByTestId(testId).click();
  await page.getByRole("option", { name: option }).first().click();
}

/** Upload a PDF through the scan dialog and land on the review page (as in phase13-evidence-expenses.spec.ts). */
async function scanPdf(page: Page, name: string) {
  await page.goto("/bills");
  await page.getByRole("button", { name: /Scan Receipt/i }).click();
  await page.getByTestId("scan-file-input").setInputFiles({ name, mimeType: "application/pdf", buffer: Buffer.concat([PDF, Buffer.from(name)]) });
  await expect(page.getByTestId("scan-manual-ready")).toBeVisible();
  await page.getByTestId("scan-use-fields").click();
  await expect(page).toHaveURL(/\/scan-review\?capture=/);
}

async function typeReceipt(page: Page, ref: string, subtotal: string, vat: string, total: string, date = "2026-09-10") {
  await pick(page, "scan-vendor-select", /E2E Vendor/);
  await page.getByTestId("scan-invoice-number").fill(ref);
  await page.getByTestId("scan-date").fill(date);
  await page.getByTestId("scan-subtotal").fill(subtotal);
  await page.getByTestId("scan-vat").fill(vat);
  await page.getByTestId("scan-total").fill(total);
}

/** Scan, save and post one bill by clicking, as phase13-evidence-expenses.spec.ts:90 does. Returns its id. */
async function postScannedBill(page: Page, ref: string, subtotal: string, vat: string, total: string): Promise<number> {
  await scanPdf(page, `${ref}.pdf`);
  await typeReceipt(page, ref, subtotal, vat, total);
  await page.getByTestId("doc-kind-tax_invoice").check();
  await expect(page.getByTestId("vat-evidence-panel")).toHaveAttribute("data-status", "evidenced");
  await page.getByTestId("scan-save-draft").click();
  await expect(page).toHaveURL(/\/bills/);
  const [b] = await bills(ref);
  expect(b, "PREMISE: the draft exists").toBeTruthy();
  await page.goto("/bills?status=draft");
  await page.getByRole("row", { name: new RegExp(b!.billNumber) }).getByRole("button", { name: /^Post$/ }).click();
  await page.getByRole("button", { name: /Confirm & Post/ }).click();
  await expect.poll(async () => (await bill(b!.id)).status).toBe("received");
  return b!.id;
}

/** Force the interleaving: wait until a capture-promotion tick has landed after the post. */
async function forcePromotionTick(id: number) {
  console.log(`[proof] bill ${id}: evidence status straight after the post = ${await evidenceStatusOf(id)}`);
  await expect
    .poll(() => evidenceStatusOf(id), { timeout: 90_000, message: "PREMISE: a capture-promotion tick landed between the post and the check" })
    .toBe("promoted");
  console.log(`[proof] bill ${id}: evidence status after the forced tick = ${await evidenceStatusOf(id)}`);
}

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
});
test.afterAll(async () => { await api.dispose(); });

test.describe("PROOF — a capture-promotion tick between the post and the check", () => {
  test("OLD check (as on main) under a forced tick — expected to FAIL", async ({ page }) => {
    test.setTimeout(150_000);
    const id = await postScannedBill(page, `PROOF-OLD-${STAMP}`, "410.00", "61.50", "471.50");
    await forcePromotionTick(id);
    // phase13-evidence-expenses.spec.ts:113 on main, verbatim:
    expect((await bill(id)).evidenceDocument.status, "the document became the posted bill's evidence").toBe("promotion_pending");
  });

  test("NEW check (as in the fix PR) under a forced tick — expected to PASS", async ({ page }) => {
    test.setTimeout(150_000);
    const id = await postScannedBill(page, `PROOF-NEW-${STAMP}`, "420.00", "63.00", "483.00");
    await forcePromotionTick(id);
    // The check as the fix PR writes it:
    const evidenceStatus = async () => (await bill(id)).evidenceDocument.status;
    expect(["promotion_pending", "promoted"], "the document became the posted bill's evidence").toContain(await evidenceStatus());
    await expect.poll(evidenceStatus, { timeout: 90_000, message: "the capture-promotion job archived the posted bill's evidence" }).toBe("promoted");
  });
});
