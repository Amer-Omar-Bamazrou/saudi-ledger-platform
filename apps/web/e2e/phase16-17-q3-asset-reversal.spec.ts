/**
 * Q3 — A MIGRATED FIXED ASSET IS REVERSED WITH ITS BATCH, BY CLICKING (2026-10-05).
 * Record: docs/product/phase-16-17-tax-treasury-decision-pack.md §14.3 (accountant Q3, Option A).
 *
 * The tenant (`E2E_ANSWERS`, identity + a bank + an asset category from global-setup) is the accountant-answers specs' own. The
 * migration is committed and its first month depreciated through the API; then, in the browser:
 *   · the commit page's reversal preview names the asset and the depreciation it will unwind;
 *   · Reverse is CLICKED — the batch reads reversed;
 *   · the register shows the asset "Reversed with its migration"; its page says it was NOT disposed of, offers
 *     no act (no depreciation, no estimate change, no disposal), and its carrying amount reads 0;
 *   · a replacement migration (API) names it, and the lineage is FOLLOWED by clicking, both ways;
 *   · the reversed page in Arabic, right to left.
 */
import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import { E2E_ANSWERS } from "./global-setup";

test.use({ storageState: E2E_ANSWERS.adminState });

let api: APIRequestContext;
let batchId = 0, assetId = 0, replacementAssetId = 0;

