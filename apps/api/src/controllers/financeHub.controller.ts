import type { Request, Response } from "express";
import { financeHubService } from "../services/financeHub.service";

export const financeHubController = {
  async liquidity(req: Request, res: Response) {
    const asOf = typeof req.query.as_of === "string" && req.query.as_of ? req.query.as_of : undefined;
    res.json(await financeHubService.liquidity(asOf));
  },

  async taxCompliance(_req: Request, res: Response) {
    res.json(await financeHubService.taxCompliance());
  },

  async booksStatus(_req: Request, res: Response) {
    res.json(await financeHubService.booksStatus());
  },
};
