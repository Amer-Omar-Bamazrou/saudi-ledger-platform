/**
 * PHASE 13 — EVIDENCE INTEGRITY AND EXPENSES, WALKED BY CLICKING (2026-09-24).
 *
 *  · 🔴 a scanned document becomes a DRAFT — the scan and the review never
 *    post; the PDF is stored and linked as the draft's evidence;
 *  · 🔴 a document that is NOT a tax invoice is HELD (accountant X1): it lands
 *    on the VAT evidence list saying why; POSTING it by clicking puts its VAT
 *    in "Input VAT awaiting evidence" — no return claims it; supplying the
 *    evidence by clicking claims it on the EVIDENCE day, in that period only,
 *    and takes it off the list;
 *  · 🔴 an expense recorded by clicking is posted AND paid from the named bank
 *    in one step — no payable left; one without evidence is ALSO posted and
 *    paid, its VAT held and listed;
 *  · 🔴 a supplier CREDIT note on held VAT, recorded and posted by clicking,
 *    reduces the held amount — no return moves — and the later claim is the
 *    NET; an evidence date before the supply is refused in the dialog;
 *  · 🔴 Art. 50 (X5): an expense on a blocked account posts and pays with its
 *    VAT in the cost — neither input VAT account moves, nothing is held;
 *  · 🔴 a possible DUPLICATE is warned about in the form and still saves;
 *  · the GL figures behind each (trial balance, by account);
 *  · Arabic (RTL) on desktop and on a phone, English on desktop and on a
 *    phone — no sideways scroll.
 * Money is asserted exactly from the API, never by substring.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");

let api: APIRequestContext;
let vendorId = 0, bankId = 0;

const bills = async (q: string) =>
  ((await (await api.get(`/api/bills?limit=200`)).json()).items as Array<{ id: number; billNumber: string; vendorReference: string | null; status: string }>)
    .filter((b) => b.vendorReference === q);
const bill = async (id: number) => (await api.get(`/api/bills/${id}`)).json();
/** Box 13 (input VAT) of one month's return, e.g. "2026-09". */
const vatInputOf = async (month: string) => Number((await (await api.get(`/api/reports/vat-return?period_from=${month}&period_to=${month}`)).json()).purchasesSection.box13_recoverableInputVat);
const vatInput = () => vatInputOf("2026-09");

/** An account's balance (debit − credit) on the trial balance, by the name its lines carry; 0 when it has none. */
const gl = async (name: string) => {
  const tb = await (await api.get(`/api/reports/trial-balance`)).json() as { accounts: Array<{ name: string; balance: number }> };
  return tb.accounts.filter((a) => a.name === name).reduce((sum, a) => sum + Number(a.balance), 0);
};
const INPUT_VAT = "Input VAT Receivable";
const HELD_VAT = "Input VAT awaiting evidence";

async function pick(page: Page, testId: string, option: RegExp) {
  await page.getByTestId(testId).click();
  await page.getByRole("option", { name: option }).first().click();
}

/** Upload a PDF through the scan dialog and land on the review page. */
async function scanPdf(page: Page, name: string) {
  await page.goto("/bills");
  await page.getByRole("button", { name: /Scan Receipt/i }).click();
  await page.getByTestId("scan-file-input").setInputFiles({ name, mimeType: "application/pdf", buffer: Buffer.concat([PDF, Buffer.from(name)]) });
  await expect(page.getByTestId("scan-manual-ready")).toBeVisible();
  await page.getByTestId("scan-use-fields").click();
  await expect(page).toHaveURL(/\/scan-review\?capture=/);
}

async function typeReceipt(page: Page, ref: string, subtotal: string, vat: string, total: string, date = "2026-09-10") {
  await pick(page, "scan-vendor-select", /E2E Vendor/);
  await page.getByTestId("scan-invoice-number").fill(ref);
  await page.getByTestId("scan-date").fill(date);
  await page.getByTestId("scan-subtotal").fill(subtotal);
  await page.getByTestId("scan-vat").fill(vat);
  await page.getByTestId("scan-total").fill(total);
}

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const ids = JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds;
  vendorId = ids.vendorId;
  bankId = ids.bankId;
});
test.afterAll(async () => { await api.dispose(); });

