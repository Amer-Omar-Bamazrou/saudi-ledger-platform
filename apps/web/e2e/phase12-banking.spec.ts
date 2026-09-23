/**
 * PHASE 12 — BANKING & RECONCILIATION, WALKED BY CLICKING (2026-09-23).
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md.
 *
 * 12A — a statement FILE is imported as a statement:
 *   · 🔴 a file whose lines do not add up to the balances the user typed from
 *     the bank's print-out imports NOTHING, and the refusal says by how much;
 *   · with the right balances it imports, and the page says what was recorded;
 *   · 🔴 the SAME file again is refused and names the first import — the
 *     request is made by the page, from the bytes the user chose;
 *   · the register lists it; Arabic under dir=rtl and a phone, four modes.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };
const DESKTOP = 1280;
const STAMP = Date.now();

let api: APIRequestContext;
let bank: { id: number; name: string };

const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};

/** Pick an option in a Radix select by clicking — no DOM-only value setting. */
async function pickOption(page: Page, trigger: ReturnType<Page["getByTestId"]>, optionText: RegExp) {
  await trigger.click();
  await page.getByRole("option", { name: optionText }).click();
}

/** Walk one page in all four modes: EN desktop, EN phone, AR desktop, AR phone. */
const inFourModes = async (page: Page, path: string, testId: string, arabicHeading: RegExp) => {
  for (const [lang, viewport, label] of [
    ["en", null, "EN desktop"], ["en", PHONE, "EN phone"], ["ar", null, "AR desktop"], ["ar", PHONE, "AR phone"],
  ] as [string, typeof PHONE | null, string][]) {
    await page.setViewportSize(viewport ?? { width: DESKTOP, height: 900 });
    await page.goto(path);
    await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
    await page.reload();
    await expect(page.locator("html"), `${path} ${label}`).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
    await expect(page.getByTestId(testId), `${path} ${label}`).toBeVisible();
    if (lang === "ar") await expect(page.getByRole("heading", { name: arabicHeading }).first(), `${path} ${label} heading`).toBeVisible();
    await noSidewaysScroll(page, viewport?.width ?? DESKTOP, `${path} ${label}`);
  }
  await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
  await page.setViewportSize({ width: DESKTOP, height: 900 });
};

/** A two-line statement file, unique to this run (the stamp is in the narrative). */
const statementCsv = () => Buffer.from(
  ["date,description,amount,type",
   `2026-05-04,E2E P12A receipt A${STAMP},1200.00,credit`,
   `2026-05-09,E2E P12A charge A${STAMP},45.50,debit`].join("\n"),
  "utf8",
);

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const banks = (await (await api.get("/api/bank-accounts")).json()) as Array<{ id: number; name: string }>;
  bank = banks[0]!;
});
test.afterAll(async () => { await api.dispose(); });

/**
 * 12B — reconciling bank lines to the ledger movements they ARE:
 *   · 🔴 the reference pass reconciles a supplier payment's bank line by its
 *     reference, and nothing posts;
 *   · 🔴 by hand: one bank debit for TWO supplier payments; a line only
 *     partly answered stays partial, its remainder shown;
 *   · 🔴 undo needs a reason (the refusal on screen), then the line returns;
 *   · 🔴 a reconciled line cannot be accepted to post again (the defect);
 *   · Arabic / RTL and a phone, the page and its dialog.
 */
