import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * M14 (A3) — the business layer must not read the identity tables.
 *
 * ── 🔴 WHY THIS GUARD EXISTS: RLS DOES NOT PROTECT THESE THREE ─────────────
 * `organizations`, `users` and `organization_memberships` are deliberately
 * OUTSIDE row-level security (`0003_rls_policies.sql`) and are granted plain
 * SELECT to the app role (`0004_m4_rls_enforcement.sql`).
 *
 * For every other business table, forgetting a tenant filter is survivable —
 * RLS catches it. **Here nothing catches it.** A service that joins
 * `organizationsTable` to put the org name on an invoice PDF returns EVERY
 * organization's row, silently, with no error and no failing test. That is a
 * cross-tenant leak introduced by ordinary-looking code.
 *
 * ── Why a build guard rather than adding RLS (M14 decision) ────────────────
 * Adding policies to these tables was the alternative and was rejected:
 *
 *   1. **They would be exercised by no traffic.** Every legitimate consumer is
 *      in the identity layer and runs on the owner/base connection, which
 *      BYPASSES RLS. A policy nothing exercises is an untested security control,
 *      and it would first be exercised by the exact mistake it exists to
 *      prevent — under production conditions rather than in CI.
 *   2. **`users` cannot take the standard policy.** It has no
 *      `organization_id`, so `tenant_isolation` does not apply; it would need a
 *      membership subquery, which is real design work on the login and
 *      user-administration paths, against a hypothetical.
 *
 * This guard instead fails the build the moment the mistake is written.
 *
 * ── Its limit, stated plainly ──────────────────────────────────────────────
 * It matches IMPORTS. A raw `pool.query("SELECT ... FROM users")` inside a
 * service would slip past — the same limitation `vault-boundary` has. It raises
 * the cost of the mistake; it does not make it impossible.
 */

/**
 * The identity layer: everything that legitimately reads these tables. All of it
 * runs BEFORE `resolveTenant` on the base/owner connection, and each does its
 * own explicit authorization (admin-of-THIS-org, platform operator, or the
 * session user).
 */
const IDENTITY_LAYER = [
  join("lib", "tenant.ts"),
  join("routes", "auth.ts"),
  join("routes", "orgs.ts"),
  join("repositories", "members.repository.ts"),
  join("repositories", "invitations.repository.ts"),
  join("repositories", "onboarding.repository.ts"),
  join("repositories", "signup.repository.ts"),
  join("repositories", "userAdmin.repository.ts"),
  join("repositories", "verification.repository.ts"),
  // Cross-tenant BY DESIGN, operator-only, and reads via `ownerDb`. It returns
  // operational metadata (onboarding state, certificate expiry) and never a
  // tenant's financial data — the M11.3 boundary.
  join("services", "operatorZatca.service.ts"),
];

const FORBIDDEN = ["organizationsTable", "usersTable", "organizationMembershipsTable"];

describe("M14 — identity tables are off-limits to the business layer", () => {
  it("🔴 no business-layer file imports organizations / users / organization_memberships", () => {
    const root = join(__dirname, "..");
    const offenders: { file: string; tables: string[] }[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== "node_modules") walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;

        const rel = full.slice(root.length + 1);
        if (rel.startsWith(`tests${sep}`)) continue; // fixtures set up tenants on purpose
        if (IDENTITY_LAYER.some((allowed) => rel === allowed)) continue;

        const src = readFileSync(full, "utf8");
        const hits = FORBIDDEN.filter((t) => new RegExp(`\\b${t}\\b`).test(src));
        if (hits.length > 0) offenders.push({ file: rel, tables: hits });
      }
    };
    walk(root);

    // 🔴 The failure message must EXPLAIN, not merely refuse. A bare "forbidden"
    // invites someone with a legitimate need to conclude the rule is overzealous
    // and route around it — which is worse than no rule, because it happens
    // quietly.
    const explanation =
      offenders.length === 0
        ? ""
        : [
            "",
            "═══════════════════════════════════════════════════════════════════",
            "  BUSINESS-LAYER CODE MUST NOT READ THE IDENTITY TABLES",
            "═══════════════════════════════════════════════════════════════════",
            "",
            ...offenders.map((o) => `  ✗ ${o.file}  →  ${o.tables.join(", ")}`),
            "",
            "WHY THIS IS BLOCKED",
            "  `organizations`, `users` and `organization_memberships` are the only",
            "  business-reachable tables WITHOUT row-level security. Everywhere else,",
            "  a forgotten tenant filter is caught by RLS. Here it is not: your query",
            "  will silently return EVERY organization's rows, with no error and no",
            "  failing test. That is a cross-tenant data leak.",
            "",
            "WHAT TO DO INSTEAD",
            "  • Need the org/company name or settings for a tenant-scoped feature?",
            "    Use `companiesRepository` — `companies` IS RLS-scoped and is what",
            "    tenant-facing code should read.",
            "  • Need the acting user, their role, or their org?",
            "    It is already resolved: `req.tenant` (userId, organizationId,",
            "    companyId, role) — no query needed.",
            "  • Genuinely doing identity work (membership, invitations, signup,",
            "    verification, user administration)? That belongs in the IDENTITY",
            "    LAYER, which runs before `resolveTenant` on the owner connection and",
            "    does its own explicit authorization. Put the code there and add the",
            "    file to IDENTITY_LAYER in this test.",
            "",
            "IF YOU BELIEVE THE BUSINESS LAYER GENUINELY NEEDS THESE TABLES",
            "  That is a DESIGN DECISION, not a lint exception. It means either the",
            "  feature belongs in the identity layer, or these tables need RLS — which",
            "  was considered and deliberately rejected (see this file's header, and",
            "  CLAUDE.md). Raise it; do not add an allowlist entry to make the build",
            "  green.",
            "═══════════════════════════════════════════════════════════════════",
            "",
          ].join("\n");

    expect(offenders, explanation).toEqual([]);
  });

  it("the allowlist has no stale entries — every listed file still exists and still uses them", () => {
    // An allowlist that outlives its entries slowly becomes a blanket exemption.
    const root = join(__dirname, "..");
    const stale: string[] = [];
    for (const rel of IDENTITY_LAYER) {
      let src: string;
      try {
        src = readFileSync(join(root, rel), "utf8");
      } catch {
        stale.push(`${rel} (file no longer exists)`);
        continue;
      }
      if (!FORBIDDEN.some((t) => new RegExp(`\\b${t}\\b`).test(src))) {
        stale.push(`${rel} (no longer references any identity table — remove it)`);
      }
    }
    expect(stale).toEqual([]);
  });
});
