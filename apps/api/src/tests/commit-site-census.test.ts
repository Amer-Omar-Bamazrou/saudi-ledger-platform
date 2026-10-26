/**
 * 🔴 THE CENSUS OF EVERY PLACE THAT COMMITS (B-O6-PRE item (v), Phase 18).
 *
 * B-O6 will make the tenant seam refuse a COMMIT whose tag says ROLLBACK
 * (`LazyTenantClient.finish("COMMIT")`, packages/db): a transaction that a
 * caught statement error aborted will no longer "succeed" in silence. Every
 * caller of `beginTenantConnection().commit()` then sees a throw where it saw
 * nothing, so each one is pinned here with what reaches it and what it does
 * with that throw.
 *
 * 🔴 TWO OTHER SHAPES ARE NOT COVERED BY THAT SEAM AT ALL: a drizzle
 * `.transaction()` takes its own pooled client and sends COMMIT without
 * reading the tag, and a raw `query("COMMIT")` does the same. They are safe
 * only while nothing inside them catches a statement error and carries on;
 * that is what each entry below records (as read on main 161a2138, from a
 * sweep of all 155 catch sites in the API, the db package and scripts/src).
 *
 * The census is exact in BOTH directions: a new site fails until someone
 * classifies it, and a removed site fails until its entry goes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");
const ROOTS = ["apps/api/src", "packages/db/src", "scripts/src"];

type Counts = { beginTenantConnection: number; transaction: number; rawCommit: number };
type Site = Counts & { reaches: string; ifCommitThrows: string };

const tenant = (n: number, reaches: string, ifCommitThrows: string): Site => ({ beginTenantConnection: n, transaction: 0, rawCommit: 0, reaches, ifCommitThrows });
const drizzleTx = (n: number, reaches: string): Site => ({
  beginTenantConnection: 0,
  transaction: n,
  rawCommit: 0,
  reaches,
  ifCommitThrows: "ownerDb, its own client; nothing inside catches and carries on; drizzle rolls back and rethrows (a route answers 500)",
});
const rawCommit = (n: number, reaches: string, ifCommitThrows: string): Site => ({ beginTenantConnection: 0, transaction: 0, rawCommit: n, reaches, ifCommitThrows });

const SITES: Record<string, Site> = {
  // ── beginTenantConnection().commit(): B-O6's seam covers these ───────────
  "apps/api/src/lib/tenant.ts": tenant(1, "every business route (resolveTenant)", "settled before the first byte (lib/responseCommit.ts): a known refusal is its own 4xx, anything else 500 commit_failed and a page"),
  "apps/api/src/scripts/backfillTransferPostings.ts": tenant(1, "CLI", "logged as rolled back, next org; postMany's items each have a savepoint (B-O6-PRE)"),
  "apps/api/src/scripts/benchmark/benchmarkCategorizer.ts": tenant(1, "CLI (benchmark)", "counted as a failed case; the meter row has its own savepoint (B-O6-PRE)"),
  "apps/api/src/scripts/benchmark/benchmarkVision.ts": tenant(1, "CLI (benchmark)", "counted as a failed case; the meter row has its own savepoint (B-O6-PRE)"),
  "apps/api/src/scripts/cashCutover.ts": tenant(1, "CLI", "recorded as an error, exit 2; nothing inside catches"),
  "apps/api/src/scripts/seedSampleData.ts": tenant(1, "CLI seed", "rethrown, exit 1; nothing inside catches"),
  "apps/api/src/services/findings.explain.service.ts": tenant(1, "scheduled-findings job; findings.controller after its response", "the pass gives up or counts `unavailable`; nothing inside catches"),
  "apps/api/src/services/findings.schedule.service.ts": tenant(2, "scheduled-findings job (hourly)", "`failed` += 1; the (org, period) claim is already committed, so that period is not retried; nothing inside catches"),
  "apps/api/src/services/recurring/generation.service.ts": tenant(1, "recurring-documents job (daily)", "rolled back, the run recorded `generation_failed`; nothing inside catches"),
  "apps/api/src/services/demo/demoSeed.service.ts": {
    beginTenantConnection: 1,
    transaction: 1,
    rawCommit: 0,
    reaches: "DEMO_MODE boot and the demo reset job",
    ifCommitThrows: "boot logs seeding failed, or the reset run is recorded failed; the .transaction() is ownerDb; nothing inside either catches",
  },
  // ── drizzle .transaction(): NOT covered by B-O6's seam ───────────────────
  "apps/api/src/repositories/invitations.repository.ts": drizzleTx(1, "POST /invitations/:token/accept"),
  "apps/api/src/repositories/members.repository.ts": drizzleTx(1, "withLastAdminGuard: the org member routes and account deactivation"),
  "apps/api/src/repositories/signup.repository.ts": drizzleTx(1, "POST /auth/signup"),
  "apps/api/src/repositories/userAdmin.repository.ts": drizzleTx(1, "POST /auth/register"),
  "apps/api/src/services/einvoice/signing/vault.repository.ts": drizzleTx(1, "ZATCA onboarding and renewal (commits apart from the request)"),
  "packages/db/src/seed.ts": drizzleTx(3, "CLI seed"),
  // ── raw COMMIT: NOT covered by B-O6's seam (except the seam itself) ──────
  "packages/db/src/index.ts": rawCommit(1, "`finish(\"COMMIT\")`: THE seam B-O6 changes", "rethrown to the caller (see tenant.ts above)"),
  "apps/api/src/services/demo/demoReset.service.ts": rawCommit(1, "demo reset job (DEMO_MODE)", "ROLLBACK, the run recorded failed; nothing inside catches"),
  "scripts/src/demo-seed.mts": rawCommit(2, "CLI demo seed", "the first reaches main().catch; the second rolls back and rethrows; nothing inside catches"),
};

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (["tests", "generated", "node_modules", "__tests__"].includes(name)) continue;
      walk(p, acc);
    } else if (/\.(ts|mts)$/.test(name) && !name.endsWith(".test.ts")) acc.push(p);
  }
  return acc;
}

// Comments are stripped so a sentence naming a call is not counted as one.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

function census(): Record<string, Counts> {
  const out: Record<string, Counts> = {};
  for (const file of ROOTS.flatMap((r) => walk(join(REPO, r)))) {
    const src = strip(readFileSync(file, "utf8"));
    const c: Counts = {
      // A call with an argument; not the declaration, not `beginTenantConnection().run()` in a message.
      beginTenantConnection: count(src, /(?<!function )\bbeginTenantConnection\(\s*[^)\s]/g),
      transaction: count(src, /\.transaction\(/g),
      // Any call handed the literal COMMIT (`query("COMMIT")`, a local `w("COMMIT")`), or sql`COMMIT`.
      rawCommit: count(src, /\(\s*["'`]\s*COMMIT\s*;?\s*["'`]\s*\)/gi) + count(src, /sql`\s*COMMIT\b/gi),
    };
    if (c.beginTenantConnection + c.transaction + c.rawCommit > 0) out[file.slice(REPO.length + 1).split("\\").join("/")] = c;
  }
  return out;
}

describe("🔴 every place that commits is in the census, with what reaches it", () => {
  const found = census();

  it("the sweep is not vacuous: it reads the request seam and a script", () => {
    expect(found["apps/api/src/lib/tenant.ts"]?.beginTenantConnection).toBe(1);
    expect(found["scripts/src/demo-seed.mts"]?.rawCommit).toBe(2);
  });

  it("🔴 the sites found are exactly the sites pinned, in both directions", () => {
    const pinned = Object.fromEntries(
      Object.entries(SITES).map(([file, { beginTenantConnection, transaction, rawCommit: raw }]) => [file, { beginTenantConnection, transaction, rawCommit: raw }]),
    );
    expect(found, "a new commit site needs an entry above (what reaches it; what it does when COMMIT throws); a removed one leaves").toEqual(pinned);
  });

  it("every entry says what reaches it and what happens when its COMMIT throws", () => {
    for (const [file, site] of Object.entries(SITES)) {
      expect(site.reaches.length > 0 && site.ifCommitThrows.length > 0, file).toBe(true);
    }
  });
});
