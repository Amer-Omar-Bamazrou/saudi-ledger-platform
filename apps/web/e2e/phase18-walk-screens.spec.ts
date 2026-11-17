/**
 * 🔴 THE PHASE 18 WALK (2026-11-17), RENDERED — Arabic, 390 px, an ar-SA browser locale (the walk's own conditions;
 * CI's default en-US locale cannot show an Eastern-digit count).
 *
 *  - W1: the security trail prints an event's time as the Riyadh clock, never the UTC clock of the served string.
 *  - W5/W9: a journal entry's line shows A20's stated reason; its status reads in Arabic.
 *  - W8: the list's paging is on the page — it was inside the new-entry dialog.
 *  - W10: the new-entry dialog fits a 390 px screen.
 *  - W7: the change-then-pay heading counts its days with Arabic agreement ("7 أيام").
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Browser } from "./fixtures";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const REASON = `دافع لم يُعرف بعد ${STAMP}`;
const SETTINGS = "/api/companies/current/control-settings";
const EASTERN = /[٠-٩]/;

let api: APIRequestContext;
let draftId = 0;

const json = async <T,>(p: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>, what: string): Promise<T> => {
  const r = await p;
  const text = await r.text();
  if (!r.ok()) throw new Error(`${what} → ${r.status()} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};
const rows = <T,>(b: unknown): T[] => (Array.isArray(b) ? b : ((b as { items?: T[]; data?: T[] })?.items ?? (b as { data?: T[] })?.data ?? [])) as T[];

async function arabicPhone(browser: Browser, path: string) {
  const ctx = await browser.newContext({ storageState: await api.storageState(), viewport: PHONE, locale: "ar-SA" });
  await ctx.addInitScript(() => { try { localStorage.setItem("ksa_lang", "ar"); } catch { /* storage off */ } });
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  return { page, close: () => ctx.close() };
}

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const cats = rows<{ id: number; systemCode?: string | null; type?: string; isPosting?: boolean }>(await json(api.get("/api/categories"), "categories"));
  const unident = cats.find((c) => c.systemCode === "UNIDENTIFIED_RECEIPTS")!;
  const expense = cats.find((c) => c.systemCode === "RENT_UTILITIES") ?? cats.find((c) => c.type === "expense" && c.isPosting !== false)!;
  draftId = (await json<{ id: number }>(api.post("/api/journal-entries", { data: {
    entryNumber: `WALK-W5-${STAMP}`, date: new Date().toISOString().slice(0, 10), description: `Walk W5 ${STAMP}`,
    lines: [
      { accountId: expense.id, accountName: "expense", debitAmount: 75, creditAmount: 0 },
      { accountId: unident.id, accountName: "unidentified", debitAmount: 0, creditAmount: 75, partyNoneReason: REASON },
    ],
  } }), "draft")).id;
});

test.afterAll(async () => {
  if (draftId) await api.delete(`/api/journal-entries/${draftId}`);
  await api.put(SETTINGS, { data: { bankChangePaymentWindowDays: null } });
  await api.dispose();
});

test("🔴 W1: the security trail's time is the Riyadh clock, and its count is in Latin digits", async ({ browser }) => {
  const me = await json<{ organizationId?: string; user?: { organizationId?: string } }>(api.get("/api/auth/me"), "me");
  const orgId = me.organizationId ?? me.user?.organizationId;
  const { events } = await json<{ events: Array<{ id: number; createdAt: string }> }>(api.get(`/api/orgs/${orgId}/security-events?limit=1`), "events");
  const e = events[0];
  const riyadh = new Date(e.createdAt).toLocaleTimeString("en-GB", { timeZone: "Asia/Riyadh", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const { page, close } = await arabicPhone(browser, "/users");
  const row = page.getByTestId(`security-event-${e.id}`);
  await expect(row).toContainText(riyadh);
  await expect(row).not.toContainText(e.createdAt.slice(11, 16));
  expect(await page.getByTestId("security-events-count").innerText()).not.toMatch(EASTERN);
  await close();
});

test("🔴 W5/W8/W9/W10: the entry shows its stated reason and Arabic status; the paging is on the page; the dialog fits", async ({ browser }) => {
  const { page, close } = await arabicPhone(browser, "/journal-entries?status=draft");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/^عرض 1–/).first()).toBeVisible();
  const row = page.locator("tr", { hasText: `Walk W5 ${STAMP}` }).first();
  await expect(row).toContainText("مسودة");
  await expect(row).not.toContainText("draft");
  await row.click();
  await expect(page.getByTestId("je-line-party-1")).toContainText(`لا عميل — ${REASON}`);
  await page.getByTestId("je-new").click();
  // The dialog slides in (its open animation starts it off to one side), so its SETTLED box is the one asserted: polled,
  // not read once at the click (CI run 44083067839 read x = -96.9 mid-animation).
  const dialog = page.getByTestId("je-dialog");
  await expect.poll(async () => (await dialog.boundingBox())?.x ?? -1, { message: "the dialog's left edge is on screen" }).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => { const b = await dialog.boundingBox(); return b ? b.x + b.width : Infinity; }, { message: "the dialog's right edge is on screen" }).toBeLessThanOrEqual(PHONE.width);
  await close();
});

test("🔴 W7: the change-then-pay heading counts 7 days as أيام", async ({ browser }) => {
  await json(api.put(SETTINGS, { data: { bankChangePaymentWindowDays: 7 } }), "window 7");
  const { page, close } = await arabicPhone(browser, "/company");
  const finding = page.getByTestId("control-finding");
  await expect(finding).toContainText("خلال 7 أيام بعده");
  await expect(finding).not.toContainText("7 يوماً");
  await close();
});
