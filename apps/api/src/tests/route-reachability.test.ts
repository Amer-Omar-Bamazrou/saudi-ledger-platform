import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * THE STANDING CHECK, MECHANIZED — every mounted route must have a terminus.
 *
 * ── 🔴 WHY THIS EXISTS: THE CHECK SAID YES AND WAS WRONG ───────────────────
 * The standing check's part 1 asks whether every capability has a production
 * caller. Applied to A1's capture pipeline and A3's recurring rules it
 * **passed** — `captureService.capture` is called by `routes/capture.ts`,
 * `recurringService.list` by `routes/recurring.ts`, and both jobs are
 * registered in `jobs/index.ts`. Every grep returned a production, non-test
 * file. And yet nothing in the product could reach either feature: the whole
 * backend was complete, tested, permission-gated and unreachable.
 *
 * The defect was that part 1 **terminates at the wrong layer**. "Something one
 * layer up calls this" bottoms out at the HTTP boundary — but an endpoint is
 * only a capability if something calls THE ENDPOINT. The chain has to end at a
 * terminus a human or a clock actually reaches:
 *
 *   1. a UI surface in `apps/web` (directly via `apiFetch`, or through a
 *      generated client hook);
 *   2. an operator surface (also `apps/web`, so it satisfies 1);
 *   3. a job that `start()` genuinely schedules — note A3 failed even this,
 *      because `ZATCA_WORKER_ENABLED` silently unscheduled it;
 *   4. an explicitly allowlisted non-UI consumer, below, with a stated reason.
 *
 * Anything else is a shape without a consumer, one layer up from where the
 * check was looking.
 *
 * ── Why a test rather than a better checklist ──────────────────────────────
 * Nine instances of this failure mode have now been found, every one of them
 * by a sweep rather than during the milestone that created it. A check that
 * survives careful review needs a forcing function, not more care — the same
 * conclusion this repository reached for two-id-spaces (M15) and for
 * write-boundary invariants (migration 0034).
 *
 * ── Its limits, stated plainly so it is not oversold ───────────────────────
 *  - It matches STRINGS. A page may reference an endpoint and never render the
 *    component that calls it; this guard cannot tell. Same limitation as
 *    `identity-table-boundary` (imports) and `vault-boundary`.
 *  - It covers ONE instance-class: a route with no caller. It would NOT have
 *    caught finding #4 (a column with no writer) or #6 (a live result covering
 *    a narrower endpoint than assumed). The judgment parts of the standing
 *    check stay human.
 *  - It proves reachability, never correctness.
 */

/**
 * Mounted paths whose terminus is deliberately NOT the web app. Each needs a
 * reason — an allowlist entry without one is how a real gap gets normalised.
 */
const NON_UI_SURFACES: Record<string, string> = {
  "/healthz":
    "Infrastructure liveness probe. Its consumers are the deployment platform and uptime monitoring, never the product UI.",
};

/**
 * 🔴 KNOWN GAPS — routes that ARE user-facing and have no UI. Debt, not
 * exemptions, and kept deliberately separate from `NON_UI_SURFACES` so the two
 * can never be confused: an entry here is an admission, not a justification.
 *
 * The guard's contract is **no NEW unreachable route**, plus a list that
 * shrinks. Adding to it is a visible diff that must carry a reason and a
 * CLAUDE.md entry — which is what stops it becoming the quiet place gaps go.
 *
 * Found by this guard's first run (2026-08-14), i.e. exactly the class the
 * standing check's caller-grep passes.
 */
const KNOWN_UNREACHABLE: Record<string, string> = {
  // "/period-locks" — CLOSED by M18.4. The Finance Hub (`/finance-hub`) is its
  // first UI: a tenant can now close and reopen a month from the product. Left
  // as a comment rather than deleted so the entry's history is visible: it sat
  // here from the guard's creation until the capability got a surface.
  "/audit-logs":
    "The admin-only audit trail has no reader UI. Every business mutation is recorded (M7) and is claimed as available to org admins; today reaching it requires calling the API by hand.",
  "/llm":
    "The LLM proposal surface (status/categorize/compare/demo) has no UI. It writes nothing to the ledger by design, so this is inert rather than risky — but the AI layer is parked (hub decision §4), and this route should either gain a consumer when it unparks or be deleted.",
};

