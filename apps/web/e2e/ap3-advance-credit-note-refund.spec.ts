/**
 * AP-3 — THE CREDIT NOTE AGAINST AN ADVANCE TAX INVOICE AND THE REFUND IT
 * UNLOCKS, WALKED BY CLICKING (2026-09-21). Decision record:
 * docs/product/advance-payments-decision-pack.md §15.
 *
 * Door C, on the real pages: an advance is received and invoiced (AP-2's
 * card) → the receipt card shows the 386 as "Issued · open", NO Refund
 * control and the hint that says why → *Credit note* → the dialog (amount,
 * the VAT that returns to the deposit, the reason ZATCA requires) → a draft
 * row under the 386 → *Approve & issue* → the 386 reads "Cancelled", the
 * note "Issued", "Not yet invoiced" rises → the Refund control appears →
 * the ordinary refund dialog → the receipt at zero. Every effect is read
 * back from the API (E5's GL, the note's document, the 386 untouched). Then
 * a phone, then Arabic on both.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";
import { businessToday } from "@workspace/shared";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };

type Note = { id: number; invoiceNumber: string; status: string; date: string; total: number; vatAmount: number; noteReason: string | null };
type Adv = { id: number; invoiceNumber: string; status: string; total: number; vatAmount: number; openAmount: number; adjustedAmount: number; creditedAmount: number; creditNotes: Note[] };
type Payment = { id: number; amount: number; unappliedAmount: number; refundedAmount: number; advanceInvoicedAmount: number; advanceOpenAmount: number; uninvoicedAmount: number; advanceInvoices: Adv[] };
type Invoice = { id: number; invoiceNumber: string; status: string; documentType: string; originalInvoiceId: number | null; noteReason: string | null; total: number; subtotal: number; vatAmount: number; icv: number | null; invoiceHash: string | null };
type Statement = { lines: Array<{ kind: string; documentNumber: string; reference: string | null; receivableDelta: number; creditDelta: number; depositDelta: number }>; reconciled: boolean };

let api: APIRequestContext;
let ids: SeededIds;

const toast = (page: Page, title: string) => page.getByText(title, { exact: true }).first();
async function pickOption(page: Page, trigger: ReturnType<Page["getByTestId"]>, optionText: RegExp) {
  await trigger.click();
  await page.getByRole("option", { name: optionText }).click();
}
const payment = async (id: number): Promise<Payment> => (await api.get(`/api/payments/${id}`)).json();
const invoice = async (id: number): Promise<Invoice> => (await api.get(`/api/invoices/${id}`)).json();
const statement = async (): Promise<Statement> => (await api.get(`/api/customers/${ids.customerId}/statement`)).json();
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

// The BUSINESS day (Asia/Riyadh), never the runner's UTC date: between 21:00 and 00:00 UTC they differ, and a document dated the UTC day sorts BEFORE a receipt the product dated the Riyadh day — the night window (findings file), seen as a −5 deposit on main's CI statement.
const TODAY = businessToday();

/** Door B's front half through the API (AP-2's spec walks it by clicking): a classified advance, and an issued 386 for all of it. */
async function seedInvoicedAdvance(amount: number): Promise<{ paymentId: number; advanceId: number }> {
  const rec = await api.post(`/api/payments`, { data: { customerId: ids.customerId, amount, paidAt: TODAY, bankAccountId: ids.bankId, reference: `AP3-RCPT-${Date.now()}`, classification: "advance", vatCategory: "S" } });
  if (!rec.ok()) throw new Error(`seed receipt: ${await rec.text()}`);
  const p = (await rec.json()) as Payment;
  const d = await api.post(`/api/payments/${p.id}/advance-invoices`, { data: { amount } });
  if (!d.ok()) throw new Error(`seed 386: ${await d.text()}`);
  const draft = (await d.json()) as Invoice;
  const ap = await api.post(`/api/invoices/${draft.id}/approve`);
  if (!ap.ok()) throw new Error(`seed approve: ${await ap.text()}`);
  return { paymentId: p.id, advanceId: draft.id };
}

async function openReceipt(page: Page, paymentId: number) {
  await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
  const toggle = page.getByTestId(`payment-toggle-${paymentId}`);
  await expect(toggle).toBeVisible();
  await toggle.click();
  const detail = page.getByTestId(`payment-detail-${paymentId}`);
  await expect(detail).toBeVisible();
  return detail;
}

