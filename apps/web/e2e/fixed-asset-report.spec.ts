/**
 * FA-G — THE MOVEMENT AND RECONCILIATION PAGE, WALKED BY CLICKING (2026-09-22).
 * Record: docs/product/fixed-assets-decision-pack.md §11, §26.
 *
 * What only a browser can show:
 *   · the roll-forward renders, adds up, and its figures are the server's;
 *   · the reconciliation is at the top and says which way it went;
 *   · 🔴 a control that FAILS shows BOTH figures and the difference — the walk
 *     breaks the books on purpose to see it, then puts them back, because a
 *     reconciliation only ever seen passing is an unread instrument;
 *   · changing the window changes the answer, by clicking the date fields;
 *   · Arabic under dir=rtl, and a phone at 390 px.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { E2E } from "./global-setup";
import { businessToday } from "@workspace/shared";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };
const YEAR = businessToday().slice(0, 4);

let api: APIRequestContext;
/** The journal entry the walk posts to break the reconciliation, so it can always be put back. */
let breakingEntryId = 0;

const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
});
test.afterAll(async () => {
  // 🔴 Always put the books back, even if a leg failed — a broken
  // reconciliation left behind would fail every later spec for the wrong reason.
  if (breakingEntryId) await api.post(`/api/journal-entries/${breakingEntryId}/reverse`, { data: {} });
  await api.dispose();
});

