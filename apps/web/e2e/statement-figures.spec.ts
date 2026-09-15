import { test, expect } from "@playwright/test";
import { E2E } from "./global-setup";

/**
 * 🔴 THE STATEMENTS SHOW A NUMBER, AND THE NUMBER IS THE LEDGER'S (2026-09-15).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * For as long as the browser suite has existed, the seeded org's balance sheet
 * read ALL ZERO against 4,635.00 of open invoices, and nothing noticed: the
 * seed wrote journal lines with no account (the statements silently excluded
 * them) and "issued" invoices with no GL entry, and the crawl's only assertion
 * on a statement page was that a row rendered. "A row renders" is not an
 * assertion — an empty state renders a row too.
 *
 * ── What this asserts ───────────────────────────────────────────────────────
 * Two figures the product computes by DIFFERENT paths must agree, and be
 * non-zero, and be what the page shows:
 *   1. balance-sheet AR (the GL: every posted line on the AR account) equals
 *      the AR-aging total (the documents: issued invoices minus payments and
 *      credit notes). On the old seed: 0 vs 4,635 — this test would have
 *      failed, which is the point.
 *   2. The trial balance is balanced AND non-trivial (debits = credits > 0):
 *      a balanced empty ledger is the CORRECT answer equalling the BROKEN one.
 *   3. The balance-sheet PAGE renders the AR figure (not only the API): a
 *      page that renders zero over a correct API is the class the walks found.
 *
 * Frame: the suite's own org, seeded through the product's own write path
 * (`global-setup.ts`), so every figure here was produced by a real posting.
 */

test.use({ storageState: E2E.storageState });

const AS_OF = "2026-09-30";
const sar = (n: number) => new Intl.NumberFormat("en-SA", { style: "currency", currency: "SAR", minimumFractionDigits: 2 }).format(n);

test("🔴 balance-sheet AR (GL) equals AR-aging total (documents), and neither is zero", async ({ page }) => {
  const bs = await (await page.request.get(`/api/reports/balance-sheet?asOf=${AS_OF}`)).json();
  const aging = await (await page.request.get(`/api/reports/ar-aging`)).json();

  expect(aging.total, "the aging total must be non-zero — an empty AR proves nothing").toBeGreaterThan(0);
  expect(bs.assets.accountsReceivable, "GL receivables must equal the documents' outstanding total").toBe(aging.total);
  expect(bs.balanced, "assets = liabilities + equity").toBe(true);
  expect(bs.assets.total, "a balanced EMPTY sheet is the broken answer, not the correct one").toBeGreaterThan(0);
});

test("the trial balance is balanced AND non-trivial", async ({ page }) => {
  const tb = await (await page.request.get(`/api/reports/trial-balance?from=2026-01-01&to=${AS_OF}`)).json();
  expect(tb.balanced).toBe(true);
  expect(tb.totalDebit).toBe(tb.totalCredit);
  expect(tb.totalDebit, "debits = credits = 0 satisfies 'balanced' and proves nothing").toBeGreaterThan(0);
  // every line carries a real account — the seed can no longer write one that does not
  expect(tb.accounts.every((a: { accountId: number | null }) => a.accountId != null), "a trial-balance line with no account id").toBe(true);
});

test("the balance-sheet PAGE shows the ledger's AR figure", async ({ page }) => {
  const bs = await (await page.request.get(`/api/reports/balance-sheet?asOf=${AS_OF}`)).json();
  const ar = bs.assets.accountsReceivable as number;
  expect(ar).toBeGreaterThan(0);

  await page.goto("/balance-sheet", { waitUntil: "networkidle" });
  await page.locator('input[type="date"]').first().fill(AS_OF);
  await page.getByRole("button", { name: /generate|إنشاء/i }).click();
  await page.waitForLoadState("networkidle");

  // The AR row, by its label, must carry the API's figure — not a zero, not a
  // different number, not a placeholder.
  const arRow = page.locator("div", { hasText: /Accounts Receivable \(AR\)|ذمم مدينة \(AR\)/ }).filter({ hasText: sar(ar) }).first();
  await expect(arRow, `the page must show ${sar(ar)} on the AR line`).toBeVisible();
  await expect(page.getByText(sar(bs.assets.total)).first(), "total assets on the page").toBeVisible();
});
