/**
 * PHASE 13B S1 — AN OPENING PAYABLE'S VAT HISTORY, DECLARED AND USED, BY CLICKING (2026-09-30).
 * Records: docs/product/phase-13b-level-policy-implementation-contract.md §1, §15, §16;
 *          apps/api/src/tests/phase13b-s1-opening-payable-vat.test.ts (the API proof).
 *
 * What only a browser shows (CLAUDE.md §3 — "assume any completed backend is
 * unreachable until someone has clicked it"): an admin or an accountant can
 * DECLARE a committed opening payable's VAT history from the migration
 * workspace, attaching the evidence it needs; a refusal — missing evidence, a
 * reversed-VAT location S1 does not act on — reaches them with a title in
 * their language and nothing is declared; a supplier credit note against the
 * declared bill posts, and what it does to input VAT (box 13) comes from the
 * DECLARED history, never from the opening bill (which carries no VAT); a note
 * without the supplier's document, or against an undeclared bill, is refused
 * in words and stays a draft; and a bookkeeper can do none of it. In English
 * and Arabic (dir=rtl), on a desktop and on a 390 px phone.
 *
 * The migration is committed through the API (the migration workspace spec
 * proves the commit by clicking); everything S1 adds is clicked.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { E2E_S1 } from "./global-setup";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");
const pdf = (name: string) => ({ name, mimeType: "application/pdf", buffer: Buffer.concat([PDF, Buffer.from(`${name}-${Date.now()}-${Math.random()}`)]) });

let admin: APIRequestContext;
let batchId = 0;
const item: Record<string, number> = {};
const billOf: Record<string, number> = {};

const ok = async (res: Awaited<ReturnType<APIRequestContext["get"]>>, what: string) => {
  expect(res.status(), `${what}: ${await res.text()}`).toBeLessThan(300);
  return res.json();
};
const box13 = async (month: string) =>
  Number((await ok(await admin.get(`/api/reports/vat-return?period_from=${month}&period_to=${month}`), "vat return")).purchasesSection.box13_recoverableInputVat);
const declarationOf = async (key: string) =>
  ((await ok(await admin.get("/api/opening-vat-declarations"), "declarations")) as Array<{ itemId: number; state: string }>).find((d) => d.itemId === item[key]) ?? null;
const statusOf = async (id: number) => (await ok(await admin.get(`/api/bills/${id}`), "bill")).status as string;
const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};

/** A page as one of the three S1 users, in a language and a viewport. */
async function open(browser: Browser, who: "admin" | "accountant" | "bookkeeper", lang: "en" | "ar", viewport: { width: number; height: number }, path: string) {
  const storageState = { admin: E2E_S1.adminState, accountant: E2E_S1.accountantState, bookkeeper: E2E_S1.bookkeeperState }[who];
  const ctx = await browser.newContext({ storageState, viewport });
  const page = await ctx.newPage();
  await page.goto(path);
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
  return { page, close: () => ctx.close() };
}

