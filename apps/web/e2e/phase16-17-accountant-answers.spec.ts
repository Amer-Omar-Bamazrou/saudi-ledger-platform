/**
 * PHASE 16 + 17 — THE ACCOUNTANT'S ANSWERS Q1 AND Q2, WALKED BY CLICKING (2026-10-05).
 * Record: docs/product/phase-16-17-tax-treasury-decision-pack.md §14.1–§14.2.
 * (Q3's browser leg is in migration-workspace.spec.ts: the reversal preview names the batch's fixed asset.)
 *
 * What only a browser can show:
 *   · Q2 — the supplier-payment dialog asks WHAT THE MONEY IS before any nature: a refundable deposit to a
 *     non-resident whose default nature withholds 15 % is previewed and recorded NOT SUBJECT (nothing withheld,
 *     the reason on the return's excluded list); money not yet identified is previewed and recorded PENDING;
 *   · Q1 — a withheld bill payment entered at the wrong amount is corrected from the return by clicking:
 *     the original is reversed (kept, struck through, out of the totals), the re-entry withholds on the right
 *     amount, and the lineage reads both ways.
 *
 * 🔴 The suite shares one tenant whose statements are asserted later (statement-figures: total assets > 0), so
 * every payment that takes cash is FUNDED first by an entry of exactly that cash (the gap-closure pattern), and
 * the spec asserts the tenant's cash is unchanged by it.
 */
import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { businessToday } from "@workspace/shared";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";

test.use({ storageState: E2E.storageState });

const TODAY = businessToday();
const PERIOD = TODAY.slice(0, 7);
const STAMP = Date.now();

let api: APIRequestContext;
let royaltyVendor = 0, consultingVendor = 0, billId = 0;

const json = async <T,>(p: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>, what: string): Promise<T> => {
  const r = await p;
  const text = await r.text();
  if (!r.ok()) throw new Error(`${what} → ${r.status()} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};
const seeded = () => JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds;
/** An entry of exactly the cash a payment takes — the bank against retained earnings — so the shared tenant's cash is left as it was. */
const fundBank = async (amount: number, why: string) => {
  const { bankId } = seeded();
  const cats = await json<Array<{ id: number; name: string; systemCode: string | null; bankAccountId?: number | null }> | { items: Array<{ id: number; name: string; systemCode: string | null; bankAccountId?: number | null }> }>(api.get("/api/categories?limit=500"), "chart");
  const all = Array.isArray(cats) ? cats : cats.items;
  const leaf = all.find((c) => c.bankAccountId === bankId);
  const equity = all.find((c) => c.systemCode === "RETAINED_EARNINGS");
  expect(leaf && equity, "the seeded bank's GL account and retained earnings").toBeTruthy();
  const je = await json<{ id: number }>(api.post("/api/journal-entries", { data: {
    date: TODAY, description: `E2E accountant answers: funds ${why}, so the shared tenant's cash is left as it was`,
    lines: [
      { accountId: leaf!.id, accountName: leaf!.name, debitAmount: amount, creditAmount: 0 },
      { accountId: equity!.id, accountName: equity!.name, debitAmount: 0, creditAmount: amount },
    ],
  } }), "funding entry");
  await json(api.post(`/api/journal-entries/${je.id}/approve`, { data: {} }), "approve the funding entry");
};
const totalCash = async () => (await json<{ totalCash: number }>(api.get("/api/treasury/position"), "position")).totalCash;
type ReturnRow = { id: number; vendorId: number; billId: number | null; baseAmount: number; whtAmount: number; notSubjectReason: string | null; status: string };
const monthReturn = () => json<{ schedule: ReturnRow[]; excluded: ReturnRow[]; pending: ReturnRow[]; corrected: ReturnRow[] }>(api.get(`/api/tax/wht/returns/${PERIOD}`), "return");

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
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
    await fundBank(3_000, "the refundable deposit");
    await dialog.getByTestId("sp-submit").click();
    await expect(dialog).toBeHidden();
    expect(await totalCash(), "the deposit took exactly the cash it was funded with").toBe(cashBefore);
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
    await fundBank(1_000, "the unidentified payment");
    await dialog.getByTestId("sp-submit").click();
    await expect(dialog).toBeHidden();
    expect(await totalCash()).toBe(cashBefore);
    const ret = await monthReturn();
    expect(ret.pending.filter((r) => r.vendorId === royaltyVendor).map((r) => r.baseAmount)).toEqual([1_000]);
    await page.goto(`/tax/withholding?tab=return&period=${PERIOD}`);
    await expect(page.getByTestId("wht-pending")).toContainText(`E2E Q2 Licensor ${STAMP}`);
  });

  test("🔴 Q1 — a withheld bill payment at the WRONG AMOUNT is corrected from the return: reversed (kept, struck through, out of the totals), re-entered at 8,000 with 400 withheld, the lineage both ways", async ({ page }) => {
    const { bankId } = seeded();
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
    // the reversal returns the 9,500 the error took; the re-entry takes 7,600 — funded
    await fundBank(7_600, "the corrected payment (8,000 less 400 withheld)");
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
    expect(await totalCash(), "the error's cash came back with its reversal; the re-entry took exactly what was funded").toBe(cashBefore);
  });
});
