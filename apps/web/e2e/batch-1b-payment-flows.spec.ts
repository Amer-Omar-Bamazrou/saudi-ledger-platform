/**
 * BATCH 1B PHASE F — PAYMENTS, ALLOCATIONS, CREDITS, REFUNDS, MATCHING, THE
 * STATEMENT AND THE AGEING, WALKED BY CLICKING (2026-09-17).
 *
 * Every flow drives the REAL page — the dialog, the Radix select, the submit —
 * and then checks the backend effect through the figure a human would check
 * (the invoice's outstanding, the receipt's unapplied remainder, the credit
 * note's remaining balance, the customer's three-component position), read
 * back from the API. English desktop first; then the same surfaces on a phone
 * and in Arabic under dir=rtl.
 *
 * Frame: the suite's own org (global-setup): one customer, one bank, INV-002
 * partly paid (1,300 open), INV-003 open, CN-001 (115) against the PAID
 * INV-001 so its whole amount is a credit-note balance, and one receipt of
 * 800 held ON ACCOUNT (a deposit). Two seeded statement rows classify
 * DETERMINISTIC and AMBIGUOUS; the seed's 1,150 row is UNMATCHED.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };

type Payment = { id: number; amount: number; allocatedAmount: number; refundedAmount: number; unappliedAmount: number; allocations: Array<{ id: number; invoiceId: number; amount: number; reversedBy: null | { id: number; reason: string } }> };
type Position = { receivable: number; creditBalance: number; depositBalance: number; netPosition: number };
type Invoice = { id: number; invoiceNumber: string; total: number; paidAmount: number; creditedAmount: number; documentType: string; status: string };

let api: APIRequestContext;
let ids: SeededIds;
let cn: Invoice;

const toast = (page: Page, title: string) => page.getByText(title, { exact: true }).first();
async function pickOption(page: Page, trigger: ReturnType<Page["getByTestId"]>, optionText: RegExp) {
  await trigger.click();
  await page.getByRole("option", { name: optionText }).click();
}
const payment = async (id: number): Promise<Payment> => (await api.get(`/api/payments/${id}`)).json();
const position = async (): Promise<Position> => (await api.get(`/api/customers/${ids.customerId}`)).json();
const invoice = async (number: string): Promise<Invoice> => {
  const page: { items: Invoice[] } = await (await api.get(`/api/invoices?customer_id=${ids.customerId}&limit=200`)).json();
  const inv = page.items.find((i) => i.invoiceNumber === number);
  if (!inv) throw new Error(`e2e: ${number} not found`);
  return inv;
};
const outstanding = (i: Invoice) => Math.round((i.total - i.paidAmount - i.creditedAmount) * 100) / 100;
const creditRemaining = async (): Promise<number> => (await (await api.get(`/api/payments/credit-notes/${cn.id}/applications`)).json()).remainingAmount;
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The dialog animates in (zoom + slide); its box is read once it has settled inside the viewport. */
async function expectFits(dialog: ReturnType<Page["getByTestId"]>, width: number, message: string) {
  await expect(dialog).toBeVisible();
  await expect.poll(async () => {
    const box = await dialog.boundingBox();
    return !!box && box.x >= 0 && box.x + box.width <= width + 1;
  }, { message, timeout: 5_000 }).toBe(true);
}

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  ids = JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds;
  cn = await invoice("E2E-CN-001");
});
test.afterAll(async () => { await api.dispose(); });

/** Open the customer page and expand one receipt. */
async function openReceipt(page: Page, paymentId: number) {
  await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
  const toggle = page.getByTestId(`payment-toggle-${paymentId}`);
  await expect(toggle).toBeVisible();
  await toggle.click();
  const detail = page.getByTestId(`payment-detail-${paymentId}`);
  await expect(detail).toBeVisible();
  return detail;
}
const openDeposit = (page: Page) => openReceipt(page, ids.depositPaymentId);

/**
 * Record a receipt ON ACCOUNT through the product's own dialog (the customer
 * page's "Record receipt"), and return its id. Each later flow allocates from
 * its own fresh receipt: one ACTIVE allocation per (source, invoice) is the
 * server's rule, and the English desktop flow leaves the seeded deposit
 * allocated to both open invoices.
 */
