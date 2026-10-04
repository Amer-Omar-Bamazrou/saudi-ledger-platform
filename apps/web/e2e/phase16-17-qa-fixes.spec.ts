/**
 * PHASE 16 + 17 — WHAT THE MANUAL QA WALK FOUND (2026-10-04), CLICKED.
 * Record: docs/history/phase-16-17-manual-qa-2026-10-04.md.
 *
 * Only a browser can show these — every server test builds its request the way
 * the server expects (CLAUDE.md §3), so a client that sends TWO, or sends no
 * date, or pre-fills a rate, is invisible to it:
 *
 *   QA-02  a double-click on a tax/treasury action fired two requests: a tax
 *          adjustment added twice (the Zakat moved with it), two identical
 *          payment plans, two remittances (the second answered 500). Asserted
 *          by COUNTING the requests the client sends — a duplicate the server
 *          later refused would still be two POSTs;
 *   QA-07  the bill pay dialog had no date: a payment recorded after the fact
 *          was dated the day it was typed and its withholding fell into the
 *          wrong month's return;
 *   QA-12  the treaty-relief form pre-filled the reduced rate with "0" — a full
 *          exemption one approval away;
 *   QA-01  the ownership helper said foreign and mixed ownership were "out of
 *          scope" after Phase 16 built income tax for both.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { businessToday } from "@workspace/shared";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";

test.use({ storageState: E2E.storageState });

const TODAY = businessToday();
const STAMP = Date.now();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// the last day of the previous month — an open period, and a payment "recorded after the fact"
const LAST_MONTH_END = addDays(TODAY, -Number(TODAY.slice(8, 10)));
const LAST_MONTH = LAST_MONTH_END.slice(0, 7);

let api: APIRequestContext;
let nrVendor = 0, nrBill = 0, resBill = 0;

const json = async <T,>(p: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>, what: string): Promise<T> => {
  const r = await p;
  const text = await r.text();
  if (!r.ok()) throw new Error(`${what} → ${r.status()} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};
/** Count the requests the CLIENT sends to a path — the double-submit is a property of the client. */
const countPosts = (page: Page, path: RegExp) => {
  const seen: { body: unknown }[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && path.test(new URL(r.url()).pathname)) seen.push({ body: r.postDataJSON() }); });
  return seen;
};
const bill = async (vendorId: number, no: string, date: string, amount: number) => {
  const b = await json<{ id: number }>(api.post("/api/bills", { data: {
    supplierDocumentKind: "tax_invoice", vendorReference: no, billNumber: no, date, dueDate: addDays(TODAY, 30), vendorId,
    items: [{ description: "Service", quantity: 1, unitPrice: amount, vatRate: 0 }],
  } }), "bill");
  await json(api.post(`/api/bills/${b.id}/approve`, { data: {} }), "approve bill");
  return b.id;
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  nrVendor = (await json<{ id: number }>(api.post("/api/vendors", { data: { name: `E2E QA Royalty ${STAMP}`, residency: "non_resident", country: "AE", whtDefaultPaymentType: "royalty", foreignTaxId: `AE-${STAMP}` } }), "nr vendor")).id;
  nrBill = await bill(nrVendor, `E2E-QA-ROY-${STAMP}`, addDays(LAST_MONTH_END, -5), 10_000);
  const resVendor = (await json<{ id: number }>(api.post("/api/vendors", { data: { name: `E2E QA Resident ${STAMP}`, residency: "resident" } }), "resident vendor")).id;
  resBill = await bill(resVendor, `E2E-QA-RES-${STAMP}`, TODAY, 3_000);
});
test.afterAll(async () => { await api.dispose(); });

