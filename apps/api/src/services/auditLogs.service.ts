/** Audit logs read service — lists the current org's audit trail (RLS-scoped). */
import { auditLogsRepository, type AuditLogFilter } from "../repositories/auditLogs.repository";
import { membersRepository } from "../repositories/members.repository";

export const auditLogsService = {
  /**
   * @param organizationId the ACTIVE org, passed by the controller from the
   *   resolved tenant. Needed only for actor-name resolution, which goes
   *   through the identity layer (`membersRepository.memberNamesByIds` — the
   *   sanctioned consumer of the outside-RLS `users` table, CLAUDE.md §4).
   *   The log rows themselves are RLS-scoped as before.
   */
  async list(filter: AuditLogFilter, organizationId: string) {
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const [rows, countResult] = await Promise.all([
      auditLogsRepository.list({ ...filter, limit, offset }),
      auditLogsRepository.count(filter),
    ]);

    // An audit trail's point is WHO did WHAT. A userId with no membership in
    // this org resolves to nothing and the UI shows "User #<id>" — honest,
    // never a cross-tenant name.
    const actorIds = [...new Set(rows.map((r) => r.userId).filter((x): x is number => x != null))];
    const names = await membersRepository.memberNamesByIds(organizationId, actorIds);

    return {
      total: countResult[0]?.count ?? 0,
      limit,
      offset,
      logs: rows.map((r) => ({
        id: r.id,
        organizationId: r.organizationId,
        userId: r.userId,
        actorName: r.userId != null ? (names.get(r.userId) ?? null) : null,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        beforeState: r.beforeState,
        afterState: r.afterState,
        ipAddress: r.ipAddress,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  },
};
