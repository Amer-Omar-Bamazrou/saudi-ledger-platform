import { test, expect, type Page, type ConsoleMessage } from "./fixtures";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E, E2E_PHONE, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";
import type { SeededBooks } from "./seedBooks";
import { EXPECTATIONS, ROWS_EXPECTED, type Kind } from "./routes";
import { fitsAtPhoneWidth } from "./phoneFit";

/**
 * THE SMOKE CRAWL — every route, authenticated, failing on a page error or an
 * empty body.
 *
 * ── 🔴 THE ROUTE LIST IS DERIVED, NEVER TYPED ──────────────────────────────
 * It is parsed out of `App.tsx`. A hand-maintained list would be a second
 * representation of the route table, and this project has watched two id spaces
 * with no forcing function drift apart before. Deriving it means a route added
 * tomorrow is crawled tomorrow, with nobody remembering to add it.
 *
 * The forcing function is `EXPECTATIONS` below: every derived route must be
 * classified, and an unclassified one FAILS the suite. So a new route cannot
 * quietly opt out of coverage — the person adding it has to say what it is.
 * That is the known-gap-list pattern P4 already uses, pointed at pages.
 */

const APP_TSX = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "App.tsx");

function declaredRoutes(): string[] {
  const src = readFileSync(APP_TSX, "utf8");
  const found = [...src.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(found)].sort();
}


function ids(): SeededIds {
  return JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds;
}

/** Concrete URL for a route, substituting seeded ids for parameters. */
function concrete(route: string): string {
  const { customerId, vendorId, migrationBatchId, budgetId, taxComputationId } = ids();
  if (route === "/migration/:id") return `/migration/${migrationBatchId}`;
  if (route === "/customers/:id") return `/customers/${customerId}`;
  if (route === "/customers/:id/statement") return `/customers/${customerId}/statement`;
  if (route === "/vendors/:id") return `/vendors/${vendorId}`;
  if (route === "/budgets/:id") return `/budgets/${budgetId}`;
  if (route === "/tax/computations/:id") return `/tax/computations/${taxComputationId}`;
  if (route === "/supplier-statements/:vendorId") return `/supplier-statements/${vendorId}`;
  // A slug that must exist in `lib/comingSoon.ts`; `nav-tree.spec.ts` asserts it.
  if (route === "/coming-soon/:slug") return "/coming-soon/transfers";
  return route;
}

/**
 * What counts as a broken page.
 *
 * 🔴 Not "did it 200" — every one of this project's browser-found defects
 * returned 200. The three that matter:
 *   - an uncaught exception (the blank page)
 *   - a 5xx the page swallowed (the frozen UI)
 *   - a body with nothing in it (the render that produced no content)
 */
interface PageProblems {
  pageErrors: string[];
  consoleErrors: string[];
  serverErrors: string[];
  notFound: string[];
}

function watch(page: Page): PageProblems {
  const p: PageProblems = { pageErrors: [], consoleErrors: [], serverErrors: [], notFound: [] };
  page.on("pageerror", (e) => p.pageErrors.push(e.message));
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // React's dev-mode key/prop warnings are noise for a reachability crawl and
    // would make this a lint job wearing a smoke test's clothes.
    if (/Download the React DevTools|Warning:/i.test(text)) return;
    p.consoleErrors.push(text);
  });
  page.on("response", (r) => {
    const url = r.url();
    if (!url.includes("/api/")) return;
    if (r.status() >= 500) p.serverErrors.push(`${r.status()} ${url}`);
    // 🔴 Closes P4's blind spot from the other side: P4 proves a call SITE
    // exists, this proves the call the running app actually makes resolves to a
    // mounted route. A 404 here is a client calling something never wired up.
    if (r.status() === 404) p.notFound.push(`404 ${url}`);
  });
  return p;
}

