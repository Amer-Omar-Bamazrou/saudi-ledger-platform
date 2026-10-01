/**
 * PHASE 15 — A BUDGET, WALKED BY CLICKING (2026-10-01).
 * Record: docs/product/phase-14-15-reporting-budgeting-decision-pack.md §5.
 *
 * What only a browser can show:
 *   · a budget is CREATED, FILLED (twelve periods for one account, one annual
 *     amount for another), SUBMITTED and APPROVED by clicking — every control
 *     is reachable, and the server answers each act;
 *   · 🔴 budget vs actual on the page is the server's, and its net actual IS the
 *     income statement for the same dates (P4) — read off the page, not only
 *     the API;
 *   · an annual amount shows "—" where a divided figure would otherwise appear;
 *   · a revision, a send-back with its note, and a rejection — and the
 *     approved version survives all three;
 *   · the CSV export carries the screen's figures;
 *   · Arabic under dir=rtl, and a phone at 390 px with no sideways scroll.
 *
 * A budget needs a DECLARED fiscal year (D15-15): the walk declares one and puts
 * the shared company back exactly as it found it (the income-tax-pool pattern).
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };
const DESKTOP = 1280;
const NAME = `E2E Walk Budget ${Date.now()}`;
const sar = (n: number) => new Intl.NumberFormat("en-SA", { style: "currency", currency: "SAR", minimumFractionDigits: 2 }).format(n);

let api: APIRequestContext;
let original: { fiscalYearStart: number | null; fiscalCalendar: string | null } = { fiscalYearStart: null, fiscalCalendar: null };
let budgetId = 0;
let sales = 0, purchases = 0;

const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};
const pick = async (page: Page, testId: string, option: RegExp | string) => {
  await page.getByTestId(testId).click();
  await page.getByRole("option", { name: option }).first().click();
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const c = await (await api.get("/api/companies/current")).json();
  original = { fiscalYearStart: c.fiscalYearStart ?? null, fiscalCalendar: c.fiscalCalendar ?? null };
  await api.patch("/api/companies/current", { data: { fiscalYearStart: 1, fiscalCalendar: "gregorian" } });
  const accounts = (await (await api.get("/api/budgets/accounts")).json()) as Array<{ id: number; name: string }>;
  sales = accounts.find((a) => a.name === "Sales Revenue")!.id;
  purchases = accounts.find((a) => a.name === "Purchases")!.id;
});
test.afterAll(async () => {
  await api.patch("/api/companies/current", { data: { fiscalYearStart: original.fiscalYearStart, ...(original.fiscalCalendar ? { fiscalCalendar: original.fiscalCalendar } : {}) } });
  await api.dispose();
});

test.describe.serial("Phase 15 — a budget, end to end", () => {
  test("🔴 CREATE and FILL by clicking: one account by period, one as an annual amount — never divided", async ({ page }) => {
    await page.goto("/budgets");
    await expect(page.getByTestId("budgets-page")).toBeVisible();
    await page.getByTestId("budget-create").click();
    await page.getByTestId("budget-create-name").fill(NAME);
    await pick(page, "budget-create-year", /^2026 ·/);
    await page.getByTestId("budget-create-submit").click();
    await expect(page.getByTestId("budget-detail")).toBeVisible();
    budgetId = Number(page.url().split("/budgets/")[1]);
    expect(budgetId).toBeGreaterThan(0);
    await expect(page.getByTestId("budget-version-status")).toContainText(/v1 · Draft/);

    // Sales: twelve periods
    await pick(page, "budget-add-account", "Sales Revenue");
    await page.getByTestId("budget-add-line").click();
    for (let p = 1; p <= 12; p++) await page.getByTestId(`budget-line-period-${sales}-${p}`).fill(p <= 6 ? "1000" : "2000");
    // Purchases: ONE annual amount
    await pick(page, "budget-add-account", "Purchases");
    await page.getByTestId("budget-add-line").click();
    await pick(page, `budget-line-mode-${purchases}`, /Annual only/);
    await page.getByTestId(`budget-line-annual-${purchases}`).fill("12000");
    await page.getByTestId("budget-save-lines").click();
    await expect(page.getByTestId(`budget-line-total-${sales}`)).toContainText("18,000.00");

    // it round-tripped through the SERVER, not merely the DOM
    const d = await (await api.get(`/api/budgets/${budgetId}`)).json();
    expect(d.lines.map((l: { accountId: number; mode: string; total: number; periods: unknown }) => [l.accountId, l.mode, l.total, l.periods === null]).sort())
      .toEqual([[purchases, "annual", 12000, true], [sales, "periods", 18000, false]].sort());
  });

  test("🔴 SUBMIT, then APPROVE — the lines lock, and the approved version is the one budget vs actual reads", async ({ page }) => {
    await page.goto(`/budgets/${budgetId}`);
    await page.getByTestId("budget-submit").click();
    await expect(page.getByTestId("budget-version-status")).toContainText(/Submitted/);
    await page.getByTestId("budget-approve").click();
    await expect(page.getByTestId("budget-version-status")).toContainText(/Approved/);
    await expect(page.getByTestId("budget-save-lines")).toHaveCount(0); // locked: no editor
    await expect(page.getByTestId("budget-revise")).toBeVisible();
  });

  test("🔴 BUDGET VS ACTUAL on the page is the server's — and its net actual IS the income statement for the same dates (P4); the annual line shows no divided budget", async ({ page }) => {
    await page.goto(`/budgets/${budgetId}`);
    await page.getByTestId("budget-tab-vs").click();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/budgets/${budgetId}/vs-actual`) && r.url().includes("through_period=8")),
      pick(page, "bva-through", /^8 ·/),
    ]);
    const vs = await res.json();
    expect([vs.throughPeriod, vs.throughDate, vs.basis]).toEqual([8, "2026-08-31", "accrual_gl"]);
    const salesLine = vs.lines.find((l: { accountId: number }) => l.accountId === sales);
    expect(salesLine.ytd.budget).toBe(10000); // 6 × 1,000 + 2 × 2,000
    await expect(page.getByTestId(`bva-ytd-actual-${sales}`)).toContainText(sar(salesLine.ytd.actual));
    // the seeded books have real sales in the window, so this is not the empty answer
    expect(salesLine.ytd.actual, "the seeded tenant has posted sales in Jan–Aug").toBeGreaterThan(0);
    const purch = vs.lines.find((l: { accountId: number }) => l.accountId === purchases);
    expect([purch.mode, purch.ytd.budget, purch.forecast.amount]).toEqual(["annual", null, null]);
    await expect(page.getByTestId(`bva-line-${purchases}`)).toContainText("—");

    const is = await (await api.get("/api/reports/income-statement?date_from=2026-01-01&date_to=2026-08-31")).json();
    expect(vs.totals.net.ytd.actual, "Σ actual (budgeted + unbudgeted) = the income statement").toBe(is.netIncome);
    await expect(page.getByTestId("bva-total-net-actual")).toContainText(sar(is.netIncome));

    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-budget-vs-actual-csv").click()]);
    const csv = readFileSync((await dl.path())!).toString("utf8");
    expect(csv).toContain(salesLine.ytd.actual.toFixed(2));
    expect(csv).toContain(NAME);
  });

  test("🔴 REVISE → SEND BACK with a note → REJECT: the approved version survives all three", async ({ page }) => {
    await page.goto(`/budgets/${budgetId}`);
    await page.getByTestId("budget-revise").click();
    await expect(page.getByTestId("budget-version-status")).toContainText(/v2 · Draft/);
    await page.getByTestId(`budget-line-period-${sales}-1`).fill("1500");
    await page.getByTestId("budget-save-lines").click();
    await expect(page.getByTestId(`budget-line-total-${sales}`)).toContainText("18,500.00");
    await page.getByTestId("budget-submit").click();
    await expect(page.getByTestId("budget-version-status")).toContainText(/v2 · Submitted/);
    await page.getByTestId("budget-send-back").click();
    await page.getByTestId("budget-send-back-text").fill("Keep January at 1,000");
    await page.getByTestId("budget-confirm").click();
    await expect(page.getByTestId("budget-version-status")).toContainText(/v2 · Draft/);
    await expect(page.getByTestId("budget-send-back-note-shown")).toContainText("Keep January at 1,000");
    await page.getByTestId("budget-reject").click();
    await page.getByTestId("budget-confirm").click();
    await expect(page.getByTestId("budget-version-status")).toContainText(/v1 · Approved/);
    const d = await (await api.get(`/api/budgets/${budgetId}`)).json();
    expect(d.versions.map((v: { versionNo: number; status: string }) => [v.versionNo, v.status])).toEqual([[1, "approved"]]);
  });

  test("the Analytics card reads an APPROVED base budget, and shows its net actual", async ({ page }) => {
    const [res] = await Promise.all([
      page.waitForResponse((r) => /\/api\/budgets\/\d+\/vs-actual/.test(r.url())),
      page.goto("/analytics"),
    ]);
    const vs = await res.json();
    expect(vs.version.status).toBe("approved");
    await expect(page.getByTestId("analytics-budget-card")).toBeVisible();
    await expect(page.getByTestId("analytics-budget-net")).toContainText(sar(vs.totals.net.ytd.actual));
  });

  test("🔴 the budget pages in Arabic (dir=rtl, the Arabic heading ASSERTED) and English, desktop and a 390 px phone — no sideways scroll", async ({ page }) => {
    const PAGES: [string, string, RegExp][] = [
      ["/budgets", "budgets-page", /الميزانيات/],
      [`/budgets/${budgetId}`, "budget-detail", /.+/],
    ];
    for (const [path, testId, arabicHeading] of PAGES) {
      for (const [lang, viewport, label] of [["en", null, "EN desktop"], ["en", PHONE, "EN phone"], ["ar", null, "AR desktop"], ["ar", PHONE, "AR phone"]] as [string, typeof PHONE | null, string][]) {
        await page.setViewportSize(viewport ?? { width: DESKTOP, height: 900 });
        await page.goto(path);
        await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
        await page.reload();
        await expect(page.locator("html"), `${path} ${label}`).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
        await expect(page.getByTestId(testId), `${path} ${label}`).toBeVisible();
        if (lang === "ar") await expect(page.getByRole("heading", { name: arabicHeading }).first(), `${path} ${label} heading`).toBeVisible();
        await noSidewaysScroll(page, viewport?.width ?? DESKTOP, `${path} ${label}`);
      }
    }
    // the detail's Arabic words, not only its direction
    await page.setViewportSize(PHONE);
    await page.goto(`/budgets/${budgetId}`);
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.reload();
    await expect(page.getByTestId("budget-version-status")).toContainText("معتمدة");
    await page.getByTestId("budget-tab-vs").click();
    await expect(page.getByTestId("bva-table")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "budget vs actual, AR phone");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
    await page.setViewportSize({ width: DESKTOP, height: 900 });
  });
});
