/**
 * M18.0 — the reports catalogue may only advertise reports that exist.
 *
 * 🔴 THE DEFECT THIS GUARDS, which was live until M18.0:
 *
 * `ReportsHub.tsx` listed 39 reports. **13 existed.** The other 26 were
 * rendered greyed out with a padlock and the tooltip "Upgrade to unlock this
 * report", under a header counting "13 available · 26 premium · 39 total" and
 * a banner offering to "upgrade your plan to access all 26 locked reports".
 *
 * There is no plan — no billing, no subscription model, no pricing decision,
 * no paid tier anywhere in this product. The page made a commercial claim that
 * was false in both halves: a tier nobody can buy, gating reports nobody wrote.
 * And one padlocked entry ("Cashflow Report") was a page that had shipped and
 * was reachable from the main navigation the entire time.
 *
 * A source-reading guard, like `route-reachability.test.ts` and the categorizer
 * control-character tests: behavioural tests prove the cases you thought of,
 * and this defect is defined by entries nobody wired up. It fails on any
 * catalogue entry whose target does not exist, and on any attempt to
 * reintroduce the locked/premium vocabulary.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "..");
const REPO_ROOT = join(API_SRC, "..", "..", "..");
const WEB_SRC = join(REPO_ROOT, "apps", "web", "src");

const catalogueSrc = readFileSync(join(WEB_SRC, "pages", "ReportsHub.tsx"), "utf8");
const appSrc = readFileSync(join(WEB_SRC, "App.tsx"), "utf8");

/** Every `href: "/..."` the catalogue offers. */
function catalogueTargets(): string[] {
  return [...catalogueSrc.matchAll(/href:\s*"(\/[^"]*)"/g)].map((m) => m[1]);
}

/** Every `<Route path="/...">` the app actually mounts. */
function mountedRoutes(): Set<string> {
  return new Set([...appSrc.matchAll(/path=\{?"(\/[^"]*)"/g)].map((m) => m[1]));
}

describe("M18.0 — the reports catalogue advertises only what exists", () => {
  it("🔴 every catalogue entry resolves to a mounted route", () => {
    const routes = mountedRoutes();
    const dangling = catalogueTargets().filter((href) => !routes.has(href));
    expect(dangling, `catalogue entries with no route: ${dangling.join(", ")}`).toEqual([]);
  });

  it("the guard is not vacuous — it found real entries to check", () => {
    // If a refactor turns the catalogue into something this regex cannot read,
    // the assertion above would pass by checking nothing. Pin the shape.
    expect(catalogueTargets().length).toBeGreaterThan(10);
    expect(mountedRoutes().size).toBeGreaterThan(10);
  });

  it("🔴 no entry is padlocked, premium, or otherwise advertised-but-absent", () => {
    // The mechanism mattered as much as the entries: a `locked` flag is what
    // made it possible to list a report without building it. Removing the 26
    // entries while leaving the flag would invite the next 26.
    //
    // Checked against the file with COMMENTS STRIPPED: the header and several
    // inline notes deliberately quote the old vocabulary to record what was
    // removed and why. That prose is the point — it is the code that must be
    // clean, not the explanation of why it is clean.
    const code = withoutComments(catalogueSrc);
    for (const banned of ["locked", "premium", "Upgrade to unlock", "upgrade your plan"]) {
      expect(
        code.includes(banned),
        `"${banned}" reappeared in reports-catalogue CODE (comments are exempt by design)`,
      ).toBe(false);
    }
  });

  it("…and the stripper leaves the code intact, so that check is not vacuous", () => {
    const code = withoutComments(catalogueSrc);
    // Still real code afterwards, and the entries it guards survive stripping.
    expect(code).toContain("/income-statement");
    expect(code).toContain("CATEGORIES");
    // …while the explanatory prose is genuinely gone.
    expect(code).not.toContain("Upgrade to unlock");
  });
});

/** Strip block comments (including JSX `{/* … *\/}`) and line comments. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}
