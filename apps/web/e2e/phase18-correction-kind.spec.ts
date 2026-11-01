/**
 * 🔴 PHASE 18 H-18 — A CORRECTION CLASSIFIED BY CLICKING (DR-15; owner accepted
 * the recommendation; register §11.73). The reverse dialog offers the IAS 8
 * kind; the mirror the server posts carries the kind chosen and the derived
 * attribution. The request the SCREEN builds is the one under test — and this
 * is the first browser spec to drive the reverse dialog's fields at all (T1e's
 * had none).
 */
import { test, expect, request as pwRequest, type APIRequestContext } from "./fixtures";
import { businessToday } from "@workspace/shared";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const TODAY = businessToday();
const STAMP = Date.now();

let api: APIRequestContext;
let originalId = 0;

const json = async <T,>(p: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>, what: string): Promise<T> => {
  const r = await p;
  const text = await r.text();
  if (!r.ok()) throw new Error(`${what} → ${r.status()} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const cats = await json<Array<{ id: number; type: string; isPosting?: boolean }>>(api.get("/api/categories"), "categories");
  const pick = (type: string) => cats.find((c) => c.type === type && c.isPosting !== false)!;
  const je = await json<{ id: number }>(api.post("/api/journal-entries", { data: {
    entryNumber: `E2E-H18-${STAMP}`, date: TODAY, description: `E2E H18 original ${STAMP}`,
    lines: [
      { accountId: pick("expense").id, accountName: "debit", debitAmount: 30, creditAmount: 0 },
      { accountId: pick("income").id, accountName: "credit", debitAmount: 0, creditAmount: 30 },
    ],
  } }), "journal entry");
  await json(api.post(`/api/journal-entries/${je.id}/approve`, { data: {} }), "approve");
  originalId = je.id;
});
test.afterAll(async () => { await api.dispose(); });

test("🔴 the kind chosen in the reverse dialog reaches the mirror, with the attribution the server derives", async ({ page }) => {
  await page.goto("/journal-entries", { waitUntil: "networkidle" });
  await page.getByTestId(`reverse-${originalId}`).click();
  await page.getByTestId("rev-kind").click();
  await page.getByTestId("rev-kind-error").click();
  await page.getByTestId("rev-reason").fill("E2E: posted to the wrong account");
  await page.getByTestId("rev-discovered").fill(TODAY);
  await page.getByTestId("rev-confirm").click();
  await expect.poll(async () => {
    const list = await json<{ items?: Array<{ id: number; reversalOf: number | null; correctionKind?: string | null; originFiscalYearStart?: string | null }> } | Array<{ id: number; reversalOf: number | null; correctionKind?: string | null; originFiscalYearStart?: string | null }>>(api.get("/api/journal-entries?limit=50"), "list");
    const rows = Array.isArray(list) ? list : (list.items ?? []);
    const mirror = rows.find((r) => r.reversalOf === originalId);
    return mirror ? [mirror.correctionKind ?? null, mirror.originFiscalYearStart != null] : null;
  }, { message: "the mirror carries the kind chosen and a derived fiscal year" }).toEqual(["error", true]);
});
