/**
 * 🔴 RLS COVERAGE — every tenant table carries the isolation policy.
 *
 * ── Why this exists (audit 2026-08-20, the auditor's OWN stated blind spot) ──
 * The authz audit verified that the app OPENS an RLS-scoped, non-owner
 * transaction and that no request path uses the owner connection. It could not
 * verify the other half: that each business table actually HAS the
 * `tenant_isolation` policy and a NOT NULL `organization_id`. A table missing
 * its policy leaks across tenants **despite perfectly correct application
 * code**, and nothing proved it did not — the single largest gap the audit
 * declared about itself.
 *
 * This guard closes it by asking Postgres, not the migrations: for every table
 * in `public` that carries an `organization_id`, RLS must be ENABLED, a policy
 * must EXIST, and the column must be NOT NULL — unless the table is one of the
 * explicitly-listed identity/ops exceptions below, each with a reason and a
 * statement of what defends it instead.
 *
 * It is deliberately DATA-DRIVEN (information_schema + pg_catalog), so a table
 * added in a future migration is covered without editing this file — the
 * org-seed-trigger test's posture, applied to tenancy.
 */
import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[rls-coverage] no real DATABASE_URL — skipping.");

/**
 * Tables carrying `organization_id` that are deliberately OUTSIDE RLS.
 *
 * 🔴 Each entry must say what defends the data instead. "It's fine" is not a
 * reason — the point of the list is that the alternative defence is named and
 * reviewable. Adding to it is a visible diff.
 */
const OUTSIDE_RLS: Record<string, string> = {
  organization_memberships:
    "IDENTITY LAYER (CLAUDE.md §4). Read pre-resolveTenant on the owner connection to DECIDE the tenant — it cannot itself be tenant-scoped without a circular dependency. Defended by: the identity-table boundary test (business-layer imports are refused) plus explicit per-caller authz (assertOrgAdmin / requireAdminScope).",
  organization_invitations:
    "IDENTITY LAYER. An invitation is consumed by a user who is not yet a member, so no tenant context exists at read time (the token is the credential). Defended by: single-use hashed token + expiry, and every management query filtering the caller's own org.",
  verification_documents:
    "ONBOARDING, pre-verification. Read by platform OPERATORS (who hold no membership, so RLS would return nothing for them) and by the applying org before its gate opens. Defended by: every query explicitly filtering `organizationId` (documents.repository.ts states this in its header) + operator authz.",
  verification_reviews:
    "ONBOARDING, operator-side. Same reason as verification_documents: the reviewer is a platform operator with no tenant context.",
  security_audit_logs:
    "SECURITY AUDIT. Records events that occur OUTSIDE a tenant transaction (failed logins, cross-org denials) — `organization_id` is nullable precisely because a security event may have no tenant. Defended by: `readForOrg` filtering the caller's org, and the platform-operator gate on the global view.",
  feature_flags:
    "🔴 UNUSED SHAPE — S6/S7 trap in CLAUDE.md: the table has NO consumer at all (no repository, no service reads it). It is on the drop-or-build list; if it EVER gains a reader, it must gain RLS in the same change. Defended by: nothing, because nothing uses it.",
};