const json = async <T,>(p: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>, what: string): Promise<T> => {
  const r = await p;
  const text = await r.text();
  if (!r.ok()) throw new Error(`${what} → ${r.status()} ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};
const list = <T,>(v: T[] | { items: T[] }) => (Array.isArray(v) ? v : v.items);

/** Bank 5,000 + a lathe (cost 30,000, accumulated 6,000 — 24 of 48 periods) against retained earnings, as at 2026-06-30. */
const migrate = async () => {
  const b = await json<{ id: number }>(api.post("/api/migration/batches", { data: { sourceSystem: "E2E Previous ERP", cutoverDate: "2026-07-01" } }), "batch");
  await json(api.put(`/api/migration/batches/${b.id}/chart`, { data: { rows: [
    { sourceCode: "1100", sourceName: "Bank", sourceType: "asset", openingDebit: 5_000, sourceRole: "bank", evidenceNote: "Statement 30 Jun 2026, closing 5,000.00" },
    { sourceCode: "1500", sourceName: "Machinery at cost", sourceType: "asset", openingDebit: 30_000 },
    { sourceCode: "1590", sourceName: "Accumulated depreciation", sourceType: "asset", openingCredit: 6_000 },
    { sourceCode: "3200", sourceName: "Retained earnings b/f", sourceType: "equity", openingCredit: 29_000, sourceRole: "retained_earnings" },
  ] } }), "chart");
  const chart = await json<{ rows: { id: number; sourceCode: string }[] }>(api.get(`/api/migration/batches/${b.id}/chart`), "chart read");
  const row = (code: string) => chart.rows.find((r) => r.sourceCode === code)!.id;
  const bank = list(await json<{ id: number; name: string }[] | { items: { id: number; name: string }[] }>(api.get("/api/bank-accounts"), "banks")).find((x) => x.name === "Answers Main")!;
  const cat = list(await json<{ name: string; costAccountId: number }[] | { items: { name: string; costAccountId: number }[] }>(api.get("/api/asset-categories"), "categories")).find((c) => c.name === "Q3 machinery")!;
  const decide = (code: string, body: Record<string, unknown>) => json(api.patch(`/api/migration/batches/${b.id}/chart/${row(code)}`, { data: body }), `decide ${code}`);
  await decide("1100", { decision: "map_to_bank", targetBankAccountId: bank.id });
  await decide("1500", { decision: "merge_into", targetCategoryId: cat.costAccountId });
  await decide("1590", { decision: "map_to_system", targetSystemCode: "ACCUMULATED_DEPRECIATION" });
  await decide("3200", { decision: "map_to_system", targetSystemCode: "RETAINED_EARNINGS" });
  await json(api.put(`/api/migration/batches/${b.id}/assets`, { data: { rows: [
    { sourceId: "FA-1", name: "Q3 Lathe", categoryName: "Q3 machinery", acquisitionDate: "2024-07-01", availableForUseDate: "2024-07-01", cost: 30_000, usefulLifeMonths: 48, openingAccumulatedDepreciation: 6_000, openingPeriodsBooked: 24, vatInputTaxAmount: 4_500, vatInitialRecoveryPct: 100 },
  ] } }), "assets");
  const v = await json<{ ok: boolean; checks: { id: string; status: string }[] }>(api.post(`/api/migration/batches/${b.id}/validate`), "validate");
  expect(v.ok, JSON.stringify(v.checks.filter((c) => c.status !== "pass"))).toBe(true);
  await json(api.post(`/api/migration/batches/${b.id}/commit`), "commit");
  const staged = await json<{ rows: { resolvedAssetId: number | null }[] }>(api.get(`/api/migration/batches/${b.id}/assets`), "staged assets");
  return { batchId: b.id, assetId: staged.rows[0]!.resolvedAssetId! };
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E_ANSWERS.adminState });
  ({ batchId, assetId } = await migrate());
  // the first month the product depreciates: (30,000 − 6,000) / 24 = 1,000
  const run = await json<{ posted: { assetId: number; amount: number }[] }>(api.post("/api/assets/depreciation-runs", { data: { period: "2026-07" } }), "run July");
  expect(run.posted).toEqual([expect.objectContaining({ assetId, amount: 1_000 })]);
});
test.afterAll(async () => { await api.dispose(); });

test.describe.serial("Q3 — a migrated fixed asset reversed with its batch", () => {
  test("🔴 the preview names the asset and the depreciation it unwinds; Reverse is CLICKED and the batch reads reversed", async ({ page }) => {
    await page.goto(`/migration/${batchId}?section=commit`);
    const preview = page.getByTestId("reversal-preview");
    await expect(preview).toBeVisible();
    await expect(preview).not.toContainText("BLOCKED");
    await expect(page.getByTestId(`reversal-asset-MIG-${batchId}-FA-1`)).toContainText("Q3 Lathe");
    await expect(page.getByTestId(`reversal-asset-MIG-${batchId}-FA-1`)).toContainText("1 posted depreciation period(s) reversed as they were dated");
    await page.getByTestId("open-reverse").click();
    const dialog = page.getByTestId("reverse-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("reverse-reason").fill("The previous system's register was exported before its year-end close");
    await dialog.getByTestId("confirm-reverse").click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await json<{ status: string }>(api.get(`/api/migration/batches/${batchId}`), "batch")).status).toBe("reversed");
  });

  test("🔴 the register and the asset's page: reversed with its migration — NOT disposed of, no act offered, carrying amount 0", async ({ page }) => {
    await page.goto("/assets");
    await expect(page.getByTestId(`asset-status-MIG-${batchId}-FA-1`)).toHaveText("Reversed with its migration");
    await page.goto(`/assets/${assetId}`);
    await expect(page.getByTestId("detail-status")).toHaveText("Reversed with its migration");
    await expect(page.getByTestId("reversed-notice")).toContainText(`migration batch ${batchId}, which was reversed`);
    await expect(page.getByTestId("reversed-notice")).toContainText("It was not disposed of — no proceeds, no gain or loss");
    await expect(page.getByTestId("disposal-notice")).toHaveCount(0);
    for (const act of ["run-depreciation", "change-estimate", "dispose-asset"]) await expect(page.getByTestId(act), act).toHaveCount(0);
    await expect(page.getByTestId("detail-carrying")).toHaveText(/(^|\s)0\.00$/);
    // the July row keeps its posted entry as history; its mirror is in the books beside it
    const a = await json<{ status: string; schedule: { period: string; journalEntryId: number | null }[]; disposal: unknown }>(api.get(`/api/assets/${assetId}`), "asset");
    expect([a.status, a.disposal]).toEqual(["reversed", null]);
    expect(a.schedule.filter((r) => r.journalEntryId != null).map((r) => r.period)).toEqual(["2026-07"]);
  });

  test("🔴 a REPLACEMENT names it: the lineage is followed by clicking — reversed → its replacement → back", async ({ page }) => {
    ({ assetId: replacementAssetId } = await migrate());
    await page.goto(`/assets/${assetId}`);
    await page.getByTestId("replaced-by-link").click();
    await expect(page).toHaveURL(new RegExp(`/assets/${replacementAssetId}$`));
    await expect(page.getByTestId("detail-status")).toHaveText("In service");
    const back = page.getByTestId("replaces-link");
    await expect(back).toContainText(`#${assetId}`);
    await back.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/assets/${assetId}$`));
    await expect(page.getByTestId("reversed-notice")).toBeVisible();
  });

  test("Arabic / RTL: the reversed asset's page reads right to left with the Arabic notice", async ({ page }) => {
    await page.goto(`/assets/${assetId}`);
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("detail-status")).toHaveText("معكوس مع ترحيله");
    await expect(page.getByTestId("reversed-notice")).toContainText("خارج الدفاتر");
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(sw, "no sideways scroll").toBeLessThanOrEqual(cw + 1);
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
  });
});