test.describe.serial("12B — the reconciliation workbench", () => {
  const REF = `P12B${STAMP}`;
  let vendorId = 0;
  const lineIds: Record<string, number> = {};

  const supplierPay = async (amount: number, reference: string | null, paidAt: string) =>
    (await (await api.post("/api/supplier-payments", { data: { vendorId, bankAccountId: bank.id, amount, paidAt, classification: "advance", ...(reference ? { reference } : {}) } })).json()) as { id: number };
  const lineState = async (id: number) => (await (await api.get(`/api/bank-reconciliation/lines/${id}`)).json()) as { status: string; remaining: number; kind: string; reconciledBy: Array<{ linkId: number | null; documentKind: string }> };
  const entries = async () => ((await (await api.get("/api/journal-entries?limit=1")).json()).page?.total) as number;

  test.beforeAll(async () => {
    vendorId = (JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds).vendorId;
    // The ledger side first: payments recorded before the statement arrives — the common case.
    await supplierPay(1234.56, REF, "2026-04-02");
    await supplierPay(400, null, "2026-04-05");
    await supplierPay(377, null, "2026-04-05");
    await supplierPay(300, null, "2026-04-08");
    // Then the bank's lines.
    const descs = { ref: `OUTWARD TT ${REF}`, multi: `BATCH ${STAMP}`, part: `PART ${STAMP}` };
    const up = await api.post("/api/transactions/upload", { data: { bankAccountId: bank.id, autoCategrize: false, rows: [
      { date: "2026-04-03", description: descs.ref, amount: 1234.56, type: "debit", currency: "SAR" },
      { date: "2026-04-05", description: descs.multi, amount: 777, type: "debit", currency: "SAR" },
      { date: "2026-04-08", description: descs.part, amount: 500, type: "debit", currency: "SAR" },
    ] } });
    expect(up.ok(), `upload: ${up.status()} ${await up.text()}`).toBe(true);
    const listed = (await (await api.get(`/api/transactions?search=${STAMP}&limit=50`)).json()).transactions as Array<{ id: number; description: string }>;
    for (const [k, d] of Object.entries(descs)) lineIds[k] = listed.find((l) => l.description === d)!.id;
  });

  test("🔴 the reference pass reconciles the supplier payment's bank line — and posts nothing", async ({ page }) => {
    const before = await entries();
    await page.goto("/bank-reconciliation");
    await expect(page.getByTestId("page-bank-reconciliation")).toBeVisible();
    await pickOption(page, page.getByTestId("rec-bank"), new RegExp(bank.name));
    await expect(page.getByTestId(`rec-line-${lineIds.ref}`)).toBeVisible();
    await page.getByTestId("rec-apply-ap").click();
    await expect(page.getByText(/line\(s\) reconciled/).first()).toBeVisible();
    const s = await lineState(lineIds.ref!);
    expect(s.status).toBe("reconciled");
    expect(s.kind).toBe("matched");
    expect(s.reconciledBy[0]!.documentKind).toBe("supplier_payment");
    expect(await entries(), "reconciling posts nothing").toBe(before);
    // 🔴 the defect, through the API the Review page uses: a reconciled line is never accepted
    const accept = await api.post("/api/transactions/review/accept", { data: { ids: [lineIds.ref] } });
    expect(accept.status()).toBe(409);
  });

  test("🔴 by hand: one bank debit for TWO supplier payments; a line only partly answered shows its remainder", async ({ page }) => {
    await page.goto("/bank-reconciliation");
    await pickOption(page, page.getByTestId("rec-bank"), new RegExp(bank.name));
    await page.getByTestId(`rec-open-${lineIds.multi}`).click();
    const dialog = page.getByTestId("rec-line-dialog");
    await expect(dialog).toBeVisible();
    // the two payments of 400 and 377 are offered; "Use" fills what each can answer
    const cands = dialog.locator('[data-testid^="rec-cand-"]');
    await expect(cands.filter({ hasText: "400.00" }).first()).toBeVisible();
    await cands.filter({ hasText: "400.00" }).first().getByRole("button", { name: /Use/ }).click();
    await cands.filter({ hasText: "377.00" }).first().getByRole("button", { name: /Use/ }).click();
    await expect(dialog.getByTestId("rec-selected-total")).toContainText("777.00");
    await dialog.getByTestId("rec-submit").click();
    await expect(dialog.getByTestId("rec-dialog-remaining")).toContainText("0.00");
    expect((await lineState(lineIds.multi!)).reconciledBy).toHaveLength(2);
    await page.getByTestId("rec-close").click();

    await page.getByTestId("rec-status").click();
    await page.getByRole("option", { name: /All lines/ }).click();
    await page.getByTestId(`rec-open-${lineIds.part}`).click();
    await dialog.locator('[data-testid^="rec-cand-"]').filter({ hasText: "300.00" }).first().getByRole("button", { name: /Use/ }).click();
    await dialog.getByTestId("rec-submit").click();
    await expect(dialog.getByTestId("rec-dialog-remaining")).toContainText("200.00");
    await page.getByTestId("rec-close").click();
    await expect(page.getByTestId(`rec-status-${lineIds.part}`)).toContainText(/Partly reconciled/);
    await expect(page.getByTestId(`rec-remaining-${lineIds.part}`)).toContainText("200.00");
  });

  test("🔴 undo needs a reason — the refusal is on screen — then the line returns to unreconciled", async ({ page }) => {
    await page.goto("/bank-reconciliation");
    await pickOption(page, page.getByTestId("rec-bank"), new RegExp(bank.name));
    await page.getByTestId("rec-status").click();
    await page.getByRole("option", { name: /All lines/ }).click();
    await page.getByTestId(`rec-open-${lineIds.part}`).click();
    const dialog = page.getByTestId("rec-line-dialog");
    const link = (await lineState(lineIds.part!)).reconciledBy.find((r) => r.linkId != null)!;
    await dialog.getByTestId(`rec-undo-${link.linkId}`).click();
    await expect(page.getByText(/Say why this reconciliation is being undone/).first()).toBeVisible();
    await dialog.getByTestId("rec-undo-reason").fill("Linked to the wrong payment");
    await dialog.getByTestId(`rec-undo-${link.linkId}`).click();
    await expect(dialog.getByTestId("rec-dialog-remaining")).toContainText("500.00");
    expect((await lineState(lineIds.part!)).status).toBe("unreconciled");
  });

  test("Arabic / RTL and a phone: the workbench and its dialog", async ({ page }) => {
    test.setTimeout(120_000);
    await inFourModes(page, "/bank-reconciliation", "page-bank-reconciliation", /التسوية البنكية/);
    await page.setViewportSize(PHONE);
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.goto("/bank-reconciliation");
    await pickOption(page, page.getByTestId("rec-status"), /كل الأسطر/);
    await page.getByTestId(`rec-open-${lineIds.multi}`).click();
    await expect(page.getByTestId("rec-line-dialog")).toBeVisible();
    await expect(page.getByText("مسوّى مع").first()).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "AR phone reconciliation dialog");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
  });
});

