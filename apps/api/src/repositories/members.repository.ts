/**
 * Members repository — organization-membership data access (M10.6).
 *
 * IMPORTANT: `organization_memberships` is global-reference data (NOT RLS-scoped;
 * the app role has SELECT-only). These operations run on the BASE (owner)
 * connection, before any tenant scoping — the same identity/infrastructure layer
 * as the org switcher. Every query is explicitly scoped by `organizationId`;
 * there is no RLS backstop here, so callers MUST authorize first (see the service).
 */
import { db, ownerDb, organizationMembershipsTable, usersTable } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";

export const membersRepository = {
  /** The user's active membership role in an org, or null if not an active member. */
  async activeRole(userId: number, orgId: string): Promise<string | null> {
    const [m] = await db
      .select({ role: organizationMembershipsTable.role })
      .from(organizationMembershipsTable)
      .where(
        and(
          eq(organizationMembershipsTable.userId, userId),
          eq(organizationMembershipsTable.organizationId, orgId),
          eq(organizationMembershipsTable.status, "active"),
        ),
      )
      .limit(1);
    return m?.role ?? null;
  },

  /**
   * Email addresses of an org's ACTIVE ADMINS — the recipients for
   * platform-generated alerts about that organization (B1).
   *
   * 🔴 Lives here, in the identity layer, deliberately. The renewal job needs
   * "who should hear about this company's certificate", which is a membership
   * question, and `organization_memberships` / `users` are the three tables
   * OUTSIDE RLS that business-layer code must never touch (M-1). The job calls
   * this instead of joining them itself, so the boundary guard stays true and
   * the query stays where the scoping discipline is.
   *
   * Admins only: renewal requires an OTP from the tenant's own Fatoora portal
   * and a fresh CSR, which is an admin action. Inactive members and deactivated
   * users are excluded — mailing a removed employee about a certificate is both
   * useless and a small data leak.
   */
  async activeAdminEmails(orgId: string): Promise<string[]> {
    // `ownerDb`, not `db`: the only caller is a BACKGROUND JOB, which has no
    // request context for the tenant proxy to resolve. Stating the connection
    // beats relying on the proxy's no-context fallback.
    const rows = await ownerDb
      .select({ email: usersTable.email })
      .from(organizationMembershipsTable)
      .innerJoin(usersTable, eq(organizationMembershipsTable.userId, usersTable.id))
      .where(
        and(
          eq(organizationMembershipsTable.organizationId, orgId),
          eq(organizationMembershipsTable.role, "admin"),
          eq(organizationMembershipsTable.status, "active"),
          eq(usersTable.isActive, true),
        ),
      );
    return rows.map((r) => r.email);
  },

  /** Count active admins in an org (to refuse orphaning the last one). */
  async activeAdminCount(orgId: string): Promise<number> {
    const rows = await db
      .select({ id: organizationMembershipsTable.id })
      .from(organizationMembershipsTable)
      .where(
        and(
          eq(organizationMembershipsTable.organizationId, orgId),
          eq(organizationMembershipsTable.role, "admin"),
          eq(organizationMembershipsTable.status, "active"),
        ),
      );
    return rows.length;
  },

  /** List all memberships of an org, joined to user identity. */
  listMembers(orgId: string) {
    return db
      .select({
        userId: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        isActive: usersTable.isActive,
        role: organizationMembershipsTable.role,
        status: organizationMembershipsTable.status,
      })
      .from(organizationMembershipsTable)
      .innerJoin(usersTable, eq(usersTable.id, organizationMembershipsTable.userId))
      .where(eq(organizationMembershipsTable.organizationId, orgId))
      .orderBy(asc(usersTable.name));
  },

  async userExists(userId: number): Promise<boolean> {
    const [u] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    return !!u;
  },

  findMembership(userId: number, orgId: string) {
    return db
      .select({ role: organizationMembershipsTable.role, status: organizationMembershipsTable.status })
      .from(organizationMembershipsTable)
      .where(
        and(
          eq(organizationMembershipsTable.userId, userId),
          eq(organizationMembershipsTable.organizationId, orgId),
        ),
      )
      .limit(1);
  },

  /** Insert or re-activate a membership (idempotent on the unique (user, org)). */
  upsert(userId: number, orgId: string, role: string) {
    return db
      .insert(organizationMembershipsTable)
      .values({ userId, organizationId: orgId, role, status: "active" })
      .onConflictDoUpdate({
        target: [organizationMembershipsTable.userId, organizationMembershipsTable.organizationId],
        set: { role, status: "active" },
      })
      .returning();
  },

  update(userId: number, orgId: string, values: Partial<typeof organizationMembershipsTable.$inferInsert>) {
    return db
      .update(organizationMembershipsTable)
      .set(values)
      .where(
        and(
          eq(organizationMembershipsTable.userId, userId),
          eq(organizationMembershipsTable.organizationId, orgId),
        ),
      )
      .returning();
  },
};