function assertClean(route: string, p: PageProblems): void {
  expect(p.pageErrors, `${route} threw an uncaught exception — this is the blank-page shape`).toEqual([]);
  expect(p.serverErrors, `${route} received a 5xx the page did not surface`).toEqual([]);
  expect(p.notFound, `${route} called an API route that is not mounted`).toEqual([]);
  expect(p.consoleErrors, `${route} logged console errors`).toEqual([]);
}

test.describe("the route list is fully classified", () => {
  test("🔴 every route in App.tsx is classified, and every classification still exists", () => {
    const declared = declaredRoutes();
    const classified = Object.keys(EXPECTATIONS).sort();

    const unclassified = declared.filter((r) => !(r in EXPECTATIONS));
    expect(
      unclassified,
      `New route(s) in App.tsx with no entry in EXPECTATIONS.\n` +
        `Add each to EXPECTATIONS saying what it is ("app" | "anonymous" | "operator" | "param").\n` +
        `A route with no classification is a page nothing crawls, which is how an\n` +
        `unreachable surface ships.`,
    ).toEqual([]);

    // The obsolete-assertion rule, applied here: a classification for a route
    // that no longer exists is a claim about nothing, and it rots quietly.
    const stale = classified.filter((r) => !declared.includes(r));
    expect(stale, `EXPECTATIONS names route(s) that App.tsx no longer declares — remove them`).toEqual([]);
  });

  test("the crawl is not vacuous — it has real routes and real seeded ids", () => {
    expect(declaredRoutes().length).toBeGreaterThan(40);
    const { customerId, vendorId } = ids();
    expect(customerId).toBeGreaterThan(0);
    expect(vendorId).toBeGreaterThan(0);
  });
});

test.describe("authenticated smoke crawl", () => {
  test.use({ storageState: E2E.storageState });

  const crawlable = Object.entries(EXPECTATIONS).filter(([, kind]) => kind === "app" || kind === "param");

  for (const [route] of crawlable) {
    test(`${route} renders`, async ({ page }) => {
      const problems = watch(page);
      const url = concrete(route);

      const response = await page.goto(url, { waitUntil: "networkidle" });
      expect(response?.status(), `${route} did not serve a document`).toBeLessThan(400);

      // Not "the URL is right" — the app is a SPA and would happily show a
      // blank shell. Assert the page produced content.
      const main = page.locator("main");
      await expect(main, `${route} has no <main> — the shell rendered without a page`).toHaveCount(1);

      const text = ((await main.textContent()) ?? "").trim();
      expect(
        text.length,
        `${route} rendered an EMPTY body. The route resolved and the shell drew, ` +
          `and nothing inside it did — the blank-page shape that six read-only audits missed.`,
      ).toBeGreaterThan(20);

      /**
       * 🔴 A PAGE THAT SHOWS ITS EMPTY STATE PASSES EVERY ASSERTION ABOVE.
       *
       * `<main>` exists, the body has content, no console error, no 5xx — an
       * empty state satisfies all four. Until this check, 37 of 54 crawled
       * routes were passing exactly that way, with none of their row-rendering
       * code executed. Two of them carried an unkeyed-fragment defect the whole
       * time, invisible because `filter(length > 0)` never yielded a row.
       */
      if (ROWS_EXPECTED.has(route)) {
        // `tbody tr` OR an explicit `data-row`: several pages render their list
        // as cards or list items rather than a table, and a check that only
        // understood tables would report those as empty — a false red that
        // teaches people to loosen the assertion.
        // 🔴 Phase 18 audit A26 (2026-11-10): the count WAITS. `count()` reads once; `/bank-accounts`' list arrives
        // ~170 ms after the shell (its ledger balances), and twice the read came first — both saved failure snapshots
        // show the three seeded cards rendered a moment later. The same assertion, polled until it holds or times out.
        await expect.poll(
          () => page.locator("tbody tr, [data-row]").count(),
          {
            message:
              `${route} is seeded with data and rendered NO rows.\n` +
              `Either the fixture regressed or the page did — and note that every\n` +
              `other assertion in this test passed, because an empty state renders\n` +
              `perfectly well. That is the whole reason this check exists.`,
          },
        ).toBeGreaterThan(0);
      }

      assertClean(route, problems);
    });
  }
});