test.describe.serial("12A — a statement file is imported as a statement", () => {
  const statementCount = async () =>
    ((await (await api.get(`/api/bank-statements?bankAccountId=${bank.id}`)).json()).items as unknown[]).length;
  const lineCount = async () =>
    ((await (await api.get(`/api/transactions?search=A${STAMP}&limit=50`)).json()).transactions as unknown[]).length;

  const chooseFile = async (page: Page) => {
    await page.goto("/upload", { waitUntil: "networkidle" });
    await pickOption(page, page.getByTestId("upload-bank-account"), new RegExp(bank.name));
    await page.locator('input[type="file"]').first().setInputFiles({ name: `p12a-${STAMP}.csv`, mimeType: "text/csv", buffer: statementCsv() });
    await expect(page.getByTestId("upload-import-file")).toBeEnabled();
  };

  test("🔴 balances the file does not add up to: NOTHING is imported, and the page says by how much", async ({ page }) => {
    const [statements, lines] = [await statementCount(), await lineCount()];
    await chooseFile(page);
    // 1,000 + 1,200 − 45.50 = 2,154.50 — the user typed 2,200 from the print-out
    await page.getByTestId("upload-opening-balance").fill("1000");
    await page.getByTestId("upload-closing-balance").fill("2200");
    await page.getByTestId("upload-import-file").click();
    await expect(page.getByText(/does not agree with its own balances/).first()).toBeVisible();
    await expect(page.getByText(/difference 45\.50/).first()).toBeVisible();
    expect(await statementCount(), "no statement").toBe(statements);
    expect(await lineCount(), "no line").toBe(lines);
  });

  test("🔴 the right balances import the file as a statement, and the SAME file again is refused", async ({ page }) => {
    const statements = await statementCount();
    await chooseFile(page);
    await page.getByTestId("upload-opening-balance").fill("1000");
    await page.getByTestId("upload-closing-balance").fill("2154.50");
    await page.getByTestId("upload-import-file").click();
    await expect(page.getByTestId("upload-statement-recorded")).toBeVisible();
    await expect(page.getByTestId("upload-statement-recorded")).toContainText("2 / 2");
    expect(await statementCount()).toBe(statements + 1);
    expect(await lineCount()).toBe(2);

    // the same bytes again — refused by the server, the refusal on screen, nothing written
    await chooseFile(page);
    await page.getByTestId("upload-import-file").click();
    await expect(page.getByText(/already imported for this bank as statement #\d+/).first()).toBeVisible();
    expect(await statementCount()).toBe(statements + 1);
    expect(await lineCount()).toBe(2);
  });

  test("the register lists the statement with what the bank stated and what was imported", async ({ page }) => {
    const items = ((await (await api.get(`/api/bank-statements?bankAccountId=${bank.id}`)).json()).items) as Array<{ id: number; fileName: string | null; closingBalance: number | null }>;
    const mine = items.find((s) => s.fileName === `p12a-${STAMP}.csv`)!;
    expect(mine.closingBalance).toBe(2154.5);
    await page.goto("/bank-statements");
    await expect(page.getByTestId(`bank-statement-${mine.id}`)).toContainText("2,154.50");
    await expect(page.getByTestId(`bank-statement-imported-${mine.id}`)).toHaveText("2 / 2");
  });

  test("Arabic / RTL and a phone: the register and the import page, four modes", async ({ page }) => {
    test.setTimeout(120_000);
    await inFourModes(page, "/bank-statements", "page-bank-statements", /كشوف الحسابات البنكية/);
    await inFourModes(page, "/upload", "upload-bank-account", /استيراد/);
  });
});
