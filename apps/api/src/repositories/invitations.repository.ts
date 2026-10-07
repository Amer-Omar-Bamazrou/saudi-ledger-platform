/**
 * Invitations repository (M11.7).
 *
 * Identity/infrastructure layer, BASE (owner) connection, before `resolveTenant`
 * — the public accept endpoint has no session and no tenant. There is no RLS
 * backstop, so callers MUST authorize first (the service does), and every query
 * here is explicitly scoped by organization or by token hash.
 */
// 🔴 The OWNER connection, named deliberately rather than inherited.
// `organization_invitations` is an owner-only table — `ownerDb`'s own doc comment already listed it, and this file was reaching it through the proxy's silent fallback.
// The `db` proxy now REFUSES a query outside a tenant transaction rather than
// falling back here silently, so this import states what was previously assumed.
import { ownerDb as db, organizationInvitationsTable, organizationMembershipsTable, organizationsTable, usersTable } from "@workspace/db";
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
  claim(id: string, acceptedUserId: number, tx: Pick<typeof db, "update"> = db) {
    return tx
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

  /**
   * 🔴 G04 zero-membership (2026-10-07): ACCEPTANCE IS ATOMIC — the account
   * (when the person has none), the claim and the membership commit together
   * or not at all. It used to be three independent writes: a claim that lost
   * its race, or a membership write that failed, left a brand-new account
   * with NO membership behind (proven), which every tenant admin could then
   * treat as theirs. Returns null when the invitation was no longer claimable
   * (accepted, revoked, expired, or a concurrent acceptance won) — nothing is
   * written then either.
   */
  async acceptAtomically(input: {
    invitationId: string;
    organizationId: string;
    role: string;
    account: { userId: number } | { email: string; name: string; passwordHash: string };
  }): Promise<{ userId: number; name: string } | null> {
    const notClaimable = Symbol("not-claimable");
    try {
      return await db.transaction(async (tx) => {
        let user: { id: number; name: string };
        if ("userId" in input.account) {
          const [u] = await tx.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(eq(usersTable.id, input.account.userId)).limit(1);
          user = u!;
        } else {
          // Invariant 1 (see the service): the global role is NON-privileged; authority is the membership below.
          const [u] = await tx
            .insert(usersTable)
            .values({ email: input.account.email, name: input.account.name, passwordHash: input.account.passwordHash, role: "viewer", isActive: true })
            .returning({ id: usersTable.id, name: usersTable.name });
          user = u!;
        }
        const [claimed] = await this.claim(input.invitationId, user.id, tx);
        if (!claimed) throw notClaimable;
        await tx
          .insert(organizationMembershipsTable)
          .values({ userId: user.id, organizationId: input.organizationId, role: input.role, status: "active" })
          .onConflictDoUpdate({
            target: [organizationMembershipsTable.userId, organizationMembershipsTable.organizationId],
            set: { role: input.role, status: "active" },
          });
        return { userId: user.id, name: user.name };
      });
    } catch (err) {
      if (err === notClaimable) return null;
      throw err;
    }
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
