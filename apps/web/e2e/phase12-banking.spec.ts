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

/**
 * The amount an element ENDS with, as a number ("-SAR 5.00" → -5). 🔴 Money is
 * asserted exactly, never by substring: "2,500.00" CONTAINS "0.00", and a
 * substring check once passed while nothing had been reconciled.
 */
const moneyOf = async (loc: ReturnType<Page["getByTestId"]>) => {
  const m = (await loc.innerText()).match(/(-)?[^\d-]*([\d,]+\.\d{2})\s*$/);
  return m ? (m[1] ? -1 : 1) * Number(m[2]!.replace(/,/g, "")) : NaN;
};

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
    await expect.poll(() => moneyOf(dialog.getByTestId("rec-selected-total"))).toBe(777);
    await dialog.getByTestId("rec-submit").click();
    await expect.poll(() => moneyOf(dialog.getByTestId("rec-dialog-remaining"))).toBe(0);
    expect((await lineState(lineIds.multi!)).reconciledBy).toHaveLength(2);
    await page.getByTestId("rec-close").click();

    await page.getByTestId("rec-status").click();
    await page.getByRole("option", { name: /All lines/ }).click();
    await page.getByTestId(`rec-open-${lineIds.part}`).click();
    await dialog.locator('[data-testid^="rec-cand-"]').filter({ hasText: "300.00" }).first().getByRole("button", { name: /Use/ }).click();
    await dialog.getByTestId("rec-submit").click();
    await expect.poll(() => moneyOf(dialog.getByTestId("rec-dialog-remaining"))).toBe(200);
    await page.getByTestId("rec-close").click();
    await expect(page.getByTestId(`rec-status-${lineIds.part}`)).toContainText(/Partly reconciled/);
    await expect.poll(() => moneyOf(page.getByTestId(`rec-remaining-${lineIds.part}`))).toBe(200);
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
    await expect.poll(() => moneyOf(dialog.getByTestId("rec-dialog-remaining"))).toBe(500);
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

/**
 * 12C — a transfer between two of the business's own banks, by clicking:
 *   · 🔴 recording it moves BOTH banks' ledger balances, by the amount, once;
 *   · 🔴 a near-identical transfer is refused ON SCREEN with what it may
 *     repeat, and records only once the person says why it is different;
 *   · 🔴 its statement leg reconciles to it in the workbench (labelled as a
 *     bank transfer), and a reconciled transfer's reversal is refused in words;
 *   · Arabic / RTL and a phone, the page and its dialog.
 * Runs after d3-bank-flows (one worker, alphabetical), which needs the tenant
 * to have exactly ONE bank — the second bank is created here, and the tenant
 * is reset at the start of every run.
 */
