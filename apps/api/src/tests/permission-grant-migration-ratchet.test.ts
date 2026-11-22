import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 🔴 Phase 19B S0 (control 19B-S0; D10, owner 2026-11-21) — MIGRATIONS DO NOT WRITE THE `permissions` TABLE.
 *
 * `PERMISSION_MATRIX` (packages/db/src/permissions.ts) is the one definition of the grants, and the reconcile command
 * (packages/db/src/permissionReconcile.ts) is the one writer that makes the table agree with it — recorded, and with the
 * owner's approval for any removal. A migration that inserts or deletes a grant is a second, unrecorded writer whose
 * effect differs by environment (it runs once, on whatever the table held).
 *
 * The seven migrations below wrote grants before S0 and stay as they are (a committed migration is never edited); the
 * list can only SHRINK. Any other migration writing `permissions` fails here: change the matrix instead, and reconcile.
 */
const PINNED_BEFORE_S0 = [
  "0077_batch_1c_migration_foundation.sql",
  "0110_phase13b_s1_opening_payable_vat.sql",
  "0113_phase16_saudi_tax.sql",
  "0114_phase17_treasury.sql",
  "0115_phase16_17_hardening.sql",
  "0154_dr14_control_flags.sql",
  "0155_dr20_posting_authority.sql",
];

/** A statement that writes the `permissions` table (any schema-qualified or quoted spelling), comments removed first. */
const WRITES_PERMISSIONS = /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE|TRUNCATE(?:\s+TABLE)?|COPY)\s+(?:ONLY\s+)?(?:"?public"?\.)?"?permissions"?(?=[\s(;,]|$)/gi;
const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
const writesPermissions = (sql: string) => (stripComments(sql).match(WRITES_PERMISSIONS) ?? []).length > 0;

describe("19B S0 — migrations do not write the permissions table", () => {
  it("the detector sees every spelling of a grant write, and not a neighbouring table or a comment", () => {
    for (const s of [
      `INSERT INTO "permissions" (role, resource, action) VALUES ('admin','x','read');`,
      "insert into permissions(role, resource, action) values ('admin','x','read');",
      `DELETE FROM public.permissions WHERE role = 'viewer';`,
      `UPDATE "public"."permissions" SET action = 'read';`,
      "TRUNCATE TABLE permissions;",
    ]) expect(writesPermissions(s), s).toBe(true);
    for (const s of [
      "INSERT INTO permission_reconciliations (kind) VALUES ('apply');",
      "SELECT 1 FROM permissions p WHERE p.role = 'admin';",
      "-- INSERT INTO permissions (role) VALUES ('admin')",
      "/* DELETE FROM permissions */ SELECT 1;",
    ]) expect(writesPermissions(s), s).toBe(false);
  });

  it("🔴 no migration writes permissions except the seven pinned before S0 — and each pinned one still does (the list only shrinks)", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "db", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(files.length, "the migrations directory was found").toBeGreaterThan(160);
    const writers = files.filter((f) => writesPermissions(readFileSync(join(dir, f), "utf8"))).sort();
    expect(writers).toEqual([...PINNED_BEFORE_S0].sort());
  });
});
