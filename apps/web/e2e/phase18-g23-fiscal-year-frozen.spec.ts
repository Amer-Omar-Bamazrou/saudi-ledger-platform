/**
 * 🔴 Phase 18 R-2 — G23 (owner 2026-11-01; register §11.85): on a company with
 * entries in the books the Company Settings page SAYS the fiscal-year start is
 * fixed before the act, keeps the controls, and a save of another month is
 * refused with the server's words — in English and in Arabic — leaving the
 * declared month in place.
 *
 * The seeded tenant is declared (January, Gregorian) and has posted entries.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "./fixtures";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

let api: APIRequestContext;
let month = 0;

const setLang = async (page: Page, lang: "en" | "ar") => {
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const c = await (await api.get("/api/companies/current")).json();
  expect(c.fiscalYearStartFrozen, "the seeded tenant has entries in the books, so its start is fixed").toBe(true);
  expect(c.fiscalYearStart, "the seed declared January before posting").toBe(1);
  month = c.fiscalYearStart;
});
test.afterAll(async () => { await api.dispose(); });

test("🔴 the page says the start is fixed; another month is refused in English, then in Arabic; the declared month stays", async ({ page }) => {
  await page.goto("/company");
  await expect(page.getByTestId("fiscal-year-frozen-note")).toBeVisible();
  await expect(page.getByTestId("fiscal-year-frozen-note")).toContainText("fixed");
  const select = page.locator("#fiscalYearStart");
  await expect(select).toHaveValue(String(month));
  await expect(select, "the control stays — a refusal is explained, never hidden").toBeEnabled();

  await select.selectOption(String(month === 4 ? 7 : 4));
  await page.getByTestId("button-save-company").click();
  const err = page.getByTestId("company-settings-error");
  await expect(err).toBeVisible();
  await expect(err).toContainText("cannot change");
  await expect(err).toContainText("posted");

  await page.reload();
  await expect(page.locator("#fiscalYearStart"), "nothing was saved").toHaveValue(String(month));
  expect((await (await api.get("/api/companies/current")).json()).fiscalYearStart).toBe(month);

  await setLang(page, "ar");
  await expect(page.getByTestId("fiscal-year-frozen-note")).toContainText("ثابتة");
  await page.locator("#fiscalYearStart").selectOption(String(month === 4 ? 7 : 4));
  await page.getByTestId("button-save-company").click();
  const errAr = page.getByTestId("company-settings-error");
  await expect(errAr).toBeVisible();
  await expect(errAr).toContainText("لا يمكن تغيير بداية السنة المالية");
  await setLang(page, "en");
  expect((await (await api.get("/api/companies/current")).json()).fiscalYearStart).toBe(month);
});
