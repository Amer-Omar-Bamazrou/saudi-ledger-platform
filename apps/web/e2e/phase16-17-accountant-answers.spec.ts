/**
 * PHASE 16 + 17 — THE ACCOUNTANT'S ANSWERS Q1 AND Q2, WALKED BY CLICKING (2026-10-05).
 * Record: docs/product/phase-16-17-tax-treasury-decision-pack.md §14.1–§14.2.
 * (Q3's browser legs: phase16-17-q3-asset-reversal.spec.ts on this tenant, and migration-workspace's preview.)
 *
 * What only a browser can show:
 *   · Q2 — the supplier-payment dialog asks WHAT THE MONEY IS before any nature: a refundable deposit to a
 *     non-resident whose default nature withholds 15 % is previewed and recorded NOT SUBJECT (nothing withheld,
 *     the reason on the return's excluded list); money not yet identified is previewed and recorded PENDING;
 *   · Q1 — a withheld bill payment entered at the wrong amount is corrected from the return by clicking:
 *     the original is reversed (kept, struck through, out of the totals), the re-entry withholds on the right
 *     amount, and the lineage reads both ways;
 *   · TR-1 (final audit 2026-10-05) — a plan paid into a FILED month from the Treasury screen carries the treatment the
 *     person chose there (the dialog used to drop it, so every such payment was refused).
 *
 * 🔴 On its OWN tenant (`E2E_ANSWERS`), not the shared smoke tenant: a WHT payment changes its month's return
 * LINES, and phase16-tax asserts its own figure on that line — run in the shared tenant, this spec's consulting
 * payment turned that line from 500.00 into 900.00 (CI 37311565856). Owning the tenant also lets every cash
 * movement be asserted exactly (the bank moves by what the payment takes) instead of funded away.
 */
import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import { businessToday } from "@workspace/shared";
import { E2E_ANSWERS } from "./global-setup";

test.use({ storageState: E2E_ANSWERS.adminState });

const TODAY = businessToday();
const PERIOD = TODAY.slice(0, 7);
const STAMP = Date.now();

let api: APIRequestContext;
let royaltyVendor = 0, consultingVendor = 0, billId = 0, bankId = 0;

