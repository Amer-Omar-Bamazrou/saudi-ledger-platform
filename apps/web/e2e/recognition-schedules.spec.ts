/**
 * PHASE 11 A2/A3 — ACCRUALS AND PREPAYMENTS, WALKED BY CLICKING (2026-09-22).
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §2, §3.
 *
 * What only a browser can show:
 *   · the whole workflow works from the page — create a draft, activate it,
 *     recognise a period, stop the rest — with real clicks and real dialogs;
 *   · 🔴 the accrual form does NOT offer Accounts Payable, because the server
 *     refuses it (IAS 37.11) and offering a control that leads to a refusal is
 *     the mapper defect this codebase has already been bitten by once;
 *   · the figures the page shows are the SERVER's derived ones;
 *   · Arabic under dir=rtl and a phone at 390 px.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };
const REF = `E2E-ACC-${Date.now()}`;

let api: APIRequestContext;
let createdId = 0;

const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
});
test.afterAll(async () => {
  // Stop anything this walk left active, so a second run starts where the first did.
  if (createdId) await api.post(`/api/recognition-schedules/${createdId}/cancel`, { data: { reason: "E2E walk teardown" } });
  await api.dispose();
});

test.describe.serial("accruals and prepayments, end to end", () => {
  test("🔴 the accrual form does NOT offer Accounts Payable — the server refuses it, so offering it would be a control that leads to a refusal", async ({ page }) => {
    await page.goto("/recognition-schedules");
    await expect(page.getByTestId("page-recognition-schedules")).toBeVisible();
    await page.getByTestId("new-schedule").click();
    await expect(page.getByTestId("new-schedule-dialog")).toBeVisible();

    // the kind starts as an accrual; open the balance-account list
    await page.getByTestId("schedule-balance").click();
    const options = page.getByRole("option");
    await expect(options.first()).toBeVisible();
    const labels = await options.allInnerTexts();
    // 🔴 Accounts Payable is absent from an ACCRUAL's list…
    expect(labels.join(" | ")).not.toMatch(/Accounts Payable/i);
    // …and the form says why, rather than just hiding it
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("new-schedule-dialog")).toContainText("IAS 37.11");

    // and the server agrees: the API refuses AP by name
    const cats = await (await api.get("/api/categories?limit=500")).json();
    const all = (cats.items ?? cats) as Array<{ id: number; systemCode: string | null; type: string }>;
    const ap = all.find((c) => c.systemCode === "AP")!;
    const expense = all.find((c) => c.systemCode === "PURCHASES")!;
    const refused = await api.post("/api/recognition-schedules", {
      data: { kind: "accrual", description: "should refuse", totalAmount: 100, periods: 1, startPeriod: "2026-06", expenseAccountId: expense.id, balanceAccountId: ap.id },
    });
    expect(refused.status(), await refused.text()).toBe(422);
    expect(await refused.text()).toMatch(/accrual_may_not_use_ap/);
  });

  test("🔴 create → activate → recognise, all by clicking, and every figure is the server's", async ({ page }) => {
    await page.goto("/recognition-schedules");
    await page.getByTestId("new-schedule").click();
    await page.getByTestId("schedule-reference").fill(REF);
    await page.getByTestId("schedule-description").fill("Audit fee accrued monthly");
    await page.getByTestId("schedule-total").fill("30000");
    await page.getByTestId("schedule-periods").fill("3");
    await page.getByTestId("schedule-start").fill("2026-06");

    await page.getByTestId("schedule-expense").click();
    await page.getByRole("option").first().click();
    await page.getByTestId("schedule-balance").click();
    await page.getByRole("option").first().click();
    await page.getByTestId("schedule-submit").click();
    await expect(page.getByTestId("new-schedule-dialog")).toHaveCount(0);

    // it is a DRAFT and has recognised nothing
    const row = page.getByTestId(`schedule-row-${REF}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`status-${REF}`)).toHaveText("draft");
    await expect(page.getByTestId(`recognised-${REF}`)).toContainText("0.00");

    const list = await (await api.get("/api/recognition-schedules")).json();
    const mine = (list.items as Array<{ id: number; reference: string; status: string; rows?: unknown }>).find((s) => s.reference === REF)!;
    createdId = mine.id;
    expect(mine.status).toBe("draft");

    // activate — the periods appear and still nothing has posted
    await page.getByTestId(`activate-${REF}`).click();
    await expect(page.getByTestId(`status-${REF}`)).toHaveText("active");
    const detail = await (await api.get(`/api/recognition-schedules/${createdId}`)).json();
    expect((detail.rows as Array<{ period: string; amount: number; journalEntryId: number | null }>).map((r) => [r.period, r.amount])).toEqual([
      ["2026-06", 10000], ["2026-07", 10000], ["2026-08", 10000],
    ]);
    expect((detail.rows as Array<{ journalEntryId: number | null }>).every((r) => r.journalEntryId === null)).toBe(true);

    // recognise the first period by clicking
    await page.getByTestId(`recognise-${REF}`).click();
    await expect(page.getByTestId(`recognised-${REF}`)).toContainText("10,000.00");

    const after = await (await api.get(`/api/recognition-schedules/${createdId}`)).json();
    const first = (after.rows as Array<{ period: string; journalEntryId: number | null }>).find((r) => r.period === "2026-06")!;
    expect(first.journalEntryId).not.toBeNull();
    // 🔴 dated the LAST DAY of the period recognised, not the day of the click
    const je = await (await api.get(`/api/journal-entries/${first.journalEntryId}`)).json();
    expect(je.date).toBe("2026-06-30");
    // Dr expense / Cr the accrued liability — both sides, on the entry itself
    const lines = (je.lines as Array<{ debitAmount: number; creditAmount: number }>);
    expect(lines.length).toBe(2);
    expect(lines.reduce((a, l) => a + l.debitAmount, 0)).toBe(10000);
    expect(lines.reduce((a, l) => a + l.creditAmount, 0)).toBe(10000);
  });

  test("🔴 the detail dialog opens the schedule and shows planned vs posted periods apart", async ({ page }) => {
    await page.goto("/recognition-schedules");
    await page.getByTestId(`open-schedule-${REF}`).click();
    await expect(page.getByTestId("schedule-detail")).toBeVisible();
    await expect(page.getByTestId("period-2026-06")).toContainText("#");        // posted, shows its entry
    await expect(page.getByTestId("period-2026-07")).toContainText("planned");  // not yet
  });

  test("🔴 stopping requires a REASON and keeps what is already in the books", async ({ page }) => {
    await page.goto("/recognition-schedules");
    await page.getByTestId(`cancel-${REF}`).click();
    await expect(page.getByTestId("cancel-dialog")).toBeVisible();
    // the submit is disabled until a reason is typed — the refusal is prevented, not explained after the fact
    await expect(page.getByTestId("cancel-submit")).toBeDisabled();
    await page.getByTestId("cancel-reason").fill("Engagement ended early");
    await page.getByTestId("cancel-submit").click();

    await expect(page.getByTestId(`status-${REF}`)).toHaveText("cancelled");
    // 🔴 the recognised period STAYS — cancelling stops the future, it reverses nothing
    await expect(page.getByTestId(`recognised-${REF}`)).toContainText("10,000.00");
    const after = await (await api.get(`/api/recognition-schedules/${createdId}`)).json();
    expect((after.rows as unknown[]).length).toBe(1);
    createdId = 0; // already cancelled; teardown has nothing to do
  });

  test("Arabic / RTL and a phone: the page reads right-to-left and nothing scrolls sideways", async ({ page }) => {
    await page.goto("/recognition-schedules");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { name: /المستحقات والمصروفات المدفوعة مقدمًا/ })).toBeVisible();
    await noSidewaysScroll(page, 1280, "ar recognition schedules");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));

    await page.setViewportSize(PHONE);
    await page.reload();
    await expect(page.getByTestId("page-recognition-schedules")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "phone recognition schedules");
    await page.getByTestId("new-schedule").click();
    await expect(page.getByTestId("new-schedule-dialog")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "phone new-schedule dialog");
  });
});
