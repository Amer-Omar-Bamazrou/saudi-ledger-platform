/**
 * OPTIONAL FIELDS LEFT BLANK DO NOT BLOCK A CREATE — driven through the
 * CLIENT'S OWN SUBMIT PATH (2026-09-14).
 *
 * The structural gap this spec exists for: every API test builds its
 * request the way the SERVER expects, so the suite cannot see a malformed
 * body the client actually sends. The New Bill form spread `dueDate: ""`
 * and 400'd whenever the optional Due Date was left empty — invisible to
 * every server test, caught only by walking the form. Same class on the
 * employee form's optional joiningDate. These tests submit the REAL forms
 * with the optional field untouched; reverting either `|| undefined` fix
 * turns the create into a 400 and fails here.
 */
import { test, expect } from "@playwright/test";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

test("🔴 New Bill with Due Date left blank CREATES — the dueDate:'' regression", async ({ page }) => {
  await page.goto("/bills", { waitUntil: "networkidle" });

  const responses: number[] = [];
  page.on("response", (r) => {
    if (r.request().method() === "POST" && new URL(r.url()).pathname === "/api/bills") responses.push(r.status());
  });

  await page.getByRole("button", { name: /new bill/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Vendor + totals; Due Date deliberately untouched — the case that 400'd.
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "E2E Vendor" }).click();
  const numeric = dialog.locator('input[type="number"]');
  await numeric.nth(0).fill("100");
  await numeric.nth(1).fill("15");
  await numeric.nth(2).fill("115");

  await dialog.getByRole("button", { name: /post bill/i }).click();
  await expect
    .poll(() => responses.length, { message: "the create request must fire" })
    .toBeGreaterThan(0);
  expect(responses[0], "a blank optional Due Date must not 400 the create").toBe(201);
});

test("🔴 New Employee with Joining Date cleared CREATES — the same class, dynamically-typed input", async ({ page }) => {
  await page.goto("/employees", { waitUntil: "networkidle" });

  const responses: number[] = [];
  page.on("response", (r) => {
    if (r.request().method() === "POST" && new URL(r.url()).pathname === "/api/employees") responses.push(r.status());
  });

  await page.getByRole("button", { name: /add employee/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // The name + basic salary are the minimum; CLEAR the prefilled joining
  // date — the optional field whose "" the spread used to send.
  await dialog.locator("input").nth(1).fill("Blank Joining Probe");
  const dateInput = dialog.locator('input[type="date"]');
  await dateInput.fill("");
  await dialog.locator('input[type="number"]').first().fill("4000");

  await dialog.getByRole("button", { name: /add employee/i }).click();
  await expect
    .poll(() => responses.length, { message: "the create request must fire" })
    .toBeGreaterThan(0);
  expect(responses[0], "a cleared optional Joining Date must not 400 the create").toBe(201);
});