async function recordReceipt(page: Page, amount: number, lang: "en" | "ar"): Promise<number> {
  const reference = `E2E-RCPT-${Date.now()}`;
  await page.getByTestId("record-receipt").click();
  const dialog = page.getByTestId("receive-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("receive-amount").fill(String(amount));
  await expect(dialog.getByTestId("receive-submit"), "no bank → cannot submit").toBeDisabled();
  await pickOption(page, dialog.getByTestId("receive-bank-account"), /E2E Current Account/);
  await dialog.getByTestId("receive-reference").fill(reference);
  await dialog.getByTestId("receive-submit").click();
  await expect(toast(page, lang === "ar" ? "تم تسجيل الإيصال" : "Receipt recorded")).toBeVisible();
  await expect(dialog).toBeHidden();
  const list: Array<{ id: number; reference: string | null; unappliedAmount: number }> = await (await api.get(`/api/payments?customer_id=${ids.customerId}&limit=200`)).json();
  const p = list.find((x) => x.reference === reference);
  if (!p) throw new Error("e2e: the recorded receipt was not listed");
  expect(p.unappliedAmount, "a receipt on account is wholly a deposit").toBe(amount);
  return p.id;
}

test.describe("Phase F — English desktop", () => {
  test("🔴 Payment flow: view → allocate (partial) → invoice balance moves → unallocate → available restored → reallocate across two invoices", async ({ page }) => {
    const p0 = await payment(ids.depositPaymentId);
    expect(p0.unappliedAmount, "the seeded receipt is wholly on account").toBe(800);
    const inv2Before = outstanding(await invoice("E2E-INV-002"));
    const inv3Before = outstanding(await invoice("E2E-INV-003"));

    const detail = await openDeposit(page);
    // Payment and allocation are labelled as two different things.
    await expect(detail.getByText("Payment", { exact: true })).toBeVisible();
    await expect(detail.getByText("Allocations — where this payment went")).toBeVisible();
    await expect(detail.getByTestId("payment-unapplied")).toContainText(money(800));
    await expect(detail.getByTestId("no-allocations")).toBeVisible();

    // Partial allocation: 300 of 800 to INV-002.
    await detail.getByTestId(`allocate-${ids.depositPaymentId}`).click();
    const dialog = page.getByTestId("allocate-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("allocate-row-E2E-INV-002").getByRole("spinbutton").fill("300");
    await expect(dialog.getByTestId("allocate-remaining")).toContainText(money(500));
    await dialog.getByTestId("allocate-submit").click();
    await expect(toast(page, "Payment allocated")).toBeVisible();
    await expect(dialog).toBeHidden();

    let p = await payment(ids.depositPaymentId);
    expect(p.allocatedAmount).toBe(300);
    expect(p.unappliedAmount).toBe(500);
    expect(outstanding(await invoice("E2E-INV-002")), "the invoice's outstanding fell by the allocation").toBe(Math.round((inv2Before - 300) * 100) / 100);
    await expect(page.getByTestId("invoice-outstanding-E2E-INV-002")).toContainText(money(inv2Before - 300));
    await expect(page.getByTestId("payment-unapplied")).toContainText(money(500));

    // Unallocate it: the original row stays, marked corrected; the amount returns.
    const active = p.allocations.find((a) => !a.reversedBy)!;
    await page.getByTestId(`unallocate-${active.id}`).click();
    const un = page.getByTestId("unallocate-dialog");
    await expect(un).toBeVisible();
    await expect(un.getByText("E2E-INV-002")).toBeVisible();
    await un.getByTestId("unallocate-reason").fill("Allocated to the wrong invoice");
    await un.getByTestId("unallocate-submit").click();
    await expect(toast(page, "Allocation corrected")).toBeVisible();
    await expect(un).toBeHidden();

    p = await payment(ids.depositPaymentId);
    expect(p.unappliedAmount, "the available amount is restored").toBe(800);
    expect(p.allocations.find((a) => a.id === active.id)!.reversedBy?.reason).toBe("Allocated to the wrong invoice");
    expect(outstanding(await invoice("E2E-INV-002"))).toBe(inv2Before);
    const row = page.getByTestId(`allocation-${active.id}`);
    await expect(row, "the corrected allocation is still visible").toBeVisible();
    await expect(row).toHaveAttribute("data-allocation-state", "corrected");
    await expect(row.getByText("Allocated to the wrong invoice")).toBeVisible();

    // Reallocate the returned amount across TWO invoices.
    await page.getByTestId(`allocate-${ids.depositPaymentId}`).click();
    const d2 = page.getByTestId("allocate-dialog");
    await d2.getByTestId("allocate-row-E2E-INV-002").getByRole("spinbutton").fill("200");
    await d2.getByTestId("allocate-row-E2E-INV-003").getByRole("spinbutton").fill("100");
    await expect(d2.getByTestId("allocate-remaining")).toContainText(money(500));
    await d2.getByTestId("allocate-submit").click();
    await expect(toast(page, "Payment allocated")).toBeVisible();
    await expect(d2).toBeHidden();

    p = await payment(ids.depositPaymentId);
    expect(p.allocatedAmount).toBe(300);
    expect(p.unappliedAmount).toBe(500);
    expect(p.allocations.filter((a) => !a.reversedBy).map((a) => a.amount).sort()).toEqual([100, 200]);
    expect(outstanding(await invoice("E2E-INV-002"))).toBe(Math.round((inv2Before - 200) * 100) / 100);
    expect(outstanding(await invoice("E2E-INV-003"))).toBe(Math.round((inv3Before - 100) * 100) / 100);
    // The position tiles: deposits fell by what is now allocated.
    const pos = await position();
    expect(pos.depositBalance).toBe(500);
    await expect(page.getByTestId("position-deposits")).toContainText(money(500));
  });

  test("🔴 Credit flow: the note's balance is a credit (not negative AR) → apply → invoice moves → correct → credit restored", async ({ page }) => {
    const before = await creditRemaining();
    expect(before, "CN-001 against a PAID invoice is wholly a credit-note balance").toBe(115);
    const inv2Before = outstanding(await invoice("E2E-INV-002"));
    const pos0 = await position();
    expect(pos0.creditBalance).toBe(115);
    expect(pos0.receivable, "AR is never negative").toBeGreaterThanOrEqual(0);

    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    await expect(page.getByTestId("position-credits")).toContainText(money(115));
    await expect(page.getByTestId("credit-note-remaining-E2E-CN-001")).toContainText(money(115));
    await page.getByTestId("credit-note-toggle-E2E-CN-001").click();
    const detail = page.getByTestId(`credit-note-detail-${cn.id}`);
    await expect(detail.getByTestId("credit-remaining")).toContainText(money(115));

    await detail.getByTestId(`apply-credit-${cn.id}`).click();
    const dialog = page.getByTestId("allocate-dialog");
    await expect(dialog.getByText("Apply credit note E2E-CN-001")).toBeVisible();
    await dialog.getByTestId("allocate-row-E2E-INV-002").getByRole("spinbutton").fill("50");
    await dialog.getByTestId("allocate-submit").click();
    await expect(toast(page, "Credit applied")).toBeVisible();

    expect(await creditRemaining()).toBe(65);
    expect(outstanding(await invoice("E2E-INV-002"))).toBe(Math.round((inv2Before - 50) * 100) / 100);
    await expect(detail.getByTestId("credit-remaining")).toContainText(money(65));
    await expect(detail.getByTestId("credit-applied")).toContainText(money(50));

    // Correct the application.
    const apps: { applications: Array<{ id: number; amount: number; reversedBy: unknown }> } = await (await api.get(`/api/payments/credit-notes/${cn.id}/applications`)).json();
    const app = apps.applications.find((a) => a.amount === 50 && !a.reversedBy)!;
    await detail.getByTestId(`unallocate-${app.id}`).click();
    await page.getByTestId("unallocate-reason").fill("Customer asked for a refund instead");
    await page.getByTestId("unallocate-submit").click();
    await expect(toast(page, "Allocation corrected")).toBeVisible();
    await expect(page.getByTestId("unallocate-dialog")).toBeHidden();
    expect(await creditRemaining(), "the credit is restored").toBe(115);
    expect(outstanding(await invoice("E2E-INV-002"))).toBe(inv2Before);
    await expect(page.getByTestId("position-credits")).toContainText(money(115));
  });

  test("🔴 Refund flow: partial refund of the deposit and of the credit — confirmation names customer, origin, amount, bank, reason and the balance after; the sources stay visible", async ({ page }) => {
    const p0 = await payment(ids.depositPaymentId);
    const depositBefore = p0.unappliedAmount;
    const pos0 = await position();

    const detail = await openDeposit(page);
    await detail.getByTestId(`refund-deposit-${ids.depositPaymentId}`).click();
    const dialog = page.getByTestId("refund-dialog");
    await expect(dialog.getByTestId("refund-available")).toContainText(money(depositBefore));
    await dialog.getByTestId("refund-amount").fill("100");
    await expect(dialog.getByTestId("refund-continue"), "no bank, no reason → cannot continue").toBeDisabled();
    await pickOption(page, dialog.getByTestId("refund-bank-account"), /E2E Current Account/);
    await dialog.getByTestId("refund-reason").fill("Overpayment returned");
    await dialog.getByTestId("refund-continue").click();
    const summary = dialog.getByTestId("refund-summary");
    await expect(summary).toContainText("E2E Customer");
    await expect(summary).toContainText(`Customer deposit from receipt RCPT-${ids.depositPaymentId}`);
    await expect(summary.getByTestId("refund-confirm-amount")).toContainText(money(100));
    await expect(summary).toContainText("E2E Current Account");
    await expect(summary).toContainText("Overpayment returned");
    await expect(summary.getByTestId("refund-after")).toContainText(money(depositBefore - 100));
    await dialog.getByTestId("refund-confirm").click();
    await expect(toast(page, "Refund recorded")).toBeVisible();
    await expect(dialog).toBeHidden();

    const p = await payment(ids.depositPaymentId);
    expect(p.refundedAmount).toBe(100);
    expect(p.unappliedAmount).toBe(Math.round((depositBefore - 100) * 100) / 100);
    expect(p.amount, "the original receipt is untouched").toBe(800);
    const pos = await position();
    expect(pos.depositBalance).toBe(Math.round((pos0.depositBalance - 100) * 100) / 100);
    await expect(page.getByTestId(`payment-row-${ids.depositPaymentId}`), "the receipt still lists").toBeVisible();
    await expect(page.getByTestId("payment-refunded")).toContainText(money(100));
    await expect(page.locator("[data-testid^=refund-row-]").first()).toBeVisible();

    // Full refund of what remains of the credit note.
    const creditBefore = await creditRemaining();
    await page.getByTestId("credit-note-toggle-E2E-CN-001").click();
    await page.getByTestId(`refund-credit-${cn.id}`).click();
    const d2 = page.getByTestId("refund-dialog");
    await expect(d2.getByTestId("refund-amount")).toHaveValue(creditBefore.toFixed(2));
    await pickOption(page, d2.getByTestId("refund-bank-account"), /E2E Current Account/);
    await d2.getByTestId("refund-reason").fill("Credit note settled in cash");
    await d2.getByTestId("refund-continue").click();
    await expect(d2.getByTestId("refund-summary")).toContainText("Credit-note balance of E2E-CN-001");
    await expect(d2.getByTestId("refund-after")).toContainText(money(0));
    await d2.getByTestId("refund-confirm").click();
    await expect(toast(page, "Refund recorded")).toBeVisible();
    await expect(d2).toBeHidden();
    expect(await creditRemaining()).toBe(0);
    expect((await position()).creditBalance).toBe(0);
    await expect(page.getByTestId("credit-note-row-E2E-CN-001"), "the credit note is still listed").toBeVisible();
    await expect(page.getByTestId("credit-note-remaining-E2E-CN-001")).toContainText(money(0));
  });

  test("🔴 Bank matching: a deterministic row shows its evidence and is accepted by a click; an ambiguous row says why and is matched by hand with a reason; unmatch supersedes without deleting", async ({ page }) => {
    await page.goto("/bank-matching", { waitUntil: "networkidle" });
    const rows: Array<{ transactionId: number; classification: string; description: string; reason: string; target: null | { id: number; identifiedBy: string } ; candidates: Array<{ id: number }> }> =
      await (await api.get("/api/payments/matching?limit=500")).json();
    const det = rows.find((r) => r.description.includes("E2E-DEP-800"))!;
    const amb = rows.find((r) => r.description === "Incoming transfer")!;
    const unm = rows.find((r) => r.description === "Customer payment received")!;
    expect(det.classification).toBe("DETERMINISTIC");
    expect(amb.classification).toBe("AMBIGUOUS");
    expect(unm.classification, "1,150 on 07-02 vs a receipt on 06-28 is outside the window").toBe("UNMATCHED");

    // Columns the spec asks for: date, amount, direction, bank, reference, status.
    const detRow = page.getByTestId(`statement-row-${det.transactionId}`);
    await expect(detRow).toHaveAttribute("data-classification", "DETERMINISTIC");
    await expect(detRow).toContainText(money(800));
    await expect(detRow.getByText("In", { exact: true })).toBeVisible();
    await expect(detRow).toContainText("E2E Current Account");
    await expect(detRow).toContainText("Deterministic match");
    await page.getByTestId(`evidence-${det.transactionId}`).click();
    const panel = page.getByTestId(`evidence-panel-${det.transactionId}`);
    await expect(panel).toContainText(`RCPT-${ids.depositPaymentId}`);
    await expect(panel).toContainText("reference E2E-DEP-800");
    await expect(panel.getByTestId(`reason-${det.transactionId}`)).toContainText("one candidate, identified by reference E2E-DEP-800");

    await page.getByTestId(`accept-${det.transactionId}`).click();
    const accept = page.getByTestId("accept-dialog");
    await expect(accept).toContainText("1 row(s)");
    await accept.getByTestId("accept-confirm").click();
    await expect(toast(page, "1 match(es) recorded")).toBeVisible();
    await expect(accept).toBeHidden();
    await expect(page.getByTestId(`statement-row-${det.transactionId}`)).toHaveAttribute("data-classification", "MATCHED");
    // The evidence panel stayed open across the refetch; it now shows the recorded match.
    await expect(page.getByTestId(`evidence-panel-${det.transactionId}`)).toContainText("deterministic");
    await page.getByTestId(`evidence-${det.transactionId}`).click();

    // Ambiguous: not pretended deterministic; the reason and the candidate are shown.
    const ambRow = page.getByTestId(`statement-row-${amb.transactionId}`);
    await expect(ambRow).toHaveAttribute("data-classification", "AMBIGUOUS");
    await expect(page.getByTestId(`accept-${amb.transactionId}`)).toHaveCount(0);
    await page.getByTestId(`evidence-${amb.transactionId}`).click();
    const ambPanel = page.getByTestId(`evidence-panel-${amb.transactionId}`);
    await expect(ambPanel).toContainText("nothing in the narrative identifies it");
    expect(amb.candidates.length).toBe(1);
    await expect(ambPanel.getByTestId(`candidate-payment-${amb.candidates[0]!.id}`)).toBeVisible();

    await page.getByTestId(`override-${amb.transactionId}`).click();
    const ov = page.getByTestId("override-dialog");
    await expect(ov).toContainText("nothing in the narrative identifies it");
    await expect(ov.getByTestId("override-submit"), "a reason is required").toBeDisabled();
    await ov.getByTestId("override-reason").fill("Bank advice confirms this is the INV-002 part payment");
    await ov.getByTestId("override-submit").click();
    await expect(toast(page, "Match recorded")).toBeVisible();
    await expect(ov).toBeHidden();
    await expect(page.getByTestId(`statement-row-${amb.transactionId}`)).toHaveAttribute("data-classification", "MATCHED");

    // The audit evidence: actor, reason, method, the row and the counterpart.
    const after: Array<{ transactionId: number; match: null | { id: number; method: string; reason: string | null; createdBy: number | null; paymentId: number | null; evidence: Record<string, unknown> } }> =
      await (await api.get("/api/payments/matching?limit=500")).json();
    const m = after.find((r) => r.transactionId === amb.transactionId)!.match!;
    expect(m.method).toBe("manual");
    expect(m.reason).toBe("Bank advice confirms this is the INV-002 part payment");
    expect(m.createdBy).not.toBeNull();
    expect(m.paymentId).toBe(amb.candidates[0]!.id);
    expect(m.evidence.narrative).toBe("Incoming transfer");
    await expect(page.getByTestId(`match-evidence-${m.id}`)).toContainText("manual override");
    await expect(page.getByTestId(`match-evidence-${m.id}`)).toContainText("Bank advice confirms");

    // Unmatch: a reversal record; the match row stays readable.
    await page.getByTestId(`unmatch-${amb.transactionId}`).click();
    await page.getByTestId("unmatch-dialog-reason").fill("Matched the wrong receipt");
    await page.getByTestId("unmatch-dialog-submit").click();
    await expect(toast(page, "Match superseded")).toBeVisible();
    await expect(page.getByTestId(`statement-row-${amb.transactionId}`)).toHaveAttribute("data-classification", "AMBIGUOUS");
    const hist: { id: number; reversedBy: { reason: string } | null } = await (await api.get(`/api/payments/matching/${m.id}`)).json();
    expect(hist.id, "the historical match still exists").toBe(m.id);
    expect(hist.reversedBy?.reason).toBe("Matched the wrong receipt");
  });

  test("🔴 Customer statement: invoices, credit notes, receipts, allocations, credit applications, corrections and refunds in chronology; three running balances; net derived; reconciled", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    await page.getByTestId("open-statement").click();
    await expect(page).toHaveURL(new RegExp(`/customers/${ids.customerId}/statement`));
    await expect(page.getByTestId("statement-reconciled")).toHaveAttribute("data-reconciled", "true");

    const stmt: { lines: Array<{ seq: number; kind: string; receivable: number; creditBalance: number; depositBalance: number; netPosition: number }>; current: Position; closing: Position } =
      await (await api.get(`/api/customers/${ids.customerId}/statement`)).json();
    const kinds = new Set(stmt.lines.map((l) => l.kind));
    for (const k of ["invoice", "credit_note", "receipt", "allocation", "credit_application", "unallocation", "refund"]) {
      expect(kinds.has(k), `the statement carries a ${k} line`).toBe(true);
    }
    for (const k of ["Invoice", "Credit note", "Receipt", "Allocation", "Credit applied", "Correction (unapplied)", "Refund"]) {
      await expect(page.locator("tbody tr").filter({ hasText: k }).first()).toBeVisible();
    }
    // Running balances rendered are the server's, and the last line equals the closing position.
    const last = stmt.lines[stmt.lines.length - 1]!;
    await expect(page.getByTestId(`line-${last.seq}-receivable`)).toContainText(money(last.receivable));
    await expect(page.getByTestId(`line-${last.seq}-credits`)).toContainText(money(last.creditBalance));
    await expect(page.getByTestId(`line-${last.seq}-deposits`)).toContainText(money(last.depositBalance));
    expect(last.receivable).toBe(stmt.closing.receivable);
    expect(last.netPosition).toBe(Math.round((last.receivable - last.creditBalance - last.depositBalance) * 100) / 100);
    for (const l of stmt.lines) {
      expect(l.receivable, "AR never negative on the statement").toBeGreaterThanOrEqual(0);
      expect(l.creditBalance).toBeGreaterThanOrEqual(0);
      expect(l.depositBalance).toBeGreaterThanOrEqual(0);
    }
    await expect(page.getByTestId("current-net")).toContainText(money(stmt.current.netPosition));
    // The statement's current position IS the customer page's position.
    const pos = await position();
    expect(stmt.current).toEqual({ receivable: pos.receivable, creditBalance: pos.creditBalance, depositBalance: pos.depositBalance, netPosition: pos.netPosition });
    // A date window folds earlier events into the opening.
    const windowed: { opening: Position } = await (await api.get(`/api/customers/${ids.customerId}/statement?date_from=2026-08-01`)).json();
    expect(windowed.opening.receivable, "INV-002's open part sits in the opening").toBeGreaterThan(0);
    await page.getByTestId("statement-from").fill("2026-08-01");
    await expect(page.getByTestId("opening-receivable")).toContainText(money(windowed.opening.receivable));
  });

  test("🔴 AR aging: buckets are receivable exposure only; credits and deposits sit beside them, never as negative buckets; the totals reconcile", async ({ page }) => {
    await page.goto("/ar-aging", { waitUntil: "networkidle" });
    const rep: { buckets: Record<string, number>; total: number; liabilities: { customerCredits: number; customerDeposits: number }; netCustomerPosition: number; items: Array<{ invoiceNumber: string; outstanding: number }> } =
      await (await api.get("/api/reports/ar-aging")).json();
    const sum = Object.values(rep.buckets).reduce((s, v) => s + v, 0);
    expect(Math.round(sum * 100) / 100, "Σ buckets = total").toBe(rep.total);
    for (const it of rep.items) expect(it.outstanding, `${it.invoiceNumber} is real exposure`).toBeGreaterThan(0);
    expect(rep.items.some((i) => i.invoiceNumber === "E2E-CN-001"), "a credit note is not an aged item").toBe(false);
    expect(rep.netCustomerPosition).toBe(Math.round((rep.total - rep.liabilities.customerCredits - rep.liabilities.customerDeposits) * 100) / 100);
    expect(rep.liabilities.customerDeposits, "the deposit is shown as a liability beside the ageing").toBeGreaterThan(0);

    await expect(page.getByTestId("recon-total")).toContainText(money(rep.total));
    await expect(page.getByTestId("recon-credits")).toContainText(money(rep.liabilities.customerCredits));
    await expect(page.getByTestId("recon-deposits")).toContainText(money(rep.liabilities.customerDeposits));
    await expect(page.getByTestId("recon-net")).toContainText(money(rep.netCustomerPosition));
    await expect(page.locator("tbody tr").filter({ hasText: "E2E-CN-001" })).toHaveCount(0);
    await expect(page.locator("tbody tr").filter({ hasText: "−" })).toHaveCount(0);
  });

  test("Payments page: receipts and refunds list; a receipt opens into its allocations", async ({ page }) => {
    await page.goto("/payments", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`payment-row-${ids.depositPaymentId}`)).toBeVisible();
    await page.getByTestId(`payment-open-${ids.depositPaymentId}`).click();
    await expect(page.getByTestId(`payment-detail-${ids.depositPaymentId}`)).toBeVisible();
    await expect(page.getByTestId("payment-refunded")).toContainText(money(100));
    await page.keyboard.press("Escape");
    await page.getByTestId("tab-refunds").click();
    await expect(page.locator("[data-testid^=refund-row-]").first()).toBeVisible();
  });
});

