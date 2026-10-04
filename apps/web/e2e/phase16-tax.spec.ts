/**
 * PHASE 16 — SAUDI TAX, WALKED BY CLICKING (2026-10-04).
 * Record: docs/product/phase-16-17-tax-treasury-decision-pack.md §2–§7.
 *
 * What only a browser can show:
 *   · a non-resident supplier's default nature is set on its record, and the
 *     BILL PAY DIALOG previews the withholding the server will apply — rate,
 *     tax withheld, cash that leaves — and the payment records it;
 *   · the WHT month shows the withholding, the return lists it, and a
 *     remittance is recorded from the page (the month reads "Remitted");
 *   · a nav deep link (`?tab=`) opens the tab it names (the lost-scope shape);
 *   · Zakat: a computation is started, its BLOCKERS name the unclassified
 *     accounts, the classification page confirms them one by one (a
 *     suggestion is pre-selected, never applied by itself), the working paper
 *     then computes, and approving the current year is refused BY NAME;
 *   · every tax page in Arabic under dir=rtl and English, desktop and a 390 px
 *     phone, with no sideways scroll.
 *
 * The walk declares what Zakat needs (ownership, a fiscal year) and puts the
 * shared company back exactly as it found it (the budgets pattern).
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { businessToday } from "@workspace/shared";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };
const DESKTOP = 1280;
const TODAY = businessToday();
const PERIOD = TODAY.slice(0, 7);
const YEAR = Number(TODAY.slice(0, 4));
const STAMP = Date.now();

let api: APIRequestContext;
let original: { fiscalYearStart: number | null; fiscalCalendar: string | null; ownershipType: string | null } = { fiscalYearStart: null, fiscalCalendar: null, ownershipType: null };
let vendorId = 0, billId = 0, computationId = 0;

const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};
const pick = async (page: Page, testId: string, option: RegExp | string) => {
  await page.getByTestId(testId).click();
  await page.getByRole("option", { name: option }).first().click();
};
const json = async <T,>(p: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>, what: string): Promise<T> => {
  const r = await p;
  const text = await r.text();
  if (!r.ok()) throw new Error(`${what} → ${r.status()} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const c = await json<{ fiscalYearStart: number | null; fiscalCalendar: string | null; ownershipType: string | null }>(api.get("/api/companies/current"), "company");
  original = { fiscalYearStart: c.fiscalYearStart ?? null, fiscalCalendar: c.fiscalCalendar ?? null, ownershipType: c.ownershipType ?? null };
  // a NON-RESIDENT supplier (declared — never inferred) and an approved bill to it
  const v = await json<{ id: number }>(api.post("/api/vendors", { data: { name: `E2E London Consulting ${STAMP}`, residency: "non_resident", country: "GB" } }), "vendor");
  vendorId = v.id;
  const b = await json<{ id: number }>(api.post("/api/bills", { data: {
    supplierDocumentKind: "tax_invoice", vendorReference: `LDN-${STAMP}`, billNumber: `E2E-WHT-${STAMP}`, date: TODAY, dueDate: TODAY, vendorId,
    items: [{ description: "Consulting services", quantity: 1, unitPrice: 10000, vatRate: 0 }],
  } }), "bill");
  await json(api.post(`/api/bills/${b.id}/approve`, { data: {} }), "approve bill");
  billId = b.id;
});
test.afterAll(async () => {
  await api.patch("/api/companies/current", { data: {
    fiscalYearStart: original.fiscalYearStart, ownershipType: original.ownershipType ?? "",
    ...(original.fiscalCalendar ? { fiscalCalendar: original.fiscalCalendar } : {}),
  } });
  await api.dispose();
});

test.describe.serial("Phase 16 — Saudi tax, end to end", () => {
  test("🔴 the supplier's default nature is SET on its record, and shows there", async ({ page }) => {
    await page.goto(`/vendors/${vendorId}`);
    await expect(page.getByTestId("vendor-wht-details")).toBeVisible();
    await page.getByTestId("vendor-wht-edit").click();
    await pick(page, "vendor-wht-default", /Technical or consulting services/);
    await page.getByTestId("vendor-wht-save").click();
    await expect(page.getByTestId("vendor-wht-default-value")).toContainText("Technical or consulting services");
  });

  test("🔴 the BILL PAY dialog previews the server's withholding — 5 % of 10,000 — and the payment records it: cash 9,500, WHT 500", async ({ page }) => {
    await page.goto("/bills");
    await page.getByTestId(`pay-bill-${billId}`).click();
    await expect(page.getByTestId("wht-fields")).toBeVisible();
    // the supplier's declared default is pre-selected; the figures are the SERVER's preview
    await expect(page.getByTestId("wht-preview-withheld")).toContainText("500.00");
    await expect(page.getByTestId("wht-preview-cash")).toContainText("9,500.00");
    await page.getByTestId("pay-bank-account").click();
    await page.getByRole("option").first().click();
    await page.getByRole("button", { name: "Record Payment" }).click();
    await expect.poll(async () => {
      const ps = await json<Array<{ withheld?: number | null; cashPaid?: number | null }>>(api.get(`/api/bills/${billId}/payments`), "payments");
      return ps.map((p) => [p.withheld, p.cashPaid]);
    }, { message: "the payment carries its withholding" }).toEqual([[500, 9500]]);
  });

  test("🔴 the WHT month shows it; the return lists it; a remittance recorded from the page closes the month", async ({ page }) => {
    await page.goto("/tax/withholding");
    await expect(page.getByTestId("wht-page")).toBeVisible();
    const row = page.getByTestId(`wht-month-${PERIOD}`);
    await expect(row).toBeVisible();
    const before = Number((await page.getByTestId(`wht-month-outstanding-${PERIOD}`).innerText()).replace(/[^0-9.]/g, ""));
    expect(before).toBeGreaterThanOrEqual(500);
    await page.getByTestId(`wht-open-${PERIOD}`).click();
    await expect(page).toHaveURL(/tab=return/);
    await expect(page.getByTestId("wht-schedule")).toContainText(`E2E London Consulting ${STAMP}`);
    await expect(page.getByTestId("wht-return-lines")).toContainText("500.00");
    await page.getByTestId("wht-remit-bank").click();
    await page.getByRole("option").first().click();
    await page.getByTestId("wht-remit-submit").click();
    await expect(page.getByTestId("wht-return-outstanding")).toHaveText("0.00");
    await expect(page.getByTestId("wht-return-status")).toContainText("Remitted");
    // W1 on the page: the ledger equals the WHT records
    await page.getByTestId("wht-tab-months").click();
    await expect(page.getByTestId("wht-reconciles")).toContainText("Equals the WHT records exactly.");
  });

  test("🔴 a nav deep link opens the tab it names (exceptions, reliefs) — never the default", async ({ page }) => {
    await page.goto("/tax/withholding?tab=exceptions");
    await expect(page.getByTestId("wht-exceptions")).toBeVisible();
    await page.goto("/tax/withholding?tab=reliefs");
    await expect(page.getByTestId("wht-reliefs")).toBeVisible();
  });

  test("🔴 ZAKAT: start the current year; the blockers NAME the unclassified accounts; confirm each class; the working paper computes; approving the open year is refused BY NAME", async ({ page }) => {
    await api.patch("/api/companies/current", { data: { fiscalYearStart: 1, fiscalCalendar: "gregorian", ownershipType: "SAUDI_GCC" } });
    await page.goto("/zakat");
    await expect(page.getByTestId("zakat-scope-eligible")).toBeVisible();
    await pick(page, "tax-computation-year", new RegExp(`^${YEAR} ·`));
    await page.getByTestId("tax-computation-create-submit").click();
    await expect(page.getByTestId("tax-computation-page")).toBeVisible();
    computationId = Number(page.url().split("/tax/computations/")[1]!.split("?")[0]);
    expect(computationId).toBeGreaterThan(0);
    await expect(page.getByTestId("tax-blocker-zakat_unclassified_accounts")).toBeVisible();

    // classify: each unclassified account — the suggestion is pre-selected, the person confirms it; with no suggestion, a class is CHOSEN
    await page.goto("/zakat/classification");
    await expect(page.getByTestId("zakat-class-table")).toBeVisible();
    for (let guard = 0; guard < 60; guard++) {
      const rows = page.locator('[data-testid^="zakat-class-row-"]');
      if ((await rows.count()) === 0) break;
      const first = rows.first();
      const id = (await first.getAttribute("data-testid"))!.replace("zakat-class-row-", "");
      const save = page.getByTestId(`zakat-class-save-${id}`);
      if (await save.isDisabled()) {
        await page.getByTestId(`zakat-class-select-${id}`).click();
        await page.getByRole("option").first().click();
      }
      await save.click();
      await expect(page.getByTestId(`zakat-class-row-${id}`)).toHaveCount(0);
    }
    await expect(page.getByTestId("zakat-class-empty")).toBeVisible();

    await page.goto(`/tax/computations/${computationId}`);
    await expect(page.getByTestId("tax-blocker-zakat_unclassified_accounts")).toHaveCount(0);
    await expect(page.getByTestId("tax-zakat-steps")).toBeVisible();
    await expect(page.getByTestId("tax-live-amount")).not.toContainText("not computed");
    await expect(page.getByTestId("tax-reconciliation")).toBeVisible();
    await page.getByTestId("tax-approve").click();
    await expect(page.getByText(/after its year has ended/).first()).toBeVisible();
    await expect(page.getByTestId("tax-version-status")).toContainText("Draft");
  });

  test("the obligations calendar no longer owes the remitted month; income tax does not apply to a Saudi-owned company; the income statement shows its profit-before-Zakat line", async ({ page }) => {
    await page.goto("/tax/obligations");
    await expect(page.getByTestId("tax-obligations-page")).toBeVisible();
    await expect(page.locator(`[data-testid^="tax-obligation-wht-"]`).filter({ hasText: PERIOD })).toHaveCount(0);
    await page.goto("/tax/income-tax");
    await expect(page.getByTestId("income-tax-scope-not-applicable")).toBeVisible();
    await page.goto("/income-statement");
    await expect(page.getByTestId("is-profit-before-zakat")).toBeVisible();
  });

  test("🔴 every tax page in Arabic (dir=rtl, the Arabic heading ASSERTED) and English, desktop and a 390 px phone — no sideways scroll", async ({ page }) => {
    const PAGES: [string, string, RegExp][] = [
      ["/zakat", "zakat-page", /الزكاة/],
      ["/zakat/classification", "zakat-classification-page", /تصنيف الحسابات للزكاة/],
      ["/tax/income-tax", "income-tax-page", /ضريبة الدخل/],
      ["/tax/withholding", "wht-page", /ضريبة الاستقطاع/],
      ["/tax/withholding?tab=return", "wht-page", /ضريبة الاستقطاع/],
      ["/tax/obligations", "tax-obligations-page", /الالتزامات الضريبية/],
      [`/tax/computations/${computationId}`, "tax-computation-page", /ورقة عمل الزكاة/],
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
    // 🔴 the TABS read right to left, not only the document (Radix writes dir=ltr unless told)
    await page.setViewportSize({ width: DESKTOP, height: 900 });
    await page.goto("/tax/withholding");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.reload();
    const tabs = await page.getByTestId("wht-tab-months").evaluate((el) => {
      const list = el.parentElement!;
      const first = el.getBoundingClientRect().x;
      const last = list.lastElementChild!.getBoundingClientRect().x;
      return { dir: getComputedStyle(list).direction, first, last };
    });
    expect(tabs.dir).toBe("rtl");
    expect(tabs.first, "the first tab is the RIGHTMOST in Arabic").toBeGreaterThan(tabs.last);
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
  });
});
