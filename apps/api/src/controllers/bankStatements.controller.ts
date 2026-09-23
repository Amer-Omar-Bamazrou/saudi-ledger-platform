import type { Request, Response } from "express";
import { bankStatementsService } from "../services/accounting/bankStatements.service";
import { requireIdParam } from "../lib/httpParams";

/** Phase 12A — imported bank statements (reads only; statements are created by the upload). */
export const bankStatementsController = {
  async list(req: Request, res: Response) {
    const q = req.query as Record<string, string | undefined>;
    res.json(await bankStatementsService.list(q.bankAccountId ? Number(q.bankAccountId) : undefined));
  },
  async get(req: Request, res: Response) {
    res.json(await bankStatementsService.get(requireIdParam(req)));
  },
};
