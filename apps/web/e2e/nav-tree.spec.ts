import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E } from "./global-setup";
import { EXPECTATIONS } from "./routes";
import { NAV_TREE, allNavEntries, type NavEntry } from "../src/nav/tree";
import { COMING_SOON, BLOCKERS } from "../src/lib/comingSoon";
import { filterLabel, INVOICE_FILTERS, BILL_FILTERS, JOURNAL_ENTRY_FILTERS, QUOTATION_FILTERS, PURCHASE_ORDER_FILTERS } from "../src/lib/listFilters";

/**
 * THE NAVIGATION TREE, CHECKED ENTRY BY ENTRY.
 *
 * ── 🔴 WHY EVERY ENTRY AND NOT A SAMPLE (owner's condition on this build) ──
 * The navigation makes ~250 promises, and they are not interchangeable. A
 * sample would cover the entries someone thought of, which is the same
 * selection bias that let a statement link drop its customer: the defect was
 * in the one link nobody checked, and every static guard was green because
 * neither file was wrong. So the tree is DATA (`src/nav/tree.ts`) and this
 * spec walks all of it. Adding an entry adds a test; there is no list here to
 * forget to update.
 *
 * ── THE THREE PROMISES, ONE CHECK EACH ─────────────────────────────────────
 *
 *   built        The href resolves and the page renders content. (The smoke
 *                crawl already asserts this per route; here it asserts the NAV
 *                points at routes that exist — a different question, and the
 *                one that catches an entry pointing at a page that was renamed.)
 *
 *   filter       🔴 The destination REFLECTS the filter. Not "the link
 *                resolves" — that was never in doubt in the lost-scope
 *                incident either. The destination must say which scope it is
 *                showing and how many rows are in it, and it must be the scope
 *                that was asked for.
 *
 *   coming-soon  The placeholder names a SPECIFIC blocker and states the work
 *                order. A page reading "coming soon" satisfies a weaker test
 *                and fails the rule this build was given.
 *
 * ── 🔴 AND THE INVERSE QUESTION, WHICH IS A DIFFERENT ONE ──────────────────
 * The reconciliation asked "does every spec entry point at something real".
 * Replacing the navigation makes the opposite question urgent: does every real
 * page still appear in it? A page that exists, works, and is in no menu is
 * exactly the unreachable-surface disease this project keeps finding — so
 * `every crawlable route is reachable from the navigation` is asserted here
 * too, and it is the check most likely to catch a mistake in the tree itself.
 */

test.use({ storageState: E2E.storageState });

const entries = allNavEntries();
const filterEntries = entries.filter(e => e.marker === "filter");
const comingSoonEntries = entries.filter(e => e.marker === "coming-soon");
const builtEntries = entries.filter(e => e.marker === "built");

const FILTER_SETS = {
  "/invoices": INVOICE_FILTERS,
  "/bills": BILL_FILTERS,
  "/journal-entries": JOURNAL_ENTRY_FILTERS,
  "/quotations": QUOTATION_FILTERS,
  "/purchase-orders": PURCHASE_ORDER_FILTERS,
} as const;

/** Routes App.tsx declares, read from source — the same trick the smoke crawl uses. */
function declaredRoutes(): string[] {
  const src = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
  return [...src.matchAll(/path="([^"]+)"/g)].map(m => m[1]);
}

// ───────────────────────────────────────────────────────────────────────────
// Pure structural checks — no browser needed, so they fail fast and loudly.
// ───────────────────────────────────────────────────────────────────────────

