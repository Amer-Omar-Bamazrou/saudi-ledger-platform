/**
 * D-3 — THE NEW BANK FLOWS, WALKED BY CLICKING (2026-09-17).
 *
 * Every defect the API suite has been structurally blind to was found by
 * clicking. These flows drive the REAL pages — the dialog, the Radix select,
 * the submit button — and then check the backend effect through the figure a
 * human would check: each bank's ledger balance (GET /bank-accounts, resolved
 * through the one bank-identity view). English first, then Arabic/RTL.
 *
 * Frame: the suite's own org (global-setup), whose one bank account is NOT
 * the invoice default — so the picker starts EMPTY and "bank is required" is
 * a real state here, not a pre-selected one.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

type Bank = { id: number; name: string; bankName: string; isActive: boolean; ledgerBalance: number; ledgerBalanceOnLeaf: number; attributedHistory: number };
let api: APIRequestContext;
let bank: Bank;

const banks = async (): Promise<Bank[]> => (await api.get("/api/bank-accounts")).json();
const ledger = async () => (await banks()).find((b) => b.id === bank.id)!.ledgerBalance;

/** A toast title: the toaster renders it twice (the visible title and an
 *  aria-live announcer that sometimes catches it), so match the visible one. */
const toast = (page: Page, title: string) => page.getByText(title, { exact: true }).first();

/** Pick an option in a Radix select by clicking — no DOM-only value setting. */
async function pickOption(page: Page, trigger: ReturnType<Page["getByTestId"]>, optionText: RegExp) {
  await trigger.click();
  await page.getByRole("option", { name: optionText }).click();
}

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const all = await banks();
  if (all.length !== 1) throw new Error(`e2e: expected the seeded org to have exactly one bank account, found ${all.length}`);
  bank = all[0]!;
});
test.afterAll(async () => { await api.dispose(); });

