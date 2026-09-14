import { test, expect } from "@playwright/test";
import { E2E } from "./global-setup";

/**
 * QA FIX #1 — CREATE INVOICE IS SINGLE-SUBMIT (2026-09-04).
 *
 * Found by the browser QA pass: a double-click on "Create Invoice" fired two
 * POSTs and minted two identical drafts — each of which would mint its own
 * ZATCA ICV on approval. The fix has two halves and this spec exercises the
 * one only a browser can: the CLIENT half (a synchronous guard + one
 * idempotency key per dialog open) driven by a real double-click. The server
 * idempotency guard is pinned by `invoice-idempotency.test.ts`.
 *
 * 🔴 Counts the CREATE requests, not just the row count — a duplicate that the
 * server later deduped would still be two POSTs, and the point is that the
 * client fires ONE.
 */

test.use({ storageState: E2E.storageState });

test("🔴 double-clicking Create Invoice fires ONE create, not two", async ({ page }) => {
  await page.goto("/invoices", { waitUntil: "networkidle" });

  let creates = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/invoices") creates++;
  });

  await page.getByRole("button", { name: /new invoice/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // A priced line + a customer — the minimum the Create button accepts.
  await dialog.getByPlaceholder("Description").first().fill("Double-submit probe");
  await dialog.getByPlaceholder("Qty").first().fill("1");
  await dialog.getByPlaceholder("Unit price").first().fill("100");

  // The customer combobox (first button-style combobox in the dialog).
  await dialog.getByRole("combobox").nth(1).click();
  await page.getByRole("option").first().click();

  const create = dialog.getByRole("button", { name: /create invoice/i });
  await expect(create, "the form must be valid (customer + priced line) before we test submit").toBeEnabled();

  // 🔴 The abuse: two clicks as fast as Playwright will issue them.
  await create.click();
  await create.click({ force: true }).catch(() => {}); // the dialog may already be closing

  // Give any second request that was going to fire, time to fire.
  await page.waitForTimeout(1500);

  expect(creates, "the client must fire exactly one create for a double-click").toBe(1);
});

/**
 * 🔴 THE DETERMINISTIC HALF (2026-09-14). The test above races Playwright's
 * two round-trip clicks against React's re-render, so on a fast machine it
 * passed even while the guard was a render snapshot — CI under load was
 * what finally counted the second POST. This test removes the race: two
 * click events dispatched in the SAME task, before React can possibly
 * commit a re-render. A guard that reads mutation state (a snapshot from
 * the last render) admits both by construction; only something with no
 * render in its loop — the ref — stops the second. Reverting the ref guard
 * fails HERE every time, not one CI run in two.
 */
test("🔴 two clicks in the SAME TICK fire one create — the render-snapshot regression", async ({ page }) => {
  await page.goto("/invoices", { waitUntil: "networkidle" });

  let creates = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/invoices") creates++;
  });

  await page.getByRole("button", { name: /new invoice/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("Description").first().fill("Same-tick probe");
  await dialog.getByPlaceholder("Qty").first().fill("1");
  await dialog.getByPlaceholder("Unit price").first().fill("100");
  await dialog.getByRole("combobox").nth(1).click();
  await page.getByRole("option").first().click();

  const create = dialog.getByRole("button", { name: /create invoice/i });
  await expect(create).toBeEnabled();

  // Both events run their handlers before any re-render can commit.
  await create.evaluate((el) => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

  await page.waitForTimeout(1500);
  expect(creates, "the second same-tick click must be swallowed by the ref, not the render").toBe(1);
});
