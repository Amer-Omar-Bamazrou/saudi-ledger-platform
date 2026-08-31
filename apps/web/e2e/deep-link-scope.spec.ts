import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";

/**
 * THE LOST-SCOPE CHECK — a link is a claim about what the destination shows.
 *
 * ── 🔴 THE INCIDENT (2026-08-31) ───────────────────────────────────────────
 * `CustomerDetail` links to the ledger report as "Open statement" with
 * `?customer_id=<id>`. Opened from one customer, it rendered ALL FOUR customers
 * and a total four times too large. `CustomerLedger` initialised its filter with
 * `useState("all")` and never read the query string.
 *
 * **Every static check was green, and none of them was wrong.** Both
 * reachability guards passed (the route is mounted; the page calls something
 * that exists). The shape guard passed (every declared field is sent).
 * Typecheck has nothing to say about a string in a URL. Six requests returned
 * 200. The source built a well-formed URL carrying the right id, and the
 * destination rendered correct figures for the set it had.
 *
 * The defect lived in NEITHER FILE — it lived in the expectation the link
 * created and the destination did not honour. The output was a true statement
 * about the wrong set, which is worse than an error because it reads as an
 * answer.
 *
 * ── WHAT THIS ASSERTS ──────────────────────────────────────────────────────
 * Not that the link resolves — that was never in doubt. That the DESTINATION
 * REFLECTS THE PARAMETER: the scope the user chose survives the navigation.
 *
 * This is the concrete form of the rule recorded in `findings-and-lessons.md`:
 * for every in-app link carrying a query parameter, assert the destination
 * reflects it — a heading, a selected control, or the row count.
 */

function ids(): SeededIds {
  return JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds;
}

test.use({ storageState: E2E.storageState });

test("🔴 'Open statement' carries the customer to the ledger report", async ({ page }) => {
  const { customerId } = ids();

  await page.goto(`/customers/${customerId}`, { waitUntil: "networkidle" });
  await expect(page.getByText("E2E Customer").first()).toBeVisible();

  // Follow the link the way a user does, rather than navigating to the URL we
  // believe it has. The bug was in the destination, but a test that builds the
  // URL itself would also pass if the SOURCE stopped sending the parameter.
  const statement = page.getByRole("link", { name: /statement/i }).first();
  await expect(statement, "no 'Open statement' link on the customer detail page").toBeVisible();
  await statement.click();

  await page.waitForURL(/customer-ledger/, { timeout: 10_000 });
  await page.waitForLoadState("networkidle");

  /**
   * 🔴 Web-first assertions, not a single `textContent()` read.
   *
   * The first version of this test read the DOM once and caught "Loading…" —
   * the report resolves its fiscal-year range before it fetches, so the content
   * arrives after `networkidle`. That is a RACE IN THE TEST, and with
   * `retries: 0` the only honest fixes are to assert on the condition or delete
   * the test. `expect(locator)` polls until the condition holds or the timeout
   * expires; a `waitForTimeout` would have asserted on the machine's mood.
   */
  const main = page.locator("main");

  // The destination must be scoped to the customer we came from. The seed has
  // exactly one customer, so scope is asserted on the CONTROL rather than on a
  // row count — a count of one would pass unscoped too.
  await expect(
    main,
    "the ledger report does not name the customer the link was opened from — " +
      "the parameter was dropped, which is the lost-scope shape",
  ).toContainText("E2E Customer");

  await expect(
    main,
    "the ledger report opened on ALL CUSTOMERS despite arriving with ?customer_id — " +
      "nothing errored and no figure is wrong, and the answer is about the wrong set",
  ).not.toContainText("All Customers");
});

test("the report still defaults to every customer when opened without a parameter", async ({ page }) => {
  // The other direction, so the fix cannot be "always filter to something".
  await page.goto("/reports/customer-ledger", { waitUntil: "networkidle" });
  await expect(
    page.locator("main"),
    "opened bare, the report should not be silently scoped to one customer",
  ).toContainText("All Customers");
});

test("a junk parameter falls back to every customer, not to an empty set", async ({ page }) => {
  // A filter that matches nothing renders an empty report, which reads exactly
  // like a tenant with no invoices — the confident-zero shape one more time.
  await page.goto("/reports/customer-ledger?customer_id=not-a-number", { waitUntil: "networkidle" });
  await expect(
    page.locator("main"),
    "a non-numeric customer_id should fall back to all, never filter to nothing",
  ).toContainText("All Customers");
});
