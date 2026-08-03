import { pgTable, uuid, varchar, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

/**
 * Organization invitations (M11.7) — how an approved organization adds its team.
 *
 * SECURITY NOTES (this table backs a PUBLIC, token-authenticated accept endpoint
 * that can create a user AND a membership — the exact shape of the M11.5.1
 * self-grantable-privilege bug, so the invariants are deliberate):
 *   - `token_hash` stores ONLY the SHA-256 of the token. The raw 32-byte token
 *     exists solely in the invite link; a database leak cannot yield usable
 *     invites.
 *   - `role` is the ORGANIZATION-MEMBERSHIP role being offered (admin |
 *     accountant | bookkeeper | viewer) — never a global/platform privilege.
 *     Accepting writes a non-privileged global `users.role`.
 *   - `expires_at` + `status` are re-checked inside the accepting UPDATE, so a
 *     revoked/expired/already-accepted invite cannot be redeemed in a race.
 *
 * Owner-only identity-layer table (no RLS, no app-role grants): the /orgs
 * invitation endpoints and the public accept endpoint all run on the base
 * connection before `resolveTenant`.
 */
export const INVITATION_STATUSES = ["pending", "accepted", "revoked", "expired"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const organizationInvitationsTable = pgTable(
  "organization_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    /** Always stored lower-cased so matching is case-insensitive. */
    email: varchar("email", { length: 320 }).notNull(),
    /** The membership role offered — NOT a global privilege. */
    role: varchar("role", { length: 50 }).notNull(),
    /** SHA-256 of the raw token; the raw value is never persisted. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    invitedByUserId: integer("invited_by_user_id").references(() => usersTable.id),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    acceptedUserId: integer("accepted_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("organization_invitations_org_idx").on(t.organizationId),
    index("organization_invitations_email_idx").on(t.email),
  ],
);

export const insertOrganizationInvitationSchema = createInsertSchema(
  organizationInvitationsTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertOrganizationInvitation = typeof organizationInvitationsTable.$inferInsert;
export type OrganizationInvitation = typeof organizationInvitationsTable.$inferSelect;