test.describe("Phase F — English phone", () => {
  test.use({ viewport: PHONE });

  test("🔴 record a receipt, allocate and unallocate from a phone; the statement renders as cards; matching and aging fit the screen", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    const rid = await recordReceipt(page, 60, "en");
    const detail = await openReceipt(page, rid);
    await detail.getByTestId(`allocate-${rid}`).click();
    const dialog = page.getByTestId("allocate-dialog");
    await expect(dialog).toBeVisible();
    await expectFits(dialog, PHONE.width, "the dialog fits the phone");
    await dialog.getByTestId("allocate-row-E2E-INV-003").getByRole("spinbutton").fill("25");
    await dialog.getByTestId("allocate-submit").click();
    await expect(toast(page, "Payment allocated")).toBeVisible();
    await expect(dialog).toBeHidden();
    const p = await payment(rid);
    expect(p.unappliedAmount).toBe(35);
    const a = p.allocations.find((x) => !x.reversedBy && x.amount === 25)!;
    await page.getByTestId(`unallocate-${a.id}`).click();
    await page.getByTestId("unallocate-reason").fill("phone correction");
    await page.getByTestId("unallocate-submit").click();
    await expect(toast(page, "Allocation corrected")).toBeVisible();
    await expect(page.getByTestId("unallocate-dialog")).toBeHidden();
    expect((await payment(rid)).unappliedAmount).toBe(60);

    for (const url of [`/customers/${ids.customerId}/statement`, "/bank-matching", "/ar-aging", "/payments"]) {
      await page.goto(url, { waitUntil: "networkidle" });
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      expect(scrollWidth, `${url} does not scroll the page sideways`).toBeLessThanOrEqual(clientWidth + 1);
    }
    await page.goto(`/customers/${ids.customerId}/statement`, { waitUntil: "networkidle" });
    await expect(page.locator("[data-testid^=statement-card-]").first()).toBeVisible();
  });
});

