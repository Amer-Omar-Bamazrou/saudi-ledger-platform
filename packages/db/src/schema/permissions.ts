import { pgTable, uuid, varchar, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Permissions — the role → (resource, action) map that RBAC guards check.
 * Roles map to permissions so roles can evolve without touching every route.
 * A global reference table (not tenant-scoped) that seeds the RBAC model.
 *
 * Added in Milestone 2 (additive). Enforcement lands in a later milestone.
 */
export const permissionsTable = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    role: varchar("role", { length: 50 }).notNull(),
    resource: varchar("resource", { length: 100 }).notNull(), // e.g. 'journal_entries', 'reports'
    action: varchar("action", { length: 50 }).notNull(), // read | create | update | delete
  },
  (t) => [unique("permissions_role_resource_action_unq").on(t.role, t.resource, t.action)],
);

export const insertPermissionSchema = createInsertSchema(permissionsTable).omit({ id: true });

export type InsertPermission = z.infer<typeof insertPermissionSchema>;
export type Permission = typeof permissionsTable.$inferSelect;