/** Cancel the 386 from the card: the dialog → a draft note under the 386 → Approve & issue. Returns the note. */
async function cancelFromCard(page: Page, paymentId: number, advanceId: number, lang: "en" | "ar", amount?: number): Promise<Note> {
  const detail = await openReceipt(page, paymentId);
  // no refund door yet, and the hint says why
  await expect(detail.getByTestId(`refund-deposit-${paymentId}`)).toHaveCount(0);
  await expect(detail.getByTestId(`advance-open-hint-${paymentId}`)).toBeVisible();
  await expect(page.getByTestId(`advance-invoice-${advanceId}`)).toContainText(lang === "ar" ? "صادرة · متبقٍ" : "Issued · open");
  await page.getByTestId(`credit-advance-${advanceId}`).click();
  const dialog = page.getByTestId("advance-credit-note-dialog");
  await expect(dialog).toBeVisible();
  if (amount != null) await dialog.getByTestId("advance-cn-amount").fill(String(amount));
  await expect(dialog.getByTestId("advance-cn-split")).toBeVisible();
  // the reason is required: nothing happens without one
  await expect(dialog.getByTestId("advance-cn-submit")).toBeDisabled();
  await dialog.getByTestId("advance-cn-reason").fill(lang === "ar" ? "إلغاء الطلب" : "Order cancelled");
  await dialog.getByTestId("advance-cn-submit").click();
  await expect(toast(page, lang === "ar" ? "أُنشئت مسودة الإشعار الدائن" : "Credit note drafted")).toBeVisible();
  await expect(dialog).toBeHidden();
  const p = await payment(paymentId);
  const draft = p.advanceInvoices.find((a) => a.id === advanceId)!.creditNotes.find((n) => n.status === "draft");
  if (!draft) throw new Error("e2e: no draft note under the 386");
  expect(p.uninvoicedAmount, "a draft note unlocks nothing").toBe(0);
  await expect(page.getByTestId(`advance-credit-note-${draft.id}`)).toHaveAttribute("data-status", "draft");
  await page.getByTestId(`approve-advance-credit-note-${draft.id}`).click();
  await expect(toast(page, lang === "ar" ? "صدر الإشعار الدائن — أُلغيت الدفعة المقدمة" : "Credit note issued — the advance is cancelled")).toBeVisible();
  await expect(page.getByTestId(`advance-credit-note-${draft.id}`)).toHaveAttribute("data-status", "sent");
  return (await payment(paymentId)).advanceInvoices.find((a) => a.id === advanceId)!.creditNotes.find((n) => n.id === draft.id)!;
}

