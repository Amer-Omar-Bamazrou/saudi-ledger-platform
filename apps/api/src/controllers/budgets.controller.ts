import type { Request, Response } from "express";
import { budgetsService } from "../services/budgets.service";
import { requireIdParam } from "../lib/httpParams";

export const budgetsController = {
  async list(req: Request, res: Response) {
    const { period } = req.query as Record<string, string>;
    res.json(await budgetsService.list(period));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await budgetsService.create(req.body));
  },
  async update(req: Request, res: Response) {
    res.json(await budgetsService.update(requireIdParam(req), req.body));
  },
  async remove(req: Request, res: Response) {
    await budgetsService.remove(requireIdParam(req));
    res.status(204).send();
  },
};
