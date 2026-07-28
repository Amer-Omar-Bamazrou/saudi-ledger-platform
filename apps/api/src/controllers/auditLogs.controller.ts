import type { Request, Response } from "express";
import { auditLogsService } from "../services/auditLogs.service";

const MAX_LIMIT = 200;

export const auditLogsController = {
  async list(req: Request, res: Response) {
    const { entity_type, action, limit, offset } = req.query as Record<string, string>;
    const parsedLimit = limit ? Math.min(Number(limit) || 50, MAX_LIMIT) : 50;
    res.json(
      await auditLogsService.list({
        entityType: entity_type || undefined,
        action: action || undefined,
        limit: parsedLimit,
        offset: offset ? Math.max(Number(offset) || 0, 0) : 0,
      }),
    );
  },
};
