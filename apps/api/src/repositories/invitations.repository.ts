/**
 * Invitations repository (M11.7).
 *
 * Identity/infrastructure layer, BASE (owner) connection, before `resolveTenant`
 * — the public accept endpoint has no session and no tenant. There is no RLS
 * backstop, so callers MUST authorize first (the service does), and every query
 * here is explicitly scoped by organization or by token hash.
 */
import {
  db,
  organizationInvitationsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { and, desc, eq, gt, sql } from "drizzle-orm";

export const invitationsRepository = {
  /** All invitations for an org, newest first (no token material exposed). */
  listByOrg(orgId: string) {
    return db
      .select({
        id: organizationInvitationsTable.id,
        email: organizationInvitationsTable.email,
        role: organizationInvitationsTable.role,
        status: organizationInvitationsTable.status,
        expiresAt: organizationInvitationsTable.expiresAt,
        acceptedAt: organizationInvitationsTable.acceptedAt,
        createdAt: organizationInvitationsTable.createdAt,
      })
      .from(organizationInvitationsTable)
      .where(eq(organizationInvitationsTable.organizationId, orgId))
      .orderBy(desc(organizationInvitationsTable.createdAt));
  },

  async findPendingByEmail(orgId: string, email: string) {
    const [row] = await db
      .select()
      .from(organizationInvitationsTable)
      .where(
        and(
          eq(organizationInvitationsTable.organizationId, orgId),
          eq(organizationInvitationsTable.email, email),
          eq(organizationInvitationsTable.status, "pending"),
        ),
      )
      .limit(1);
    return row;
  },

  async findInOrg(id: string, orgId: string) {
    const [row] = await db
      .select()
      .from(organizationInvitationsTable)
      .where(
        and(
          eq(organizationInvitationsTable.id, id),
          eq(organizationInvitationsTable.organizationId, orgId),
        ),
      )
      .limit(1);
    return row;
  },

  /**
   * Look an invitation up by TOKEN HASH, joined to its organization so the
   * caller can check the org's verification status without a second query.
   * Returns the row regardless of status/expiry — the service decides, and the
   * accepting UPDATE re-checks atomically.
   */
  async findByTokenHash(tokenHash: string) {
    const [row] = await db
      .select({
        id: organizationInvitationsTable.id,
        organizationId: organizationInvitationsTable.organizationId,
        email: organizationInvitationsTable.email,
        role: organizationInvitationsTable.role,
        status: organizationInvitationsTable.status,
        expiresAt: organizationInvitationsTable.expiresAt,
        organizationName: organizationsTable.name,
        verificationStatus: organizationsTable.verificationStatus,
      })
      .from(organizationInvitationsTable)
      .innerJoin(
        organizationsTable,
        eq(organizationsTable.id, organizationInvitationsTable.organizationId),
      )
      .where(eq(organizationInvitationsTable.tokenHash, tokenHash))
      .limit(1);
    return row;
  },

  insert(values: typeof organizationInvitationsTable.$inferInsert) {
    return db.insert(organizationInvitationsTable).values(values).returning();
  },

  /** Re-issue the token + expiry of a pending invitation (resend). */
  reissue(id: string, tokenHash: string, expiresAt: Date) {
    return db
      .update(organizationInvitationsTable)
      .set({ tokenHash, expiresAt, updatedAt: new Date() })
      .where(
        and(
          eq(organizationInvitationsTable.id, id),
          eq(organizationInvitationsTable.status, "pending"),
        ),
      )
      .returning({ id: organizationInvitationsTable.id });
  },

  /** Revoke a PENDING invitation. Zero rows ⇒ it was not pending. */
  revoke(id: string, orgId: string) {
    return db
      .update(organizationInvitationsTable)
      .set({ status: "revoked", updatedAt: new Date() })
      .where(
        and(
          eq(organizationInvitationsTable.id, id),
          eq(organizationInvitationsTable.organizationId, orgId),
          eq(organizationInvitationsTable.status, "pending"),
        ),
      )
      .returning({ id: organizationInvitationsTable.id });
  },

  /**
   * ATOMICALLY claim an invitation: pending AND unexpired → accepted. Zero rows
   * means it was already accepted/revoked/expired or lost a race, so a token can
   * never be redeemed twice (no duplicate memberships).
   */
  claim(id: string, acceptedUserId: number) {
    return db
      .update(organizationInvitationsTable)
      .set({
        status: "accepted",
        acceptedAt: new Date(),
        acceptedUserId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(organizationInvitationsTable.id, id),
          eq(organizationInvitationsTable.status, "pending"),
          gt(organizationInvitationsTable.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: organizationInvitationsTable.id });
  },

  async findUserByEmail(email: string) {
    const [row] = await db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    return row;
  },
};