test.beforeAll(async () => {
  admin = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E_S1.adminState });
  const bank = ((await ok(await admin.get("/api/bank-accounts"), "banks")) as Array<{ id: number }>)[0]!.id;
  const rows = [
    // key, issued, original = outstanding, staged historical VAT
    ["S1-D", "2026-05-01", 11500, { category: "S", rate: 15, amount: 1500 }],
    ["S1-N", "2026-04-10", 11500, { category: "S", rate: 15, amount: 1500 }],
    ["S1-B", "2026-03-15", 2300, { rate: 15, amount: 300 }],
    ["S1-R", "2025-03-10", 11500, { rate: 15, amount: 1500 }],
    ["S1-U", "2026-05-20", 1150, { rate: 15, amount: 150 }],
  ] as const;
  const total = rows.reduce((s, r) => s + r[2], 0);
  const batch = await ok(await admin.post("/api/migration/batches", { data: { sourceSystem: "E2E Previous ERP", cutoverDate: "2026-07-01" } }), "batch");
  batchId = batch.id;
  const chart = await ok(await admin.put(`/api/migration/batches/${batchId}/chart`, { data: { rows: [
    { sourceCode: "1100", sourceName: "Bank", sourceType: "asset", openingDebit: total, sourceRole: "bank", evidenceNote: "statement" },
    { sourceCode: "2100", sourceName: "Creditors", sourceType: "liability", openingCredit: total, sourceRole: "payable" },
  ] } }), "chart");
  const rowId = (code: string) => (chart.rows as Array<{ id: number; sourceCode: string }>).find((r) => r.sourceCode === code)!.id;
  await ok(await admin.patch(`/api/migration/batches/${batchId}/chart/${rowId("1100")}`, { data: { decision: "map_to_bank", targetBankAccountId: bank } }), "decide bank");
  await ok(await admin.patch(`/api/migration/batches/${batchId}/chart/${rowId("2100")}`, { data: { decision: "map_to_system", targetSystemCode: "AP" } }), "decide AP");
  await ok(await admin.put(`/api/migration/batches/${batchId}/parties`, { data: { rows: [{ partyType: "vendor", sourceId: "V1", name: "Gamma Supplies" }] } }), "parties");
  await ok(await admin.put(`/api/migration/batches/${batchId}/open-items`, { data: { rows: rows.map(([key, date, amount, historicalVat]) => ({
    itemType: "ap", sourceId: key, partySourceId: "V1", documentNumber: `OLD-${key}`, issueDate: date, dueDate: date, originalAmount: amount, outstandingAmount: amount, historicalVat,
  })) } }), "open items");
  const validated = await ok(await admin.post(`/api/migration/batches/${batchId}/validate`), "validate");
  expect(validated.ok, JSON.stringify(validated.checks?.filter((c: { status: string }) => c.status === "fail"))).toBe(true);
  await ok(await admin.post(`/api/migration/batches/${batchId}/commit`), "commit");
  const items = await ok(await admin.get(`/api/migration/batches/${batchId}/open-items`), "items");
  for (const r of items.rows as Array<{ id: number; sourceId: string; resolvedId: number }>) { item[r.sourceId] = r.id; billOf[r.sourceId] = r.resolvedId; }
});
test.afterAll(async () => { await admin.dispose(); });

