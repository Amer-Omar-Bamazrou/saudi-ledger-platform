import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import { E2E } from "./global-setup";

/**
 * 🔴 ACCEPTING A BANK ROW INTO A CLOSED MONTH IS REFUSED ON THE SCREEN
 * (2026-09-16, the pre-pilot batch).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The Review page's Accept — one row or "Accept ready" — called an endpoint
 * that flipped the rows to accepted, swallowed the period-lock refusal per
 * row, and answered 200 with a `failed` list the page never read. The toast
 * said "Accepted 1 row(s)", the row left the list, and the ledger had no
 * entry. Every other closed-month write in the app raised the dialog; this
 * one raised a success toast. A service test proves the server now refuses
 * truthfully (`bulk-accept-closed-period.test.ts`); THIS proves the refusal
 * reaches the person who clicked, through the real client's request.
 *
 * ── What this asserts ───────────────────────────────────────────────────────
 *   1. A single row dated in a closed month: Accept opens the closed-month
 *      dialog (the 423 path every other write takes) and the row stays.
 *   2. "Accept ready" over one open row and one closed row: the open row is
 *      accepted, a toast names the closed row's month and says it stayed in
 *      review, and the closed row is still listed. The server's answer is
 *      read back too: the closed row is still pending with no entry.
 *
 * Frame: the suite's own org. The two rows are imported through the product's
 * upload path and categorised through its PATCH (so bulk mode sweeps exactly
 * them — the seed's three review rows are uncategorised and never swept).
 * The lock is placed on a month nothing else in the suite uses, and removed
 * in `afterAll` whatever happens.
 */

test.use({ storageState: E2E.storageState });

const CLOSED = "2026-02";
const OPEN_DESC = "E2E OPEN MONTH ROW";
const CLOSED_DESC = "E2E CLOSED MONTH ROW";

let api: APIRequestContext;
let closedId = 0;
let openId = 0;

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const categories: Array<{ id: number; systemCode: string | null; type: string }> = await (await api.get("/api/categories")).json();
  const expense = categories.find((c) => c.systemCode === "RENT_UTILITIES") ?? categories.find((c) => c.type === "expense");
  if (!expense) throw new Error("e2e: the seeded chart has no expense category");

  const up = await api.post("/api/transactions/upload", {
    data: {
      rows: [
        { date: "2026-06-11", description: OPEN_DESC, amount: 210, type: "debit", currency: "SAR" },
        { date: "2026-02-11", description: CLOSED_DESC, amount: 220, type: "debit", currency: "SAR" },
      ],
    },
  });
  expect(up.ok(), await up.text()).toBe(true);

  const pending: Array<{ id: number; description: string }> = await (await api.get("/api/transactions/review")).json();
  const byDesc = (d: string) => pending.find((t) => t.description === d)?.id;
  openId = byDesc(OPEN_DESC) ?? 0;
  closedId = byDesc(CLOSED_DESC) ?? 0;
  expect(openId, "the open row was imported").toBeGreaterThan(0);
  expect(closedId, "the closed row was imported").toBeGreaterThan(0);

  for (const id of [openId, closedId]) {
    const r = await api.patch(`/api/transactions/${id}`, { data: { categoryId: expense.id } });
    expect(r.ok(), await r.text()).toBe(true);
  }
  const lock = await api.post("/api/period-locks", { data: { period: CLOSED, notes: "e2e: bulk accept into a closed month" } });
  expect(lock.ok(), await lock.text()).toBe(true);
});

test.afterAll(async () => {
  // Unlock whatever happened above — a lock left behind would refuse the next spec's writes.
  await api.delete(`/api/period-locks/${CLOSED}`);
  await api.dispose();
});

test("🔴 a single row in a closed month: Accept raises the closed-month dialog, and the row stays in review", async ({ page }) => {
  await page.goto("/review", { waitUntil: "networkidle" });
  // The innermost div holding both the description and an Accept button is
  // the row (ancestors match too and come first in document order).
  const row = page
    .locator("div")
    .filter({ hasText: CLOSED_DESC })
    .filter({ has: page.getByRole("button", { name: "Accept", exact: true }) })
    .last();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Accept", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog, "the dialog names the closed month").toContainText("February 2026 is closed");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByText(CLOSED_DESC), "a refused row must still be in review").toBeVisible();
  const tx = await (await page.request.get(`/api/transactions/${closedId}`)).json();
  expect(tx.reviewStatus).toBe("pending_review");
});

test("🔴 Accept ready over an open row and a closed row: one accepted, the other named as refused and still listed", async ({ page }) => {
  await page.goto("/review", { waitUntil: "networkidle" });
  await expect(page.getByText(OPEN_DESC)).toBeVisible();
  await expect(page.getByText(CLOSED_DESC)).toBeVisible();

  const bulk = page.getByRole("button", { name: /^Accept ready \(2\)$/ });
  await expect(bulk, "exactly the two seeded-by-this-spec rows are bulk-safe").toBeVisible();
  await bulk.click();

  // `exact`: Radix renders each toast's text twice — the visible element and
  // an aria-live announcer prefixed "Notification" — so a substring match
  // resolves to two elements.
  await expect(page.getByText("Accepted 1 row(s)", { exact: true })).toBeVisible();
  await expect(page.getByText(`1 not accepted — the books for ${CLOSED} are closed`, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Those rows stayed in review and nothing was posted for them. Date them in an open month, or an admin can reopen the month from Closed months.", { exact: true }),
  ).toBeVisible();

  await expect(page.getByText(CLOSED_DESC), "the refused row is still in review").toBeVisible();
  await expect(page.getByText(OPEN_DESC), "the accepted row has left review").toBeHidden();

  const open = await (await page.request.get(`/api/transactions/${openId}`)).json();
  const closed = await (await page.request.get(`/api/transactions/${closedId}`)).json();
  expect(open.reviewStatus).toBe("accepted");
  expect(closed.reviewStatus, "the refused row is not accepted").toBe("pending_review");
});
