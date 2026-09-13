/**
 * User-administration repository (M11.5.1 security hotfix).
 *
 * Data access for the `/auth/users*` surface, which used to be guarded ONLY by
 * the ambient GLOBAL session role (`requireAdmin`) and queried the `users` table
 * with NO organization filter — so any admin could enumerate and reset the
 * password of ANY user on the platform, across tenants.
 *
 * Every query here is explicitly scoped to the organizations the ACTOR
 * administers. Like the members repository this is identity/infrastructure data
 * on the BASE (owner) connection, read BEFORE `resolveTenant`, so there is no RLS
 * backstop — callers MUST authorize first (the service does).
 */
// 🔴 The OWNER connection, named deliberately rather than inherited.
// Identity layer: `users`, `organizations` and `organization_memberships` are OUTSIDE RLS (§4).
// The `db` proxy now REFUSES a query outside a tenant transaction instead of
// silently falling back to this connection.
import { ownerDb as db, organizationMembershipsTable, organizationsTable, usersTable, platformOperatorsTable } from "@workspace/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

export const userAdminRepository = {
  /**
   * §5 rank-1 break-glass (2026-09-04) — the identity data access for
   * `operatorService.resetUserPassword`, HERE because the business layer must
   * not import identity tables (`identity-table-boundary.test.ts` — which is
   * exactly the guard that sent this code here). Callers authorize first.
   */
  async isPlatformOperator(userId: number): Promise<boolean> {
    const [row] = await db
      .select({ id: platformOperatorsTable.id })
      .from(platformOperatorsTable)
      .where(eq(platformOperatorsTable.userId, userId))
      .limit(1);
    return !!row;
  },
  async setPasswordHash(userId: number, passwordHash: string): Promise<void> {
    await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, userId));
  },
  /** Kills every live session of the user; returns how many died. */
  async revokeSessions(userId: number): Promise<number> {
    const res = await db.execute(sql`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int = ${userId}`);
    return res.rowCount ?? 0;
  },

  /**
   * The organizations in which `userId` is an ACTIVE admin AND which are
   * verification-`approved`.
   *
   * The approved-only requirement matters: `/auth/*` is mounted before
   * `resolveTenant`, so the M11.2 verification gate does NOT cover it. Without
   * this filter a brand-new, unverified self-signup would still administer its
   * own org and could therefore mint global user accounts — letting an
   * unreviewed party squat arbitrary emails (a denial-of-registration) before
   * anyone has vetted them. An org that cannot yet use the platform has no
   * business provisioning team accounts.
   */
  async administeredOrgIds(userId: number): Promise<string[]> {
    const rows = await db
      .select({ organizationId: organizationMembershipsTable.organizationId })
      .from(organizationMembershipsTable)
      .innerJoin(
        organizationsTable,
        eq(organizationsTable.id, organizationMembershipsTable.organizationId),
      )
      .where(
        and(
          eq(organizationMembershipsTable.userId, userId),
          eq(organizationMembershipsTable.role, "admin"),
          eq(organizationMembershipsTable.status, "active"),
          eq(organizationsTable.verificationStatus, "approved"),
        ),
      );
    return rows.map((r) => r.organizationId);
  },

  /**
   * Users who hold a membership in ANY of `orgIds` — i.e. the actor's own
   * teams, never the whole platform. De-duplicated (a user may belong to
   * several of the actor's orgs).
   */
  async listUsersInOrgs(orgIds: string[]) {
    if (orgIds.length === 0) return [];
    const rows = await db
      .selectDistinct({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        role: usersTable.role,
        isActive: usersTable.isActive,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .innerJoin(
        organizationMembershipsTable,
        eq(organizationMembershipsTable.userId, usersTable.id),
      )
      .where(inArray(organizationMembershipsTable.organizationId, orgIds))
      .orderBy(asc(usersTable.createdAt));
    return rows;
  },

  /** True when `targetUserId` is a member of at least one of `orgIds`. */
  async isMemberOfAny(targetUserId: number, orgIds: string[]): Promise<boolean> {
    if (orgIds.length === 0) return false;
    const [row] = await db
      .select({ id: organizationMembershipsTable.id })
      .from(organizationMembershipsTable)
      .where(
        and(
          eq(organizationMembershipsTable.userId, targetUserId),
          inArray(organizationMembershipsTable.organizationId, orgIds),
        ),
      )
      .limit(1);
    return !!row;
  },

  async findById(userId: number) {
    const [row] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    return row;
  },

  async findByEmail(email: string) {
    // Widened from {id} to the full row for the rank-1 break-glass (existing
    // callers read only .id — compatible).
    const [row] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    return row;
  },

  insert(values: typeof usersTable.$inferInsert) {
    return db.insert(usersTable).values(values).returning();
  },

  update(userId: number, values: Partial<typeof usersTable.$inferInsert>) {
    return db.update(usersTable).set(values).where(eq(usersTable.id, userId)).returning();
  },
};