test.describe.serial("Phase 13B S1 — declaring an opening payable's VAT history, and the notes that use it", () => {
  test("🔴 EN desktop (admin): a DEDUCTED history — refused while evidence is missing (nothing declared), declared once it is attached", async ({ browser }) => {
    const { page, close } = await open(browser, "admin", "en", DESKTOP, `/migration/${batchId}?section=ap`);
    await expect(page.getByTestId("vat-history-undeclared-OLD-S1-D")).toBeVisible();
    await page.getByTestId("declare-vat-OLD-S1-D").click();
    const dialog = page.getByTestId("opening-vat-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("opening-vat-state").click();
    await page.getByTestId("opening-vat-state-DEDUCTED").click();
    await expect(page.getByTestId("opening-vat-amount")).toHaveValue("1500"); // the staged figure, restated
    await page.getByTestId("opening-vat-deducted-period").fill("2026-05");
    await page.getByTestId("opening-vat-file-ORIGINAL_TAX_INVOICE").setInputFiles(pdf("invoice"));
    await page.getByTestId("opening-vat-submit").click();
    const refusal = page.getByTestId("opening-vat-refusal");
    await expect(refusal).toContainText("Attach the evidence this history needs");
    await expect(refusal).toContainText(/DEDUCTION_RETURN/);
    expect(await declarationOf("S1-D"), "nothing declared").toBeNull();

    await page.getByTestId("opening-vat-file-DEDUCTION_RETURN").setInputFiles(pdf("return"));
    await page.getByTestId("opening-vat-submit").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("vat-history-state-OLD-S1-D")).toContainText("deducted");
    await expect(page.getByTestId("declare-vat-OLD-S1-D")).toHaveCount(0); // permanent: no second declaration offered
    expect((await declarationOf("S1-D"))?.state).toBe("DEDUCTED");
    await close();
  });

  test("🔴 AR desktop RTL (accountant — the dedicated grant): a NEVER-DEDUCTED history, declared in Arabic", async ({ browser }) => {
    const { page, close } = await open(browser, "accountant", "ar", DESKTOP, `/migration/${batchId}?section=ap`);
    await expect(page.getByTestId("vat-history-undeclared-OLD-S1-N")).toContainText("غير مُعلن");
    await expect(page.getByTestId("correct-amount-OLD-S1-N"), "migration write stays the admin's").toHaveCount(0);
    await page.getByTestId("declare-vat-OLD-S1-N").click();
    await expect(page.getByTestId("opening-vat-dialog")).toContainText("إعلان تاريخ الضريبة");
    await page.getByTestId("opening-vat-state").click();
    await page.getByTestId("opening-vat-state-NOT_DEDUCTED").click();
    await page.getByTestId("opening-vat-reason").fill("لم تتوفر فاتورة ضريبية صالحة عند تقديم الإقرار");
    await page.getByTestId("opening-vat-carried-in-cost").click();
    await page.getByTestId("opening-vat-file-ORIGINAL_TAX_INVOICE").setInputFiles(pdf("invoice-n"));
    await page.getByTestId("opening-vat-submit").click();
    await expect(page.getByTestId("opening-vat-dialog")).toBeHidden();
    await expect(page.getByTestId("vat-history-state-OLD-S1-N")).toContainText("لم تُخصم");
    expect((await declarationOf("S1-N"))?.state).toBe("NOT_DEDUCTED");
    await close();
  });

  test("🔴 EN phone (admin): an Art. 50 BLOCKED history, declared on a 390 px screen with no sideways scroll", async ({ browser }) => {
    const { page, close } = await open(browser, "admin", "en", PHONE, `/migration/${batchId}?section=ap`);
    await page.getByTestId("declare-vat-OLD-S1-B").click();
    await page.getByTestId("opening-vat-state").click();
    await page.getByTestId("opening-vat-state-BLOCKED_ART50").click();
    await page.getByTestId("opening-vat-ground").fill("Entertainment (VAT IR Art. 50)");
    await page.getByTestId("opening-vat-file-ORIGINAL_TAX_INVOICE").setInputFiles(pdf("invoice-b"));
    await page.getByTestId("opening-vat-file-CLASSIFICATION").setInputFiles(pdf("classification"));
    await noSidewaysScroll(page, PHONE.width, "EN phone, dialog open");
    await page.getByTestId("opening-vat-submit").click();
    await expect(page.getByTestId("opening-vat-dialog")).toBeHidden();
    expect((await declarationOf("S1-B"))?.state).toBe("BLOCKED_ART50");
    await noSidewaysScroll(page, PHONE.width, "EN phone, after declaring");
    await close();
  });

  test("🔴 AR phone RTL (accountant): a REVERSED history — the location is never assumed; an adjustment account is refused by name in Arabic; carried in cost it is declared", async ({ browser }) => {
    const { page, close } = await open(browser, "accountant", "ar", PHONE, `/migration/${batchId}?section=ap`);
    await page.getByTestId("declare-vat-OLD-S1-R").click();
    await page.getByTestId("opening-vat-state").click();
    await page.getByTestId("opening-vat-state-REVERSED_ART40_10").click();
    await page.getByTestId("opening-vat-deducted-period").fill("2025-03");
    await page.getByTestId("opening-vat-reversed-period").fill("2026-03");
    for (const k of ["ORIGINAL_TAX_INVOICE", "DEDUCTION_RETURN", "REVERSAL_RETURN", "PAYMENT_RECORDS"]) {
      await page.getByTestId(`opening-vat-file-${k}`).setInputFiles(pdf(`r-${k}`));
    }
    // no location chosen → refused, never assumed
    await page.getByTestId("opening-vat-submit").click();
    await expect(page.getByTestId("opening-vat-refusal")).toContainText("حدّد أين حُمِّلت الضريبة المعكوسة");
    // an adjustment account — S1 does not act on it
    await page.getByTestId("opening-vat-location").click();
    await page.getByRole("option", { name: "في حساب تسوية ضريبية" }).click();
    await page.getByTestId("opening-vat-submit").click();
    await expect(page.getByTestId("opening-vat-refusal")).toContainText("هذا التاريخ غير مدعوم بعد");
    expect(await declarationOf("S1-R"), "nothing declared").toBeNull();
    await noSidewaysScroll(page, PHONE.width, "AR phone with the refusal in view");
    await page.getByTestId("opening-vat-location").click();
    await page.getByRole("option", { name: "في تكلفة المشتريات" }).click();
    await page.getByTestId("opening-vat-submit").click();
    await expect(page.getByTestId("opening-vat-dialog")).toBeHidden();
    expect((await declarationOf("S1-R"))?.state).toBe("REVERSED_ART40_10");
    await close();
  });

  test("🔴 EN desktop (admin): a note against the DEDUCTED bill, recorded with the supplier's document, posts — and input VAT falls by EXACTLY its VAT", async ({ browser }) => {
    const before = await box13("2026-08");
    const { page, close } = await open(browser, "admin", "en", DESKTOP, "/supplier-credit-notes");
    await page.getByTestId("new-supplier-note").click();
    await page.getByTestId("note-against-bill").click();
    await page.getByRole("option", { name: /^OLD-S1-D —/ }).click();
    await expect(page.getByTestId("note-opening-hint")).toContainText("opening balance migrated at cut-over");
    await page.getByTestId("note-number").fill("S1-E2E-CN-D");
    await page.getByTestId("note-date").fill("2026-08-10");
    await page.getByTestId("note-subtotal").fill("2000");
    await page.getByTestId("note-vat").fill("300");
    await page.getByTestId("note-document").setInputFiles(pdf("supplier-note-d"));
    await page.getByTestId("note-submit").click();
    await expect(page.getByRole("status").filter({ hasText: "Note recorded as a draft" })).toBeVisible();
    const row = page.locator("[data-testid^=supplier-note-row-]").filter({ hasText: "S1-E2E-CN-D" });
    const noteId = Number((await row.getAttribute("data-testid"))!.replace("supplier-note-row-", ""));
    await page.getByTestId(`approve-note-${noteId}`).click();
    await expect(page.getByRole("status").filter({ hasText: "Note posted" })).toBeVisible();
    expect(await statusOf(noteId)).not.toBe("draft");
    expect(Math.round((await box13("2026-08") - before) * 100) / 100, "the full note VAT, from the declared history").toBe(-300);
    await close();
  });

  test("🔴 AR desktop RTL (accountant): a note against the NEVER-DEDUCTED bill posts — and input VAT does not move at all", async ({ browser }) => {
    const before = await box13("2026-08");
    const draft = await ok(await admin.post("/api/bills", { data: { documentType: "credit_note", creditNoteAgainstBillId: billOf["S1-N"], billNumber: "S1-E2E-CN-N", vendorReference: "SUP-S1-E2E-CN-N", date: "2026-08-11", subtotal: 2000, vatAmount: 300, total: 2300, items: [] } }), "note N");
    const { page, close } = await open(browser, "accountant", "ar", DESKTOP, "/supplier-credit-notes");
    await page.getByTestId(`attach-note-${draft.id}`).click();
    await page.getByTestId("note-attach-input").setInputFiles(pdf("supplier-note-n"));
    await expect(page.getByRole("status").filter({ hasText: "أُرفق مستند المورّد" })).toBeVisible();
    await page.getByTestId(`approve-note-${draft.id}`).click();
    await expect(page.getByRole("status").filter({ hasText: "تم ترحيل الإشعار" })).toBeVisible();
    expect(await statusOf(draft.id)).not.toBe("draft");
    expect(Math.round((await box13("2026-08") - before) * 100) / 100, "never deducted: nothing to reduce").toBe(0);
    await close();
  });

  test("🔴 EN phone (admin): a note WITHOUT the supplier's document is refused with the next step in view; attached from the phone, it posts", async ({ browser }) => {
    const draft = await ok(await admin.post("/api/bills", { data: { documentType: "credit_note", creditNoteAgainstBillId: billOf["S1-D"], billNumber: "S1-E2E-CN-NODOC", vendorReference: "SUP-S1-E2E-CN-NODOC", date: "2026-08-12", subtotal: 400, vatAmount: 60, total: 460, items: [] } }), "note nodoc");
    const { page, close } = await open(browser, "admin", "en", PHONE, "/supplier-credit-notes");
    await page.getByTestId(`approve-note-${draft.id}`).click();
    const toast = page.getByRole("status").filter({ hasText: "Attach the supplier's credit note first" });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/opening balance migrated at cut-over/);
    await noSidewaysScroll(page, PHONE.width, "EN phone with the refusal in view");
    expect(await statusOf(draft.id)).toBe("draft");
    await page.getByTestId(`attach-note-${draft.id}`).click();
    await page.getByTestId("note-attach-input").setInputFiles(pdf("supplier-note-nodoc"));
    await expect(page.getByRole("status").filter({ hasText: "Supplier's document attached" })).toBeVisible();
    await page.getByTestId(`approve-note-${draft.id}`).click();
    await expect(page.getByRole("status").filter({ hasText: "Note posted" })).toBeVisible();
    expect(await statusOf(draft.id)).not.toBe("draft");
    await close();
  });

  test("🔴 AR phone RTL (admin): a note against an UNDECLARED opening bill is refused in Arabic — declare first — and stays a draft", async ({ browser }) => {
    const { page, close } = await open(browser, "admin", "ar", PHONE, "/supplier-credit-notes");
    await page.getByTestId("new-supplier-note").click();
    await page.getByTestId("note-against-bill").click();
    await page.getByRole("option", { name: /^OLD-S1-U —/ }).click();
    await expect(page.getByTestId("note-opening-hint")).toContainText("رصيد افتتاحي");
    await page.getByTestId("note-number").fill("S1-E2E-CN-U");
    await page.getByTestId("note-date").fill("2026-08-13");
    await page.getByTestId("note-subtotal").fill("100");
    await page.getByTestId("note-vat").fill("15");
    await page.getByTestId("note-document").setInputFiles(pdf("supplier-note-u"));
    await page.getByTestId("note-submit").click();
    await expect(page.getByRole("status").filter({ hasText: "سُجِّل الإشعار كمسودة" })).toBeVisible();
    const row = page.locator("[data-testid^=supplier-note-row-]").filter({ hasText: "S1-E2E-CN-U" });
    const noteId = Number((await row.getAttribute("data-testid"))!.replace("supplier-note-row-", ""));
    await page.getByTestId(`approve-note-${noteId}`).click();
    const toast = page.getByRole("status").filter({ hasText: "أعلِن أولًا تاريخ ضريبة الفاتورة الافتتاحية" });
    await expect(toast).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "AR phone with the refusal in view");
    expect(await statusOf(noteId)).toBe("draft");
    await close();
  });

  test("🔴 roles: a BOOKKEEPER cannot declare (403 at the API, no control in the UI); the accountant's grant did not widen migration write", async ({ browser }) => {
    const bk = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E_S1.bookkeeperState });
    expect((await bk.get("/api/opening-vat-declarations")).status()).toBe(403);
    expect((await bk.post("/api/opening-vat-declarations", { data: { itemId: item["S1-U"], state: "NOT_DEDUCTED", evidence: [] } })).status()).toBe(403);
    await bk.dispose();
    const acct = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E_S1.accountantState });
    expect((await acct.post(`/api/migration/open-items/${item["S1-U"]}/correct`, { data: { correctOutstanding: 1000, reason: "not the accountant's act" } })).status()).toBe(403);
    await acct.dispose();
    for (const lang of ["en", "ar"] as const) {
      const { page, close } = await open(browser, "bookkeeper", lang, DESKTOP, `/migration/${batchId}?section=ap`);
      await expect(page.locator("body")).not.toContainText(/Declare VAT history|إعلان تاريخ الضريبة/);
      await expect(page.getByTestId("declare-vat-OLD-S1-U")).toHaveCount(0);
      await close();
    }
  });
});
