import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E_MIGRATION, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";

/**
 * BATCH 1C — THE MIGRATION WORKSPACE, DRIVEN AS AN OPERATOR WOULD DRIVE IT.
 *
 * One tenant whose ledger is empty before its opening date (seeded in
 * global-setup with identity rows and one bank account only). Everything
 * else — the chart, the mapping, the parties, the open items, the deliberate
 * validation failure and its correction, the commit, the collection of an
 * opening receivable — happens through the UI, against the real API.
 *
 * What this suite asserts that no service test can: the buttons exist, the
 * dialogs close, the row the validation pointed at is the row the operator
 * lands on, the commit button is disabled until the server says validated,
 * an opening receivable shows NO tax-invoice PDF and NO credit-note option,
 * the page reads right-to-left, and nothing scrolls sideways on a phone.
 */

test.use({ storageState: E2E_MIGRATION.adminState });

const ids = (): SeededIds => JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds;

const CHART_CSV = [
  "sourceCode,sourceName,sourceType,openingDebit,openingCredit,sourceRole,evidenceNote",
  "1100,Riyad Bank,asset,30000,0,bank,Riyad statement 31 Dec 2024 closing 30000.00",
  "1200,Trade debtors,asset,25000,0,receivable,",
  // FA-D: the fixed-asset balances the register must tie to (they post no line of their own)
  "1500,Equipment at cost,asset,20000,0,,",
  "1590,Accumulated depreciation,asset,0,8000,,",
  "2100,Trade creditors,liability,0,7000,payable,",
  "3100,Share capital,equity,0,60000,,",
].join("\n");
// FA-D: the assets those two balances are made of — cost 20,000, accumulated 8,000.
const ASSETS_CSV = [
  "sourceId,name,nameAr,serialNumber,categoryName,acquisitionDate,availableForUseDate,cost,residualValue,usefulLifeMonths,openingAccumulatedDepreciation,openingPeriodsBooked,vatInputTaxAmount,vatInitialRecoveryPct,vatNonDeductibleReason,location,description",
  "FA-1,Packing machine,آلة تعبئة,SN-1,Migrated equipment,2023-01-01,2023-01-01,20000,0,50,8000,20,3000,100,,Warehouse,",
].join("\n");
const PARTIES_CSV = [
  "partyType,sourceId,name,nameAr,taxNumber",
  "customer,C1,Alpha Trading Est.,مؤسسة ألفا التجارية,300000000000003",
  "customer,C2,Beta Logistics,,",
  "vendor,V1,Delta Supplies,,",
].join("\n");
// INV-1004 is DELIBERATELY dated after the opening date (2024-12-31): the server's OPEN_ITEMS control must block it.
// 2026-09-22: INV-1001 carries the previous solution's e-invoicing identity (cleared, with its UUID);
// INV-1002 states nothing — the follow-ups test records it ONCE through the UI before a credit note is allowed.
const UUID_1001 = "6f9619ff-8b86-4d11-b42d-00c04fc964ff";
const ITEMS_CSV = [
  "itemType,sourceId,partySourceId,documentNumber,issueDate,dueDate,originalAmount,outstandingAmount,historicalVat.category,historicalVat.rate,historicalVat.badDebtReliefClaimed,einvoicingStatus,sourceUuid",
  `ar,SI-1001,C1,INV-1001,2024-11-10,2024-12-10,10000,10000,S,15,yes,cleared,${UUID_1001}`,
  "ar,SI-1002,C1,INV-1002,2024-12-01,2024-12-31,8000,8000,,,no,,",
  "ar,SI-1003,C2,INV-1003,2024-12-10,2025-01-09,4000,4000,,,,,",
  "ar,SI-1004,C2,INV-1004,2025-01-15,2025-02-14,3000,3000,,,,,",
  "ap,PI-77,V1,BILL-77,2024-10-15,2024-11-14,7000,7000,,,,,",
].join("\n");

async function importSet(page: Page, kind: "chart" | "parties" | "ar" | "assets", csv: string) {
  await page.getByTestId(`${kind}-import`).click();
  const dialog = page.getByTestId(`import-dialog-${kind === "ar" ? "openItems" : kind}`);
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("import-text").fill(csv);
  await expect(dialog.getByTestId("import-preview")).toContainText("row(s) ready");
  await dialog.getByTestId("import-submit").click();
  await expect(dialog).toBeHidden();
}