test.describe.serial("12C — transfers between own banks", () => {
  let second: { id: number; name: string };
  type Ledger = { id: number; ledgerBalance: number };
  const ledgers = async () => (await (await api.get("/api/bank-accounts")).json()) as Ledger[];
  const ledgerOf = (all: Ledger[], id: number) => all.find((b) => b.id === id)!.ledgerBalance;

  test.beforeAll(async () => {
    const res = await api.post("/api/bank-accounts", { data: { name: `E2E Payroll ${STAMP}`, bankName: "Al Rajhi", currency: "SAR" } });
    expect(res.ok(), await res.text()).toBe(true);
    second = (await res.json()) as { id: number; name: string };
  });

  const recordTransfer = async (page: Page, amount: string, date: string) => {
    await page.getByTestId("trf-new").click();
    const dialog = page.getByTestId("trf-dialog");
    await expect(dialog).toBeVisible();
    await pickOption(page, dialog.getByTestId("trf-from"), new RegExp(bank.name));
    await pickOption(page, dialog.getByTestId("trf-to"), new RegExp(second.name));
    await dialog.getByTestId("trf-amount").fill(amount);
    await dialog.getByTestId("trf-date").fill(date);
    await dialog.getByTestId("trf-submit").click();
    return dialog;
  };

  test("🔴 recording a transfer moves both banks once; a near-identical one is explained and needs a reason", async ({ page }) => {
    const before = await ledgers();
    await page.goto("/bank-transfers");
    await expect(page.getByTestId("page-bank-transfers")).toBeVisible();
    const d1 = await recordTransfer(page, "2500", "2026-06-02");
    await expect(d1).toBeHidden();
    const after = await ledgers();
    expect(ledgerOf(after, bank.id), "the source bank went DOWN by the amount").toBeCloseTo(ledgerOf(before, bank.id) - 2500, 2);
    expect(ledgerOf(after, second.id), "the destination bank went UP by the amount").toBeCloseTo(ledgerOf(before, second.id) + 2500, 2);

    const d2 = await recordTransfer(page, "2500", "2026-06-03");
    await expect(d2.getByTestId("trf-duplicates")).toBeVisible();
    await expect(d2.getByTestId("trf-duplicates")).toContainText("2,500.00");
    await expect(d2.getByTestId("trf-submit"), "no reason, no record").toBeDisabled();
    expect(ledgerOf(await ledgers(), second.id), "the refusal moved nothing").toBeCloseTo(ledgerOf(after, second.id), 2);
    await d2.getByTestId("trf-duplicate-reason").fill("second top-up, same amount");
    await d2.getByTestId("trf-submit").click();
    await expect(d2).toBeHidden();
    await expect(page.getByText("Confirmed not a duplicate: second top-up, same amount").first()).toBeVisible();
  });

  test("🔴 the statement leg reconciles to the transfer in the workbench; the reconciled transfer cannot be reversed", async ({ page }) => {
    const transfers = (await (await api.get("/api/bank-transfers?limit=50")).json()).transfers as Array<{ id: number; transferDate: string; reversal: unknown }>;
    const first = transfers.find((x) => x.transferDate === "2026-06-02")!;
    const desc = `TFR TO PAYROLL ${STAMP}`;
    const up = await api.post("/api/transactions/upload", { data: { bankAccountId: bank.id, autoCategrize: false, rows: [{ date: "2026-06-02", description: desc, amount: 2500, type: "debit", currency: "SAR" }] } });
    expect(up.ok(), await up.text()).toBe(true);
    const listed = (await (await api.get(`/api/transactions?search=${encodeURIComponent(desc)}&limit=5`)).json()).transactions as Array<{ id: number }>;
    const lineId = listed[0]!.id;

    await page.goto("/bank-reconciliation");
    await pickOption(page, page.getByTestId("rec-bank"), new RegExp(bank.name));
    await page.getByTestId(`rec-open-${lineId}`).click();
    const dialog = page.getByTestId("rec-line-dialog");
    const cand = dialog.locator('[data-testid^="rec-cand-"]').filter({ hasText: "Bank transfer" }).first();
    await expect(cand, "the transfer is offered, labelled as a bank transfer").toBeVisible();
    await cand.getByRole("button", { name: /Use/ }).click();
    await dialog.getByTestId("rec-submit").click();
    await expect.poll(() => moneyOf(dialog.getByTestId("rec-dialog-remaining"))).toBe(0);
    // The SERVER's word, before leaving the page (leaving aborts an in-flight request).
    await expect.poll(async () => (await (await api.get(`/api/bank-reconciliation/lines/${lineId}`)).json()).status).toBe("reconciled");
    await page.getByTestId("rec-close").click();

    await page.goto("/bank-transfers");
    await expect(page.getByTestId(`trf-state-${first.id}`)).toContainText("1 of 2 reconciled");
    await page.getByTestId(`trf-reverse-${first.id}`).click();
    const rev = page.getByTestId("trf-reverse-dialog");
    await rev.getByTestId("trf-reverse-reason").fill("test: should be refused");
    await rev.getByTestId("trf-reverse-submit").click();
    await expect(rev.getByTestId("trf-reverse-error")).toContainText("reconciled");
  });

  test("Arabic / RTL and a phone: the transfers page and its dialog", async ({ page }) => {
    test.setTimeout(120_000);
    await inFourModes(page, "/bank-transfers", "page-bank-transfers", /التحويلات بين الحسابات البنكية/);
    await page.setViewportSize(PHONE);
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.goto("/bank-transfers");
    await page.getByTestId("trf-new").click();
    await expect(page.getByTestId("trf-dialog")).toBeVisible();
    await expect(page.getByText("من (خرجت منه الأموال)")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "AR phone transfer dialog");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
  });
});

