import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";
import { EXPECTATIONS, type Kind } from "./routes";

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
  const { customerId, vendorId } = ids();
  if (route === "/customers/:id") return `/customers/${customerId}`;
  if (route === "/vendors/:id") return `/vendors/${vendorId}`;
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