/** The ordinary refund dialog, now offered: refund the whole un-invoiced remainder. */
async function refundFromCard(page: Page, paymentId: number, amount: number, lang: "en" | "ar") {
  await expect(page.getByTestId(`refund-deposit-${paymentId}`)).toBeVisible();
  await page.getByTestId(`refund-deposit-${paymentId}`).click();
  const dialog = page.getByTestId("refund-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("refund-amount").fill(String(amount));
  await pickOption(page, dialog.getByTestId("refund-bank-account"), /E2E Current Account/);
  await dialog.getByTestId("refund-reason").fill(lang === "ar" ? "إعادة الدفعة المقدمة" : "Advance returned");
  await dialog.getByTestId("refund-continue").click();
  await dialog.getByTestId("refund-confirm").click();
  await expect(toast(page, lang === "ar" ? "تم تسجيل الردّ" : "Refund recorded")).toBeVisible();
  await expect(dialog).toBeHidden();
}

test.describe("AP-3 — English desktop", () => {
  test("🔴 an invoiced advance has no refund door → credit note (draft, approve) → the 386 reads Cancelled, the note Issued, the deposit un-invoiced again → the refund door opens → the receipt ends at zero; E5 posted; 386, receipt and note preserved", async ({ page }) => {
    const { paymentId, advanceId } = await seedInvoicedAdvance(1150);
    const advBefore = await invoice(advanceId);
    const refused = await api.post(`/api/payments/refunds`, { data: { customerId: ids.customerId, origin: "deposit", paymentId, amount: 1150, bankAccountId: ids.bankId, reason: "x" } });
    expect(refused.status(), "no refund before the note").toBe(409);
    expect((await refused.json()).code).toBe("advance_invoiced_requires_prepayment_adjustment");

    const note = await cancelFromCard(page, paymentId, advanceId, "en");
    expect(note.total).toBe(1150);
    expect(note.vatAmount).toBe(150);
    expect(note.noteReason).toBe("Order cancelled");
    const noteDoc = await invoice(note.id);
    expect(noteDoc.documentType).toBe("advance_credit_note");
    expect(noteDoc.originalInvoiceId).toBe(advanceId);
    expect(noteDoc.icv).not.toBeNull();
    const p1 = await payment(paymentId);
    expect(p1.advanceOpenAmount).toBe(0);
    expect(p1.uninvoicedAmount).toBe(1150);
    expect(p1.advanceInvoices[0]).toMatchObject({ creditedAmount: 1150, openAmount: 0, adjustedAmount: 0 });
    await expect(page.getByTestId(`advance-invoice-${advanceId}`)).toContainText("Cancelled");
    await expect(page.getByTestId(`advance-credited-${advanceId}`)).toContainText("1,150.00");
    await expect(page.getByTestId(`advance-uninvoiced-${paymentId}`)).toContainText("1,150.00");
    await expect(page.getByTestId(`credit-advance-${advanceId}`)).toHaveCount(0); // nothing left to credit
    // the 386 is untouched: same number, ICV, hash, status
    const advAfter = await invoice(advanceId);
    expect(advAfter).toMatchObject({ status: advBefore.status, icv: advBefore.icv, invoiceHash: advBefore.invoiceHash, total: advBefore.total });

    await refundFromCard(page, paymentId, 1150, "en");
    const p2 = await payment(paymentId);
    expect(p2.unappliedAmount).toBe(0);
    expect(p2.refundedAmount).toBe(1150);
    expect(p2.amount).toBe(1150);
    await expect(page.getByTestId(`payment-unapplied`).first()).toContainText("0.00");
    // the chain on the statement: receipt → 386 → note (zero movement) → refund, reconciled
    const stmt = await statement();
    const noteLine = stmt.lines.find((l) => l.kind === "advance_credit_note" && l.documentNumber === note.invoiceNumber)!;
    expect(noteLine).toBeTruthy();
    expect(noteLine.reference).toBe(advBefore.invoiceNumber);
    expect([noteLine.receivableDelta, noteLine.creditDelta, noteLine.depositDelta]).toEqual([0, 0, 0]);
    expect(stmt.reconciled).toBe(true);
    // the Invoices list carries the note's type badge; nothing is due on it
    await page.goto("/invoices", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`type-advance-cn-${note.id}`)).toContainText("Credit note — advance");
    await expect(page.getByTestId(`due-${note.id}`)).toContainText("—");
    // an ordinary credit note against the 386 is still refused
    const ordinary = await api.post(`/api/invoices`, { data: { date: TODAY, customerId: ids.customerId, documentType: "credit_note", originalInvoiceId: advanceId, noteReason: "x", items: [{ description: "x", quantity: 1, unitPrice: 10, vatRate: 15 }] } });
    expect(ordinary.status()).toBe(409);
    expect((await ordinary.json()).code).toBe("note_original_is_advance_invoice");
  });

  test("🔴 PARTIAL cancellation: credit 575 of 1,150 → only 575 is refundable; the other 575 stays open (still applicable on a final invoice); a second note beyond it is refused", async ({ page }) => {
    const { paymentId, advanceId } = await seedInvoicedAdvance(1150);
    const note = await cancelFromCard(page, paymentId, advanceId, "en", 575);
    expect(note.total).toBe(575);
    expect(note.vatAmount).toBe(75);
    const p1 = await payment(paymentId);
    expect(p1.uninvoicedAmount).toBe(575);
    expect(p1.advanceOpenAmount).toBe(575);
    await expect(page.getByTestId(`advance-invoice-${advanceId}`)).toContainText("Issued · open");
    await expect(page.getByTestId(`credit-advance-${advanceId}`)).toBeVisible();
    const over = await api.post(`/api/payments/refunds`, { data: { customerId: ids.customerId, origin: "deposit", paymentId, amount: 600, bankAccountId: ids.bankId, reason: "x" } });
    expect(over.status()).toBe(409);
    await refundFromCard(page, paymentId, 575, "en");
    expect((await payment(paymentId)).unappliedAmount).toBe(575);
    const tooMuch = await api.post(`/api/invoices/${advanceId}/advance-credit-notes`, { data: { amount: 576, reason: "x" } });
    expect(tooMuch.status()).toBe(409);
    expect((await tooMuch.json()).code).toBe("advance_credit_note_exceeds_open");
    // leave the customer as found: the open 575 is applied on a final invoice (door B)
    const fin = await api.post(`/api/invoices`, { data: { date: TODAY, customerId: ids.customerId, items: [{ description: "e2e settle", quantity: 1, unitPrice: 500, vatRate: 15 }], prepayments: [{ advanceInvoiceId: advanceId, amount: 575 }] } });
    if (!fin.ok()) throw new Error(await fin.text());
    const ap = await api.post(`/api/invoices/${((await fin.json()) as Invoice).id}/approve`);
    if (!ap.ok()) throw new Error(await ap.text());
    expect((await payment(paymentId)).unappliedAmount).toBe(0);
  });
});

