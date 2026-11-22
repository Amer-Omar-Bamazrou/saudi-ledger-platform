import { pgTable, serial, integer, text, jsonb, timestamp, check, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * 🔴 Phase 19B S0 (D10, owner 2026-11-21) — THE RECORD OF EVERY CHANGE TO THE `permissions` TABLE.
 *
 * `PERMISSION_MATRIX` (../permissions.ts) is the one definition of the grants; the `permissions` table is what the API
 * (lib/rbac.ts) and the database's posting checks (`role_holds_grant`, `org_usable_approver_count`, 0155) both read.
 * The API refuses to start while the two differ, and the only way to make them agree is the explicit reconcile command
 * (../permissionReconcile.ts), which writes one row here per run that changed something — or nothing at all.
 *
 * Each row names who, when, which environment and database, the grants ADDED, and every grant REMOVED **in full**
 * (its id included), so `restore` can put a removal back. A removal is applied only with the owner's approval for that
 * environment and that exact set (`removal_set_hash`). A restore is its own row, pointing at the run it restores.
 *
 * Owner-only (platform infrastructure, like `demo_reset_runs`): no organization, no RLS, the application's role holds
 * nothing (0168 revokes explicitly). Append-only for every role, the owner included (0168's trigger).
 */
export const permissionReconciliationsTable = pgTable(
  "permission_reconciliations",
  {
    id: serial("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /** `apply`: the matrix reconciled; `restore`: the rows a recorded `apply` removed, put back. */
    kind: text("kind").notNull(),
    /** The environment named by whoever ran it (an approval binds to it). */
    environment: text("environment").notNull(),
    /** `current_database()` at the time — the environment as the server knows it. */
    databaseName: text("database_name").notNull(),
    actor: text("actor").notNull(),
    /** `[{ role, resource, action }]` inserted. */
    added: jsonb("added").notNull(),
    /** `[{ id, role, resource, action }]` deleted, in full. */
    removed: jsonb("removed").notNull(),
    /** SHA-256 of the removal set (sorted `role:resource:action` lines); null when nothing was removed. */
    removalSetHash: text("removal_set_hash"),
    /** The approval given for the removal set (`<environment>:<removal_set_hash>`); null when nothing was removed. */
    approval: text("approval"),
    restoresId: integer("restores_id"),
    /** The matrix's row count when it ran. */
    matrixRows: integer("matrix_rows").notNull(),
  },
  (t) => [
    check("permission_reconciliations_kind_chk", sql`${t.kind} IN ('apply', 'restore')`),
    check("permission_reconciliations_restores_chk", sql`(${t.kind} = 'restore') = (${t.restoresId} IS NOT NULL)`),
    check(
      "permission_reconciliations_approval_chk",
      sql`(jsonb_array_length(${t.removed}) > 0 AND ${t.kind} = 'apply') = (${t.approval} IS NOT NULL AND ${t.removalSetHash} IS NOT NULL)`,
    ),
    foreignKey({ columns: [t.restoresId], foreignColumns: [t.id], name: "permission_reconciliations_restores_fk" }),
  ],
);

export type PermissionReconciliation = typeof permissionReconciliationsTable.$inferSelect;