/**
 * 12D — a period reconciliation, the cash position and the bank-accounts
 * headline, by clicking:
 *   · 🔴 a wrong balance shows its difference and CANNOT be completed (no plug);
 *     the right one completes, and the bank is then locked through the date;
 *   · reopening needs a reason, and unlocks;
 *   · 🔴 the cash position and the Bank Accounts headline show the LEDGER
 *     balance — the same figure the API computes — not the typed balance;
 *   · Arabic / RTL and a phone.
 * On a bank of its own, so its lock touches no other spec's postings.
 */
test.describe.serial("12D — period reconciliation and the cash position", () => {
  let recBank: { id: number; name: string };
  type Ledger = { id: number; ledgerBalance: number };

  test.beforeAll(async () => {
    const res = await api.post("/api/bank-accounts", { data: { name: `E2E Recon ${STAMP}`, bankName: "SNB", currency: "SAR" } });
    expect(res.ok(), await res.text()).toBe(true);
    recBank = (await res.json()) as { id: number; name: string };
    // May: 1,000 arrives by transfer from the main bank (recorded, and its leg reconciled); the bank also charged 15.
    const trf = await api.post("/api/bank-transfers", { data: { fromBankAccountId: bank.id, toBankAccountId: recBank.id, amount: 1000, transferDate: "2026-05-10", reference: `REC${STAMP}` } });
    expect(trf.ok(), await trf.text()).toBe(true);
    const transfer = (await trf.json()) as { journalEntryId: number };
    const up = await api.post("/api/transactions/upload", { data: { bankAccountId: recBank.id, autoCategrize: false, rows: [
      { date: "2026-05-10", description: `TFR IN REC${STAMP}`, amount: 1000, type: "credit", currency: "SAR" },
      { date: "2026-05-31", description: `ACCOUNT FEE REC${STAMP}`, amount: 15, type: "debit", currency: "SAR" },
    ] } });
    expect(up.ok(), await up.text()).toBe(true);
    const lines = (await (await api.get(`/api/bank-reconciliation/lines?bankAccountId=${recBank.id}&limit=10`)).json()).items as Array<{ id: number; amount: number }>;
    const leg = lines.find((l) => Math.abs(l.amount) === 1000)!;
    const detail = (await (await api.get(`/api/bank-reconciliation/lines/${leg.id}`)).json()) as { candidates: Array<{ journalLineId: number; journalEntryId: number }> };
    const cand = detail.candidates.find((c) => c.journalEntryId === transfer.journalEntryId)!;
    const link = await api.post(`/api/bank-reconciliation/lines/${leg.id}/links`, { data: { lines: [{ journalLineId: cand.journalLineId, amount: 1000 }] } });
    expect(link.ok(), await link.text()).toBe(true);
  });

  test("🔴 a wrong balance shows its difference and cannot complete; the right one completes and locks the month", async ({ page }) => {
    await page.goto("/bank-reconciliations");
    await expect(page.getByTestId("page-bank-reconciliations")).toBeVisible();
    await pickOption(page, page.getByTestId("brec-bank"), new RegExp(recBank.name));
    await page.getByTestId("brec-asof").fill("2026-05-31");
    await page.getByTestId("brec-balance").fill("980");
    await expect.poll(() => moneyOf(page.getByTestId("brec-expected"))).toBe(985);
    await expect.poll(() => moneyOf(page.getByTestId("brec-difference"))).toBe(-5);
    await expect(page.getByTestId("brec-find")).toBeVisible();
    await expect(page.getByTestId("brec-complete"), "no plug: a difference cannot be completed").toBeDisabled();
    await expect(page.getByTestId("brec-statement-only")).toContainText(`ACCOUNT FEE REC${STAMP}`);

    await page.getByTestId("brec-balance").fill("985");
    await expect.poll(() => moneyOf(page.getByTestId("brec-difference"))).toBe(0);
    await page.getByTestId("brec-complete").click();
    await expect(page.getByTestId("brec-through")).toContainText("2026-05-31");
    const rows = page.locator('[data-testid^="brec-row-"]');
    await expect(rows.first()).toContainText("Completed");

    // The lock, through the API the upload page uses: a May line is refused, in words.
    const late = await api.post("/api/transactions/upload", { data: { bankAccountId: recBank.id, autoCategrize: false, rows: [{ date: "2026-05-20", description: `LATE REC${STAMP}`, amount: 5, type: "debit", currency: "SAR" }] } });
    expect(late.status()).toBe(409);
    expect((await late.json()).code).toBe("bank_reconciled_through");
  });

  test("reopening needs a reason, and unlocks the month", async ({ page }) => {
    await page.goto("/bank-reconciliations");
    await pickOption(page, page.getByTestId("brec-bank"), new RegExp(recBank.name));
    const reopen = page.locator('[data-testid^="brec-reopen-"]').first();
    await reopen.click();
    const dialog = page.getByTestId("brec-reopen-dialog");
    await expect(dialog.getByTestId("brec-reopen-submit"), "no reason, no reopening").toBeDisabled();
    await dialog.getByTestId("brec-reopen-reason").fill("the bank re-issued May");
    await dialog.getByTestId("brec-reopen-submit").click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-testid^="brec-row-"]').first()).toContainText("Reopened");
    const late = await api.post("/api/transactions/upload", { data: { bankAccountId: recBank.id, autoCategrize: false, rows: [{ date: "2026-05-20", description: `LATE REC${STAMP}`, amount: 5, type: "debit", currency: "SAR" }] } });
    expect(late.ok(), "unlocked, the May line imports").toBe(true);
  });

  test("🔴 the cash position and the Bank Accounts headline show the LEDGER balance the API computes", async ({ page }) => {
    const ledgers = (await (await api.get("/api/bank-accounts")).json()) as Ledger[];
    const ledger = ledgers.find((b) => b.id === recBank.id)!.ledgerBalance;
    expect(ledger, "the transfer in, and nothing typed").toBeCloseTo(1000, 2);
    await page.goto("/cash-position");
    await expect(page.getByTestId("page-cash-position")).toBeVisible();
    await expect.poll(() => moneyOf(page.getByTestId(`cp-ledger-${recBank.id}`))).toBe(1000);
    await expect(page.getByTestId(`cp-statement-${recBank.id}`), "no statement states a balance — said so, not zero").toContainText("not known");
    await expect(page.getByTestId("cp-exceptions")).toBeVisible();

    await page.goto("/bank-accounts");
    const card = page.locator("[data-row]", { hasText: recBank.name });
    await expect.poll(() => moneyOf(card.getByTestId("ledger-balance"))).toBe(1000);
    await expect(card.getByTestId("typed-balance")).toContainText("not updated by postings");
  });

  test("Arabic / RTL and a phone: period reconciliation and the cash position", async ({ page }) => {
    test.setTimeout(150_000);
    await inFourModes(page, "/bank-reconciliations", "page-bank-reconciliations", /التسوية البنكية للفترة/);
    await inFourModes(page, "/cash-position", "page-cash-position", /المركز النقدي والاستثناءات/);
  });
});