test.describe("D-3 bank flows — English", () => {
  test("🔴 Invoice → Record Payment: the bank picker appears, the bank is REQUIRED, a bank can be chosen, the payment posts to THAT bank", async ({ page }) => {
    const before = await ledger();
    await page.goto("/invoices", { waitUntil: "networkidle" });
    const row = page.locator("tr", { hasText: "E2E-INV-003" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Mark Paid" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Record Payment" })).toBeVisible();
    const picker = page.getByTestId("pay-bank-account");
    await expect(picker, "the bank picker is on the dialog").toBeVisible();
    // One bank exists and it is NOT marked default: the picker must start EMPTY
    // (no single-bank inference — "there is only one" is not a choice).
    await expect(picker).toContainText("Choose the bank account");
    await expect(dialog.getByText("Received into bank account *")).toBeVisible();
    const submit = dialog.getByRole("button", { name: "Record Payment" });
    await expect(submit, "no bank chosen → cannot submit").toBeDisabled();

    await pickOption(page, picker, new RegExp(bank.name));
    await expect(picker).toContainText(bank.name);
    await expect(submit).toBeEnabled();
    await dialog.locator('input[type="number"]').fill("500");
    await submit.click();
    await expect(toast(page, "Payment recorded")).toBeVisible();

    expect(await ledger(), "the receipt reached THIS bank's own ledger account").toBe(before + 500);
  });

  test("🔴 Bill → Record Payment: same contract, cash leaves THAT bank", async ({ page }) => {
    const before = await ledger();
    await page.goto("/bills", { waitUntil: "networkidle" });
    const row = page.locator("tr", { hasText: "E2E-BILL-002" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Pay", exact: true }).click();

    const dialog = page.getByRole("dialog");
    const picker = page.getByTestId("pay-bank-account");
    await expect(picker).toBeVisible();
    await expect(dialog.getByText("Paid from bank account *")).toBeVisible();
    await expect(picker).toContainText("Choose the bank account");
    const submit = dialog.getByRole("button", { name: "Record Payment" });
    await expect(submit).toBeDisabled();
    await pickOption(page, picker, new RegExp(bank.name));
    await dialog.locator('input[type="number"]').fill("300");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(toast(page, "Payment recorded")).toBeVisible();

    expect(await ledger()).toBe(before - 300);
  });

  test("🔴 Statement upload: a missing bank is REFUSED before anything is sent; with a bank chosen the rows are imported and carry that bank", async ({ page }) => {
    await page.goto("/upload", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Manual Entry" }).click();
    const desc = `E2E D3 UPLOAD ${Date.now()}`;
    await page.getByPlaceholder("Description").first().fill(desc);
    await page.getByPlaceholder("Amount").first().fill("42");

    const requests: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/transactions/upload")) requests.push(r.url()); });
    await page.getByRole("button", { name: /^Submit/ }).click();
    await expect(toast(page, "Choose the bank account this statement belongs to")).toBeVisible();
    expect(requests, "nothing was sent without a bank").toEqual([]);

    await pickOption(page, page.getByTestId("upload-bank-account"), new RegExp(bank.name));
    await page.getByRole("button", { name: /^Submit/ }).click();
    await expect(toast(page, "Import successful")).toBeVisible();

    const list: { transactions: Array<{ description: string; bankAccountId: number | null; reviewStatus: string }> } =
      await (await api.get(`/api/transactions?search=${encodeURIComponent(desc)}`)).json();
    const imported = list.transactions.find((t) => t.description === desc);
    expect(imported, "the row exists").toBeTruthy();
    expect(imported!.bankAccountId, "the row inherited the statement's bank").toBe(bank.id);
    expect(imported!.reviewStatus).toBe("pending_review");
  });

  test("🔴 Transactions: a banked row shows NO bank field (the bank is set once); the category picker does not offer the bank's own cash account", async ({ page }) => {
    await page.goto("/transactions", { waitUntil: "networkidle" });
    const rows = page.locator("tbody tr");
    await expect(rows.first()).toBeVisible();
    await rows.first().hover();
    await rows.first().getByRole("button").last().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Edit Transaction")).toBeVisible();
    // Every seeded row was imported WITH a bank, so the "which bank" field
    // must not be offered — a bank is a fact recorded once, not a revision.
    await expect(page.getByTestId("edit-bank-account")).toHaveCount(0);
    // And the bank's own cash account is not a category.
    await dialog.getByRole("combobox").first().click();
    const options = await page.getByRole("option").allTextContents();
    expect(options.length).toBeGreaterThan(3);
    expect(options.some((o) => o.includes(bank.name)), `the bank leaf "${bank.name}" must not be a category option`).toBe(false);
    expect(options.some((o) => o.includes("Cash and Bank")), "nor the non-posting header").toBe(false);
    await page.keyboard.press("Escape");
  });

  test("Bank accounts page: the ledger balance is the figure the payments moved, resolved per bank", async ({ page }) => {
    await page.goto("/bank-accounts", { waitUntil: "networkidle" });
    const card = page.locator("[data-row]", { hasText: bank.name });
    await expect(card.getByTestId("ledger-balance")).toContainText("Ledger balance");
    const current = await ledger();
    const shown = (await card.getByTestId("ledger-balance").innerText()).replace(/,/g, "");
    expect(shown).toContain(current.toFixed(2).replace(/\.00$/, ".00"));
  });
});

test.describe("D-3 bank flows — Arabic / RTL", () => {
  test("🔴 the same Record Payment flow in Arabic: labels, validation and layout under dir=rtl", async ({ page }) => {
    await page.goto("/invoices", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^ع$/ }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const before = await ledger();

    const row = page.locator("tr", { hasText: "E2E-INV-003" });
    await row.getByRole("button", { name: "تسجيل كمدفوع" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "تسجيل دفعة" })).toBeVisible();
    await expect(dialog.getByText("استُلم في الحساب البنكي *")).toBeVisible();
    const picker = page.getByTestId("pay-bank-account");
    await expect(picker).toBeVisible();
    // The control sits inside the dialog's box in RTL — not clipped or pushed out.
    const dbox = await dialog.boundingBox();
    const pbox = await picker.boundingBox();
    expect(dbox && pbox && pbox.x >= dbox.x - 1 && pbox.x + pbox.width <= dbox.x + dbox.width + 1, "picker within the dialog under RTL").toBe(true);
    const submit = dialog.getByRole("button", { name: "تسجيل الدفعة" });
    await expect(picker).toContainText("اختر الحساب البنكي");
    await expect(submit).toBeDisabled();
    await pickOption(page, picker, new RegExp(bank.name));
    await dialog.locator('input[type="number"]').fill("250");
    await submit.click();
    await expect(toast(page, "تم تسجيل الدفعة")).toBeVisible();
    expect(await ledger()).toBe(before + 250);

    // Upload's refusal message renders in Arabic too.
    await page.goto("/upload", { waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.getByRole("button", { name: "إدخال يدوي" }).click();
    await page.getByPlaceholder("الوصف").first().fill("E2E D3 AR NO BANK");
    await page.getByPlaceholder("المبلغ").first().fill("7");
    await page.getByRole("button", { name: /^إرسال/ }).click();
    await expect(toast(page, "اختر الحساب البنكي الذي يخص هذا الكشف")).toBeVisible();
    await expect(page.getByText("الحساب البنكي * (لأي حساب هذا الكشف؟)")).toBeVisible();

    // Back to English so later specs start where they expect.
    await page.getByRole("button", { name: /^EN$/i }).click().catch(() => {});
  });
});
