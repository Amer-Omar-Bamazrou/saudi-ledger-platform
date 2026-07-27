import { pgTable, uuid, varchar, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

/**
 * Organization memberships — the M:N join that makes a user part of an
 * organization and defines their role there. The same user can be an admin in
 * one organization and a viewer in another, so the tenant role lives here (not
 * on `users`). `resolveTenant` (later milestone) validates membership.
 *
 * Added in Milestone 2 (additive).
 */
export const organizationMembershipsTable = pgTable(
  "organization_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    role: varchar("role", { length: 50 }).notNull(), // admin | accountant | viewer
    status: varchar("status", { length: 50 }).notNull().default("active"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("organization_memberships_user_org_unq").on(t.userId, t.organizationId)],
);

export const insertOrganizationMembershipSchema = createInsertSchema(
  organizationMembershipsTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertOrganizationMembership = z.infer<typeof insertOrganizationMembershipSchema>;
export type OrganizationMembership = typeof organizationMembershipsTable.$inferSelect;
