/**
 * 🔴 PHASE 18 G4c-2 — A DEPOSIT FORFEITED, WALKED BY CLICKING (owner decision
 * 14, 2026-10-27; register §11.46).
 *
 * What only a browser can show: the forfeiture FORM builds the request — its
 * own date, the user's classification, the amount — and a server test builds
 * its request the way the server expects, so it cannot see a field the form
 * drops. The walk:
 *   · a non-resident's security deposit opens with a "Forfeited to the
 *     supplier" section; recording is refused until the forfeiture is
 *     classified;
 *   · classified as consideration, the record shows the WHT due in the
 *     forfeiture month — not withheld, not posted.
 */
import { test, expect, request as pwRequest, type APIRequestContext } from "./fixtures";
import { businessToday } from "@workspace/shared";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const TODAY = businessToday();
const STAMP = Date.now();

let api: APIRequestContext;
let depositId = 0;

const json = async <T,>(p: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>, what: string): Promise<T> => {
  const r = await p;
  const text = await r.text();
  if (!r.ok()) throw new Error(`${what} → ${r.status()} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const v = await json<{ id: number }>(api.post("/api/vendors", { data: { name: `E2E Lisbon Lessor ${STAMP}`, residency: "non_resident", country: "PT", whtDefaultPaymentType: "technical_consulting" } }), "vendor");
  const banks = await json<Array<{ id: number }>>(api.get("/api/bank-accounts"), "banks");
  const d = await json<{ id: number }>(api.post("/api/supplier-payments", { data: {
    vendorId: v.id, bankAccountId: banks[0]!.id, amount: 5000, paidAt: TODAY, classification: "security_deposit", reference: `E2E-DEP-${STAMP}`,
  } }), "deposit");
  depositId = d.id;
});
test.afterAll(async () => { await api.dispose(); });

test("🔴 a non-resident's deposit forfeited as CONSIDERATION, recorded from the form — the record shows the WHT due in the forfeiture month, nothing posted", async ({ page }) => {
  await page.goto("/supplier-payments");
  await page.getByTestId(`open-supplier-payment-${depositId}`).click();
  const section = page.getByTestId("deposit-forfeitures");
  await expect(section).toBeVisible();
  await section.getByTestId("forfeiture-reason").fill("Kept as the fee for the work delivered");
  await section.getByTestId("forfeiture-amount").fill("2000");
  await expect(section.getByTestId("forfeiture-submit"), "never recorded unclassified").toBeDisabled();
  await section.getByTestId("forfeiture-class-consideration").check();
  await section.getByTestId("forfeiture-submit").click();
  await expect.poll(async () => {
    const fs = await json<Array<{ forfeitedOn: string; amount: number; classification: string; whtDue: { month: string; rate: number; amount: number } | null }>>(
      api.get(`/api/supplier-payments/${depositId}/forfeitures`), "forfeitures");
    return fs.map((f) => [f.forfeitedOn, f.amount, f.classification, f.whtDue]);
  }, { message: "the form's date, amount and classification reached the record" })
    .toEqual([[TODAY, 2000, "consideration", { month: TODAY.slice(0, 7), rate: 0.05, amount: 100 }]]);
});
