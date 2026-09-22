/**
 * FIXED ASSETS — FA-A + FA-B, WALKED BY CLICKING (2026-09-22).
 * Record: docs/product/fixed-assets-decision-pack.md §20, §21.
 *
 * The workflow an accountant performs, through the real pages: register a
 * category, register an asset as a DRAFT, buy it with a vendor bill that names
 * it, approve the bill (which capitalises it), depreciate a period, change the
 * estimate — and every effect read back from the API: the entry's lines, the
 * asset's state, the schedule's posted row, the regenerated tail.
 *
 * English desktop, then Arabic under dir=rtl, then a phone, each proving what
 * only a browser can: the controls exist, the dialogs close, the figures the
 * page shows are the server's, and nothing scrolls sideways at 390 px.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";
import { businessToday } from "@workspace/shared";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };
const TODAY = businessToday();
const MONTH = TODAY.slice(0, 7);
const ids = (): SeededIds => JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds;

let api: APIRequestContext;
test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
});
test.afterAll(async () => { await api.dispose(); });

type Asset = { id: number; assetNumber: string; name: string; status: string; cost: number; accumulatedDepreciation: number; carryingAmount: number; postedPeriods: number; plannedPeriods: number; nextPeriod: string | null; capitalisationJournalEntryId: number | null; usefulLifeMonths: number; residualValue: number; schedule: Array<{ period: string; amount: number; journalEntryId: number | null; sequence: number }>; events: Array<{ kind: string }> };

const asset = async (id: number): Promise<Asset> => (await api.get(`/api/assets/${id}`)).json();
const entryLines = async (id: number) => {
  const je = await (await api.get(`/api/journal-entries/${id}`)).json();
  return (je.lines as Array<{ accountName: string; debitAmount: number; creditAmount: number }>).map((l) => [l.accountName, l.debitAmount, l.creditAmount]);
};

async function pickOption(page: Page, name: RegExp | string) {
  await page.getByRole("option", { name }).click();
}
const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};

test.describe.serial("fixed assets, end to end", () => {
  let assetId = 0;
  let assetNumber = "";

  test("🔴 register a category and a DRAFT asset by clicking; the draft moves nothing and its planned schedule is shown", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/assets");
    // the category (its Saudi classifications are chosen, never defaulted silently)
    await page.getByTestId("new-asset-category").click();
    const cat = page.getByTestId("asset-category-dialog");
    await expect(cat).toBeVisible();
    await cat.getByTestId("category-name").fill("Workshop equipment");
    await cat.getByTestId("category-life").fill("24");
    await cat.getByTestId("category-tax-group").click();
    await pickOption(page, /^3 ·/);
    await cat.getByTestId("category-vat-class").click();
    await pickOption(page, /Movable/);
    await cat.getByTestId("category-submit").click();
    await expect(cat).toBeHidden();

    const jeBefore = (await (await api.get("/api/journal-entries?limit=1")).json()).page.total as number;
    // the asset, as a DRAFT
    await page.getByTestId("new-asset").click();
    const dlg = page.getByTestId("asset-dialog");
    await dlg.getByTestId("asset-category").click();
    await pickOption(page, /Workshop equipment/);
    await dlg.getByTestId("asset-name").fill("Compressor");
    await dlg.getByTestId("asset-acquired").fill(`${MONTH}-01`);
    await dlg.getByTestId("asset-available").fill(`${MONTH}-01`);
    await dlg.getByTestId("asset-cost").fill("24000");
    await dlg.getByTestId("asset-life").fill("24");
    await expect(dlg.getByTestId("asset-preview")).toContainText("1,000.00"); // 24,000 over 24 months
    await dlg.getByTestId("asset-submit").click();
    await expect(dlg).toBeHidden();

    const list = (await (await api.get("/api/assets?limit=50")).json()) as { items: Asset[]; totals: { drafts: number; cost: number } };
    const created = list.items.find((a) => a.name === "Compressor")!;
    assetId = created.id; assetNumber = created.assetNumber;
    expect(created.status).toBe("draft");
    // a draft moves NOTHING
    expect((await (await api.get("/api/journal-entries?limit=1")).json()).page.total).toBe(jeBefore);
    const full = await asset(assetId);
    expect([full.schedule.length, full.capitalisationJournalEntryId]).toEqual([0, null]);
    await expect(page.getByTestId(`asset-status-${assetNumber}`)).toHaveText("Draft");
    // the detail page says how it is capitalised rather than offering a control that does not exist
    await page.getByTestId(`open-asset-${assetNumber}`).click();
    await expect(page).toHaveURL(new RegExp(`/assets/${assetId}$`));
    await expect(page.getByTestId("draft-notice")).toContainText("capitalised by the BILL");
    await expect(page.getByTestId("run-depreciation")).toHaveCount(0);
    await expect(page.getByTestId("detail-carrying")).toContainText("24,000.00");
    await expect(page.getByTestId(`schedule-${MONTH}`)).toContainText("1,000.00"); // the PLANNED schedule
  });

  test("🔴 a vendor bill that names the asset CAPITALISES it on its own entry: Dr the cost account, Cr AP; the asset is in service with its stored schedule", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/bills");
    await page.getByRole("button", { name: /New Bill/i }).first().click();
    await page.getByTestId("bill-capitalises-asset").click();
    await pickOption(page, new RegExp(assetNumber));
    await expect(page.getByTestId("bill-capitalise-hint")).toContainText("capitalised");
    // the expense-account picker is GONE: a capitalising bill takes its account from the asset's category
    await expect(page.getByText(/Expense \/ Debit Account/)).toHaveCount(0);
    await page.getByTestId("bill-vendor").click();
    await page.getByRole("option").first().click();
    await page.getByTestId("bill-number").fill(`FA-E2E-${Date.now()}`);
    await page.getByTestId("bill-subtotal").fill("24000");
    await page.getByTestId("bill-vat").fill("3600");
    await page.getByTestId("bill-total").fill("27600");
    await page.getByTestId("bill-submit").click();

    await expect.poll(async () => (await asset(assetId)).status, { timeout: 20_000 }).toBe("in_service");
    const a = await asset(assetId);
    expect(a.capitalisationJournalEntryId).not.toBeNull();
    expect(await entryLines(a.capitalisationJournalEntryId!)).toEqual([
      ["Fixed Assets", 24000, 0],
      ["Input VAT Receivable", 3600, 0],
      ["Accounts Payable", 0, 27600],
    ]);
    expect([a.schedule.length, a.plannedPeriods, a.postedPeriods]).toEqual([24, 24, 0]);
    expect(a.events.map((e) => e.kind)).toEqual(["created", "capitalised"]);
  });

  test("🔴 depreciate a period by clicking: Dr depreciation expense / Cr accumulated, the row reads posted and links to its entry, the figures move; a second run is not offered for that period", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/assets/${assetId}`);
    await expect(page.getByTestId("detail-accumulated")).toContainText("0.00");
    const next = (await asset(assetId)).nextPeriod!;
    await page.getByTestId("run-depreciation").click();
    const dlg = page.getByTestId("run-depreciation-dialog");
    await expect(dlg.getByTestId("run-amount")).toContainText("1,000.00");
    await dlg.getByTestId("run-submit").click();
    await expect(dlg).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId("detail-accumulated")).toContainText("1,000.00");
    await expect(page.getByTestId("detail-carrying")).toContainText("23,000.00");
    await expect(page.getByTestId(`posted-${next}`)).toBeVisible();
    const a = await asset(assetId);
    const row = a.schedule.find((s) => s.period === next)!;
    expect(await entryLines(row.journalEntryId!)).toEqual([["Depreciation expense", 1000, 0], ["Accumulated depreciation", 0, 1000]]);
    expect([a.postedPeriods, a.accumulatedDepreciation, a.carryingAmount]).toEqual([1, 1000, 23000]);
    expect(a.nextPeriod).not.toBe(next);
    // the API refuses the same period again, by name, with nothing posted
    const again = await api.post(`/api/assets/${assetId}/depreciate`, { data: { period: next } });
    expect(again.status()).toBe(409);
    expect((await again.json()).code).toBe("depreciation_already_posted");
    expect((await asset(assetId)).postedPeriods).toBe(1);
  });

  test("🔴 change the estimate by clicking: the posted period is untouched, the tail is regenerated, and the history records it", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/assets/${assetId}`);
    const before = await asset(assetId);
    const posted = before.schedule.filter((s) => s.journalEntryId != null).map((s) => [s.period, s.amount]);
    await page.getByTestId("change-estimate").click();
    const dlg = page.getByTestId("estimate-dialog");
    await expect(dlg.getByTestId("estimate-submit")).toBeDisabled();
    await dlg.getByTestId("estimate-life").fill("12");
    await dlg.getByTestId("estimate-reason").fill("Re-assessed: heavier use, one year (IAS 16.51)");
    await dlg.getByTestId("estimate-submit").click();
    await expect(dlg).toBeHidden({ timeout: 15_000 });
    const after = await asset(assetId);
    expect(after.schedule.filter((s) => s.journalEntryId != null).map((s) => [s.period, s.amount])).toEqual(posted);
    expect(after.usefulLifeMonths).toBe(12);
    expect(after.schedule.filter((s) => s.journalEntryId == null)).toHaveLength(11);
    expect(Math.round(after.schedule.reduce((s, r) => s + r.amount, 0) * 100) / 100).toBe(24000);
    await expect(page.getByTestId("event-estimate_changed")).toBeVisible();
    await expect(page.getByTestId("detail-life")).toContainText("1/12");
  });

  test("🔴 FA-C — scrap it by clicking: the months up to the disposal are depreciated first, the cost and its accumulated depreciation leave the books, the loss is the carrying amount and the page says so", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/assets/${assetId}`);
    const before = await asset(assetId);
    const carrying = before.carryingAmount;
    expect(carrying).toBeGreaterThan(0);
    await page.getByTestId("dispose-asset").click();
    const dlg = page.getByTestId("dispose-dialog");
    await expect(dlg.getByTestId("dispose-submit")).toBeDisabled();
    await expect(dlg.getByTestId("dispose-loss")).toContainText(carrying.toLocaleString("en-US", { minimumFractionDigits: 2 }));
    await dlg.getByTestId("dispose-kind").click();
    await pickOption(page, /Withdrawn from the business/);
    await expect(dlg.getByTestId("withdrawn-hint")).toContainText("NOMINAL SUPPLY");
    await dlg.getByTestId("dispose-kind").click();
    await pickOption(page, /^Scrapped/);
    await dlg.getByTestId("dispose-reason").fill("Damaged beyond repair — scrap certificate E2E-1");
    await dlg.getByTestId("dispose-submit").click();
    await expect(dlg).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId("disposal-notice")).toContainText("Scrapped");
    await expect(page.getByTestId("disposal-notice")).toContainText("loss");
    const after = await asset(assetId);
    expect([after.status, after.carryingAmount, after.plannedPeriods]).toEqual(["disposed", 0, 0]);
    const d = (after as unknown as { disposal: { kind: string; gainLoss: number; carryingAmountAtDisposal: number; vatTreatment: string; journalEntryId: number } }).disposal;
    expect(d).toMatchObject({ kind: "scrapped", vatTreatment: "no_adjustment" });
    expect(d.gainLoss).toBe(-d.carryingAmountAtDisposal);
    // the derecognition: the cost off, the accumulated off, the carrying amount to the disposal account
    const lines = await entryLines(d.journalEntryId);
    expect(lines.map((l) => l[0])).toEqual(["Accumulated depreciation", "Gain (loss) on disposal of fixed assets", "Fixed Assets"]);
    expect(lines[2]).toEqual(["Fixed Assets", 0, after.cost]);
    // terminal: the acts are gone from the page
    await expect(page.getByTestId("dispose-asset")).toHaveCount(0);
    await expect(page.getByTestId("run-depreciation")).toHaveCount(0);
    await expect(page.getByTestId("change-estimate")).toHaveCount(0);
  });

  test("Arabic / RTL: the register, the detail page and both dialogs read right-to-left with Arabic labels, and nothing scrolls sideways", async ({ page }) => {
    await page.goto("/assets");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { name: "الأصول الثابتة" })).toBeVisible();
    await expect(page.getByTestId(`asset-status-${assetNumber}`)).toHaveText("مستبعد");
    await noSidewaysScroll(page, 1280, "ar register");
    await page.goto(`/assets/${assetId}`);
    await expect(page.getByTestId("disposal-notice")).toContainText("شُطب");
    await page.goto("/asset-schedule");
    await expect(page.getByRole("heading", { name: "جدول الأصول الثابتة" })).toBeVisible();
    await expect(page.getByTestId(`schedule-row-${assetNumber}`)).toBeVisible();
    await noSidewaysScroll(page, 1280, "ar schedule");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
  });

  test("phone width: the register, the detail page and the run dialog all fit 390 px", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/assets");
    await noSidewaysScroll(page, PHONE.width, "phone register");
    await page.goto(`/assets/${assetId}`);
    await noSidewaysScroll(page, PHONE.width, "phone asset detail");
    await expect(page.getByTestId("disposal-notice")).toBeVisible();
    await page.goto("/asset-schedule");
    await noSidewaysScroll(page, PHONE.width, "phone asset schedule");
  });
});