async function switchToArabic(page: Page) {
  await page.getByRole("button", { name: /^ع$/ }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
}

/** On a phone the toggle lives in the drawer: open it, click, close it — all by clicking. */
async function switchToArabicOnPhone(page: Page) {
  await page.getByTestId("nav-hamburger").click();
  const drawer = page.getByTestId("nav-drawer");
  await drawer.getByRole("button", { name: /^ع$/ }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await drawer.getByRole("button", { name: "إغلاق القائمة" }).click();
  await expect(drawer).toHaveCount(0);
}

test.describe("Phase F — Arabic / RTL desktop", () => {
  test("🔴 the same flows in Arabic under dir=rtl: labels, validation, dialogs within the viewport, toasts", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    await switchToArabic(page);
    await expect(page.getByText("الذمم المدينة", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("أرصدة دائنة للعميل")).toBeVisible();
    await expect(page.getByText("عرابين العميل")).toBeVisible();
    await expect(page.getByText("صافي المركز")).toBeVisible();

    const rid = await recordReceipt(page, 100, "ar");
    const before = 100;
    await page.getByTestId(`payment-toggle-${rid}`).click();
    const detail = page.getByTestId(`payment-detail-${rid}`);
    await expect(detail.getByText("الدفعة", { exact: true })).toBeVisible();
    await expect(detail.getByText("التخصيصات — أين ذهبت هذه الدفعة")).toBeVisible();
    await detail.getByTestId(`allocate-${rid}`).click();
    const dialog = page.getByTestId("allocate-dialog");
    await expect(dialog.getByText(`تخصيص RCPT-${rid}`)).toBeVisible();
    const vw = page.viewportSize()!.width;
    const dbox = (await dialog.boundingBox())!;
    expect(dbox.x >= 0 && dbox.x + dbox.width <= vw + 1, "dialog within the viewport under RTL").toBe(true);
    await dialog.getByTestId("allocate-row-E2E-INV-003").getByRole("spinbutton").fill("40");
    await expect(dialog.getByText("المتبقي على الحساب بعده")).toBeVisible();
    await dialog.getByTestId("allocate-submit").click();
    await expect(toast(page, "تم تخصيص الدفعة")).toBeVisible();
    await expect(dialog).toBeHidden();
    const p = await payment(rid);
    expect(p.unappliedAmount).toBe(Math.round((before - 40) * 100) / 100);
    const a = p.allocations.find((x) => !x.reversedBy && x.amount === 40)!;
    await page.getByTestId(`unallocate-${a.id}`).click();
    const un = page.getByTestId("unallocate-dialog");
    await expect(un.getByText("تصحيح هذا التخصيص")).toBeVisible();
    await expect(un.getByTestId("unallocate-submit"), "بدون سبب لا يمكن الإرسال").toBeDisabled();
    await un.getByTestId("unallocate-reason").fill("تصحيح");
    await un.getByTestId("unallocate-submit").click();
    await expect(toast(page, "تم تصحيح التخصيص")).toBeVisible();
    await expect(un).toBeHidden();
    expect((await payment(rid)).unappliedAmount).toBe(before);

    // Refund dialog in Arabic: the labels and the two-step confirmation.
    await detail.getByTestId(`refund-deposit-${rid}`).click();
    const rd = page.getByTestId("refund-dialog");
    await expect(rd.getByText("ردّ رصيد العميل")).toBeVisible();
    await expect(rd.getByText("يُدفع من الحساب البنكي *")).toBeVisible();
    await expect(rd.getByTestId("refund-bank-account")).toContainText("اختر الحساب البنكي");
    await rd.getByTestId("refund-amount").fill("10");
    await pickOption(page, rd.getByTestId("refund-bank-account"), /E2E Current Account/);
    await rd.getByTestId("refund-reason").fill("إرجاع مبلغ زائد");
    await rd.getByTestId("refund-continue").click();
    await expect(rd.getByText("تأكيد الردّ", { exact: true }).first()).toBeVisible();
    await expect(rd.getByTestId("refund-summary")).toContainText("إرجاع مبلغ زائد");
    await rd.getByTestId("refund-confirm").click();
    await expect(toast(page, "تم تسجيل الردّ")).toBeVisible();
    await expect(rd).toBeHidden();
    expect((await payment(rid)).unappliedAmount).toBe(Math.round((before - 10) * 100) / 100);

    // Statement, matching, aging and payments in Arabic.
    await page.goto(`/customers/${ids.customerId}/statement`, { waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { name: "كشف حساب العميل" })).toBeVisible();
    await expect(page.locator("tbody tr").filter({ hasText: "ردّ" }).first()).toBeVisible();
    await expect(page.getByText("صافي المركز (مشتق)").first()).toBeVisible();

    await page.goto("/bank-matching", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "مطابقة كشوف البنك" })).toBeVisible();
    await expect(page.getByText("غير محسوم").first()).toBeVisible();
    await expect(page.getByText("مطابَق", { exact: true }).first()).toBeVisible();

    await page.goto("/ar-aging", { waitUntil: "networkidle" });
    await expect(page.getByText("= صافي مركز العملاء (مشتق)")).toBeVisible();
    await expect(page.getByText("− عرابين العملاء (إيصالات غير مخصصة)")).toBeVisible();

    await page.goto("/payments", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "المدفوعات" })).toBeVisible();
    await expect(page.getByTestId("tab-refunds")).toContainText("المبالغ المردودة");

    // Back to English so later specs start where they expect.
    await page.getByRole("button", { name: /^EN$/i }).click().catch(() => {});
  });
});

