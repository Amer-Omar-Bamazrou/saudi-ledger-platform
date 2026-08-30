/**
 * Members repository — organization-membership data access (M10.6).
 *
 * IMPORTANT: `organization_memberships` is global-reference data (NOT RLS-scoped;
 * the app role has SELECT-only). These operations run on the BASE (owner)
 * connection, before any tenant scoping — the same identity/infrastructure layer
 * as the org switcher. Every query is explicitly scoped by `organizationId`;
 * there is no RLS backstop here, so callers MUST authorize first (see the service).
 */
// 🔴 The OWNER connection, named deliberately rather than inherited.
// Identity layer: membership and user lookups, which the business layer must never do (§4).
// The `db` proxy now REFUSES a query outside a tenant transaction instead of
// silently falling back to this connection.
import { ownerDb as db, ownerDb, organizationMembershipsTable, usersTable } from "@workspace/db";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";

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
  /**
   * Resolve actor userIds to display names for the AUDIT TRAIL (M23).
   *
   * IDENTITY LAYER, deliberately (CLAUDE.md §4): `users` sits outside RLS and
   * the business layer must never read it — this repository is the sanctioned
   * consumer, same as `activeAdminEmails` above. Scoped to the org's OWN
   * memberships so an audit row can never resolve a name from another tenant:
   * a userId with no membership in this org comes back unresolved and the UI
   * shows "User #<id>", which is honest rather than leaky.
   */
  async memberNamesByIds(orgId: string, userIds: number[]): Promise<Map<number, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await ownerDb
      .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
      .from(organizationMembershipsTable)
      .innerJoin(usersTable, eq(organizationMembershipsTable.userId, usersTable.id))
      .where(
        and(
          eq(organizationMembershipsTable.organizationId, orgId),
          inArray(organizationMembershipsTable.userId, userIds),
        ),
      );
    return new Map(rows.map((r) => [r.id, r.name || r.email]));
  },

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

  /**
   * F1 — the organizations `targetUserId` belongs to that are NOT in `orgIds`.
   *
   * The predicate behind `lib/accountScope.ts`. Deliberately returns the ids
   * rather than a boolean: a caller that must decide how much to disclose needs
   * to know THAT there are foreign memberships, and a boolean invites the
   * "isMemberOfAny" reading that F1 showed is the wrong question.
   *
   * 🔴 Status is NOT filtered. An `inactive` membership is one re-activation
   * away from being access, and that re-activation belongs to the other
   * organization — see the note in accountScope.ts for what the strict reading
   * costs and why it is still the right side to err on.
   */
  async foreignMembershipOrgIds(targetUserId: number, orgIds: string[]): Promise<string[]> {
    const rows = await db
      .select({ organizationId: organizationMembershipsTable.organizationId })
      .from(organizationMembershipsTable)
      .where(
        orgIds.length === 0
          ? eq(organizationMembershipsTable.userId, targetUserId)
          : and(
              eq(organizationMembershipsTable.userId, targetUserId),
              notInArray(organizationMembershipsTable.organizationId, orgIds),
            ),
      );
    return [...new Set(rows.map((r) => r.organizationId))];
  },

  /**
   * Organizations in which `userId` is an ACTIVE ADMIN, whatever the org's
   * verification status.
   *
   * Distinct from `userAdminRepository.administeredOrgIds`, which additionally
   * requires the org to be verification-`approved` because `/auth/*` sits
   * outside the M11.2 gate. Membership management does NOT require approval —
   * an org under review still administers its own members — so narrowing to
   * approved orgs here would refuse an admin the right to re-activate a member
   * of their own pending org. The two sets differ on purpose.
   */
  async administeredOrgIds(userId: number): Promise<string[]> {
    const rows = await db
      .select({ organizationId: organizationMembershipsTable.organizationId })
      .from(organizationMembershipsTable)
      .where(
        and(
          eq(organizationMembershipsTable.userId, userId),
          eq(organizationMembershipsTable.role, "admin"),
          eq(organizationMembershipsTable.status, "active"),
        ),
      );
    return rows.map((r) => r.organizationId);
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