const json = async <T,>(p: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>, what: string): Promise<T> => {
  const r = await p;
  const text = await r.text();
  if (!r.ok()) throw new Error(`${what} → ${r.status()} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};
const totalCash = async () => (await json<{ totalCash: number }>(api.get("/api/treasury/position"), "position")).totalCash;
type ReturnRow = { id: number; vendorId: number; billId: number | null; baseAmount: number; whtAmount: number; notSubjectReason: string | null; status: string };
const monthReturn = () => json<{ schedule: ReturnRow[]; excluded: ReturnRow[]; pending: ReturnRow[]; corrected: ReturnRow[] }>(api.get(`/api/tax/wht/returns/${PERIOD}`), "return");

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E_ANSWERS.adminState });
  const banks = await json<{ id: number; name: string }[] | { items: { id: number; name: string }[] }>(api.get("/api/bank-accounts"), "banks");
  bankId = (Array.isArray(banks) ? banks : banks.items).find((b) => b.name === "Answers Main")!.id;
  // two NON-RESIDENT suppliers (declared, never inferred): one whose default nature withholds 15 % (royalty), one 5 % (technical consulting)
  royaltyVendor = (await json<{ id: number }>(api.post("/api/vendors", { data: { name: `E2E Q2 Licensor ${STAMP}`, residency: "non_resident", country: "GB", whtDefaultPaymentType: "royalty", foreignTaxId: `GB-Q2-${STAMP}` } }), "royalty vendor")).id;
  consultingVendor = (await json<{ id: number }>(api.post("/api/vendors", { data: { name: `E2E Q1 Consultant ${STAMP}`, residency: "non_resident", country: "GB", whtDefaultPaymentType: "technical_consulting", foreignTaxId: `GB-Q1-${STAMP}` } }), "consulting vendor")).id;
  const b = await json<{ id: number }>(api.post("/api/bills", { data: {
    supplierDocumentKind: "tax_invoice", vendorReference: `Q1-${STAMP}`, billNumber: `E2E-Q1-${STAMP}`, date: TODAY, dueDate: TODAY, vendorId: consultingVendor,
    items: [{ description: "Consulting services", quantity: 1, unitPrice: 10000, vatRate: 0 }],
  } }), "bill");
  await json(api.post(`/api/bills/${b.id}/approve`, { data: {} }), "approve bill");
  billId = b.id;
});
test.afterAll(async () => { await api.dispose(); });

test.describe.serial("Phase 16 + 17 — the accountant's answers, by clicking", () => {
  const newPayment = async (page: import("@playwright/test").Page, classification: RegExp, amount: string) => {
    await page.goto("/supplier-payments");
    await page.getByTestId("new-supplier-payment").click();
    const dialog = page.getByTestId("new-supplier-payment-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("sp-vendor").click();
    await page.getByRole("option", { name: `E2E Q2 Licensor ${STAMP}` }).click();
    await dialog.getByTestId("sp-bank").click();
    await page.getByRole("option").first().click();
    await dialog.getByTestId("sp-amount").fill(amount);
    await dialog.getByTestId("sp-classification").click();
    await page.getByRole("option", { name: classification }).click();
    return dialog;
  };

  test("🔴 Q2 — a refundable DEPOSIT to a non-resident whose default nature withholds 15 % is NOT SUBJECT: the dialog says why before anything is recorded, and the return lists it excluded with that reason", async ({ page }) => {
    const dialog = await newPayment(page, /Refundable security deposit/, "3000");
    // the class decides BEFORE a nature is read — the supplier's royalty default never applies to a deposit
    await expect(dialog.getByTestId("wht-class-decides")).toContainText("not consideration for a supply");
    await expect(dialog.getByTestId("wht-preview")).toContainText("Not subject — nothing is withheld");
    // the figures, not their absence: nothing withheld, the whole 3,000 leaves the bank
    await expect(dialog.getByTestId("wht-preview-withheld")).toHaveText(/(^|\s)0\.00$/); // the page formats money ("SAR 0.00")
    await expect(dialog.getByTestId("wht-preview-cash")).toHaveText(/(^|\s)3,000\.00$/);
    const cashBefore = await totalCash();
    await dialog.getByTestId("sp-submit").click();
    await expect(dialog).toBeHidden();
    expect(await totalCash(), "the whole deposit left the bank — nothing withheld").toBe(cashBefore - 3_000);
    const ret = await monthReturn();
    expect(ret.excluded.filter((r) => r.vendorId === royaltyVendor).map((r) => [r.baseAmount, r.notSubjectReason])).toEqual([[3_000, "refundable_deposit"]]);
    expect(ret.schedule.filter((r) => r.vendorId === royaltyVendor), "nothing withheld on a deposit").toEqual([]);
    // and the return page says so, by name
    await page.goto(`/tax/withholding?tab=return&period=${PERIOD}`);
    await expect(page.getByTestId("wht-excluded")).toContainText(`E2E Q2 Licensor ${STAMP}`);
  });

  test("🔴 Q2 — money whose purpose is NOT YET IDENTIFIED is PENDING: nothing withheld, nothing claimed, listed until classified — never withheld automatically", async ({ page }) => {
    const dialog = await newPayment(page, /Not yet identified/, "1000");
    await expect(dialog.getByTestId("wht-class-decides")).toContainText("recorded PENDING");
    await expect(dialog.getByTestId("wht-preview-pending")).toBeVisible();
    const cashBefore = await totalCash();
    await dialog.getByTestId("sp-submit").click();
    await expect(dialog).toBeHidden();
    expect(await totalCash(), "the whole amount left the bank — nothing withheld while pending").toBe(cashBefore - 1_000);
    const ret = await monthReturn();
    expect(ret.pending.filter((r) => r.vendorId === royaltyVendor).map((r) => r.baseAmount)).toEqual([1_000]);
    await page.goto(`/tax/withholding?tab=return&period=${PERIOD}`);
    await expect(page.getByTestId("wht-pending")).toContainText(`E2E Q2 Licensor ${STAMP}`);
  });

  test("🔴 Q1 — a withheld bill payment at the WRONG AMOUNT is corrected from the return: reversed (kept, struck through, out of the totals), re-entered at 8,000 with 400 withheld, the lineage both ways", async ({ page }) => {
    const cashBefore = await totalCash();
    // the error: 10,000 paid, 500 withheld (5 %) — it should have been 8,000
    await json(api.post(`/api/bills/${billId}/pay`, { data: { amount: 10_000, paidAt: TODAY, bankAccountId: bankId } }), "pay the bill at the wrong amount");
    const original = (await monthReturn()).schedule.find((r) => r.billId === billId)!;
    expect([original.baseAmount, original.whtAmount]).toEqual([10_000, 500]);

    await page.goto(`/tax/withholding?tab=return&period=${PERIOD}`);
    await page.getByTestId(`wht-correct-${original.id}`).click();
    const panel = page.getByTestId(`wht-correct-panel-${original.id}`);
    await expect(panel).toBeVisible();
    await panel.getByTestId("wht-correct-reason").fill("Paid 10,000 in error; the agreed fee was 8,000");
    await panel.getByTestId("wht-correct-amount").fill("8000");
    // the re-entry's withholding is the SERVER's preview, on the corrected amount
    await expect(panel.getByTestId("wht-preview-withheld")).toContainText("400.00");
    await panel.getByTestId("wht-correct-submit").click();
    await expect(panel).toBeHidden();

    // the original: struck through in this return's corrected list, out of the totals; the re-entry in the schedule
    await expect(page.getByTestId(`wht-corrected-${original.id}`)).toBeVisible();
    const ret = await monthReturn();
    expect(ret.corrected.filter((r) => r.billId === billId).map((r) => r.id)).toEqual([original.id]);
    const reentry = ret.schedule.find((r) => r.billId === billId)!;
    expect([reentry.baseAmount, reentry.whtAmount]).toEqual([8_000, 400]);
    // the lineage, both ways (the API) and on the page
    const lin = await json<{ correction: { reason: string } | null; reentry: { id: number } | null }>(api.get(`/api/tax/wht/withholdings/${original.id}`), "lineage of the original");
    expect([lin.correction?.reason, lin.reentry?.id]).toEqual(["Paid 10,000 in error; the agreed fee was 8,000", reentry.id]);
    const back = await json<{ corrects: { id: number } | null }>(api.get(`/api/tax/wht/withholdings/${reentry.id}`), "lineage of the re-entry");
    expect(back.corrects?.id).toBe(original.id);
    await page.getByTestId(`wht-history-${reentry.id}`).click();
    await expect(page.getByTestId(`wht-lineage-${reentry.id}`)).toBeVisible();
    // the bill owes what the corrected payment left; the shared tenant's cash is where it was
    const bill = await json<{ outstanding?: number | string }>(api.get(`/api/bills/${billId}`), "bill");
    expect(Number(bill.outstanding ?? 0)).toBe(2_000);
    // the error took 9,500 and its reversal returned it; the corrected payment took 7,600 (8,000 less 400 withheld)
    expect(await totalCash(), "net of the error and its correction, the bank paid exactly the corrected cash").toBe(cashBefore - 7_600);
  });

  test("🔴 TR-1 — a plan paid into a FILED month: the treatment chosen on the Treasury screen travels with the payment (it was dropped, so every such payment was refused)", async ({ page }) => {
    // the previous month, recorded FILED (an API act — the walk under test is the payment)
    const d = new Date(`${TODAY}T00:00:00Z`); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
    const PREV = d.toISOString().slice(0, 7);
    await json(api.post(`/api/tax/wht/returns/${PREV}/file`, { data: { filedOn: TODAY, zatcaReference: `E2E-TR1-${STAMP}` } }), "file the previous month");
    const b = await json<{ id: number }>(api.post("/api/bills", { data: {
      supplierDocumentKind: "tax_invoice", vendorReference: `TR1-${STAMP}`, billNumber: `E2E-TR1-${STAMP}`, date: `${PREV}-01`, dueDate: `${PREV}-28`, vendorId: consultingVendor,
      items: [{ description: "Consulting services", quantity: 1, unitPrice: 2000, vatRate: 0 }],
    } }), "bill");
    await json(api.post(`/api/bills/${b.id}/approve`, { data: {} }), "approve the bill");
    const planned = new Date(`${TODAY}T00:00:00Z`); planned.setUTCDate(planned.getUTCDate() + 5);
    const plan = await json<{ id: number }>(api.post("/api/treasury/payment-plans", { data: { billId: b.id, amount: 2000, plannedDate: planned.toISOString().slice(0, 10) } }), "plan");
    await json(api.post(`/api/treasury/payment-plans/${plan.id}/approve`, { data: {} }), "approve the plan");
    await page.goto("/treasury?tab=plans");
    await page.getByTestId(`treasury-plan-pay-${plan.id}`).click();
    const form = page.getByTestId(`treasury-plan-pay-form-${plan.id}`);
    await form.getByTestId("treasury-plan-pay-date").fill(`${PREV}-15`);
    // the screen asks how the filed month's withholding is reported — chosen, never preselected
    await expect(form.getByTestId("wht-filed-month")).toBeVisible();
    await form.getByTestId("wht-treatment-subsequent").check();
    await form.getByTestId("treasury-plan-pay-bank").click();
    await page.getByRole("option").first().click();
    await form.getByTestId("treasury-plan-pay-submit").click();
    await expect(page.getByTestId(`treasury-plan-status-${plan.id}`)).toContainText("Paid");
    const pays = await json<Array<{ withheld?: number | null; cashPaid?: number | null }>>(api.get(`/api/bills/${b.id}/payments`), "payments");
    expect(pays.map((x) => [x.withheld, x.cashPaid]), "paid once, 5 % withheld").toEqual([[100, 1900]]);
  });
});