test.describe.serial("Phase 16 + 17 — what the manual QA found", () => {
  test("🔴 QA-02 — a double-click on Add adjustment sends ONE request; one adjustment is listed", async ({ page }) => {
    const { taxComputationId } = JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds;
    const posts = countPosts(page, /\/api\/tax\/computations\/\d+\/versions\/\d+\/adjustments$/);
    await page.goto(`/tax/computations/${taxComputationId}`);
    await expect(page.getByTestId("tax-adjustment-form")).toBeVisible();
    const reason = `E2E double-click probe ${STAMP}`;
    await page.getByTestId("tax-adjustment-amount").fill("1000");
    await page.getByTestId("tax-adjustment-reason").fill(reason);
    await page.getByTestId("tax-adjustment-article").fill("Zakat Regulations Art. 63");
    await page.getByTestId("tax-adjustment-add").dblclick();
    await expect(page.getByTestId("tax-adjustments-table")).toContainText(reason);
    await expect(page.getByTestId("tax-adjustments-table").getByText(reason)).toHaveCount(1);
    expect(posts.length, "the client sent ONE add").toBe(1);
  });

  test("🔴 QA-02 — a double-click on Create plan sends ONE request", async ({ page }) => {
    const posts = countPosts(page, /^\/api\/treasury\/payment-plans$/);
    await page.goto("/treasury?tab=plans");
    await page.getByTestId("treasury-plan-create").click();
    await page.getByTestId("treasury-plan-bill").click();
    await page.getByRole("option", { name: new RegExp(`E2E-QA-RES-${STAMP}`) }).click();
    await page.getByTestId("treasury-plan-amount").fill("1500"); // half: a duplicate would still fit what the bill owes
    await page.getByTestId("treasury-plan-date").fill(addDays(TODAY, 4));
    await page.getByTestId("treasury-plan-submit").dblclick();
    await expect.poll(async () => (await json<Array<{ billId: number; status: string }>>(api.get("/api/treasury/payment-plans"), "plans")).filter((p) => p.billId === resBill && p.status === "planned").length).toBe(1);
    expect(posts.length, "the client sent ONE create").toBe(1);
  });

  test("🔴 QA-07 — the bill pay dialog takes the payment DATE; the withholding lands in THAT month, not this one", async ({ page }) => {
    await page.goto("/bills");
    await page.getByTestId(`pay-bill-${nrBill}`).click();
    const date = page.getByTestId("pay-date");
    await expect(date, "today unless stated").toHaveValue(TODAY);
    await date.fill(addDays(TODAY, 1));
    await expect(page.getByRole("button", { name: "Record Payment" }), "never a future date").toBeDisabled();
    await date.fill(LAST_MONTH_END);
    await page.getByTestId("pay-bank-account").click();
    await page.getByRole("option").first().click();
    await expect(page.getByTestId("wht-preview")).toContainText("1,500.00"); // royalty 15 % of 10,000
    await page.getByRole("button", { name: "Record Payment" }).click();
    await expect.poll(async () => {
      const ov = await json<{ months: Array<{ period: string; withheld: number }> }>(api.get("/api/tax/wht/overview"), "overview");
      return ov.months.find((m) => m.period === LAST_MONTH)?.withheld ?? 0;
    }).toBeGreaterThanOrEqual(1_500);
    const ret = await json<{ schedule: Array<{ document: string | null; paymentDate: string }> }>(api.get(`/api/tax/wht/returns/${LAST_MONTH}`), "return");
    expect(ret.schedule.some((s) => s.document === `E2E-QA-ROY-${STAMP}` && s.paymentDate === LAST_MONTH_END), `the withholding is on ${LAST_MONTH}'s return, dated ${LAST_MONTH_END}`).toBe(true);
  });

  test("🔴 QA-02 — a double-click on Record remittance sends ONE request, carrying an idempotency key", async ({ page }) => {
    const posts = countPosts(page, /^\/api\/tax\/wht\/periods\/[^/]+\/pay$/);
    await page.goto("/tax/withholding?tab=return");
    await page.getByTestId("wht-return-period").click();
    await page.getByRole("option", { name: LAST_MONTH, exact: true }).click();
    await expect(page.getByTestId("wht-remit-form")).toBeVisible();
    await page.getByTestId("wht-remit-bank").click();
    await page.getByRole("option").first().click();
    await page.getByTestId("wht-remit-submit").dblclick();
    await expect(page.getByTestId("wht-remittances")).toContainText(TODAY.slice(0, 4));
    expect(posts.length, "the client sent ONE remittance").toBe(1);
    expect(typeof (posts[0]!.body as { idempotencyKey?: unknown }).idempotencyKey, "the remittance carries its idempotency key").toBe("string");
  });

  test("🔴 QA-12 — the treaty-relief rate starts EMPTY; nothing is recorded until a rate is typed", async ({ page }) => {
    await page.goto("/tax/withholding?tab=reliefs");
    const rate = page.getByTestId("wht-relief-rate");
    await expect(rate, "never a pre-filled 0 % (a full exemption)").toHaveValue("");
    await page.getByTestId("wht-relief-vendor-search").fill(`E2E QA Royalty ${STAMP}`);
    await page.getByTestId("wht-relief-vendor").click();
    await page.getByRole("option", { name: new RegExp(`E2E QA Royalty ${STAMP}`) }).click();
    await expect(page.getByTestId("wht-relief-create"), "no rate, no relief").toBeDisabled();
    await rate.fill("10"); // a percent, not a fraction
    await expect(page.getByTestId("wht-relief-create"), "10 is not a rate (0.10 is)").toBeDisabled();
    await rate.fill("0.10");
    await expect(page.getByTestId("wht-relief-create")).toBeEnabled();
  });

  test("QA-01 — the ownership helper says which tax applies — not that foreign or mixed ownership is out of scope", async ({ page }) => {
    await page.goto("/company");
    await expect(page.getByText(/foreign-owned company pays income tax/)).toBeVisible();
    await expect(page.getByText(/out of scope for now/)).toHaveCount(0);
  });
});
