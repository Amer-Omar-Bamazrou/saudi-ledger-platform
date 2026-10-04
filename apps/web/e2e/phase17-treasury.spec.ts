/**
 * PHASE 17 — TREASURY, WALKED BY CLICKING (2026-10-04).
 * Record: docs/product/phase-16-17-tax-treasury-decision-pack.md §8.
 *
 * What only a browser can show:
 *   · the cash POSITION on the page is the ledger: Σ banks + unattributed =
 *     the total, the reconciliation line says it equals the balance sheet, and
 *     money in transit sits BESIDE the total, never in it;
 *   · a payment plan is created, approved and PAID by clicking — the bill's
 *     ordinary pay path (the bill now owes less; the plan reads Paid);
 *   · a manual assumption appears in the forecast as a MANUAL row, and is
 *     deleted (two clicks — an administrator's act);
 *   · the minimum buffer moves the funding requirement, and the recommendation
 *     is words — nothing is booked;
 *   · nav deep links (`?tab=`) open the tab they name;
 *   · Arabic under dir=rtl and a 390 px phone, with no sideways scroll.
 *
 * Every figure is read off the page and compared with the API's own — the
 * page never computes one.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { businessToday } from "@workspace/shared";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };
const DESKTOP = 1280;
const TODAY = businessToday();
const STAMP = Date.now();
const num = (s: string) => Number(s.replace(/[^0-9.-]/g, ""));
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let api: APIRequestContext;
let billId = 0, planId = 0;
let originalSettings: { minimumCashBalance: number | null; forecastHorizonWeeks: number } = { minimumCashBalance: null, forecastHorizonWeeks: 13 };

const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};
const json = async <T,>(p: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>, what: string): Promise<T> => {
  const r = await p;
  const text = await r.text();
  if (!r.ok()) throw new Error(`${what} → ${r.status()} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  originalSettings = await json(api.get("/api/treasury/settings"), "settings");
  // a resident supplier's approved bill, so the plan walk has something to plan (WHT is Phase 16's walk)
  const v = await json<{ id: number }>(api.post("/api/vendors", { data: { name: `E2E Treasury Supplier ${STAMP}`, residency: "resident" } }), "vendor");
  const b = await json<{ id: number }>(api.post("/api/bills", { data: {
    supplierDocumentKind: "tax_invoice", vendorReference: `TRS-${STAMP}`, billNumber: `E2E-TRS-${STAMP}`, date: TODAY, dueDate: addDays(TODAY, 30), vendorId: v.id,
    items: [{ description: "Office supplies", quantity: 1, unitPrice: 2500, vatRate: 0 }],
  } }), "bill");
  await json(api.post(`/api/bills/${b.id}/approve`, { data: {} }), "approve bill");
  billId = b.id;
});
test.afterAll(async () => {
  await api.put("/api/treasury/settings", { data: originalSettings });
  await api.dispose();
});

test.describe.serial("Phase 17 — treasury, end to end", () => {
  test("🔴 the POSITION on the page is the ledger: Σ banks + unattributed = the total = the API's, it reconciles to the balance sheet, and in-transit is BESIDE it", async ({ page }) => {
    const pos = await json<{ banks: { bankAccountId: number; ledgerBalance: number }[]; unattributedCash: number; totalCash: number; inTransit: number; reconciliation: { reconciles: boolean } }>(api.get("/api/treasury/position"), "position");
    await page.goto("/treasury");
    await expect(page.getByTestId("treasury-page")).toBeVisible();
    const total = num(await page.getByTestId("treasury-total-cash").innerText());
    expect(total).toBe(pos.totalCash);
    let sumH = Math.round(pos.unattributedCash * 100);
    for (const b of pos.banks) {
      const shown = num(await page.getByTestId(`treasury-bank-balance-${b.bankAccountId}`).innerText());
      expect(shown).toBe(b.ledgerBalance);
      sumH += Math.round(shown * 100);
    }
    expect(sumH / 100, "Σ banks + unattributed = the total, to the halala").toBe(total);
    expect(pos.reconciliation.reconciles).toBe(true);
    await expect(page.getByTestId("treasury-reconciles")).toBeVisible();
    expect(num(await page.getByTestId("treasury-in-transit").innerText())).toBe(pos.inTransit);
    await expect(page.getByTestId("treasury-chart").first()).toBeVisible();
  });

  test("🔴 a PLAN by clicking: create for the bill, approve, pay — the bill's ordinary pay path; the plan reads Paid and the bill owes nothing", async ({ page }) => {
    await page.goto("/treasury?tab=plans");
    // before any plan exists the list is its empty state, not an empty table (an empty block prints its emptiness)
    await expect(page.getByTestId("treasury-plans").or(page.getByTestId("treasury-plans-empty"))).toBeVisible();
    await page.getByTestId("treasury-plan-create").click();
    await page.getByTestId("treasury-plan-bill").click();
    await page.getByRole("option", { name: new RegExp(`E2E-TRS-${STAMP}`) }).click();
    await page.getByTestId("treasury-plan-amount").fill("2500");
    await page.getByTestId("treasury-plan-date").fill(addDays(TODAY, 3));
    await page.getByTestId("treasury-plan-submit").click();
    await expect.poll(async () => {
      const plans = await json<Array<{ id: number; billId: number; status: string }>>(api.get("/api/treasury/payment-plans"), "plans");
      planId = plans.find((p) => p.billId === billId)?.id ?? 0;
      return planId;
    }).toBeGreaterThan(0);
    await expect(page.getByTestId(`treasury-plan-status-${planId}`)).toContainText("Planned");
    await page.getByTestId(`treasury-plan-approve-${planId}`).click();
    await expect(page.getByTestId(`treasury-plan-status-${planId}`)).toContainText("Approved");
    await page.getByTestId(`treasury-plan-pay-${planId}`).click();
    const bank = page.getByTestId("treasury-plan-pay-bank");
    await bank.click();
    await page.getByRole("option").first().click();
    await page.getByTestId("treasury-plan-pay-submit").click();
    await expect(page.getByTestId(`treasury-plan-status-${planId}`)).toContainText("Paid");
    const bill = await json<{ outstanding?: number | string; status: string }>(api.get(`/api/bills/${billId}`), "bill");
    expect(Number(bill.outstanding ?? 0)).toBe(0);
  });

  test("🔴 a MANUAL assumption appears in the forecast as a manual row; deleting it takes two clicks", async ({ page }) => {
    await page.goto("/treasury?tab=assumptions");
    // before the first assumption the list is its empty state, not an empty table
    await expect(page.getByTestId("treasury-assumption-form")).toBeVisible();
    const desc = `E2E shareholder loan ${STAMP}`;
    await page.getByTestId("treasury-assumption-date").fill(addDays(TODAY, 10));
    await page.getByTestId("treasury-assumption-direction").click();
    await page.getByRole("option", { name: /Inflow/ }).click();
    await page.getByTestId("treasury-assumption-amount").fill("12345.67");
    await page.getByTestId("treasury-assumption-description").fill(desc);
    await page.getByTestId("treasury-assumption-submit").click();
    await expect(page.getByTestId("treasury-assumptions")).toContainText(desc);
    await page.goto("/treasury?tab=forecast");
    await expect(page.getByTestId("treasury-rows")).toContainText(desc);
    await expect(page.getByTestId("treasury-rows")).toContainText("12,345.67");
    const list = await json<Array<{ id: number; description: string }>>(api.get("/api/treasury/assumptions"), "assumptions");
    const id = list.find((a) => a.description === desc)!.id;
    await page.goto("/treasury?tab=assumptions");
    await page.getByTestId(`treasury-assumption-delete-${id}`).click();
    await page.getByTestId(`treasury-assumption-delete-confirm-${id}`).click();
    await expect(page.getByTestId(`treasury-assumption-${id}`)).toHaveCount(0);
  });

  test("🔴 the BUFFER moves the funding requirement; the recommendation is words, and nothing is booked", async ({ page }) => {
    const entriesBefore = (await json<{ items?: unknown[]; page?: { total: number } } | unknown[]>(api.get("/api/journal-entries?limit=1"), "entries"));
    await page.goto("/treasury?tab=settings");
    await page.getByTestId("treasury-settings-minimum").fill("999999999");
    await page.getByTestId("treasury-settings-save").click();
    await expect.poll(async () => (await json<{ minimumCashBalance: number | null }>(api.get("/api/treasury/settings"), "settings")).minimumCashBalance).toBe(999_999_999);
    await page.goto("/treasury");
    const f = await json<{ funding: { requirement: number } }>(api.get("/api/treasury/forecast"), "forecast");
    expect(f.funding.requirement).toBeGreaterThan(0);
    expect(num(await page.getByTestId("treasury-funding-requirement").innerText())).toBe(f.funding.requirement);
    await expect(page.getByTestId("treasury-recommendation")).toContainText("not a financing transaction");
    const entriesAfter = (await json<{ items?: unknown[]; page?: { total: number } } | unknown[]>(api.get("/api/journal-entries?limit=1"), "entries"));
    expect(JSON.stringify(entriesAfter), "a funding requirement books nothing").toBe(JSON.stringify(entriesBefore));
  });

  test("🔴 nav deep links open the tab they name", async ({ page }) => {
    for (const [tab, testId] of [["forecast", "treasury-buckets"], ["plans", "treasury-plan-create"], ["assumptions", "treasury-assumption-form"], ["settings", "treasury-settings-save"]] as const) {
      await page.goto(`/treasury?tab=${tab}`);
      await expect(page.getByTestId(testId), tab).toBeVisible();
    }
  });

  test("🔴 treasury in Arabic (dir=rtl, the Arabic heading ASSERTED) and English, desktop and a 390 px phone — no sideways scroll", async ({ page }) => {
    test.setTimeout(180_000); // five tabs × four views, each loaded and reloaded
    for (const tab of ["overview", "forecast", "plans", "assumptions", "settings"]) {
      for (const [lang, viewport, label] of [["en", null, "EN desktop"], ["en", PHONE, "EN phone"], ["ar", null, "AR desktop"], ["ar", PHONE, "AR phone"]] as [string, typeof PHONE | null, string][]) {
        await page.setViewportSize(viewport ?? { width: DESKTOP, height: 900 });
        await page.goto(`/treasury?tab=${tab}`);
        await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
        await page.reload();
        await expect(page.locator("html"), `${tab} ${label}`).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
        await expect(page.getByTestId("treasury-page"), `${tab} ${label}`).toBeVisible();
        if (lang === "ar") await expect(page.getByRole("heading", { name: /الخزينة/ }).first(), `${tab} ${label} heading`).toBeVisible();
        await noSidewaysScroll(page, viewport?.width ?? DESKTOP, `/treasury?tab=${tab} ${label}`);
      }
    }
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
  });
});