test.describe.serial("the fixed-asset movement and reconciliation, end to end", () => {
  test("🔴 the roll-forward renders, ADDS UP, and its figures are the server's", async ({ page }) => {
    await page.goto("/assets/report");
    await expect(page.getByTestId("page-fixed-asset-report")).toBeVisible();
    await expect(page.getByTestId("movement")).toBeVisible();

    const r = await (await api.get(`/api/assets/report?from=${YEAR}-01-01&to=${businessToday()}`)).json();
    for (const m of r.movement as Array<Record<string, number>>) {
      // the property a reader checks first, on every row
      expect(Math.round((m.openingCost! + m.additions! - m.disposalsCost!) * 100) / 100).toBe(m.closingCost);
      expect(Math.round((m.openingAccumulated! + m.charge! - m.disposalsAccumulated!) * 100) / 100).toBe(m.closingAccumulated);
      expect(m.closingNetBookValue).toBe(Math.round((m.closingCost! - m.closingAccumulated!) * 100) / 100);
    }
    // and the rendered total is the server's
    await expect(page.getByTestId("total-closing-cost")).toContainText(
      new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(r.totals.closingCost),
    );
    // the Zakat feed states the same closing net book value, once
    for (const z of r.zakatNetFixedAssets as Array<{ categoryName: string; netBookValue: number }>) {
      const m = (r.movement as Array<{ categoryName: string; closingNetBookValue: number }>).find((x) => x.categoryName === z.categoryName)!;
      expect(z.netBookValue).toBe(m.closingNetBookValue);
    }
  });

  test("🔴 the reconciliation is at the top and says which way it went", async ({ page }) => {
    await page.goto("/assets/report");
    await expect(page.getByTestId("reconciliation")).toBeVisible();
    const r = await (await api.get("/api/assets/report")).json();
    await expect(page.getByTestId("reconciles")).toHaveText(r.reconciles ? "reconciles" : "differs");
    expect(r.controls.length, "the seeded tenant has asset categories, so there is something to reconcile").toBeGreaterThan(0);
  });

  test("🔴 BREAK IT ON PURPOSE: a line posted to a fixed-asset account from outside the register makes the control FAIL, with both figures and the difference — then the reversal puts it back", async ({ page }) => {
    const before = await (await api.get("/api/assets/report")).json();
    const cat = (before.controls as Array<{ id: string; categoryName: string; ledger: number; register: number }>).find((c) => c.id === "FA_COST")!;
    expect(cat, "a cost control to break").toBeTruthy();

    // find the accounts by name through the product's own chart
    const cats = await (await api.get("/api/categories?limit=500")).json();
    const all = (cats.items ?? cats) as Array<{ id: number; name: string; systemCode: string | null; isPosting?: boolean }>;
    const costAccount = all.find((c) => c.systemCode === "FIXED_ASSETS")!;
    const equity = all.find((c) => c.systemCode === "RETAINED_EARNINGS")!;
    expect(costAccount && equity, "the chart carries both accounts").toBeTruthy();

    const created = await api.post("/api/journal-entries", {
      data: {
        date: `${YEAR}-06-15`, description: "E2E: asset cost posted outside the register",
        lines: [
          { accountId: costAccount.id, accountName: costAccount.name, debitAmount: 7777, creditAmount: 0, description: "Cost" },
          { accountId: equity.id, accountName: equity.name, debitAmount: 0, creditAmount: 7777, description: "Funded from reserves" },
        ],
      },
    });
    // 🔴 A create that quietly fails would make the approve error with "Invalid
    // id" and send the reader to the wrong layer — so the create's own status
    // is asserted, with the server's words.
    expect(created.ok(), await created.text()).toBe(true);
    const je = await created.json();
    breakingEntryId = je.id;
    const approved = await api.post(`/api/journal-entries/${je.id}/approve`, { data: {} });
    expect(approved.ok(), await approved.text()).toBe(true);

    await page.goto("/assets/report");
    await expect(page.getByTestId("reconciles")).toHaveText("differs");
    const failing = page.getByTestId(`control-status-FA_COST-${cat.categoryName}`);
    await expect(failing).toBeVisible();
    // 🔴 BOTH figures and the gap are on the page, not just a verdict
    const card = page.getByTestId(`control-FA_COST-${cat.categoryName}`);
    await expect(card).toContainText("7,777.00");
    await expect(card).toContainText("Register");

    const broken = await (await api.get("/api/assets/report")).json();
    const brokenControl = (broken.controls as Array<{ id: string; categoryName: string; difference: number; ledger: number }>)
      .find((c) => c.id === "FA_COST" && c.categoryName === cat.categoryName)!;
    expect(brokenControl.ledger).toBe(cat.ledger + 7777);
    expect(brokenControl.difference).toBe(Math.round((cat.register - (cat.ledger + 7777)) * 100) / 100);

    // put it back — and see the page agree again
    const rev = await api.post(`/api/journal-entries/${je.id}/reverse`, { data: {} });
    expect(rev.ok(), await rev.text()).toBe(true);
    breakingEntryId = 0;
    await page.reload();
    await expect(page.getByTestId("reconciles")).toHaveText("reconciles");
  });

  test("🔴 changing the window by clicking changes the answer", async ({ page }) => {
    await page.goto("/assets/report");
    const wide = await (await api.get(`/api/assets/report?from=2000-01-01&to=${businessToday()}`)).json();
    // a window BEFORE the platform had any asset has nothing in it
    await page.getByTestId("report-from").fill("1990-01-01");
    await page.getByTestId("report-to").fill("1990-12-31");
    await expect(page.getByTestId("total-closing-cost")).toContainText("0.00");
    await expect(page.getByTestId("additions-list")).toContainText("None in this window.");
    // …and widening it brings the figures back, so the emptiness was the window's
    await page.getByTestId("report-from").fill("2000-01-01");
    await page.getByTestId("report-to").fill(businessToday());
    if (wide.totals.closingCost > 0) {
      await expect(page.getByTestId("total-closing-cost")).not.toContainText(/^0\.00$/);
    }
  });

  test("Arabic / RTL and a phone: the page reads right-to-left and nothing scrolls sideways", async ({ page }) => {
    await page.goto("/assets/report");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { name: /الحركة والمطابقة/ })).toBeVisible();
    await noSidewaysScroll(page, 1280, "ar asset report");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));

    await page.setViewportSize(PHONE);
    await page.reload();
    await expect(page.getByTestId("movement")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "phone asset report");
  });
});
