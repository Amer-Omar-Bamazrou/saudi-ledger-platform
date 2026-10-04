/**
 * PHASE 16 + 17 — THE QA GAPS THAT NEEDED NO DECISION, CLOSED AND CLICKED (2026-10-04).
 * Record: docs/history/phase-16-17-gap-closure-2026-10-04.md.
 *
 * What only a browser can see (CLAUDE.md §3 — a server test builds its request
 * the way the server expects; a navigation can lose its scope while every
 * static check stays green):
 *
 *   QA-15  the approvals inbox shows a pending relief and a planned payment; its
 *          acts post to the record's own route, ONE request per click, and a
 *          reason the server requires is typed inline;
 *   QA-16  the plans list no longer scrolls sideways (1280 / 390 px, EN / AR, a
 *          long name, a large amount) and its forms open inside the viewport;
 *          the plan pay form shows the server's WHT preview and the payment
 *          withholds exactly what it showed; obligations rows open THEIR period
 *          and back / forward keep it; legal references read in Arabic;
 *   QA-04  the classification page shows balances at a year-end, scoped by URL;
 *   Q-d    a relief at the statutory rate is flagged before it is recorded;
 *   Q-e    an existing computation stays listed whatever today's ownership.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { businessToday } from "@workspace/shared";
import { readFileSync } from "node:fs";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";

test.use({ storageState: E2E.storageState });

const TODAY = businessToday();
const PERIOD = TODAY.slice(0, 7);
const STAMP = Date.now();
const DESKTOP = 1280, PHONE = { width: 390, height: 844 };
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** An amount as the page prints it (`fmtNum` — "SAR 1,000.00"), matched WHOLE: a substring would let 11,000.00 pass for 1,000.00. */
const amount = (n: number) => new RegExp(`^(SAR\\s)?${money(n).replace(/[.,]/g, (c) => `\\${c}`)}$`);

let api: APIRequestContext;