describeMaybe("RLS coverage — a tenant table cannot be added without its isolation policy", () => {
  it("🔴 every table with organization_id has RLS enabled and a policy", async () => {
    const { rows } = await pool.query<{
      table_name: string;
      rls_on: boolean;
      policies: string;
      org_nullable: string;
    }>(`
      SELECT c.relname AS table_name,
             c.relrowsecurity AS rls_on,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies,
             (SELECT col.is_nullable FROM information_schema.columns col
               WHERE col.table_name = c.relname AND col.column_name = 'organization_id') AS org_nullable
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM information_schema.columns col
                      WHERE col.table_name = c.relname AND col.column_name = 'organization_id')
       ORDER BY c.relname
    `);

    // Vacuity guard: if the query returns nothing, the schema shape changed and
    // this test would pass while proving nothing (the 0-vs-0 pattern).
    expect(rows.length, "no org-scoped tables found — the catalog query has drifted").toBeGreaterThan(20);

    const unprotected = rows
      .filter((r) => !(r.table_name in OUTSIDE_RLS))
      .filter((r) => !r.rls_on || Number(r.policies) === 0)
      .map((r) => `${r.table_name} (rls=${r.rls_on}, policies=${r.policies})`);

    expect(
      unprotected,
      [
        "",
        "═══════════════════════════════════════════════════════════════════",
        "  TENANT TABLES WITHOUT ROW-LEVEL SECURITY",
        "═══════════════════════════════════════════════════════════════════",
        "",
        ...unprotected.map((t) => `  ✗ ${t}`),
        "",
        "These tables carry organization_id but Postgres is not enforcing",
        "isolation on them. Every tenant's rows are visible to every other",
        "tenant's session — regardless of how correct the application code is,",
        "and invisible to any app-layer review.",
        "",
        "FIX: add to the migration —",
        '  ALTER TABLE "x" ENABLE ROW LEVEL SECURITY;',
        '  CREATE POLICY "tenant_isolation" ON "x"',
        "    USING (organization_id::text = current_setting('app.current_org_id', true))",
        "    WITH CHECK (organization_id::text = current_setting('app.current_org_id', true));",
        "",
        "Only if the table is genuinely identity/ops-layer, add it to",
        "OUTSIDE_RLS in this file WITH the defence that replaces RLS.",
        "",
      ].join("\n"),
    ).toEqual([]);
  });

  it("🔴 organization_id is NOT NULL on every RLS-protected table", async () => {
    // A nullable organization_id defeats the policy: a NULL never equals the
    // GUC, so such a row belongs to no tenant and is invisible to everyone —
    // or, worse, is written by a path that forgot the column and then can
    // never be read back.
    const { rows } = await pool.query<{ table_name: string; org_nullable: string }>(`
      SELECT c.relname AS table_name, col.is_nullable AS org_nullable
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN information_schema.columns col
          ON col.table_name = c.relname AND col.column_name = 'organization_id'
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
       ORDER BY c.relname
    `);
    const nullable = rows.filter((r) => r.org_nullable === "YES").map((r) => r.table_name);
    expect(nullable, "these RLS tables allow a NULL organization_id — a row belonging to no tenant").toEqual([]);
  });

  it("every OUTSIDE_RLS entry states its alternative defence, and still exists", async () => {
    const thin = Object.entries(OUTSIDE_RLS)
      .filter(([, reason]) => !reason || reason.trim().length < 40)
      .map(([t]) => t);
    expect(thin, "an exemption without a stated defence is how a leak gets normalised").toEqual([]);

    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    const present = new Set(rows.map((r) => r.table_name));
    const stale = Object.keys(OUTSIDE_RLS).filter((t) => !present.has(t));
    expect(stale, "these exempted tables no longer exist — delete the entries").toEqual([]);
  });

  it("🔴 the policy actually FILTERS by the tenant GUC (not a permissive true)", async () => {
    // A policy that exists but says `USING (true)` is worse than none: it looks
    // protected in every catalog check and isolates nothing.
    const { rows } = await pool.query<{ table_name: string; qual: string | null }>(`
      SELECT c.relname AS table_name, pg_get_expr(p.polqual, p.polrelid) AS qual
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
    `);
    expect(rows.length, "no policies found — the catalog query has drifted").toBeGreaterThan(20);
    const permissive = rows
      .filter((r) => !r.qual || !r.qual.includes("app.current_org_id"))
      .map((r) => `${r.table_name}: ${r.qual ?? "(no qualifier)"}`);
    expect(permissive, "these policies do not reference the tenant GUC — they isolate nothing").toEqual([]);
  });
});