test.describe("authenticated pages outside the app shell", () => {
  test.use({ storageState: E2E.storageState });

  for (const [route, kind] of Object.entries(EXPECTATIONS)) {
    if (kind !== "authenticated-no-shell") continue;
    test(`${route} renders (no shell)`, async ({ page }) => {
      const problems = watch(page);
      await page.goto(route, { waitUntil: "networkidle" });
      // Same standard, asserted one level out: content, not just a 200.
      await expect(
        page.locator("body"),
        `${route} rendered an empty body`,
      ).not.toBeEmpty();
      const text = ((await page.locator("body").textContent()) ?? "").trim();
      expect(text.length, `${route} rendered almost nothing`).toBeGreaterThan(20);
      assertClean(route, problems);
    });
  }
});

test.describe("routes that are not the tenant's", () => {
  test.use({ storageState: E2E.storageState });

  test("the operator surface does not render for a tenant admin", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/operator", { waitUntil: "networkidle" });
    // Whatever it does — redirect, refuse, or render a refusal — it must not
    // throw and must not 5xx. The refusal is a product decision; the crash
    // would be a defect.
    expect(problems.pageErrors, "/operator threw for a non-operator").toEqual([]);
    expect(problems.serverErrors, "/operator 5xx'd for a non-operator").toEqual([]);
  });
});

test.describe("anonymous routes", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const [route, kind] of Object.entries(EXPECTATIONS)) {
    if (kind !== "anonymous") continue;
    test(`${route} renders logged out`, async ({ page }) => {
      const problems = watch(page);
      await page.goto(route, { waitUntil: "networkidle" });
      const text = ((await page.locator("body").textContent()) ?? "").trim();
      expect(text.length, `${route} rendered empty`).toBeGreaterThan(20);
      expect(problems.pageErrors, `${route} threw`).toEqual([]);
      expect(problems.serverErrors, `${route} 5xx'd`).toEqual([]);
    });
  }
});

/**
 * 🔴 EVERY ROUTE FITS A 390 PX PHONE, IN ARABIC (owner, 2026-11-21).
 *
 * The app's content area clips sideways (Layout.tsx `overflow-x-hidden`), so a row wider than the phone loses its
 * last controls off screen and nothing scrolls: the document-width check every walk used was true by construction.
 * A sweep of all 95 routes (2026-11-21) found five report pages whose Generate button lay 44 of its 49 px past the
 * edge. `fitsAtPhoneWidth` measures the content area itself and names what does not fit. It runs here, over every
 * route this crawl classifies, so a new page is measured the day it is added. Frame: each page as it first renders
 * (default tab, no dialog opened). `/operator` is measured by `p19a-walk-390.spec.ts` as an operator.
 *
 * 🔴 DETERMINISTIC (owner, 2026-11-21): it measures the PHONE-FIT tenant (global-setup.ts `E2E_PHONE`), seeded with
 * the worst values a page plausibly meets (seedBooks.ts `PHONE_BOOKS`: the longest names, unbroken references, long
 * narratives, large amounts) and written to by nothing else — so the result cannot depend on what other specs left in
 * the shared tenant. CI's fonts are the reference; `E2E_PHONE_WIDTH` narrows the viewport to check a fix leaves margin.
 */