const json = async <T,>(p: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>, what: string): Promise<T> => {
  const r = await p;
  const text = await r.text();
  if (!r.ok()) throw new Error(`${what} → ${r.status()} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};
/** Count the requests the CLIENT sends — single-flight is a property of the client. */
const countPosts = (page: Page, path: RegExp) => {
  const seen: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && path.test(new URL(r.url()).pathname)) seen.push(r.url()); });
  return seen;
};
const setLang = async (page: Page, lang: "en" | "ar") => {
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
};
const vendor = async (name: string, extra: Record<string, unknown> = {}) =>
  (await json<{ id: number }>(api.post("/api/vendors", { data: { name, ...extra } }), `vendor ${name}`)).id;
const bill = async (vendorId: number, no: string, amount: number) => {
  const b = await json<{ id: number }>(api.post("/api/bills", { data: {
    supplierDocumentKind: "tax_invoice", vendorReference: no, billNumber: no, date: addDays(TODAY, -2), dueDate: addDays(TODAY, 30), vendorId,
    items: [{ description: "Service", quantity: 1, unitPrice: amount, vatRate: 0 }],
  } }), `bill ${no}`);
  await json(api.post(`/api/bills/${b.id}/approve`, { data: {} }), `approve ${no}`);
  return b.id;
};
const plan = async (billId: number, amount: number, extra: Record<string, unknown> = {}) =>
  (await json<{ id: number }>(api.post("/api/treasury/payment-plans", { data: { billId, amount, plannedDate: addDays(TODAY, 5), ...extra } }), "plan")).id;
const relief = async (vendorId: number, paymentType: string, reducedRate: number) =>
  (await json<{ id: number }>(api.post("/api/tax/wht/reliefs", { data: {
    vendorId, paymentType, reducedRate, treatyCountry: "AE", zatcaApprovalReference: `Z-${STAMP}`, residencyCertificateReference: `R-${STAMP}`,
    validFrom: addDays(TODAY, -30), validTo: addDays(TODAY, 300),
  } }), "relief")).id;

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
});
test.afterAll(async () => { await api.dispose(); });

test.describe.serial("Phase 16 + 17 — the gaps closed without a decision", () => {
  test.afterEach(async ({ page }) => {
    // every test leaves the app in English at the desktop width, as the next spec expects
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en")).catch(() => {});
    await page.setViewportSize({ width: DESKTOP, height: 900 });
  });

  test("🔴 QA-15 — the approvals inbox lists a pending relief and a planned payment; a double-click approves with ONE request; revoking asks for its reason inline", async ({ page }) => {
    const nr = await vendor(`E2E Gap Relief ${STAMP}`, { residency: "non_resident", country: "AE", whtDefaultPaymentType: "royalty", foreignTaxId: `AE-G-${STAMP}` });
    const reliefId = await relief(nr, "royalty", 0.1);
    const res = await vendor(`E2E Gap Inbox ${STAMP}`, { residency: "resident" });
    const planId = await plan(await bill(res, `E2E-GAP-IN-${STAMP}`, 4_000), 1_500);

    await page.goto("/approvals");
    await expect(page.getByTestId(`approval-payment-plans-${planId}`)).toContainText(`E2E-GAP-IN-${STAMP}`);
    await expect(page.getByTestId(`approval-payment-plans-${planId}`)).toContainText("1,500.00");
    await expect(page.getByTestId(`approval-wht-reliefs-${reliefId}`)).toContainText(`E2E Gap Relief ${STAMP}`);
    await expect(page.getByTestId(`approval-wht-reliefs-${reliefId}`)).toContainText("Royalty or proceeds");

    const approvals = countPosts(page, /^\/api\/treasury\/payment-plans\/\d+\/approve$/);
    await page.getByTestId(`approval-approve-payment-plans-${planId}`).dblclick();
    await expect(page.getByTestId(`approval-payment-plans-${planId}`)).toHaveCount(0);
    expect(approvals.length, "the client sent ONE approve").toBe(1);
    const plans = await json<Array<{ id: number; status: string }>>(api.get("/api/treasury/payment-plans"), "plans");
    expect(plans.find((p) => p.id === planId)?.status).toBe("approved");

    await page.getByTestId(`approval-reject-wht-reliefs-${reliefId}`).click();
    const confirm = page.getByTestId(`approval-confirm-submit-wht-reliefs-${reliefId}`);
    await expect(confirm, "no reason, no revocation").toBeDisabled();
    await page.getByTestId(`approval-text-wht-reliefs-${reliefId}`).fill("no");
    await expect(confirm, "the record keeps a reason of three characters or more").toBeDisabled();
    await page.getByTestId(`approval-text-wht-reliefs-${reliefId}`).fill("Certificate expired");
    await confirm.click();
    await expect(page.getByTestId(`approval-wht-reliefs-${reliefId}`)).toHaveCount(0);
    const reliefs = await json<Array<{ id: number; status: string }>>(api.get("/api/tax/wht/reliefs"), "reliefs");
    expect(reliefs.find((r) => r.id === reliefId)?.status).toBe("revoked");
  });

  test("🔴 QA-16 — the plans list never scrolls sideways (1280 / 390 px, EN / AR) with a long supplier name and a large amount; the pay form opens inside the viewport", async ({ page }) => {
    const longName = `E2E Gap Very Long Supplier Name Trading and Contracting Establishment ${STAMP}`;
    const v = await vendor(longName, { residency: "resident" });
    const planId = await plan(await bill(v, `E2E-GAP-WIDE-${STAMP}`, 123_456_789.12), 123_456_789.12);
    await json(api.post(`/api/treasury/payment-plans/${planId}/approve`, { data: {} }), "approve");
    await page.goto("/treasury?tab=plans");
    for (const [lang, viewport] of [["en", null], ["en", PHONE], ["ar", null], ["ar", PHONE]] as const) {
      const width = viewport?.width ?? DESKTOP;
      await page.setViewportSize(viewport ?? { width: DESKTOP, height: 900 });
      await setLang(page, lang);
      const row = page.getByTestId(`treasury-plan-${planId}`);
      await expect(row).toContainText(longName);
      await expect(row).toContainText("123,456,789.12");
      const page_ = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(page_, `${lang} ${width}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
      // the list — and every box around it up to the page — scrolls nothing sideways (the old table sat in an
      // overflow-x box that scrolled while the page itself did not, which a page-level check cannot see)
      const scrolling = await page.getByTestId("treasury-plans").evaluate((el) => {
        const out: string[] = [];
        for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
          if (n.scrollWidth > n.clientWidth + 1) out.push(`${n.tagName.toLowerCase()}${n.getAttribute("data-testid") ? `[${n.getAttribute("data-testid")}]` : ""}: ${n.scrollWidth} > ${n.clientWidth}`);
        }
        return out;
      });
      expect(scrolling, `${lang} ${width}: nothing around the plans scrolls sideways`).toEqual([]);
      await page.getByTestId(`treasury-plan-pay-${planId}`).click();
      const form = await page.getByTestId(`treasury-plan-pay-form-${planId}`).boundingBox();
      expect(form, "the pay form is rendered").not.toBeNull();
      expect(form!.x, `${lang} ${width}: the form starts inside the viewport`).toBeGreaterThanOrEqual(-1);
      expect(form!.x + form!.width, `${lang} ${width}: the form ends inside the viewport`).toBeLessThanOrEqual(width + 1);
      await page.getByTestId(`treasury-plan-pay-${planId}`).click(); // close it again
    }
    await json(api.post(`/api/treasury/payment-plans/${planId}/reject`, { data: { reason: "e2e layout probe" } }), "cancel the probe plan");
  });

  test("🔴 QA-16 — the plan pay form shows the server's WHT preview, and the payment withholds exactly what it showed — the nature changed at payment governs", async ({ page }) => {
    const nr = await vendor(`E2E Gap Plan WHT ${STAMP}`, { residency: "non_resident", country: "AE", whtDefaultPaymentType: "technical_consulting", foreignTaxId: `AE-P-${STAMP}` });
    const billId = await bill(nr, `E2E-GAP-PW-${STAMP}`, 20_000);
    const planId = await plan(billId, 20_000, { whtPaymentType: "royalty" }); // the plan's nature: royalty (15 %)
    await json(api.post(`/api/treasury/payment-plans/${planId}/approve`, { data: {} }), "approve");
    await page.goto("/treasury?tab=plans");
    await page.getByTestId(`treasury-plan-pay-${planId}`).click();
    const form = page.getByTestId(`treasury-plan-pay-form-${planId}`);
    await expect(form.getByTestId("wht-fields")).toBeVisible();
    // the plan's own nature preselected → the server's preview: 15 % of 20,000
    await expect(form.getByTestId("wht-preview-withheld")).toHaveText(amount(3_000));
    await expect(form.getByTestId("wht-preview-cash")).toHaveText(amount(17_000));
    await expect(form.getByTestId("wht-preview-legal")).toContainText("Income Tax IR Art. 63(1)");
    // declared otherwise at payment → the preview follows, and so must the payment
    await form.getByTestId("wht-nature").click();
    // rent (5 %) — a Form 06 row no other spec's withholding this month shares, so their line totals stay theirs
    await page.getByRole("option", { name: "Rent", exact: true }).click();
    await expect(form.getByTestId("wht-preview-withheld")).toHaveText(amount(1_000));
    await form.getByTestId("treasury-plan-pay-bank").click();
    await page.getByRole("option").first().click();
    await form.getByTestId("treasury-plan-pay-submit").click();
    await expect(page.getByTestId(`treasury-plan-status-${planId}`)).toContainText("Paid");
    const ret = await json<{ schedule: Array<{ billId: number | null; whtAmount: number }> }>(api.get(`/api/tax/wht/returns/${PERIOD}`), "return");
    expect(ret.schedule.filter((r) => r.billId === billId).map((r) => r.whtAmount), "withheld = what the screen showed").toEqual([1_000]);
  });

  test("🔴 QA-16 — an obligations row opens ITS period; back and forward keep it; a direct URL opens a month with nothing withheld; Arabic links carry the same scope", async ({ page }) => {
    // this month's withholding, unremitted — an obligations row for PERIOD (a rent payment: its own Form 06 row)
    const { bankId } = JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds;
    const rent = await vendor(`E2E Gap Landlord ${STAMP}`, { residency: "non_resident", country: "AE", whtDefaultPaymentType: "rent", foreignTaxId: `AE-L-${STAMP}` });
    const rentBill = await bill(rent, `E2E-GAP-RENT-${STAMP}`, 2_000);
    await json(api.post(`/api/bills/${rentBill}/pay`, { data: { amount: 2_000, paidAt: TODAY, bankAccountId: bankId } }), "pay the rent (withholds 100)");
    await page.goto("/tax/obligations");
    const whtLink = page.locator(`[data-testid^="tax-obligation-wht-"]`).filter({ hasText: PERIOD }).locator(`[data-testid^="tax-obligation-link-wht-"]`);
    await expect(whtLink).toHaveAttribute("href", `/tax/withholding?tab=return&period=${PERIOD}`);
    await whtLink.click();
    await expect(page).toHaveURL(new RegExp(`period=${PERIOD}`));
    await expect(page.getByTestId("wht-return-period")).toContainText(PERIOD);
    await page.goBack();
    await expect(page.getByTestId("tax-obligations-page")).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId("wht-return-period"), "forward lands on the same month").toContainText(PERIOD);
    // an undeclared VAT period has nothing to scope — its row links to the return page itself …
    await page.goto("/tax/obligations");
    const vatLinks = page.locator(`[data-testid^="tax-obligation-link-vat-"]`);
    const before = await json<{ vatTaxPeriod: string | null }>(api.get("/api/companies/current"), "company");
    if (before.vatTaxPeriod == null) await expect(vatLinks.first()).toHaveAttribute("href", "/vat");
    // … a declared one opens the return for ITS period (the last completed quarter, and the current one to date)
    await json(api.patch("/api/companies/current", { data: { vatTaxPeriod: "quarterly" } }), "declare quarterly VAT");
    try {
      await page.goto("/tax/obligations");
      const q = Math.floor((Number(TODAY.slice(5, 7)) - 1) / 3);           // this quarter, 0-based
      const y = Number(TODAY.slice(0, 4));
      const [ly, lq] = q === 0 ? [y - 1, 3] : [y, q - 1];                   // the last completed one
      const from = `${ly}-${String(lq * 3 + 1).padStart(2, "0")}`, to = `${ly}-${String(lq * 3 + 3).padStart(2, "0")}`;
      const lastQuarter = page.locator(`[data-testid^="tax-obligation-link-vat-"][href="/vat?from=${from}&to=${to}"]`);
      await expect(lastQuarter, "the last completed quarter's row links to that quarter").toHaveCount(1);
      await lastQuarter.click();
      await expect(page).toHaveURL(new RegExp(`/vat\\?from=${from}&to=${to}$`));
      await expect(page.getByTestId("vat-period-from")).toHaveValue(from);
      await expect(page.getByTestId("vat-period-to")).toHaveValue(to);
      await page.reload();
      await expect(page.getByTestId("vat-period-from"), "a reload keeps the period").toHaveValue(from);
      await page.goBack();
      await expect(page.getByTestId("tax-obligations-page"), "back returns to the calendar").toBeVisible();
    } finally {
      await json(api.patch("/api/companies/current", { data: { vatTaxPeriod: before.vatTaxPeriod } }), "restore the VAT period");
    }
    // a direct URL to a month with nothing withheld still opens THAT month
    await page.goto("/tax/withholding?tab=return&period=2020-01");
    await expect(page.getByTestId("wht-return-period")).toContainText("2020-01");
    // Arabic: the same scope on the same link
    await page.goto("/tax/obligations");
    await setLang(page, "ar");
    await expect(page.locator(`[data-testid^="tax-obligation-wht-"]`).filter({ hasText: PERIOD }).locator(`[data-testid^="tax-obligation-link-wht-"]`)).toHaveAttribute("href", `/tax/withholding?tab=return&period=${PERIOD}`);
  });

  test("🔴 QA-04 — the classification page shows each account's balance at the chosen date — the balance sheet's own figure — and keeps its scope in the URL", async ({ page }) => {
    const bs = await json<{ assets: { items: Array<{ key: string; amount: number }> } }>(api.get(`/api/reports/balance-sheet?as_of=${TODAY}`), "balance sheet");
    const item = bs.assets.items.find((i) => /^\d+$/.test(i.key) && Math.round(i.amount * 100) !== 0);
    expect(item, "the e2e tenant carries a balance-sheet asset today").toBeTruthy();
    await page.goto(`/zakat/classification?asOf=${TODAY}&filter=all`);
    await expect(page.getByTestId("zakat-class-table")).toContainText("Balance at");
    await expect(page.getByTestId(`zakat-class-balance-${item!.key}`).locator("span").first(), "the balance sheet's own figure — one reading").toHaveText(amount(item!.amount));
    await page.getByTestId("zakat-class-filter").click();
    await page.getByRole("option", { name: "Not classified — blocking a computation at this date" }).click();
    await expect(page).toHaveURL(/filter=blocking/);
    await page.reload();
    await expect(page.getByTestId("zakat-class-filter"), "a reload keeps the filter").toContainText("Not classified — blocking a computation at this date");
    const rows = page.locator(`[data-testid^="zakat-class-row-"]`);
    const n = await rows.count();
    for (let i = 0; i < n; i++) await expect(rows.nth(i).locator(`[data-testid^="zakat-class-blocks-"]`), "every row shown blocks").toHaveCount(1);
    for (const viewport of [PHONE, null]) {
      await page.setViewportSize(viewport ?? { width: DESKTOP, height: 900 });
      await setLang(page, "ar");
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(w, "no sideways page scroll").toBeLessThanOrEqual((viewport?.width ?? DESKTOP) + 1);
    }
  });

  test("🔴 QA-16 — legal references read in Arabic (the regulation by its Arabic title); the citation stays on the element verbatim", async ({ page }) => {
    await page.goto("/tax/withholding?tab=rates");
    await setLang(page, "ar");
    const rates = page.getByTestId("wht-rates");
    await expect(rates).toContainText("اللائحة التنفيذية لنظام ضريبة الدخل");
    await expect(rates).not.toContainText("Income Tax IR");
    await expect(rates.locator(`[title^="Income Tax IR Art. 63"]`).first(), "the original citation is kept").toBeAttached();
  });

  test("Q-d — a relief at the statutory rate is flagged before it is recorded; above it, the refusal is said in advance", async ({ page }) => {
    await page.goto("/tax/withholding?tab=reliefs");
    await page.getByTestId("wht-relief-type").click();
    await page.getByRole("option", { name: "Royalty or proceeds" }).click();
    await expect(page.getByTestId("wht-relief-statutory")).toContainText("15.00%");
    const rate = page.getByTestId("wht-relief-rate");
    await rate.fill("0.15");
    await expect(page.getByTestId("wht-relief-equals-statutory")).toBeVisible();
    await rate.fill("0.2");
    await expect(page.getByTestId("wht-relief-above-statutory")).toBeVisible();
    await rate.fill("0.1");
    await expect(page.getByTestId("wht-relief-equals-statutory")).toHaveCount(0);
    await expect(page.getByTestId("wht-relief-above-statutory")).toHaveCount(0);
  });

  test("Q-e — an income-tax computation of a company declared Saudi stays LISTED (it was invisible); starting one is not offered there", async ({ page }) => {
    const c = await json<{ ownershipType: string | null; fiscalYearStart: number | null; fiscalCalendar: string | null }>(api.get("/api/companies/current"), "company");
    await json(api.patch("/api/companies/current", { data: { ownershipType: "SAUDI_GCC", fiscalYearStart: 1, fiscalCalendar: "gregorian" } }), "declare");
    let id = 0;
    try {
      id = (await json<{ id: number }>(api.post("/api/tax/computations", { data: { kind: "income_tax", fiscalYearLabel: 2024 } }), "an API-made income-tax computation")).id;
      await page.goto("/tax/income-tax");
      await expect(page.getByTestId("income-tax-scope-not-applicable")).toBeVisible();
      await expect(page.getByTestId(`tax-computation-row-${id}`), "the record is visible and can be opened").toBeVisible();
      await expect(page.getByTestId("tax-computation-not-offered")).toBeVisible();
      await expect(page.getByTestId("tax-computation-create")).toHaveCount(0);
    } finally {
      if (id) await json(api.delete(`/api/tax/computations/${id}`), "remove the probe computation");
      await json(api.patch("/api/companies/current", { data: { ownershipType: c.ownershipType, fiscalYearStart: c.fiscalYearStart, fiscalCalendar: c.fiscalCalendar ?? "gregorian" } }), "restore");
    }
  });
});
