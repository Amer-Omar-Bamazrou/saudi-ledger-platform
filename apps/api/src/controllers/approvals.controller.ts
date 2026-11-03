import type { Request, Response } from "express";
import { approvalsQueueService } from "../services/approvalsQueue.service";

export const approvalsController = {
  async pending(req: Request, res: Response) {
    // DR-18: the caller's role scopes the queue to what it may approve; the caller's id flags their own items
    res.json(await approvalsQueueService.pending(req.tenant?.role ?? "", req.session?.userId ?? null));
  },
};
