/**
 * BAD DEBTS, WALKED BY CLICKING (2026-09-22). Decision record:
 * docs/product/advance-payments-decision-pack.md §17.
 *
 * On the Invoices page: an issued, unpaid, old-enough invoice shows *Write
 * off* → the dialog (the unpaid amount, the VAT relieved, the certificate
 * reference the rule demands) → "Written off" badge, Due "—" → *Declare
 * recovery* → the dialog picks the receipt that carried the money → a draft
 * "Tax invoice — recovery (Art. 40(9))" row → approved (API) → the return's
 * figures read back. Every effect is read back from the API. Then a phone,
 * then Arabic on both.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };
type Invoice = { id: number; invoiceNumber: string; status: string; documentType: string; total: number; vatAmount: number; paidAmount: number; writtenOffAmount: number; badDebtRelief: { claimedOn: string; vatAmount: number; source: string } | null; recoversInvoiceId: number | null; recoveryPaymentId: number | null; icv: number | null };
type Payment = { id: number; unappliedAmount: number; liabilityAccountCode: string | null };
type VatReturn = { salesSection: { box6_vatOnStandardRatedSales: number; box7_vatAdjustments: number; box8_totalOutputVat: number; badDebtReliefs: Array<{ invoiceNumber: string; reliefVat: number }> } };

let api: APIRequestContext;
let ids: SeededIds;
const toast = (page: Page, title: string) => page.getByText(title, { exact: true }).first();
const invoice = async (id: number): Promise<Invoice> => (await api.get(`/api/invoices/${id}`)).json();
const payment = async (id: number): Promise<Payment> => (await api.get(`/api/payments/${id}`)).json();
const vatReturn = async (period: string): Promise<VatReturn> => (await api.get(`/api/reports/vat-return?period_from=${period}&period_to=${period}`)).json();
async function expectFits(el: ReturnType<Page["getByTestId"]>, width: number, message: string) {
  await expect(el).toBeVisible();
  await expect.poll(async () => { const b = await el.boundingBox(); return !!b && b.x >= 0 && b.x + b.width <= width + 1; }, { message, timeout: 5_000 }).toBe(true);
}
const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  ids = JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds;
});
test.afterAll(async () => { await api.dispose(); });

let seq = 0;
/** An issued invoice old enough for relief (supplied two years ago), unpaid. */
async function seedOldInvoice(net: number): Promise<Invoice> {
  const year = new Date().getFullYear() - 2;
  const number = `E2E-BD-${Date.now()}-${++seq}`;
  const c = await api.post(`/api/invoices`, { data: { invoiceNumber: number, date: `${year}-03-01`, dueDate: `${year}-04-01`, customerId: ids.customerId, items: [{ description: "Consulting (bad debt walk)", quantity: 1, unitPrice: net, vatRate: 15 }] } });
  if (!c.ok()) throw new Error(`seed invoice: ${await c.text()}`);
  const draft = (await c.json()) as Invoice;
  const ap = await api.post(`/api/invoices/${draft.id}/approve`);
  if (!ap.ok()) throw new Error(`seed approve: ${await ap.text()}`);
  return ap.json();
}
/** Dated on the business day of the relief (Asia/Riyadh — never the browser's UTC date: the night window), so the money arrives AFTER the relief. */
async function seedReceiptOnAccount(amount: number, paidAt: string): Promise<Payment> {
  const r = await api.post(`/api/payments`, { data: { customerId: ids.customerId, amount, paidAt, bankAccountId: ids.bankId, reference: `E2E-BD-RCPT-${Date.now()}`, classification: "unknown" } });
  if (!r.ok()) throw new Error(`seed receipt: ${await r.text()}`);
  return r.json();
}
async function findRow(page: Page, id: number) {
  await page.goto("/invoices", { waitUntil: "networkidle" });
  const row = page.getByTestId(`write-off-${id}`).or(page.getByTestId(`declare-recovery-${id}`)).first();
  await expect(row).toBeVisible();
}

