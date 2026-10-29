/**
 * 🔴 PHASE 18 H-4 — A DEBIT NOTE COLLECTED BY CLICKING (DR-36, owner accepted
 * the recommendation; register §11.50): "Collectable directly, like an
 * invoice." The invoice list offers Mark Paid on an issued debit note, and the
 * payment the dialog records reaches it — the note reads paid.
 */
import { test, expect, request as pwRequest, type APIRequestContext } from "./fixtures";
import { businessToday } from "@workspace/shared";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const TODAY = businessToday();
const STAMP = Date.now();

let api: APIRequestContext;
let noteId = 0;

const json = async <T,>(p: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>, what: string): Promise<T> => {
  const r = await p;
  const text = await r.text();
  if (!r.ok()) throw new Error(`${what} → ${r.status()} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const c = await json<{ id: number }>(api.post("/api/customers", { data: { name: `E2E Debit Note Customer ${STAMP}` } }), "customer");
  const inv = await json<{ id: number }>(api.post("/api/invoices", { data: { date: TODAY, customerId: c.id, items: [{ description: "Freight", quantity: 1, unitPrice: 1000, vatRate: 15 }] } }), "invoice");
  await json(api.post(`/api/invoices/${inv.id}/approve`, { data: {} }), "approve invoice");
  const dn = await json<{ id: number }>(api.post("/api/invoices", { data: {
    date: TODAY, customerId: c.id, documentType: "debit_note", originalInvoiceId: inv.id, noteReason: "Undercharged freight",
    chargeSubstance: "price_change", chargeEventDate: TODAY, items: [{ description: "Freight adjustment", quantity: 1, unitPrice: 100, vatRate: 15 }],
  } }), "debit note");
  await json(api.post(`/api/invoices/${dn.id}/approve`, { data: {} }), "approve debit note");
  noteId = dn.id;
});
test.afterAll(async () => { await api.dispose(); });

test("🔴 an issued DEBIT NOTE offers Mark Paid, and the payment recorded from the dialog settles it", async ({ page }) => {
  await page.goto("/invoices", { waitUntil: "networkidle" });
  await page.getByTestId(`mark-paid-${noteId}`).click();
  const dialog = page.getByRole("dialog");
  await page.getByTestId("pay-bank-account").click();
  await page.getByRole("option").first().click();
  await dialog.getByRole("button", { name: "Record Payment" }).click();
  await expect.poll(async () => {
    const n = await json<{ status: string; paidAmount: number | string; total: number | string }>(api.get(`/api/invoices/${noteId}`), "note");
    return [n.status, Number(n.paidAmount)];
  }, { message: "the debit note reads paid, for its full amount" }).toEqual(["paid", 115]);
});