test.describe("Phase F — Arabic / RTL phone", () => {
  test.use({ viewport: PHONE });

  test("🔴 Arabic on a phone: the allocate dialog fits and works; the statement cards, matching and aging render RTL without sideways scroll", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    await switchToArabicOnPhone(page);
    const rid = await recordReceipt(page, 30, "ar");
    await page.getByTestId(`payment-toggle-${rid}`).click();
    await page.getByTestId(`allocate-${rid}`).click();
    const dialog = page.getByTestId("allocate-dialog");
    await expectFits(dialog, PHONE.width, "the Arabic dialog fits the phone");
    await dialog.getByTestId("allocate-row-E2E-INV-003").getByRole("spinbutton").fill("15");
    await dialog.getByTestId("allocate-submit").click();
    await expect(toast(page, "تم تخصيص الدفعة")).toBeVisible();
    await expect(dialog).toBeHidden();
    const p = await payment(rid);
    const a = p.allocations.find((x) => !x.reversedBy && x.amount === 15)!;
    await page.getByTestId(`unallocate-${a.id}`).click();
    await page.getByTestId("unallocate-reason").fill("تصحيح من الجوال");
    await page.getByTestId("unallocate-submit").click();
    await expect(toast(page, "تم تصحيح التخصيص")).toBeVisible();
    await expect(page.getByTestId("unallocate-dialog")).toBeHidden();
    expect((await payment(rid)).unappliedAmount).toBe(30);

    for (const url of [`/customers/${ids.customerId}/statement`, "/bank-matching", "/ar-aging", "/payments"]) {
      await page.goto(url, { waitUntil: "networkidle" });
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      expect(scrollWidth, `${url} (RTL) does not scroll the page sideways`).toBeLessThanOrEqual(clientWidth + 1);
    }
    await page.goto(`/customers/${ids.customerId}/statement`, { waitUntil: "networkidle" });
    await expect(page.locator("[data-testid^=statement-card-]").first()).toBeVisible();
    // Back to English through the same drawer, so later specs start where they expect.
    await page.getByTestId("nav-hamburger").click();
    await page.getByTestId("nav-drawer").getByRole("button", { name: /^EN$/i }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  });
});