async function writeOffFromList(page: Page, inv: Invoice, lang: "en" | "ar"): Promise<Invoice> {
  await findRow(page, inv.id);
  await page.getByTestId(`write-off-${inv.id}`).click();
  const dialog = page.getByTestId("bad-debt-write-off-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("bad-debt-unpaid")).toContainText((inv.total - inv.paidAmount).toLocaleString("en-US", { minimumFractionDigits: 2 }));
  // the rule: no certificate, no submit
  await expect(dialog.getByTestId("bad-debt-submit")).toBeDisabled();
  await dialog.getByTestId("bad-debt-certificate").fill("CA-E2E-1");
  await expect(dialog.getByTestId("bad-debt-submit")).toBeEnabled();
  await dialog.getByTestId("bad-debt-submit").click();
  await expect(toast(page, lang === "ar" ? "شُطب الدين — وطُلب إعفاء الضريبة" : "Written off — VAT relief claimed")).toBeVisible();
  const after = await invoice(inv.id);
  expect(after.writtenOffAmount).toBe(inv.total - inv.paidAmount);
  expect(after.badDebtRelief?.source).toBe("recorded");
  await expect(page.getByTestId(`type-written-off-${inv.id}`)).toBeVisible();
  await expect(page.getByTestId(`due-${inv.id}`)).toContainText("0.00");
  return after;
}

async function declareRecoveryFromList(page: Page, inv: Invoice, rcpt: Payment, amount: number, lang: "en" | "ar"): Promise<Invoice> {
  await findRow(page, inv.id);
  await page.getByTestId(`declare-recovery-${inv.id}`).click();
  const dialog = page.getByTestId("bad-debt-recovery-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("bad-debt-recovery-payment").click();
  await page.getByTestId(`bad-debt-recovery-payment-${rcpt.id}`).click();
  await dialog.getByTestId("bad-debt-recovery-amount").fill(String(amount));
  await dialog.getByTestId("bad-debt-recovery-submit").click();
  await expect(toast(page, lang === "ar" ? "أُنشئت مسودة فاتورة الاسترداد" : "Recovery invoice drafted")).toBeVisible();
  const drafts = ((await (await api.get(`/api/invoices?status=draft&limit=50`)).json()) as { items: Invoice[] }).items;
  const draft = drafts.find((d) => d.recoversInvoiceId === inv.id && d.recoveryPaymentId === rcpt.id)!;
  expect(draft.documentType).toBe("recovery_invoice");
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByTestId(`type-recovery-${draft.id}`)).toBeVisible();
  await expect(page.getByTestId(`due-${draft.id}`)).toContainText("—");
  return draft;
}

test.describe("Bad debts — English / desktop", () => {
  test("🔴 write off with relief → badge and no amount due → a receipt on account → declare the Art. 40(9) recovery → the draft's type badge → approved: VAT payable again; the return shows the relief in box 7 and the recovery in box 6", async ({ page }) => {
    const inv = await seedOldInvoice(2_000);
    const written = await writeOffFromList(page, inv, "en");
    expect(written.badDebtRelief?.vatAmount).toBe(300);
    const period = written.badDebtRelief!.claimedOn.slice(0, 7);
    const now = await vatReturn(period);
    // the relief sits in box 7 of ITS period (a business-day period — Riyadh, not the browser's UTC month)
    expect(now.salesSection.box7_vatAdjustments).toBeLessThanOrEqual(-300);
    expect(now.salesSection.badDebtReliefs.map((r) => r.invoiceNumber)).toContain(inv.invoiceNumber);
    const rcpt = await seedReceiptOnAccount(1_150, written.badDebtRelief!.claimedOn);
    expect(rcpt.liabilityAccountCode).toBe("UNIDENTIFIED_RECEIPTS");
    const draft = await declareRecoveryFromList(page, written, rcpt, 1_150, "en");
    expect(draft.total).toBe(1_150);
    expect(draft.vatAmount).toBe(150);
    const ap = await api.post(`/api/invoices/${draft.id}/approve`);
    expect(ap.ok(), await ap.text()).toBe(true);
    const issued = await invoice(draft.id);
    expect(issued.status).toBe("paid");
    expect(issued.icv).not.toBeNull();
    expect((await payment(rcpt.id)).unappliedAmount).toBe(0);
    const after = await vatReturn(period);
    expect(after.salesSection.box6_vatOnStandardRatedSales).toBe(Math.round((now.salesSection.box6_vatOnStandardRatedSales + 150) * 100) / 100);
  });
});

test.describe("Bad debts — English / phone", () => {
  test.use({ viewport: PHONE });
  test("🔴 both dialogs fit the phone; the list carries the badges without sideways scroll", async ({ page }) => {
    const inv = await seedOldInvoice(1_000);
    await findRow(page, inv.id);
    await page.getByTestId(`write-off-${inv.id}`).click();
    const dialog = page.getByTestId("bad-debt-write-off-dialog");
    await expectFits(dialog, PHONE.width, "the write-off dialog fits the phone");
    await dialog.getByTestId("bad-debt-certificate").fill("CA-E2E-P");
    await dialog.getByTestId("bad-debt-submit").click();
    await expect(toast(page, "Written off — VAT relief claimed")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "the invoices list after the write-off");
    const rcpt = await seedReceiptOnAccount(575, (await invoice(inv.id)).badDebtRelief!.claimedOn);
    await findRow(page, inv.id);
    await page.getByTestId(`declare-recovery-${inv.id}`).click();
    const rd = page.getByTestId("bad-debt-recovery-dialog");
    await expectFits(rd, PHONE.width, "the recovery dialog fits the phone");
    await rd.getByTestId("bad-debt-recovery-payment").click();
    await page.getByTestId(`bad-debt-recovery-payment-${rcpt.id}`).click();
    await rd.getByTestId("bad-debt-recovery-amount").fill("575");
    await rd.getByTestId("bad-debt-recovery-submit").click();
    await expect(toast(page, "Recovery invoice drafted")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "the invoices list with the recovery draft");
  });
});

async function switchToArabic(page: Page) {
  await page.getByRole("button", { name: /^ع$/ }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
}
async function switchToArabicOnPhone(page: Page) {
  await page.getByTestId("nav-hamburger").click();
  const drawer = page.getByTestId("nav-drawer");
  await drawer.getByRole("button", { name: /^ع$/ }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await drawer.getByRole("button", { name: "إغلاق القائمة" }).click();
  await expect(drawer).toHaveCount(0);
}

test.describe("Bad debts — Arabic / RTL desktop", () => {
  test("🔴 the same workflow in Arabic under dir=rtl", async ({ page }) => {
    const inv = await seedOldInvoice(1_500);
    await page.goto("/invoices", { waitUntil: "networkidle" });
    await switchToArabic(page);
    const written = await writeOffFromList(page, inv, "ar");
    await expect(page.getByTestId(`type-written-off-${inv.id}`)).toContainText("مشطوبة");
    const rcpt = await seedReceiptOnAccount(1_150, written.badDebtRelief!.claimedOn);
    const draft = await declareRecoveryFromList(page, written, rcpt, 1_150, "ar");
    await expect(page.getByTestId(`type-recovery-${draft.id}`)).toContainText("استرداد");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });
});

test.describe("Bad debts — Arabic / RTL phone", () => {
  test.use({ viewport: PHONE });
  test("🔴 Arabic on a phone: the dialogs fit and work; no sideways scroll", async ({ page }) => {
    const inv = await seedOldInvoice(800);
    await page.goto("/invoices", { waitUntil: "networkidle" });
    await switchToArabicOnPhone(page);
    await findRow(page, inv.id);
    await page.getByTestId(`write-off-${inv.id}`).click();
    const dialog = page.getByTestId("bad-debt-write-off-dialog");
    await expectFits(dialog, PHONE.width, "the Arabic write-off dialog fits the phone");
    await dialog.getByTestId("bad-debt-certificate").fill("CA-E2E-AR");
    await dialog.getByTestId("bad-debt-submit").click();
    await expect(toast(page, "شُطب الدين — وطُلب إعفاء الضريبة")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "the Arabic invoices list after the write-off");
    const rcpt = await seedReceiptOnAccount(460, (await invoice(inv.id)).badDebtRelief!.claimedOn);
    await findRow(page, inv.id);
    await page.getByTestId(`declare-recovery-${inv.id}`).click();
    const rd = page.getByTestId("bad-debt-recovery-dialog");
    await expectFits(rd, PHONE.width, "the Arabic recovery dialog fits the phone");
    await rd.getByTestId("bad-debt-recovery-payment").click();
    await page.getByTestId(`bad-debt-recovery-payment-${rcpt.id}`).click();
    await rd.getByTestId("bad-debt-recovery-amount").fill("460");
    await rd.getByTestId("bad-debt-recovery-submit").click();
    await expect(toast(page, "أُنشئت مسودة فاتورة الاسترداد")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "the Arabic list with the recovery draft");
  });
});