const PHONE = { width: Number(process.env.E2E_PHONE_WIDTH ?? 390), height: 844 };
function phoneUrl(route: string): string {
  const b = JSON.parse(readFileSync(E2E_PHONE.ids, "utf8")) as SeededBooks;
  const map: Record<string, string> = {
    "/migration/:id": `/migration/${b.migrationBatchId}`,
    "/customers/:id": `/customers/${b.customerId}`,
    "/customers/:id/statement": `/customers/${b.customerId}/statement`,
    "/vendors/:id": `/vendors/${b.vendorId}`,
    "/budgets/:id": `/budgets/${b.budgetId}`,
    "/tax/computations/:id": `/tax/computations/${b.taxComputationId}`,
    "/supplier-statements/:vendorId": `/supplier-statements/${b.vendorId}`,
    "/invoices/:id": `/invoices/${b.invoiceId}`,
    "/assets/:id": `/assets/${b.assetId}`,
    "/coming-soon/:slug": "/coming-soon/transfers",
  };
  if (!route.includes(":")) return route;
  const url = map[route];
  if (!url) throw new Error(`the 390 px crawl has no phone-fit id for ${route}: add it to seedBooks and this map`);
  return url;
}
async function openInArabic(page: Page, url: string): Promise<void> {
  await page.addInitScript(() => { try { localStorage.setItem("ksa_lang", "ar"); } catch { /* the default language */ } });
  await page.goto(url, { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
}

test.describe("every route fits a 390 px phone, in Arabic", () => {
  test.describe("signed in", () => {
    test.use({ storageState: E2E_PHONE.state, viewport: PHONE, locale: "ar-SA" });
    for (const [route, kind] of Object.entries(EXPECTATIONS)) {
      if (kind !== "app" && kind !== "param" && kind !== "authenticated-no-shell") continue;
      test(`${route} fits at 390 px`, async ({ page }) => {
        await openInArabic(page, phoneUrl(route));
        await fitsAtPhoneWidth(page, route);
      });
    }
  });

  test.describe("signed out", () => {
    test.use({ storageState: { cookies: [], origins: [] }, viewport: PHONE, locale: "ar-SA" });
    for (const [route, kind] of Object.entries(EXPECTATIONS)) {
      if (kind !== "anonymous") continue;
      test(`${route} fits at 390 px, signed out`, async ({ page }) => {
        await openInArabic(page, route);
        await fitsAtPhoneWidth(page, route);
      });
    }
  });
});

/**
 * 🔴 A KPI FIGURE IN THE HUNDREDS OF MILLIONS STAYS ON ONE LINE AT 360 PX (owner, 2026-11-21). The phone-fit tenant's
 * balance sheet totals are planted that large; the figure must be whole (never broken between digits), inside its
 * card, and the page must fit. 360 px is narrower than the 390 px every route is measured at: the margin.
 */
test.describe("a nine-figure KPI at 360 px", () => {
  test.use({ storageState: E2E_PHONE.state, viewport: { width: 360, height: 800 }, locale: "ar-SA" });
  test("the balance sheet's total assets is one unbroken figure inside its card", async ({ page }) => {
    await openInArabic(page, "/balance-sheet");
    const kpi = page.getByTestId("bs-kpi-assets");
    await expect(kpi).toBeVisible();
    const m = await kpi.evaluate((el) => {
      const text = (el.textContent ?? "").trim();
      const digits = /\d[\d,]*\.\d{2}/.exec(text);
      const node = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && digits && (n.nodeValue ?? "").includes(digits[0])) ?? el.firstChild!;
      const range = document.createRange();
      const at = (node.nodeValue ?? "").indexOf(digits?.[0] ?? "");
      range.setStart(node, Math.max(at, 0));
      range.setEnd(node, Math.max(at, 0) + (digits?.[0].length ?? 0));
      const lines = new Set(Array.from(range.getClientRects()).filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
      const card = el.closest(".rounded-lg")!.getBoundingClientRect();
      const box = range.getBoundingClientRect();
      return { text, value: Number((digits?.[0] ?? "0").replace(/,/g, "")), lines, inside: box.left >= card.left && box.right <= card.right };
    });
    expect(m.value, `anti-vacuity: the planted total is in the hundreds of millions (${m.text})`).toBeGreaterThanOrEqual(100_000_000);
    expect(m.lines, `the amount ${m.text} is on one line`).toBe(1);
    expect(m.inside, "and inside its card").toBe(true);
    await fitsAtPhoneWidth(page, "/balance-sheet at 360 px");
  });
});
