/**
 * 🔴 PHASE 18 H-9 — COMPANY SETTINGS → CONTROLS, BY CLICKING (DR-19, DR-21,
 * DR-23; each owner accepted the recommendation; register §11.56). A window
 * typed and saved on the screen turns DR-23's finding on, and it lists a
 * payment made on the day the supplier's IBAN changed; Switch off sends null
 * and the finding says it is off. The request the SCREEN builds is the one
 * under test (a server test builds its own).
 */
import { test, expect, request as pwRequest, type APIRequestContext } from "./fixtures";
import { businessToday } from "@workspace/shared";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const TODAY = businessToday();
const STAMP = Date.now();
const VENDOR = `E2E Bank Change Supplier ${STAMP}`;
const SETTINGS = "/api/companies/current/control-settings";

let api: APIRequestContext;

const json = async <T,>(p: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>, what: string): Promise<T> => {
  const r = await p;
  const text = await r.text();
  if (!r.ok()) throw new Error(`${what} → ${r.status()} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const banks = await json<Array<{ id: number }>>(api.get("/api/bank-accounts"), "bank accounts");
  const bankId = banks[0]?.id ?? (await json<{ id: number }>(api.post("/api/bank-accounts", { data: { name: `E2E Ops ${STAMP}`, bankName: "SNB", currency: "SAR" } }), "bank")).id;
  const v = await json<{ id: number }>(api.post("/api/vendors", { data: { name: VENDOR, residency: "resident", iban: "SA0380000000608010167519" } }), "supplier");
  await json(api.patch(`/api/vendors/${v.id}`, { data: { iban: "SA4420000001234567891234" } }), "change the IBAN");
  const b = await json<{ id: number }>(api.post("/api/bills", { data: {
    supplierDocumentKind: "tax_invoice", vendorReference: `E2E-H9-${STAMP}`, billNumber: `E2E-H9-${STAMP}`, date: TODAY, dueDate: TODAY, vendorId: v.id,
    items: [{ description: "Supplies", quantity: 1, unitPrice: 250, vatRate: 0 }],
  } }), "bill");
  await json(api.post(`/api/bills/${b.id}/approve`, { data: {} }), "approve bill");
  await json(api.post(`/api/bills/${b.id}/pay`, { data: { amount: 250, paidAt: TODAY, bankAccountId: bankId } }), "pay bill");
});
test.afterAll(async () => {
  // the company's slot is left as it ships: empty
  await api.put(SETTINGS, { data: { bankChangePaymentWindowDays: null } });
  await api.dispose();
});

test("🔴 a window saved on the screen turns the finding on and lists the payment; Switch off turns it off", async ({ page }) => {
  await page.goto("/company", { waitUntil: "networkidle" });
  const section = page.getByTestId("control-settings");
  await section.getByTestId("control-window-input").fill("7");
  await section.getByTestId("control-window-save").click();
  await expect.poll(async () => (await json<{ bankChangePaymentWindowDays: number | null }>(api.get(SETTINGS), "settings")).bankChangePaymentWindowDays,
    { message: "what the screen sent is what the server stored" }).toBe(7);
  await expect(section.getByTestId("control-finding")).toHaveAttribute("data-enabled", "true");
  await expect(section.getByTestId("control-finding").getByText(VENDOR)).toBeVisible();

  await section.getByTestId("control-window-clear").click();
  await expect.poll(async () => (await json<{ bankChangePaymentWindowDays: number | null }>(api.get(SETTINGS), "settings")).bankChangePaymentWindowDays,
    { message: "Switch off sends null, never 0" }).toBeNull();
  await expect(section.getByTestId("control-finding-off")).toBeVisible();
  await expect(section.getByTestId("control-window-input")).toHaveValue("");
});
