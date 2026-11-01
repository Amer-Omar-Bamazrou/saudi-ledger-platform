/**
 * 🔴 PHASE 18 H-19 — RETAINED EARNINGS THROUGH A CLASSIFIED CORRECTION, BY
 * CLICKING (DR-33; owner accepted the recommendation; register §11.75). A
 * manual journal to retained earnings saved without a kind is REFUSED, and the
 * refusal explains the next step; with the kind chosen it is saved as a
 * classified correction. The request the SCREEN builds is the one under test.
 */
import { test, expect, request as pwRequest, type APIRequestContext } from "./fixtures";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const STAMP = Date.now();
const DESCRIPTION = `E2E H19 prior-year error ${STAMP}`;

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
});
test.afterAll(async () => { await api.dispose(); });

test("🔴 a journal to retained earnings is refused until its kind is stated; stated, it saves as a classified correction", async ({ page }) => {
  await page.goto("/journal-entries", { waitUntil: "networkidle" });
  await page.getByTestId("je-new").click();
  const dialog = page.getByTestId("je-dialog");
  await dialog.getByTestId("je-description").fill(DESCRIPTION);
  await dialog.getByTestId("je-line-account-0").click();
  await page.getByRole("option", { name: /retained earnings/i }).first().click();
  await dialog.getByTestId("je-line-debit-0").fill("100");
  await dialog.getByTestId("je-line-account-1").click();
  await page.getByRole("option", { name: /rent|utilit|office|supplies/i }).first().click();
  await dialog.getByTestId("je-line-credit-1").fill("100");

  // without a kind: refused, and the refusal names the next step
  await dialog.getByTestId("je-save").click();
  await expect(page.getByText(/classified correction/i).first(), "the refusal explains the kind is needed").toBeVisible();

  // with the kind: saved as a classified correction
  await dialog.getByTestId("je-kind").click();
  await page.getByTestId("je-kind-error").click();
  await dialog.getByTestId("je-save").click();
  await expect.poll(async () => {
    const r = await api.get("/api/journal-entries?limit=50");
    const body = await r.json();
    const rows: Array<{ description: string; correctionKind?: string | null }> = Array.isArray(body) ? body : (body.items ?? []);
    return rows.find((x) => x.description === DESCRIPTION)?.correctionKind ?? null;
  }, { message: "the entry saved from the form is a classified correction" }).toBe("error");
});