test.describe("the tree is internally consistent", () => {
  test("the check is not vacuous — the tree has real entries of all three kinds", () => {
    expect(NAV_TREE.length).toBeGreaterThan(5);
    expect(builtEntries.length).toBeGreaterThan(30);
    expect(filterEntries.length).toBeGreaterThan(15);
    expect(comingSoonEntries.length).toBeGreaterThan(20);
  });

  test("🔴 every BUILT href points at a route App.tsx actually declares", () => {
    const routes = new Set(declaredRoutes());
    const dead = builtEntries
      .map(e => e.href.split("?")[0])
      .filter(path => !routes.has(path));
    expect(
      [...new Set(dead)],
      "Navigation entries pointing at routes that do not exist. This is the dead-click " +
        "shape: the entry looks live, the click lands on the 404 page.",
    ).toEqual([]);
  });

  test("🔴 every FILTER href points at a declared route AND a status that list offers", () => {
    const routes = new Set(declaredRoutes());
    const problems: string[] = [];
    for (const e of filterEntries) {
      if (!e.filter) {
        problems.push(`${e.label}: marked filter but carries no filter descriptor`);
        continue;
      }
      if (!routes.has(e.filter.path)) problems.push(`${e.label}: ${e.filter.path} is not a route`);
      const options = FILTER_SETS[e.filter.path as keyof typeof FILTER_SETS];
      if (!options) {
        problems.push(`${e.label}: ${e.filter.path} has no declared filter vocabulary`);
        continue;
      }
      if (!options.some(o => o.value === e.filter!.status)) {
        problems.push(`${e.label}: '${e.filter.status}' is not an option on ${e.filter.path}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("🔴 every COMING SOON entry resolves to a registered placeholder", () => {
    const slugs = new Set(COMING_SOON.map(e => e.slug));
    const unregistered = comingSoonEntries
      .map(e => e.href.replace("/coming-soon/", ""))
      .filter(slug => !slugs.has(slug));
    expect(
      unregistered,
      "A nav entry points at /coming-soon/<slug> with nothing registered for it. " +
        "That renders the 'this page does not exist' branch, which is a dead click " +
        "wearing a placeholder's clothes.",
    ).toEqual([]);
  });

  test("🔴 no placeholder is an orphan — every registered entry is reachable from the nav", () => {
    // The obsolete-assertion rule pointed at content: a placeholder nothing
    // links to is a page written for nobody, and it rots unnoticed.
    const linked = new Set(comingSoonEntries.map(e => e.href.replace("/coming-soon/", "")));
    const orphans = COMING_SOON.map(e => e.slug).filter(slug => !linked.has(slug));
    expect(orphans, "Registered placeholders that no navigation entry points at").toEqual([]);
  });

  test("🔴 every placeholder names a blocker and states its work order", () => {
    const weak = /^(coming soon|not available|tbd|todo|soon)\.?$/i;
    const problems: string[] = [];
    for (const e of COMING_SOON) {
      const blocker = BLOCKERS[e.blocker];
      if (!blocker) problems.push(`${e.slug}: unknown blocker '${e.blocker}'`);
      if (!e.whenCleared || e.whenCleared.length < 40) {
        problems.push(`${e.slug}: the work order is missing or too thin to act on`);
      }
      if (weak.test(e.summary.trim())) problems.push(`${e.slug}: summary says nothing`);
      // Arabic is a launch requirement, and a placeholder is a page like any
      // other. An English-only placeholder is the exact gap the coverage sweep
      // keeps finding, arriving fresh in new code.
      for (const [field, value] of Object.entries({
        titleAr: e.titleAr, summaryAr: e.summaryAr, whenClearedAr: e.whenClearedAr,
      })) {
        if (!value || !/[؀-ۿ]/.test(value)) problems.push(`${e.slug}: ${field} is not Arabic`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("🔴 every crawlable route is reachable from the navigation", () => {
    /**
     * The INVERSE question, and the one this build makes urgent: a page that
     * exists and appears in no menu is unreachable, which is the disease six
     * read-only audits missed and one pass with a browser found.
     */
    const navPaths = new Set(entries.map(e => e.href.split("?")[0]));
    const EXEMPT = new Set([
      "/login", "/signup", "/accept-invite", "/operator", "/verification-status",
      // Reached from a record, not a menu.
      "/customers/:id", "/vendors/:id",
      // The placeholder route itself; its entries are counted individually.
      "/coming-soon/:slug",
    ]);
    const unreachable = declaredRoutes().filter(r => !EXEMPT.has(r) && !navPaths.has(r));
    expect(
      unreachable,
      "Routes with a working page and no way to reach them from the sidebar.\n" +
        "Either add a navigation entry, or add the route to EXEMPT with a reason.",
    ).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The browser checks.
// ───────────────────────────────────────────────────────────────────────────

test.describe("every filter entry's destination reflects its filter", () => {
  for (const entry of filterEntries) {
    const f = entry.filter!;
    test(`${entry.href} → the page says it is showing "${entry.label}"`, async ({ page }) => {
      await page.goto(entry.href, { waitUntil: "networkidle" });

      const scope = page.locator('[data-testid="filter-scope"]');
      await expect(
        scope,
        `${entry.href} rendered no filter scope. The link carried a filter and the ` +
          `destination said nothing about it — the lost-scope shape: a true statement ` +
          `about a set the user did not ask for.`,
      ).toBeVisible();

      // The scope the page believes it is showing IS the one the link asked for.
      await expect(scope).toHaveAttribute("data-status", f.status);

      // And it is named in the user's language, from the shared vocabulary —
      // so a nav label and a page label cannot drift apart.
      const options = FILTER_SETS[f.path as keyof typeof FILTER_SETS];
      await expect(page.locator('[data-testid="filter-scope-label"]')).toHaveText(
        filterLabel(options, f.status, "en"),
      );

      // A count, from the server, for the filtered set — never a length taken
      // from the fetched page.
      const total = await scope.getAttribute("data-total");
      expect(total, `${entry.href} showed a scope with no count`).not.toBeNull();
      expect(Number(total)).toBeGreaterThanOrEqual(0);
    });
  }
});

test.describe("the filters actually filter", () => {
  /**
   * 🔴 The anti-vacuity half, and the reason the per-entry checks above are not
   * enough on their own. Every one of them would pass against a page that
   * displayed the requested scope and then ignored it — the destination would
   * say "Issued · 4" over a list of all four invoices, which is precisely the
   * defect shape: a label that is true about the request and false about the
   * data. So at least one filter must return STRICTLY FEWER rows than the
   * unfiltered list, and the seeded fixture is built to guarantee it.
   */
  test("🔴 a filtered list is strictly smaller than the unfiltered one", async ({ page }) => {
    await page.goto("/invoices", { waitUntil: "networkidle" });
    // The scope is deliberately absent when nothing is filtered — an
    // unfiltered list needs no announcement.
    await expect(page.locator('[data-testid="filter-scope"]')).toHaveCount(0);
    const allRows = await page.locator("tbody tr").count();
    expect(
      allRows,
      "the fixture seeded no invoices — every assertion here would be vacuous",
    ).toBeGreaterThan(1);

    await page.goto("/invoices?status=paid", { waitUntil: "networkidle" });
    const scope = page.locator('[data-testid="filter-scope"]');
    await expect(scope).toBeVisible();
    const paidRows = await page.locator("tbody tr").count();

    expect(
      paidRows,
      "'paid' returned every invoice — the page displayed the requested scope and " +
        "then ignored it, which is a label that is true about the request and false " +
        "about the data",
    ).toBeLessThan(allRows);
    expect(
      Number(await scope.getAttribute("data-total")),
      "the stated count disagrees with the rows on screen",
    ).toBe(paidRows);
  });

  test("🔴 an unrecognised status falls back to the whole list, not an empty one", async ({ page }) => {
    // Showing everything is visibly wrong; showing nothing looks like a fact.
    await page.goto("/invoices?status=not-a-real-status", { waitUntil: "networkidle" });
    await expect(page.locator('[data-testid="filter-scope"]')).toHaveCount(0);
    expect(await page.locator("tbody tr").count()).toBeGreaterThan(1);
  });
});

test.describe("every placeholder explains itself", () => {
  for (const entry of COMING_SOON) {
    test(`/coming-soon/${entry.slug} names its blocker`, async ({ page }) => {
      await page.goto(`/coming-soon/${entry.slug}`, { waitUntil: "networkidle" });

      const root = page.locator('[data-testid="coming-soon"]');
      await expect(root, "the placeholder did not render").toBeVisible();
      await expect(root).toHaveAttribute("data-slug", entry.slug);

      const blocker = page.locator('[data-testid="coming-soon-blocker"]');
      await expect(blocker).toBeVisible();
      const blockerText = ((await blocker.textContent()) ?? "").trim();
      expect(
        blockerText.length,
        `${entry.slug} named no blocker. "Not built" invites someone to build it; ` +
          `"waiting on a contract" tells them why they must not.`,
      ).toBeGreaterThan(10);
      expect(blockerText.toLowerCase()).not.toBe("coming soon");

      await expect(page.locator('[data-testid="coming-soon-work-order"]')).toBeVisible();
    });
  }
});

test.describe("the navigation itself", () => {
  /**
   * 🔴 NO NAV ENTRY IS A DEAD CLICK — ASSERTED AS A COMPOSITION, AND THE EDGE
   *    BETWEEN THE TWO HALVES IS THE ASSERTION.
   *
   * The first version of this crawled all sixty-odd destinations here. Two
   * things came of that, and both are the reason it does not any more.
   *
   * 1. It was WRONG, in a way worth recording: it waited for
   *    `domcontentloaded`, and fourteen data-driven pages were still showing
   *    "Loading…" — eight characters — at that moment. Fourteen red tests, not
   *    one of them a defect. The smoke crawl had been right to wait for
   *    `networkidle`, and copying the shape of a check without its timing
   *    reproduced the check and not its meaning.
   *
   * 2. Once fixed, it bought NOTHING. Every one of those destinations is
   *    already crawled — harder, with console-error and 5xx assertions — by
   *    `smoke-crawl.spec.ts`. Sixty duplicate page loads tripled the suite's
   *    runtime to buy a second opinion on pages already covered, and a slow
   *    suite is one people learn to skip.
   *
   * So the guarantee is composed from two checks that already exist, and the
   * EDGE is asserted here explicitly rather than assumed:
   *
   *     every nav href → a route in the smoke crawl's crawlable set   (below)
   *     every crawlable route → renders, with no console error or 5xx (there)
   *
   * 🔴 This is deliberately NOT the "two correct assertions with a gap between
   * them" shape this project keeps finding. That defect is two checks whose
   * junction nobody states; this states the junction, in code, and fails when
   * it breaks. If a destination is not in `EXPECTATIONS`, nothing crawls it and
   * this goes red — which is exactly the fact the composition depends on.
   */
  const destinations = [...new Set(entries.map(e => e.href.split("?")[0]))];

  test("the destination list is not vacuous", () => {
    expect(destinations.length).toBeGreaterThan(30);
  });

  test("🔴 every navigation destination is a route the smoke crawl renders", () => {
    // `authenticated-no-shell` counts: those ARE crawled, just without the
    // `<main>` assertion — `/verification` renders outside the app shell by
    // design, which the crawl discovered rather than assumed.
    const crawled = new Set(
      Object.entries(EXPECTATIONS)
        .filter(([, kind]) => kind === "app" || kind === "param" || kind === "authenticated-no-shell")
        .map(([route]) => route),
    );
    // The placeholder route is crawled as a param shape there, and every one of
    // its slugs is loaded individually by this file.
    const uncrawled = destinations.filter(
      d => !crawled.has(d) && !d.startsWith("/coming-soon/"),
    );
    expect(
      uncrawled,
      "Navigation destinations that NOTHING renders in a browser. Either add the\n" +
        "route to smoke-crawl's EXPECTATIONS, or remove the navigation entry — an\n" +
        "entry pointing at a page no test has ever rendered is how a dead click ships.",
    ).toEqual([]);
  });

  test("🔴 the sidebar renders, and a Coming Soon entry is a real link", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const soonLinks = page.locator('[data-nav-marker="coming-soon"]');
    // Not disabled, not greyed into uselessness: a real anchor with a real href.
    const count = await soonLinks.count();
    expect(count, "no Coming Soon entries rendered in the sidebar at all").toBeGreaterThan(0);
    const href = await soonLinks.first().getAttribute("href");
    expect(href).toMatch(/^\/coming-soon\//);
  });
});