/** Repo layout, resolved from this file so the test is location-independent. */
const API_SRC = join(__dirname, "..");
const REPO_ROOT = join(API_SRC, "..", "..", "..");
const WEB_SRC = join(REPO_ROOT, "apps", "web", "src");
const GENERATED_CLIENT = join(
  REPO_ROOT,
  "packages",
  "api-client-react",
  "src",
  "generated",
  "api.ts",
);

function readAll(dir: string, exts: string[]): string {
  let out = "";
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules" && entry !== "generated") out += readAll(full, exts);
      continue;
    }
    if (exts.some((e) => entry.endsWith(e))) out += readFileSync(full, "utf8") + "\n";
  }
  return out;
}

describe("the standing check, mechanized — every mounted route has a terminus", () => {
  it("🔴 no route is mounted without a UI surface, a scheduled job, or a stated reason", () => {
    const routerSrc = readFileSync(join(API_SRC, "routes", "index.ts"), "utf8");
    const mounted = [...routerSrc.matchAll(/router\.use\(\s*["'](\/[a-z0-9/-]*)["']/gi)]
      .map((m) => m[1])
      .filter((p) => p !== "/");

    expect(mounted.length, "no mounts parsed — the regex has drifted from routes/index.ts").toBeGreaterThan(10);

    // Everything the web app says, minus its own generated output.
    const webSrc = readAll(WEB_SRC, [".ts", ".tsx"]);

    // Generated client: map each operation stem to the URL it requests, so a
    // page that calls `useListTransactions()` counts as reaching /transactions
    // without naming the path literally.
    const clientSrc = readFileSync(GENERATED_CLIENT, "utf8");
    const stemsByUrl: Array<{ stem: string; url: string }> = [];
    for (const m of clientSrc.matchAll(/export const get(\w+)Url\s*=[\s\S]*?`(\/api\/[^`?]*)`/g)) {
      stemsByUrl.push({ stem: m[1], url: m[2] });
    }
    expect(stemsByUrl.length, "no URL builders parsed — the generated client's shape has changed").toBeGreaterThan(10);

    const reachableFromWeb = (path: string): boolean => {
      // (a) named directly, as apiFetch("/x") / `/x/${id}` / "/x?…"
      for (const quote of ['"', "'", "`"]) {
        if (webSrc.includes(`${quote}${path}`)) return true;
      }
      // (b) reached through a generated hook the web app actually imports
      return stemsByUrl.some(
        ({ stem, url }) =>
          (url === `/api${path}` || url.startsWith(`/api${path}/`) || url.startsWith(`/api${path}?`)) &&
          new RegExp(`\\b(use)?${stem}\\b`).test(webSrc),
      );
    };

    const unreachable = mounted.filter(
      (p) => !(p in NON_UI_SURFACES) && !(p in KNOWN_UNREACHABLE) && !reachableFromWeb(p),
    );

    const explanation =
      unreachable.length === 0
        ? ""
        : [
            "",
            "═══════════════════════════════════════════════════════════════════",
            "  MOUNTED ROUTES THAT NOTHING CAN REACH",
            "═══════════════════════════════════════════════════════════════════",
            "",
            ...unreachable.map((p) => `  ✗ ${p}`),
            "",
            "WHAT THIS MEANS",
            "  These endpoints are mounted, permission-gated and probably tested —",
            "  and no part of the product calls them. That is the failure mode this",
            "  repository has now hit nine times: a complete, green backend whose",
            "  only callers live in test files. The standing check's caller-grep",
            "  passes for exactly this shape, which is why the check is mechanized",
            "  here instead of being trusted.",
            "",
            "HOW TO FIX IT (in order of preference)",
            "  1. Build the UI surface. If the feature is for users, it is not done",
            "     until a user can reach it — ship it in the SAME milestone, the way",
            "     M10.6 shipped the approvals worklist.",
            "  2. If the endpoint is genuinely not user-facing (an infrastructure",
            "     probe, a machine-to-machine surface), add it to NON_UI_SURFACES",
            "     in this file WITH A REASON.",
            "  3. If nothing should call it, delete it. An endpoint kept 'for later'",
            "     is a claim the next engineer will believe.",
            "",
            "  🔴 Do NOT add an allowlist entry to make the build green. The entry",
            "  is a design decision that outlives you; the reason string is what",
            "  makes it reviewable.",
            "",
          ].join("\n");

    expect(unreachable, explanation).toEqual([]);
  });

  it("every allowlisted non-UI surface is still mounted — no stale exemptions", () => {
    const routerSrc = readFileSync(join(API_SRC, "routes", "index.ts"), "utf8");
    const stale = Object.keys(NON_UI_SURFACES).filter(
      (p) => !new RegExp(`router\\.use\\(\\s*["']${p}["']`).test(routerSrc),
    );
    expect(stale, "these paths are allowlisted but no longer mounted — delete the entries").toEqual([]);
  });

  it("every allowlist and known-gap entry states a reason", () => {
    const missing = [...Object.entries(NON_UI_SURFACES), ...Object.entries(KNOWN_UNREACHABLE)]
      .filter(([, reason]) => !reason || reason.trim().length < 20)
      .map(([p]) => p);
    expect(missing, "an exemption without a real reason is how a gap gets normalised").toEqual([]);
  });

  it("🔴 the known-gap list only shrinks — a fixed route must leave it", () => {
    // Prevents the list becoming a parking space: once a gap has a UI, its
    // entry is stale and must be deleted, or the next real gap hides behind it.
    const routerSrc = readFileSync(join(API_SRC, "routes", "index.ts"), "utf8");
    const webSrc = readAll(WEB_SRC, [".ts", ".tsx"]);
    const nowReachable = Object.keys(KNOWN_UNREACHABLE).filter(
      (p) =>
        new RegExp(`router\\.use\\(\\s*["']${p}["']`).test(routerSrc) &&
        ['"', "'", "`"].some((q) => webSrc.includes(`${q}${p}`)),
    );
    expect(
      nowReachable,
      "these routes now have a UI — remove them from KNOWN_UNREACHABLE and from CLAUDE.md's gap list",
    ).toEqual([]);
  });
});

/**
 * THE INVERSE GUARD — every URL the web app CALLS must hit a mounted route.
 *
 * ── 🔴 WHY THIS EXISTS: the mirror gap the first guard could not see ────────
 * The guard above proves every mounted route has a UI. It says nothing about
 * the reverse, and that reverse shipped a CRITICAL: the 2026-08-19 audit found
 * six pages whose Save button toasted "saved" and POSTed nothing to routes
 * that never existed (`/purchase-orders`, `/vendor-receipts`, …), plus six
 * report pages fetching `/reports/gl`, `/reports/expenses`, … — none mounted —
 * with the 404 hidden by `.catch(() => [])`. A user was told a false
 * statement; the data evaporated. The route-vs-UI guard is blind to it because
 * the routes were never mounted in the first place: there was nothing for it
 * to flag.
 *
 * This guard closes the mirror: it extracts every hand-written `apiFetch(...)`
 * URL in the web app and asserts each resolves to a mounted API route.
 *
 * ── Its limits, stated plainly ─────────────────────────────────────────────
 *  - It matches `apiFetch("/literal")` and template PREFIXES
 *    (`` `/invoices/${id}/pay` `` → `/invoices/`). A URL built entirely from a
 *    variable (`apiFetch(url)`) is invisible — same string-matching limit as
 *    every boundary guard here.
 *  - It proves the FIRST path segment(s) map to a mount, not that the exact
 *    sub-path exists inside that router — except under `/reports/*`, where the
 *    C1 defect lived, which it checks at the second segment exactly.
 *  - It proves a route is reachable, never that it behaves.
 */

/** Web-called paths that are deliberately NOT backed yet. Each needs a reason. */
/**
 * 🔴 EMPTY, and that is the milestone's result rather than an oversight.
 *
 * This held `/quotations` and `/purchase-orders` — two pages that rendered a
 * form, showed a success toast and persisted nothing, against API routes that
 * did not exist. M21.1 built the first and M21.3 the second, and each entry
 * was DELETED as part of that stage's definition of done rather than reworded.
 *
 * Keeping it empty is the point: the guard below fails the moment any page
 * calls an unmounted route, and an empty allowlist means there is no parking
 * space to add one to. If a genuine future exception appears, it belongs here
 * WITH a reason and a named owner — not as a bare path.
 */
const KNOWN_UNBACKED: Record<string, string> = {};

describe("the inverse guard — every URL the web calls hits a mounted route", () => {
  it("🔴 no page calls an API route that is not mounted", () => {
    const robustMount = /router\.use\(\s*["'](\/[a-z0-9/-]+)["']/gi;

    const indexSrc = readFileSync(join(API_SRC, "routes", "index.ts"), "utf8");
    const topMounts = [...indexSrc.matchAll(robustMount)].map((m) => m[1]).filter((p) => p !== "/");
    expect(topMounts.length, "no top-level mounts parsed — regex drifted").toBeGreaterThan(10);

    const reportsSrc = readFileSync(join(API_SRC, "routes", "reports", "index.ts"), "utf8");
    const reportsSub = new Set(
      [...reportsSrc.matchAll(robustMount)].map((m) => `/reports${m[1]}`),
    );
    expect(reportsSub.size, "no reports sub-mounts parsed — regex drifted").toBeGreaterThan(10);

    // A web-called path is backed if it lives under /reports and names a real
    // sub-route, or (otherwise) starts with a mounted top-level prefix. The
    // /reports hub itself (`/reports` exactly) is fine; `/reports/<unknown>` is
    // NOT — that is precisely the C1 defect (`/reports/gl`).
    const backed = (path: string): boolean => {
      const segs = path.split("/").filter(Boolean);
      if (segs[0] === "reports") {
        return segs.length === 1 || reportsSub.has(`/reports/${segs[1]}`);
      }
      return topMounts.some((m) => path === m || path.startsWith(`${m}/`));
    };

    const webSrc = readAll(WEB_SRC, [".ts", ".tsx"]);
    // Capture the static leading path of every apiFetch call, stopping at the
    // first query, interpolation, or closing quote.
    const called = new Set<string>();
    for (const m of webSrc.matchAll(/apiFetch(?:<[^>]*>)?\(\s*[`"'](\/[a-zA-Z0-9/_-]*)/g)) {
      let p = m[1].replace(/\/$/, "");
      if (p) called.add(p);
    }
    expect(called.size, "no apiFetch calls parsed — the call shape changed").toBeGreaterThan(15);

    const unbacked = [...called]
      .filter((p) => !backed(p))
      .filter((p) => !(p in KNOWN_UNBACKED));

    const explanation =
      unbacked.length === 0
        ? ""
        : [
            "",
            "═══════════════════════════════════════════════════════════════════",
            "  WEB CALLS TO ROUTES THAT ARE NOT MOUNTED",
            "═══════════════════════════════════════════════════════════════════",
            "",
            ...unbacked.map((p) => `  ✗ apiFetch("${p}...")  → no such API route`),
            "",
            "WHAT THIS MEANS",
            "  A page fetches (or POSTs to) an endpoint the backend does not serve.",
            "  On a GET, `.catch(() => [])` renders it as an empty list; on a POST,",
            "  a page may toast 'saved' and persist nothing. Either way the user is",
            "  told something false. This is the CRITICAL the 2026-08-19 audit found.",
            "",
            "HOW TO FIX IT (in order of preference)",
            "  1. Fix the path if the route exists under another name (the C1 report",
            "     pages called /reports/gl when the route is /reports/general-ledger).",
            "  2. Build the route if the feature is real and just missing its backend.",
            "  3. Delete the page if nothing should serve it — a Save button that lies",
            "     is worse than a missing feature.",
            "  4. Only if it is a genuinely-held future feature, add it to",
            "     KNOWN_UNBACKED WITH A REASON (and a plan to resolve it).",
            "",
          ].join("\n");

    expect(unbacked, explanation).toEqual([]);
  });

  it("every KNOWN_UNBACKED entry states a reason, and is still called by the web", () => {
    const webSrc = readAll(WEB_SRC, [".ts", ".tsx"]);
    const noReason = Object.entries(KNOWN_UNBACKED)
      .filter(([, r]) => !r || r.trim().length < 20)
      .map(([p]) => p);
    expect(noReason, "a held path without a real reason is how a gap gets normalised").toEqual([]);
    // Stale-exemption guard: if the page was deleted, its entry must go too.
    const stale = Object.keys(KNOWN_UNBACKED).filter(
      (p) => !['"', "'", "`"].some((q) => webSrc.includes(`${q}${p}`)),
    );
    expect(stale, "these held paths are no longer called by any page — delete the entries").toEqual([]);
  });
});