async function pickOption(page: Page, name: RegExp | string) {
  await page.getByRole("option", { name }).click();
}

async function noHorizontalScroll(page: Page, where: string) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw, `${where}: the page scrolls sideways (${sw} > ${cw})`).toBeLessThanOrEqual(cw + 1);
}

let batchId = 0;

test.describe.serial("the migration, end to end", () => {
  test("🔴 create → stage → map → deliberate failure → navigate to the record → correct → validate → trial balance → commit → post-commit", async ({ page }) => {
    test.setTimeout(240_000);
    const { migrationBankId } = ids();

    // 1. the list, empty; start a batch
    await page.goto("/migration");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await page.getByTestId("new-migration").click();
    await page.getByTestId("mig-source-system").fill("Previous ERP");
    await page.getByTestId("mig-cutover").fill("2025-01-01");
    await expect(page.getByTestId("new-migration-dialog")).toContainText("2024-12-31");
    await page.getByTestId("create-migration").click();
    await expect(page).toHaveURL(/\/migration\/\d+\?section=chart/);
    batchId = Number(page.url().match(/\/migration\/(\d+)/)![1]);
    await expect(page.getByTestId("batch-status")).toHaveText("Draft");

    // 2. the chart
    await importSet(page, "chart", CHART_CSV);
    await expect(page.getByTestId("chart-row-1200")).toBeVisible();
    await expect(page.getByTestId("chart-balance-line")).toContainText("balances");
    // suggestions from the role hints; the operator still clicks
    for (const code of ["1200", "2100"]) {
      await page.getByTestId(`chart-row-${code}`).locator('[data-testid^="apply-suggestion-"]').click();
      await expect(page.getByTestId(`chart-row-${code}`)).toContainText("Map to system account");
    }
    // the bank row → the company's bank account
    await page.getByTestId("chart-row-1100").locator('[data-testid^="map-"]').click();
    const editor1100 = page.locator('[data-testid^="decision-editor-"]');
    await editor1100.locator('[data-testid^="decision-"]').first().click();
    await pickOption(page, /Map to bank account/);
    await editor1100.locator('[data-testid^="target-bank-"]').click();
    await pickOption(page, /Riyad Main/);
    await editor1100.locator('[data-testid^="decision-save-"]').click();
    await expect(page.getByTestId("chart-row-1100")).toContainText("Riyad Main");
    // FA-D: the two fixed-asset rows — the cost merges into the default Fixed Assets account,
    // the accumulated depreciation maps to the system account of the same name.
    await page.getByTestId("chart-row-1500").locator('[data-testid^="map-"]').click();
    const editor1500 = page.locator('[data-testid^="decision-editor-"]');
    await editor1500.locator('[data-testid^="decision-"]').first().click();
    await pickOption(page, /Merge into existing account/);
    await editor1500.locator('[data-testid^="target-category-"]').click();
    await pickOption(page, /^Fixed Assets$/);
    await editor1500.locator('[data-testid^="decision-save-"]').click();
    await expect(page.getByTestId("chart-row-1500")).toContainText("Fixed Assets");
    await page.getByTestId("chart-row-1590").locator('[data-testid^="map-"]').click();
    const editor1590 = page.locator('[data-testid^="decision-editor-"]');
    await editor1590.locator('[data-testid^="decision-"]').first().click();
    await pickOption(page, /Map to system account/);
    await editor1590.locator('[data-testid^="target-system-"]').click();
    await pickOption(page, /Accumulated depreciation/);
    await editor1590.locator('[data-testid^="decision-save-"]').click();
    await expect(page.getByTestId("chart-row-1590")).toContainText("Accumulated depreciation");

    // capital → a new account. 🔴 The system-account list never offers OPENING_BALANCE_EQUITY.
    await page.getByTestId("chart-row-3100").locator('[data-testid^="map-"]').click();
    const editor3100 = page.locator('[data-testid^="decision-editor-"]');
    await editor3100.locator('[data-testid^="decision-"]').first().click();
    await pickOption(page, /Map to system account/);
    await editor3100.locator('[data-testid^="target-system-"]').click();
    const options = await page.getByRole("option").allTextContents();
    expect(options.join(" | ")).not.toMatch(/OPENING_BALANCE_EQUITY|Opening balance equity/i);
    expect(options.join(" | ")).not.toMatch(/\bCASH\b/);
    await page.keyboard.press("Escape");
    await editor3100.locator('[data-testid^="decision-"]').first().click();
    await pickOption(page, /Create as new account/);
    await editor3100.locator('[data-testid^="decision-save-"]').click();
    await expect(page.getByTestId("chart-row-3100")).toContainText("New account");
    await expect(page.getByTestId("chart-kpi-1")).toHaveText("0"); // unmapped
    void migrationBankId;

    // 3. parties
    await page.getByTestId("tab-parties").click();
    await importSet(page, "parties", PARTIES_CSV);
    // A party with no look-alike is decided "create" by the import itself (the server only leaves a
    // decision EMPTY when a candidate exists); the row says so and the button is spent.
    for (const sid of ["C1", "C2", "V1"]) {
      await expect(page.getByTestId(`party-row-${sid}`)).toContainText("Create new");
      await expect(page.getByTestId(`party-row-${sid}`).locator('[data-testid^="create-party-"]')).toBeDisabled();
    }

    // 4. open items (AR + AP in one file), the relief flag as three words
    await page.getByTestId("tab-ar").click();
    await importSet(page, "ar", ITEMS_CSV);
    await expect(page.getByTestId("relief-INV-1001")).toContainText("Yes");
    await expect(page.getByTestId("relief-INV-1002")).toContainText("No");
    await expect(page.getByTestId("relief-INV-1003")).toContainText("Unknown");
    await expect(page.getByTestId("item-row-INV-1001")).toContainText("historical record");
    await page.getByTestId("tab-ap").click();
    await expect(page.getByTestId("item-row-BILL-77")).toBeVisible();

    // 4b. FA-D — the fixed assets. They post NO line of their own, so the register must TIE to the
    // chart's asset balances: the control fails while the register is empty and passes once it does.
    await page.getByTestId("tab-validation").click();
    await page.getByTestId("run-validation").click();
    await expect(page.getByTestId("check-FIXED_ASSETS_CONTROL")).toHaveAttribute("data-status", "fail");
    await page.getByTestId("tab-assets").click();
    await expect(page.getByTestId("section-assets")).toBeVisible();
    await importSet(page, "assets", ASSETS_CSV);
    await expect(page.getByTestId("asset-row-FA-1")).toContainText("Packing machine");
    await expect(page.getByTestId("assets-kpi-1")).toContainText("20,000.00");
    await expect(page.getByTestId("assets-kpi-2")).toContainText("8,000.00");
    await expect(page.getByTestId("assets-kpi-3")).toContainText("12,000.00");
    await page.getByTestId("tab-banks").click();
    await expect(page.getByTestId("bank-row-1100")).toContainText("30,000.00");
    await page.getByTestId("tab-vat").click();
    await expect(page.getByTestId("vat-output")).toContainText("0.00");

    // 5. validation: BLOCKED by the item dated after the opening date; navigate to it
    await page.getByTestId("tab-validation").click();
    await page.getByTestId("run-validation").click();
    await expect(page.getByTestId("validation-blocked-banner")).toBeVisible();
    await expect(page.getByTestId("check-OPEN_ITEMS")).toHaveAttribute("data-status", "fail");
    await expect(page.getByTestId("check-CHART_BALANCED")).toHaveAttribute("data-status", "pass");
    // the ledger is untouched by validation: the batch is still a draft, nothing posted
    await expect(page.getByTestId("batch-status")).toHaveText("Draft");
    const jes = await page.request.get("/api/journal-entries?limit=5");
    expect((await jes.json()).page.total).toBe(0);
    // "Open record" from the problem list lands on the exact row, highlighted
    await page.getByTestId("problem-rows").locator('[data-testid^="open-problem-"]').first().click();
    await expect(page).toHaveURL(/section=ar.*focus=\d+/);
    const bad = page.getByTestId("item-row-INV-1004");
    await expect(bad).toBeVisible();
    await expect(bad).toContainText("after the opening date");
    // 6. correct it in place and re-stage
    await bad.locator('[data-testid^="edit-item-"]').click();
    const editor = page.getByTestId("row-editor-openItems");
    await editor.getByTestId("field-issueDate").fill("2024-12-20");
    await editor.getByTestId("field-dueDate").fill("2025-01-19");
    await editor.getByTestId("row-editor-save").click();
    await expect(editor).toBeHidden();
    await expect(page.getByTestId("item-row-INV-1004")).not.toContainText("after the opening date");

    // 7. validate again → validated
    await page.getByTestId("tab-validation").click();
    await page.getByTestId("run-validation").click();
    await expect(page.getByTestId("validation-ok-banner")).toBeVisible();
    await expect(page.getByTestId("batch-status")).toHaveText("Validated");
    await page.getByTestId("tab-overview").click();
    await expect(page.getByTestId("overview-blocking")).toHaveText("0");
    await expect(page.getByTestId("overview-balance")).toContainText("balanced");

    // 8. the trial balance: Dr = Cr, difference 0
    await page.getByTestId("tab-trial-balance").click();
    await expect(page.getByTestId("tb-debit")).toContainText("75,000.00");
    await expect(page.getByTestId("tb-credit")).toContainText("75,000.00");
    await expect(page.getByTestId("tb-difference")).toContainText("0.00");
    await expect(page.getByTestId("tb-line-system:AR")).toContainText("25,000.00");
    // 9. R1–R10 do not exist before commit
    await page.getByTestId("tab-reconciliation").click();
    await expect(page.getByTestId("reconciliation-pending")).toBeVisible();

    // 10. commit — enabled only now, behind an acknowledgement and a confirmation
    await page.getByTestId("tab-commit").click();
    await expect(page.getByTestId("commit-statement")).toContainText("cannot be undone by editing the staging data");
    await expect(page.getByTestId("commit-button")).toBeDisabled();
    await page.getByTestId("commit-ack").click();
    await expect(page.getByTestId("commit-button")).toBeEnabled();
    await page.getByTestId("commit-button").click();
    await expect(page.getByTestId("commit-dialog")).toContainText("4 opening receivable(s), 1 opening bill(s)");
    await page.getByTestId("confirm-commit").click();
    await expect(page.getByTestId("post-commit")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("batch-status")).toHaveText("Committed");
    await expect(page.getByTestId("committed-at")).not.toHaveText("—");
    await expect(page.getByTestId("link-opening-journal")).toContainText(`MIG-${batchId}-OPEN`);
    await expect(page.getByTestId("created-counts")).toContainText("Opening receivables");
    await page.getByTestId("tab-reconciliation").click();
    await expect(page.getByTestId("reconciliation-committed")).toBeVisible();
    for (const r of ["R1", "R5", "R6", "R7", "R10"]) await expect(page.getByTestId(`check-${r}`)).toHaveAttribute("data-status", "pass");
    // staging is read-only now
    await page.getByTestId("tab-ar").click();
    await expect(page.getByTestId("ar-import")).toHaveCount(0);
    await expect(page.locator('[data-testid^="edit-item-"]')).toHaveCount(0);
    // the backend records exist: the opening journal, four opening invoices, one opening bill, the lock
    const inv = await (await page.request.get("/api/invoices?limit=50")).json();
    const opening = inv.items.filter((i: { isOpening?: boolean }) => i.isOpening);
    expect(opening.map((i: { invoiceNumber: string }) => i.invoiceNumber).sort()).toEqual(["INV-1001", "INV-1002", "INV-1003", "INV-1004"]);
    expect(opening.every((i: { invoiceHash: string | null; icv: number | null; qrCode: string | null }) => i.invoiceHash == null && i.icv == null && i.qrCode == null)).toBe(true);
    const je2 = await (await page.request.get("/api/journal-entries?limit=5")).json();
    expect(je2.page.total).toBe(1);
    expect(je2.items[0].entryNumber).toBe(`MIG-${batchId}-OPEN`);
    // FA-D: the staged asset is now a register row IN SERVICE on the opening journal, and its
    // schedule resumes after the opening date — the migration created no extra journal entry.
    await page.getByTestId("tab-assets").click();
    await expect(page.getByTestId("asset-registered-FA-1")).toBeVisible();
    const assets = await (await page.request.get("/api/assets?limit=50")).json();
    const migrated = (assets.items as Array<{ id: number; source: string; status: string; cost: number; accumulatedDepreciation: number; carryingAmount: number; capitalisationJournalEntryId: number | null; plannedPeriods: number }>).find((a) => a.source === "migration")!;
    expect([migrated.status, migrated.cost, migrated.accumulatedDepreciation, migrated.carryingAmount]).toEqual(["in_service", 20000, 8000, 12000]);
    expect(migrated.plannedPeriods).toBe(30); // 50 − 20 already booked
    const detail = await (await page.request.get(`/api/assets/${migrated.id}`)).json();
    expect(detail.capitalisationJournalEntryId).toBe(je2.items[0].id);
    expect(detail.schedule[0].sequence).toBe(21);

    // the journal deep link lands on the entry
    await page.getByTestId("tab-commit").click();
    await page.getByTestId("link-opening-journal").click();
    await expect(page).toHaveURL(/journal-entries\?entry=\d+/);
    await expect(page.locator("main")).toContainText(`MIG-${batchId}-OPEN`);
  });

  test("🔴 an opening receivable in the product: badge + historical-record note, NO tax-invoice PDF, NO credit-note original; it collects through Mark Paid; the reversal is then blocked by the server", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/invoices");
    const row = page.locator("tr", { hasText: "INV-1001" }).first();
    await expect(row.getByTestId("opening-record-badge")).toBeVisible();
    await expect(row.getByTestId("opening-record-note")).toContainText("Historical record from the previous system");
    await expect(row.locator('a[href*="/document"]')).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Mark Paid" })).toBeVisible();
    // an ordinary issued invoice would show the PDF link — the note is not hiding it for everyone (there is none here, so assert the class on the seeded smoke tenant is out of scope; the unit of proof is the row)

    // credit notes: the picker offers no original yet — INV-1001 is cleared (identity known) but INV-1002..1004 state nothing;
    // INV-1001 IS offered (accountant answer 3: a note against a previous-system invoice goes through Fatoora once it is identified)
    await page.goto("/credit-notes");
    await expect(page.locator("main")).toContainText(/credit/i);
    await expect(page.getByTestId("new-note")).toBeEnabled();
    await page.getByTestId("new-note").click();
    await page.getByTestId("note-original").click();
    const opts0 = await page.getByRole("option").allTextContents();
    expect(opts0.join(" | ")).toContain("INV-1001");
    expect(opts0.join(" | ")).not.toMatch(/INV-100[2-4]/);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    // the server's fail-closed guard, exercised from the same session
    const inv = await (await page.request.get("/api/invoices?limit=50")).json();
    const target = inv.items.find((i: { invoiceNumber: string }) => i.invoiceNumber === "INV-1002");
    // 2026-09-22 (accountant answer 3): the refusal names the MISSING IDENTITY, not the opening item as such
    const refused = await page.request.post("/api/invoices", { data: { invoiceNumber: "CN-E2E-1", documentType: "credit_note", originalInvoiceId: target.id, noteReason: "test", date: "2025-02-01", dueDate: "2025-02-01", customerId: target.customerId, items: [{ description: "x", quantity: 1, unitPrice: 10, vatRate: 15 }] } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).code).toBe("opening_item_einvoicing_identity_missing");
    const pdf = await page.request.get(`/api/invoices/${target.id}/document?lang=ar`);
    expect(pdf.status()).toBe(409);

    // collect INV-1003 through the product's Mark Paid (D-4)
    await page.goto("/invoices");
    const row3 = page.locator("tr", { hasText: "INV-1003" }).first();
    await row3.getByRole("button", { name: "Mark Paid" }).click();
    await page.getByTestId("pay-bank-account").click();
    await pickOption(page, /Riyad Main/);
    await page.getByRole("button", { name: "Record Payment" }).click();
    await expect(row3).toContainText(/Paid/i, { timeout: 15_000 });
    const after = (await (await page.request.get("/api/invoices?limit=50")).json()).items.find((i: { invoiceNumber: string }) => i.invoiceNumber === "INV-1003");
    expect(after.status).toBe("paid");
    expect(after.paidAmount).toBe(4000);
    expect(after.invoiceHash).toBeNull();
    expect(after.icv).toBeNull();
    expect(after.qrCode).toBeNull();
    expect(after.isOpening).toBe(true);

    // the reversal respects the server's blockers: a collected item blocks Policy C
    await page.goto(`/migration/${batchId}?section=commit`);
    await expect(page.getByTestId("reversal-preview")).toContainText("BLOCKED");
    await expect(page.getByTestId("reversal-preview")).toContainText("INV-1003");
    await expect(page.getByTestId("open-reverse")).toBeDisabled();
  });

  test("🔴 migration follow-ups (2026-09-22): the identity badges; INV-1002 8,000 → 7,000 through the dialog (the original stays, a replacement OPEN number, retained earnings on the other side); the collected item is refused by name; the identity recorded ONCE unlocks a credit note through Fatoora and is then never changed", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`/migration/${batchId}?section=ar`);
    // identity as staged: INV-1001 cleared + UUID; INV-1002 not stated
    await expect(page.getByTestId("identity-INV-1001")).toContainText("cleared");
    await expect(page.getByTestId("identity-INV-1001")).toContainText(UUID_1001);
    await expect(page.getByTestId("identity-missing-INV-1002")).toBeVisible();
    await expect(page.getByTestId("live-number-INV-1002")).toHaveCount(0);

    // the correction, through the dialog
    const jeBefore = (await (await page.request.get("/api/journal-entries?limit=5")).json()).page.total as number;
    await page.getByTestId("correct-amount-INV-1002").click();
    const dlg = page.getByTestId("correct-open-item-dialog");
    await expect(dlg).toBeVisible();
    await expect(dlg.getByTestId("correct-current")).toContainText("8,000.00");
    await expect(dlg.getByTestId("correct-submit")).toBeDisabled();
    await dlg.getByTestId("correct-amount").fill("7000");
    await dlg.getByTestId("correct-date").fill("2025-02-10");
    await dlg.getByTestId("correct-reason").fill("transfer error: the previous system's invoice was 7,000");
    await expect(dlg.getByTestId("correct-preview")).toContainText("Dr Retained earnings SAR 1,000.00 / Cr Accounts receivable SAR 1,000.00");
    await dlg.getByTestId("correct-submit").click();
    await expect(dlg).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId("live-number-INV-1002")).toContainText(`OPEN-${batchId}-`);
    await expect(page.getByTestId("live-number-INV-1002")).toContainText("1 correction(s)");
    await expect(page.getByTestId("live-outstanding-INV-1002")).toContainText("7,000.00");
    // the books: the original stays (reversed), the replacement is live for 7,000, ONE new entry against retained earnings
    // the reversed original leaves the LIVE list (Batch 1C); it is still there by id
    type Row = { id: number; invoiceNumber: string; total: number; isOpening: boolean; reversedAt: string | null; replacesInvoiceId?: number | null; openingCorrectionJournalEntryId?: number | null; customerId: number };
    const inv = (await (await page.request.get("/api/invoices?limit=50")).json()).items as Row[];
    expect(inv.find((i) => i.invoiceNumber === "INV-1002")).toBeUndefined();
    const replacement = inv.find((i) => i.replacesInvoiceId != null && i.isOpening)!;
    const original = (await (await page.request.get(`/api/invoices/${replacement.replacesInvoiceId}`)).json()) as Row;
    expect(original.invoiceNumber).toBe("INV-1002");
    expect(original.reversedAt).not.toBeNull();
    expect(original.total).toBe(8000);
    expect(original.openingCorrectionJournalEntryId).toEqual(expect.any(Number));
    expect(replacement.invoiceNumber).toMatch(new RegExp(`^OPEN-${batchId}-\\d+$`));
    expect([replacement.total, replacement.isOpening, replacement.reversedAt]).toEqual([7000, true, null]);
    const je = await (await page.request.get("/api/journal-entries?limit=5")).json();
    expect(je.page.total).toBe(jeBefore + 1);
    const corr = await (await page.request.get(`/api/journal-entries/${original.openingCorrectionJournalEntryId}`)).json();
    expect(corr.entryNumber).toMatch(/^OPEN-CORR-/);
    expect(corr.reference).toBe(`migration:${batchId}`);
    const byCode = Object.fromEntries((corr.lines as { systemCode?: string | null; accountCode?: string; debitAmount: number; creditAmount: number; accountName: string }[]).map((l) => [l.accountName, [l.debitAmount, l.creditAmount]]));
    expect(byCode["Retained earnings"] ?? byCode["Retained Earnings"]).toEqual([1000, 0]);
    expect(byCode["Accounts Receivable"] ?? byCode["Accounts receivable"]).toEqual([0, 1000]);

    // the collected item (INV-1003, paid in the previous test): refused BY NAME, nothing written
    const items = (await (await page.request.get(`/api/migration/batches/${batchId}/open-items`)).json()).rows as { id: number; documentNumber: string; liveIdentityRecorded: boolean; corrections: number }[];
    const s1003 = items.find((r) => r.documentNumber === "INV-1003")!;
    const refused = await page.request.post(`/api/migration/open-items/${s1003.id}/correct`, { data: { correctOutstanding: 3500, reason: "x" } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).code).toBe("opening_item_partly_settled");
    expect((await (await page.request.get("/api/journal-entries?limit=5")).json()).page.total).toBe(jeBefore + 1);

    // the identity, recorded ONCE through the dialog — on the live replacement row of INV-1002
    await page.getByTestId("record-identity-INV-1002").click();
    const idDlg = page.getByTestId("record-identity-dialog");
    await expect(idDlg).toBeVisible();
    await expect(idDlg.getByTestId("identity-submit")).toBeDisabled();
    await idDlg.getByTestId("identity-status").click();
    await pickOption(page, /Issued before e-invoicing/);
    await expect(idDlg.getByTestId("identity-uuid")).toHaveCount(0); // pre-e-invoicing: no UUID exists to record
    await idDlg.getByTestId("identity-submit").click();
    await expect(idDlg).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId("identity-INV-1002")).toContainText("pre-e-invoicing");
    await expect(page.getByTestId("record-identity-INV-1002")).toHaveCount(0);
    // never changed: the second recording is refused at the API
    const s1002 = items.find((r) => r.documentNumber === "INV-1002")!;
    const again = await page.request.put(`/api/migration/open-items/${s1002.id}/identity`, { data: { einvoicingStatus: "cleared", sourceUuid: "not-invented-here" } });
    expect(again.status()).toBe(409);
    expect((await again.json()).code).toBe("opening_identity_already_recorded");
    // the credit note is now ALLOWED against the live row — through the picker, which offers it — and names the previous system's number
    await page.goto("/credit-notes");
    await page.getByTestId("new-note").click();
    await page.getByTestId("note-original").click();
    const opts = await page.getByRole("option").allTextContents();
    expect(opts.join(" | ")).toContain(replacement.invoiceNumber);
    expect(opts.join(" | ")).toContain("INV-1001");
    expect(opts.join(" | ")).not.toMatch(/INV-1002|INV-1003|INV-1004/);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const cn = await page.request.post("/api/invoices", { data: { invoiceNumber: "CN-E2E-2", documentType: "credit_note", originalInvoiceId: replacement.id, noteReason: "Price adjustment", date: "2025-02-11", dueDate: "2025-02-11", customerId: replacement.customerId, items: [{ description: "Adj", quantity: 1, unitPrice: 100, vatRate: 15 }] } });
    expect(cn.status(), await cn.text()).toBe(201);
    // the reversed original stays refused by name (the Batch 1C write boundary, before any note rule)
    const onOriginal = await page.request.post("/api/invoices", { data: { invoiceNumber: "CN-E2E-3", documentType: "credit_note", originalInvoiceId: original.id, noteReason: "x", date: "2025-02-11", dueDate: "2025-02-11", customerId: original.customerId, items: [{ description: "x", quantity: 1, unitPrice: 10, vatRate: 15 }] } });
    expect(onOriginal.status()).toBe(409);
    expect((await onOriginal.json()).code).toBe("opening_item_reversed");
  });

  test("Arabic / RTL: the workspace reads right-to-left with Arabic labels, and nothing scrolls sideways", async ({ page }) => {
    await page.goto(`/migration/${batchId}?section=overview`);
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("tab-chart")).toHaveText("دليل الحسابات");
    await expect(page.getByTestId("batch-status").first()).toHaveText("معتمد");
    for (const s of ["trial-balance", "ar", "reconciliation", "commit"]) {
      await page.getByTestId(`tab-${s}`).click();
      await expect(page.getByTestId(`section-${s}`)).toBeVisible();
      await noHorizontalScroll(page, `ar ${s}`);
    }
    await expect(page.getByTestId("relief-INV-1001").or(page.getByTestId("section-commit"))).toBeVisible();
    await page.getByTestId("tab-ar").click();
    await expect(page.getByTestId("relief-INV-1001")).toContainText("نعم");
    await expect(page.getByTestId("identity-INV-1001")).toContainText("معتمدة");
    await expect(page.getByTestId("identity-INV-1002")).toContainText("قبل الفوترة الإلكترونية");
    await expect(page.getByTestId("live-number-INV-1002")).toContainText("الصف الحي");
    await page.getByTestId("correct-amount-INV-1001").click();
    await expect(page.getByTestId("correct-open-item-dialog")).toContainText("تصحيح المبلغ المرحَّل");
    await noHorizontalScroll(page, "ar correct dialog");
    await page.keyboard.press("Escape");
    await page.goto("/invoices");
    await expect(page.locator("tr", { hasText: "INV-1001" }).first().getByTestId("opening-record-note")).toContainText("سجل تاريخي");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
  });

  test("phone width: the section picker replaces the tabs, every section renders without sideways scroll, and the import dialog fits", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/migration/${batchId}?section=overview`);
    await expect(page.getByTestId("section-select")).toBeVisible();
    await expect(page.getByTestId("section-tabs")).toBeHidden();
    // 🔴 The picker's order IS the SECTIONS order — keep the two in step (FA-D added "assets").
    const ORDER = ["overview", "chart", "parties", "ar", "ap", "advances", "assets", "banks", "vat", "trial-balance", "reconciliation", "validation", "commit"];
    for (const s of ["chart", "parties", "ar", "assets", "trial-balance", "validation", "commit"]) {
      await page.getByTestId("section-select").click();
      await page.getByRole("option").nth(ORDER.indexOf(s)).click();
      await expect(page.getByTestId(`section-${s}`)).toBeVisible();
      await noHorizontalScroll(page, `phone ${s}`);
    }
    // the follow-up dialogs fit a phone too (opened by a real click on the AR section's row action)
    await page.goto(`/migration/${batchId}?section=ar`);
    await page.getByTestId("correct-amount-INV-1001").click();
    const corr = page.getByTestId("correct-open-item-dialog");
    await expect(corr).toBeVisible();
    await expect.poll(async () => { const box = await corr.boundingBox(); return !!box && box.x >= 0 && box.x + box.width <= 391; }, { message: "the correction dialog fits a 390px phone", timeout: 5_000 }).toBe(true);
    await page.keyboard.press("Escape");
    await expect(corr).toBeHidden();
    await page.goto("/migration");
    await noHorizontalScroll(page, "phone list");
    await page.getByTestId("new-migration").click();
    const dlg = page.getByTestId("new-migration-dialog");
    await expect(dlg).toBeVisible();
    // The dialog animates in (zoom + slide from the left); read its box once it has settled.
    await expect.poll(async () => { const box = await dlg.boundingBox(); return !!box && box.x >= 0 && box.x + box.width <= 391; }, { message: "the new-migration dialog fits a 390px phone", timeout: 5_000 }).toBe(true);
  });
});

test.describe("permissions", () => {
  test.use({ storageState: E2E_MIGRATION.accountantState });
  test("an accountant reads the workspace and cannot stage, validate, commit or reverse — in the UI and at the API", async ({ page }) => {
    await page.goto("/migration");
    await expect(page.getByTestId("migration-permission-hint")).toBeVisible();
    await expect(page.getByTestId("new-migration")).toBeDisabled();
    // A different storageState means a different worker: read the committed batch from the API, not module state.
    const list = await (await page.request.get("/api/migration/batches")).json();
    const batchId = (list as Array<{ id: number; status: string }>).find((b) => b.status === "committed")!.id;
    await page.goto(`/migration/${batchId}?section=commit`);
    await expect(page.getByTestId("post-commit")).toBeVisible();
    await expect(page.getByTestId("open-reverse")).toHaveCount(0);
    await page.goto(`/migration/${batchId}?section=chart`);
    await expect(page.getByTestId("chart-row-1200")).toBeVisible();
    await expect(page.getByTestId("chart-import")).toHaveCount(0);
    for (const [method, path, data] of [
      ["put", `/api/migration/batches/${batchId}/parties`, { rows: [{ partyType: "customer", sourceId: "X", name: "Nope" }] }],
      ["post", `/api/migration/batches/${batchId}/validate`, undefined],
      ["post", `/api/migration/batches/${batchId}/commit`, undefined],
      ["post", `/api/migration/batches/${batchId}/reverse`, { reason: "accountant cannot reverse this" }],
      ["post", "/api/migration/batches", { sourceSystem: "X", cutoverDate: "2025-01-01" }],
    ] as const) {
      const res = method === "put" ? await page.request.put(path, { data }) : await page.request.post(path, { data });
      expect(res.status(), `${method.toUpperCase()} ${path}`).toBe(403);
    }
  });
});
