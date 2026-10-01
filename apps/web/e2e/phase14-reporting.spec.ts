/**
 * PHASE 14 — THE FINANCIAL STATEMENTS, WALKED BY CLICKING (2026-10-01).
 * Record: docs/product/phase-14-15-reporting-budgeting-decision-pack.md §3.
 *
 * What only a browser can show (§3: "assume any completed backend is
 * unreachable until someone has clicked it"):
 *   · a window chosen by TYPING DATES is the window the server is asked for,
 *     and the page shows the server's figure for it — not a zero, not a
 *     different number;
 *   · 🔴 a DRILL lands on the same question (§3 "a navigation can lose the
 *     scope"): the general ledger opened from a trial-balance or balance-sheet
 *     row opens and closes on THAT row's figures — only following the link and
 *     reading what it shows catches a destination that ignores the parameter;
 *   · an export is the screen: the downloaded CSV carries the page's totals;
 *     the PDF is a PDF;
 *   · an ageing AS OF a past date asks the server for that date, and ties to
 *     the GL receivable at that date — on the product's own seeded books;
 *   · Arabic under dir=rtl, and a phone at 390 px with no sideways scroll.
 *
 * Every figure here was written by the product's own posting paths
 * (`global-setup.ts`), so a figure that matches is a real one (§3 standing rule 2).
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };
const DESKTOP = 1280;
const FROM = "2026-06-01";
const TO = "2026-08-31";
const sar = (n: number) => new Intl.NumberFormat("en-SA", { style: "currency", currency: "SAR", minimumFractionDigits: 2 }).format(n);

let api: APIRequestContext;
test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
});
test.afterAll(async () => { await api.dispose(); });

const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};

/** Type a window into a report's date fields and press its button; resolve with the server's answer the page received. */
async function applyWindow(page: Page, prefix: string, endpoint: string, from: string, to: string) {
  await page.getByTestId(`${prefix}-from`).fill(from);
  await page.getByTestId(`${prefix}-to`).fill(to);
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/reports/${endpoint}?`) && r.url().includes(`date_from=${from}`) && r.url().includes(`date_to=${to}`)),
    page.getByTestId(`${prefix}-generate`).click(),
  ]);
  expect(res.status(), `${endpoint} answered`).toBe(200);
  return res.json();
}

/** Click an export button; return the downloaded file's bytes. */
async function download(page: Page, testId: string): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId(testId).click()]);
  return readFileSync((await dl.path())!);
}

test.describe.serial("Phase 14 — the statements, end to end", () => {
  test("🔴 the trial balance answers the window TYPED into it: balanced, non-trivial, opening and closing both zero, and the page shows the server's totals", async ({ page }) => {
    await page.goto("/trial-balance");
    const tb = await applyWindow(page, "tb", "trial-balance", FROM, TO);
    expect(tb.window).toEqual({ from: FROM, to: TO });
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit, "a balanced EMPTY ledger proves nothing").toBeGreaterThan(0);
    expect([tb.totalOpening, tb.totalClosing]).toEqual([0, 0]);
    await expect(page.getByTestId("tb-total-debit")).toContainText(sar(tb.totalDebit));
    await expect(page.getByTestId("tb-total-credit")).toContainText(sar(tb.totalCredit));
  });

  test("🔴 DRILL: a trial-balance row opens the general ledger on THAT account and THAT window, and the ledger opens and closes on the row's own figures", async ({ page }) => {
    await page.goto("/trial-balance");
    const tb = await applyWindow(page, "tb", "trial-balance", FROM, TO);
    // a balance-sheet row and a P&L row — the two openings the ledger must reproduce (D14-09)
    for (const type of ["asset", "income"]) {
      const row = (tb.accounts as Array<{ accountId: number | null; type: string; debit: number; credit: number; openingBalance: number; closingBalance: number }>)
        .find((r) => r.accountId != null && r.type === type && (r.debit > 0 || r.credit > 0));
      expect(row, `the seeded books have a ${type} account that moved in the window`).toBeTruthy();
      await page.goto("/trial-balance");
      await applyWindow(page, "tb", "trial-balance", FROM, TO);
      const [gl] = await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/reports/general-ledger?") && r.url().includes(`account_id=${row!.accountId}`)),
        page.getByTestId(`tb-drill-${row!.accountId}`).click(),
      ]);
      await expect(page).toHaveURL(new RegExp(`/reports/general-ledger\\?account_id=${row!.accountId}&date_from=${FROM}&date_to=${TO}`));
      const body = await gl.json();
      expect(body.window, `${type}: the ledger was asked for the row's window`).toEqual({ from: FROM, to: TO });
      expect([body.openingBalance, body.closingBalance], `${type}: the ledger opens and closes on the row`).toEqual([row!.openingBalance, row!.closingBalance]);
      await expect(page.getByTestId("gl-kpi-opening")).toContainText(sar(row!.openingBalance));
      await expect(page.getByTestId("gl-closing")).toContainText(sar(row!.closingBalance));
    }
  });

  test("🔴 the income statement: the typed window, the server's totals on the page, and the CSV export carries exactly those totals (UTF-8 BOM); the PDF is a PDF", async ({ page }) => {
    await page.goto("/income-statement");
    const is = await applyWindow(page, "is", "income-statement", FROM, TO);
    expect(is.totalRevenue, "the seeded window has revenue").toBeGreaterThan(0);
    expect([is.grossProfit, is.expenseAnalysis, is.source]).toEqual([null, "nature", "journal_entries"]);
    await expect(page.getByTestId("is-total-revenue")).toContainText(sar(is.totalRevenue));
    await expect(page.getByTestId("is-nature-note")).toBeVisible();

    const csv = await download(page, "export-income-statement-csv");
    expect([...csv.subarray(0, 3)], "UTF-8 BOM, so Excel reads Arabic").toEqual([0xef, 0xbb, 0xbf]);
    const text = csv.toString("utf8");
    expect(text).toContain(is.totalRevenue.toFixed(2));
    expect(text).toContain(is.totalExpenses.toFixed(2));
    expect(text).toContain(FROM);

    const pdf = await download(page, "export-income-statement-pdf");
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  test("🔴 the balance sheet AS OF a typed date: balanced, the AR line is the server's, and its drill opens the receivable's ledger up to that date — closing on the same figure", async ({ page }) => {
    await page.goto("/balance-sheet");
    await page.getByTestId("bs-as-of").fill(TO);
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/reports/balance-sheet?") && r.url().includes(`as_of=${TO}`)),
      page.getByTestId("bs-generate").click(),
    ]);
    const bs = await res.json();
    expect(bs.asOf).toBe(TO);
    expect(bs.balanced).toBe(true);
    expect(bs.assets.accountsReceivable, "the seeded books hold a receivable at the date").toBeGreaterThan(0);
    await expect(page.getByTestId("bs-ar")).toContainText(sar(bs.assets.accountsReceivable));
    await expect(page.getByTestId("bs-kpi-assets")).toContainText(sar(bs.assets.total));

    const [gl] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/reports/general-ledger?") && r.url().includes(`account_id=${bs.assets.accountsReceivableKey}`)),
      page.getByTestId(`bs-drill-${bs.assets.accountsReceivableKey}`).click(),
    ]);
    const body = await gl.json();
    expect(body.window.to, "the ledger is read up to the balance-sheet date").toBe(TO);
    expect(body.closingBalance).toBe(bs.assets.accountsReceivable);
    await expect(page.getByTestId("gl-closing")).toContainText(sar(bs.assets.accountsReceivable));
  });

  test("🔴 the cash flow RECONCILES on the seeded books, and the page shows the server's closing cash", async ({ page }) => {
    await page.goto("/cash-flow");
    const cf = await applyWindow(page, "cf", "cash-flow", FROM, TO);
    expect(cf.reconciles, "opening + activities + internal + migration = closing").toBe(true);
    expect(cf.method).toBe("direct");
    expect(cf.operating.items.length, "the seeded receipts and payments are operating lines").toBeGreaterThan(0);
    await expect(page.getByTestId("cf-reconciles")).toContainText(/Reconciles|تتطابق/);
    await expect(page.getByTestId("cf-closing")).toContainText(sar(cf.closingCash));
  });

  test("🔴 AR ageing AS OF a past date: the page asks the server for that date, shows its total, and the total ties to the GL receivable at that date", async ({ page }) => {
    const AS_OF = "2026-07-15";
    await page.goto("/ar-aging");
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/reports/ar-aging?") && r.url().includes(`as_of=${AS_OF}`)),
      page.getByTestId("ar-aging-as-of").fill(AS_OF),
    ]);
    const ag = await res.json();
    expect([ag.asOf, ag.basis]).toEqual([AS_OF, "events"]);
    await expect(page.getByTestId("aging-total")).toContainText(sar(ag.total));
    const bs = await (await api.get(`/api/reports/balance-sheet?as_of=${AS_OF}`)).json();
    expect(Math.round((ag.total - ag.liabilities.customerCredits - ag.liabilities.customerDeposits) * 100) / 100, "ageing (documents) ⇄ GL receivable at the same date").toBe(bs.assets.accountsReceivable);
  });

  test("the P&L trend on Analytics renders the server's window totals", async ({ page }) => {
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/analytics/pnl-trend?")),
      page.goto("/analytics"),
    ]);
    const trend = await res.json();
    await expect(page.getByTestId("analytics-pnl-trend")).toBeVisible();
    await expect(page.getByTestId("analytics-pnl-totals")).toContainText(sar(trend.totals.net));
  });

  test("🔴 every Phase 14 page in Arabic (dir=rtl, the Arabic heading ASSERTED) and English, on a desktop and a 390 px phone — no sideways scroll", async ({ page }) => {
    const ar = (await (await api.get("/api/reports/balance-sheet?as_of=" + TO)).json()).assets.accountsReceivableKey as string;
    const PAGES: [string, string, RegExp][] = [
      ["/trial-balance", "tb-total-debit", /ميزان المراجعة/],
      ["/income-statement", "is-nature-note", /قائمة الدخل/],
      ["/balance-sheet", "bs-balanced", /الميزانية العمومية/],
      ["/cash-flow", "cf-statement", /قائمة التدفق النقدي/],
      [`/reports/general-ledger?account_id=${ar}&date_from=${FROM}&date_to=${TO}`, "gl-closing", /دفتر الأستاذ العام/],
      ["/ar-aging", "aging-total", /تقرير أعمار الذمم المدينة/],
      ["/ap-aging", "ap-recon-total", /أعمار الذمم الدائنة/],
      ["/analytics", "analytics-pnl-trend", /التحليلات/],
    ];
    for (const [path, testId, arabicHeading] of PAGES) {
      for (const [lang, viewport, label] of [
        ["en", null, "EN desktop"], ["en", PHONE, "EN phone"], ["ar", null, "AR desktop"], ["ar", PHONE, "AR phone"],
      ] as [string, typeof PHONE | null, string][]) {
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
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
    await page.setViewportSize({ width: DESKTOP, height: 900 });
  });
});