test.describe("AP-3 — English phone", () => {
  test.use({ viewport: PHONE });
  test("🔴 cancel and refund from a phone: the credit-note dialog and the card fit; no sideways scroll", async ({ page }) => {
    const { paymentId, advanceId } = await seedInvoicedAdvance(230);
    const detail = await openReceipt(page, paymentId);
    await expectFits(detail.getByTestId(`advance-invoices-${paymentId}`), PHONE.width, "the advance section fits the phone");
    await page.getByTestId(`credit-advance-${advanceId}`).click();
    const dialog = page.getByTestId("advance-credit-note-dialog");
    await expectFits(dialog, PHONE.width, "the credit-note dialog fits the phone");
    await dialog.getByTestId("advance-cn-reason").fill("Order cancelled");
    await dialog.getByTestId("advance-cn-submit").click();
    await expect(toast(page, "Credit note drafted")).toBeVisible();
    await expect(dialog).toBeHidden();
    await noSidewaysScroll(page, PHONE.width, "customer page with a draft note on a phone");
    const draft = (await payment(paymentId)).advanceInvoices[0]!.creditNotes[0]!;
    await page.getByTestId(`approve-advance-credit-note-${draft.id}`).click();
    await expect(toast(page, "Credit note issued — the advance is cancelled")).toBeVisible();
    await expectFits(page.getByTestId(`refund-deposit-${paymentId}`), PHONE.width, "the refund control appears inside the viewport");
    await refundFromCard(page, paymentId, 230, "en");
    await noSidewaysScroll(page, PHONE.width, "customer page after the refund on a phone");
    expect((await payment(paymentId)).unappliedAmount).toBe(0);
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

test.describe("AP-3 — Arabic / RTL desktop", () => {
  test("🔴 the same door in Arabic under dir=rtl: the card's states, the credit-note dialog, the refund", async ({ page }) => {
    const { paymentId, advanceId } = await seedInvoicedAdvance(1150);
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    await switchToArabic(page);
    const note = await cancelFromCard(page, paymentId, advanceId, "ar");
    expect(note.noteReason).toBe("إلغاء الطلب");
    await expect(page.getByTestId(`advance-invoice-${advanceId}`)).toContainText("مُلغاة");
    await expect(page.getByTestId(`advance-credit-note-${note.id}`)).toContainText("إشعار دائن");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await refundFromCard(page, paymentId, 1150, "ar");
    expect((await payment(paymentId)).unappliedAmount).toBe(0);
    await page.goto("/invoices", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`type-advance-cn-${note.id}`)).toContainText("إشعار دائن — دفعة مقدمة");
  });
});

test.describe("AP-3 — Arabic / RTL phone", () => {
  test.use({ viewport: PHONE });
  test("🔴 Arabic on a phone: the credit-note dialog fits and issues; the refund follows; no sideways scroll", async ({ page }) => {
    const { paymentId, advanceId } = await seedInvoicedAdvance(460);
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    await switchToArabicOnPhone(page);
    await openReceipt(page, paymentId);
    await page.getByTestId(`credit-advance-${advanceId}`).click();
    const dialog = page.getByTestId("advance-credit-note-dialog");
    await expectFits(dialog, PHONE.width, "the Arabic credit-note dialog fits the phone");
    await expect(dialog.getByRole("heading", { name: "إلغاء الدفعة المقدمة — إشعار دائن" })).toBeVisible();
    await dialog.getByTestId("advance-cn-reason").fill("إلغاء الطلب");
    await dialog.getByTestId("advance-cn-submit").click();
    await expect(toast(page, "أُنشئت مسودة الإشعار الدائن")).toBeVisible();
    await expect(dialog).toBeHidden();
    const draft = (await payment(paymentId)).advanceInvoices[0]!.creditNotes[0]!;
    await page.getByTestId(`approve-advance-credit-note-${draft.id}`).click();
    await expect(toast(page, "صدر الإشعار الدائن — أُلغيت الدفعة المقدمة")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "customer page in Arabic on a phone after the note");
    await refundFromCard(page, paymentId, 460, "ar");
    await noSidewaysScroll(page, PHONE.width, "customer page in Arabic on a phone after the refund");
    expect((await payment(paymentId)).unappliedAmount).toBe(0);
  });
});
