import type { Request, Response } from "express";
import { approvalsQueueService } from "../services/approvalsQueue.service";

export const approvalsController = {
  async pending(req: Request, res: Response) {
    res.json(await approvalsQueueService.pending(req.tenant?.role ?? ""));
  },
};
