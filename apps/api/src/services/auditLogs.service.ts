/** Audit logs read service — lists the current org's audit trail (RLS-scoped). */
import { auditLogsRepository, type AuditLogFilter } from "../repositories/auditLogs.repository";

export const auditLogsService = {
  async list(filter: AuditLogFilter) {
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const [rows, countResult] = await Promise.all([
      auditLogsRepository.list({ ...filter, limit, offset }),
      auditLogsRepository.count(filter),
    ]);
    return {
      total: countResult[0]?.count ?? 0,
      limit,
      offset,
      logs: rows.map((r) => ({
        id: r.id,
        organizationId: r.organizationId,
        userId: r.userId,
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