test.describe.serial("Phase 13 — evidence integrity and expenses, by clicking", () => {
  const REF_OK = `SCAN-OK-${STAMP}`;
  const REF_HELD = `SCAN-HELD-${STAMP}`;

  test("🔴 a scanned PDF becomes a DRAFT with its document linked — the review saves, it never posts", async ({ page }) => {
    const vat0 = await vatInput();
    await scanPdf(page, `invoice-${STAMP}.pdf`);
    await typeReceipt(page, REF_OK, "400.00", "60.00", "460.00");
    await page.getByTestId("doc-kind-tax_invoice").check();
    await expect(page.getByTestId("vat-evidence-panel")).toHaveAttribute("data-status", "evidenced");
    await page.getByTestId("scan-save-draft").click();
    await expect(page).toHaveURL(/\/bills/);

    const [b] = await bills(REF_OK);
    expect(b, "the draft exists").toBeTruthy();
    expect(b!.status, "saved as a DRAFT — nothing posted").toBe("draft");
    const full = await bill(b!.id);
    expect(full.vatEvidence.status).toBe("evidenced");
    expect(full.evidenceDocument).toMatchObject({ contentType: "application/pdf", source: "manual", status: "staged" });
    expect(await vatInput(), "no input VAT was claimed by scanning or saving").toBe(vat0);

    // posting is the ordinary Post, by clicking — and only then is the VAT claimed
    await page.goto("/bills?status=draft");
    await page.getByRole("row", { name: new RegExp(b!.billNumber) }).getByRole("button", { name: /^Post$/ }).click();
    await page.getByRole("button", { name: /Confirm & Post/ }).click();
    await expect.poll(async () => (await bill(b!.id)).status).toBe("received");
    expect(await vatInput() - vat0).toBeCloseTo(60, 2);
    expect((await bill(b!.id)).evidenceDocument.status, "the document became the posted bill's evidence").toBe("promotion_pending");
  });

  test("🔴 X1: a document that is NOT a tax invoice is HELD — listed with its reason; POSTED by clicking, its VAT is held off every return; supplying the evidence by clicking claims it on the evidence day", async ({ page }) => {
    // Dated in February so the evidence day (today) falls in a DIFFERENT period.
    const SUPPLY_MONTH = "2026-02";
    const feb0 = await vatInputOf(SUPPLY_MONTH);
    await scanPdf(page, `receipt-${STAMP}.pdf`);
    await typeReceipt(page, REF_HELD, "100.00", "15.00", "115.00", "2026-02-10");
    await page.getByTestId("doc-kind-no_tax_invoice").check();
    await expect(page.getByTestId("vat-evidence-panel")).toHaveAttribute("data-status", "awaiting_evidence");
    await expect(page.getByTestId("vat-evidence-reasons").locator('[data-code="no_tax_invoice"]')).toBeVisible();
    await page.getByTestId("scan-save-draft").click();
    await expect(page).toHaveURL(/\/vat-evidence/);

    const [held] = await bills(REF_HELD);
    await expect(page.getByTestId(`held-row-${held!.id}`)).toBeVisible();
    await expect(page.getByTestId(`held-row-${held!.id}`).locator('[data-code="no_tax_invoice"]')).toBeVisible();
    expect((await bill(held!.id)).status).toBe("draft");
    expect(await vatInputOf(SUPPLY_MONTH), "a draft claims nothing").toBe(feb0);

    // POST it by clicking — the ordinary Post. It posts; its VAT is HELD.
    await page.goto("/bills?status=draft");
    await page.getByRole("row", { name: new RegExp(held!.billNumber) }).getByRole("button", { name: /^Post$/ }).click();
    await expect(page.getByTestId("je-preview-vat-account"), "the preview names the account the VAT will really go to").toHaveText("Input VAT awaiting evidence");
    const glBefore = { input: await gl(INPUT_VAT), held: await gl(HELD_VAT) };
    await page.getByRole("button", { name: /Confirm & Post/ }).click();
    await expect.poll(async () => (await bill(held!.id)).status).toBe("received");
    expect((await bill(held!.id)).inputVat).toMatchObject({ state: "awaiting_evidence", pending: 15, claimedOn: null });
    expect(await vatInputOf(SUPPLY_MONTH), "held VAT is on no return").toBe(feb0);
    expect(await gl(HELD_VAT) - glBefore.held, "GL: the VAT sits in the holding asset").toBeCloseTo(15, 2);
    expect(await gl(INPUT_VAT) - glBefore.input, "GL: Input VAT does not move").toBeCloseTo(0, 2);

    // X3 — a supplier CREDIT note on the HELD VAT, recorded and posted by clicking
    const NOTE_NO = `SCN-${STAMP}`;
    await page.goto("/supplier-credit-notes");
    await page.getByTestId("new-supplier-note").click();
    await page.getByTestId("note-against-bill").click();
    await page.getByRole("option", { name: new RegExp(held!.billNumber) }).click();
    await page.getByTestId("note-number").fill(NOTE_NO);
    await page.getByTestId("note-date").fill("2026-02-15");
    await page.getByTestId("note-subtotal").fill("20");
    await page.getByTestId("note-vat").fill("3");
    await page.getByTestId("note-submit").click();
    await expect(page.getByTestId("new-supplier-note-dialog")).toHaveCount(0);
    const note = ((await (await api.get("/api/supplier-credit-notes")).json()).items as Array<{ id: number; billNumber: string }>).find((n) => n.billNumber === NOTE_NO)!;
    await page.getByTestId(`approve-note-${note.id}`).click();
    await expect.poll(async () => (await bill(note.id)).status).not.toBe("draft");
    expect((await bill(note.id)).inputVat.state, "the note follows its held original").toBe("awaiting_evidence");
    expect((await bill(held!.id)).inputVat.pending, "the original now holds the NET").toBe(12);
    expect(await gl(HELD_VAT) - glBefore.held, "GL: the note reduced the HELD VAT").toBeCloseTo(12, 2);
    expect(await gl(INPUT_VAT) - glBefore.input, "GL: never Input VAT").toBeCloseTo(0, 2);
    expect(await vatInputOf(SUPPLY_MONTH), "no return entry for the note").toBe(feb0);

    // the list shows it POSTED with its VAT held; supply the evidence by clicking
    await page.goto(`/vat-evidence?q=${encodeURIComponent(REF_HELD)}`);
    await expect(page.getByTestId(`held-state-${held!.id}`)).toContainText("VAT held");
    await page.getByTestId(`held-supply-${held!.id}`).click();
    await expect(page.getByTestId("posted-evidence-dialog")).toBeVisible();
    await pick(page, "posted-evidence-kind", /^Tax invoice$/);
    const evidenceDay = await page.getByTestId("posted-evidence-date").inputValue();
    // the evidence date: before the supply is REFUSED, and nothing moves
    await page.getByTestId("posted-evidence-date").fill("2026-02-01");
    await page.getByTestId("posted-evidence-submit").click();
    await expect(page.getByText("Could not record the evidence", { exact: true })).toBeVisible();
    expect((await bill(held!.id)).inputVat).toMatchObject({ state: "awaiting_evidence", pending: 12 });
    await page.getByTestId("posted-evidence-date").fill(evidenceDay);
    const claimMonth = evidenceDay.slice(0, 7);
    const claim0 = await vatInputOf(claimMonth);
    await page.getByTestId("posted-evidence-submit").click();
    await expect.poll(async () => (await bill(held!.id)).inputVat.state).toBe("claimed");
    expect((await bill(held!.id)).inputVat).toMatchObject({ state: "claimed", pending: 0, claimedOn: evidenceDay });
    expect((await bill(note.id)).inputVat).toMatchObject({ state: "claimed", claimedOn: evidenceDay });
    expect(await vatInputOf(claimMonth) - claim0, "the NET is claimed in the EVIDENCE period").toBeCloseTo(12, 2);
    expect(await vatInputOf(SUPPLY_MONTH), "no prior-period correction").toBe(feb0);
    expect(await gl(INPUT_VAT) - glBefore.input, "GL: Dr Input VAT, the net").toBeCloseTo(12, 2);
    expect(await gl(HELD_VAT) - glBefore.held, "GL: nothing left held").toBeCloseTo(0, 2);
    await page.goto("/vat-evidence");
    await expect(page.getByTestId(`held-row-${held!.id}`)).toHaveCount(0);
  });

  test("🔴 an expense recorded by clicking is posted AND paid from the named bank — nothing left owing", async ({ page }) => {
    const ref = `EXP-${STAMP}`;
    await page.goto("/expenses");
    await expect(page.getByTestId("page-expenses")).toBeVisible();
    await page.getByTestId("record-expense").click();
    await pick(page, "expense-vendor", /E2E Vendor/);
    await pick(page, "expense-document-kind", /^Tax invoice$/);
    await page.getByTestId("expense-reference").fill(ref);
    await page.getByTestId("expense-subtotal").fill("200");
    await page.getByTestId("expense-vatAmount").fill("30");
    await page.getByTestId("expense-total").fill("230");
    await pick(page, "expense-bank", /E2E Current Account/);
    await page.getByTestId("expense-paid-at").fill("2026-09-12");
    await expect(page.getByTestId("vat-evidence-panel")).toHaveAttribute("data-status", "evidenced");
    await page.getByTestId("expense-save").click();

    await expect.poll(async () => (await bills(ref)).length).toBe(1);
    const [e] = await bills(ref);
    await expect.poll(async () => (await bill(e!.id)).status).toBe("paid");
    const full = await bill(e!.id);
    expect(full).toMatchObject({ recordedAsExpense: true, expensePaidFromBankAccountId: bankId, expensePaidAt: "2026-09-12", outstanding: 0 });
    const pays = await (await api.get(`/api/bills/${e!.id}/payments`)).json();
    expect(pays.map((p: { amount: number; paidAt: string }) => [p.amount, p.paidAt])).toEqual([[230, "2026-09-12"]]);
    await page.reload();
    await expect(page.getByTestId(`expense-payment-${e!.id}`)).toContainText("Paid");
  });

  test("🔴 X1: an expense with no tax invoice is posted AND paid — the supplier was paid — with its VAT HELD and listed", async ({ page }) => {
    const ref = `EXP-HELD-${STAMP}`;
    await page.goto("/expenses");
    await page.getByTestId("record-expense").click();
    await pick(page, "expense-vendor", /E2E Vendor/);
    await pick(page, "expense-document-kind", /Not a tax invoice/);
    await page.getByTestId("expense-reference").fill(ref);
    await page.getByTestId("expense-total").fill("57.50");
    await page.getByTestId("expense-subtotal").fill("50");
    await page.getByTestId("expense-vatAmount").fill("7.50");
    await pick(page, "expense-bank", /E2E Current Account/);
    await page.getByTestId("expense-save").click();
    await expect.poll(async () => (await bills(ref)).length).toBe(1);
    const [e] = await bills(ref);
    await expect.poll(async () => (await bill(e!.id)).status).toBe("paid");
    expect((await bill(e!.id)).inputVat).toMatchObject({ state: "awaiting_evidence", pending: 7.5 });
    const pays = await (await api.get(`/api/bills/${e!.id}/payments`)).json();
    expect(pays.map((p: { amount: number }) => p.amount), "paid the gross").toEqual([57.5]);
    await page.reload();
    await expect(page.getByTestId(`expense-held-${e!.id}`)).toContainText("VAT held");
  });

  test("🔴 X5: an expense on an Art. 50 BLOCKED account posts and pays with its VAT in the COST — neither input VAT account moves, nothing is held", async ({ page }) => {
    const ref = `EXP-MEAL-${STAMP}`;
    const before = { input: await gl(INPUT_VAT), held: await gl(HELD_VAT), meals: await gl("Food & Meals") };
    await page.goto("/expenses");
    await page.getByTestId("record-expense").click();
    await pick(page, "expense-vendor", /E2E Vendor/);
    await pick(page, "expense-document-kind", /^Tax invoice$/);
    await page.getByTestId("expense-reference").fill(ref);
    await page.getByTestId("expense-subtotal").fill("100");
    await page.getByTestId("expense-vatAmount").fill("15");
    await page.getByTestId("expense-total").fill("115");
    await pick(page, "expense-account", /Food & Meals/);
    await pick(page, "expense-bank", /E2E Current Account/);
    await expect(page.getByTestId("vat-evidence-panel")).toHaveAttribute("data-status", "not_deductible");
    await expect(page.getByTestId("vat-evidence-panel")).toContainText("part of the expense's cost");
    await page.getByTestId("expense-save").click();
    await expect.poll(async () => (await bills(ref)).length).toBe(1);
    const [e] = await bills(ref);
    await expect.poll(async () => (await bill(e!.id)).status).toBe("paid");
    expect((await bill(e!.id)).inputVat).toMatchObject({ state: "not_deductible", pending: 0 });
    expect(await gl("Food & Meals") - before.meals, "GL: the gross is the expense").toBeCloseTo(115, 2);
    expect(await gl(INPUT_VAT) - before.input, "GL: no input VAT").toBeCloseTo(0, 2);
    expect(await gl(HELD_VAT) - before.held, "GL: nothing held").toBeCloseTo(0, 2);
    await page.reload();
    await expect(page.getByTestId(`expense-vat-${e!.id}`)).toContainText("VAT in cost");
    await page.goto(`/vat-evidence?q=${encodeURIComponent(ref)}`);
    await expect(page.getByTestId(`held-row-${e!.id}`), "blocked VAT is not waiting for anything").toHaveCount(0);
  });

  test("🔴 a possible DUPLICATE is WARNED about in the form — and the document still saves", async ({ page }) => {
    const ref = `EXP-${STAMP}`; // the expense recorded above
    await page.goto("/expenses");
    await page.getByTestId("record-expense").click();
    await pick(page, "expense-vendor", /E2E Vendor/);
    await pick(page, "expense-document-kind", /^Tax invoice$/);
    await page.getByTestId("expense-reference").fill(ref);
    await page.getByTestId("expense-subtotal").fill("200");
    await page.getByTestId("expense-vatAmount").fill("30");
    await page.getByTestId("expense-total").fill("230");
    await pick(page, "expense-bank", /E2E Current Account/);
    await expect(page.getByTestId("duplicate-warning")).toBeVisible();
    await page.getByTestId("expense-save").click();
    await expect.poll(async () => (await bills(ref)).length, "a warning, never a refusal").toBe(2);
  });

  test("Arabic (RTL) on DESKTOP: a posted held document reads right-to-left, and its evidence dialog is Arabic", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    const [heldExpense] = await bills(`EXP-HELD-${STAMP}`);
    await page.goto("/vat-evidence");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.goto(`/vat-evidence?q=${encodeURIComponent(`EXP-HELD-${STAMP}`)}`);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId(`held-state-${heldExpense!.id}`)).toContainText("الضريبة محتجزة");
    await page.getByTestId(`held-supply-${heldExpense!.id}`).click();
    await expect(page.getByTestId("posted-evidence-dialog")).toContainText("استكمال الإثبات");
    await expect(page.getByTestId("posted-evidence-dialog")).toContainText("ضريبة مدخلات بانتظار الإثبات");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366 + 1);
    await page.keyboard.press("Escape");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
  });

  test("Arabic (RTL) on a phone: the VAT evidence list, the expenses page and a held reason — no sideways scroll", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/vat-evidence");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("page-vat-evidence")).toContainText("إثبات ضريبة المدخلات");
    expect(await page.evaluate(() => document.documentElement.scrollWidth), "no sideways scroll").toBeLessThanOrEqual(PHONE.width + 1);
    const [heldExpense] = await bills(`EXP-HELD-${STAMP}`);
    await page.goto(`/vat-evidence?q=${encodeURIComponent(`EXP-HELD-${STAMP}`)}`);
    await page.getByTestId(`held-supply-${heldExpense!.id}`).click();
    await expect(page.getByTestId("posted-evidence-dialog")).toBeVisible();
    const box = await page.getByTestId("posted-evidence-dialog").boundingBox();
    expect(box!.width, "the evidence dialog fits the phone").toBeLessThanOrEqual(PHONE.width);
    await page.keyboard.press("Escape");
    await page.goto("/expenses");
    await expect(page.getByTestId("page-expenses")).toContainText("المصروفات");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width + 1);
    await page.getByTestId("record-expense").click();
    await pick(page, "expense-vendor", /E2E Vendor/);
    await pick(page, "expense-document-kind", /ليست فاتورة ضريبية/);
    await page.getByTestId("expense-subtotal").fill("10");
    await page.getByTestId("expense-vatAmount").fill("1.50");
    await page.getByTestId("expense-total").fill("11.50");
    await expect(page.getByTestId("vat-evidence-panel")).toContainText("بانتظار إثبات الضريبة");
    await expect(page.getByTestId("vat-evidence-reasons")).toContainText("ليس فاتورة ضريبية");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
  });

  test("English on a phone: the review page and the expenses page fit the screen", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await scanPdf(page, `phone-${STAMP}.pdf`);
    await expect(page.getByTestId("scan-document-kind")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth), "the review page: no sideways scroll").toBeLessThanOrEqual(PHONE.width + 1);
    await page.goto("/expenses");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width + 1);
  });
});
