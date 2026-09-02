import type { Request, Response } from "express";
import { CreateBudgetBody, UpdateBudgetBody } from "@workspace/api-zod";
import { budgetsService } from "../services/budgets.service";
import { requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

/** Contract batch 5: the declared body constraint is the enforced one. */
function parseOr400<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): T {
  if (result.success) return result.data;
  throw new BadRequestError(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}

export const budgetsController = {
  async list(req: Request, res: Response) {
    const { period } = req.query as Record<string, string>;
    res.json(await budgetsService.list(period));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await budgetsService.create(parseOr400(CreateBudgetBody.safeParse(req.body))));
  },
  async update(req: Request, res: Response) {
    res.json(await budgetsService.update(requireIdParam(req), parseOr400(UpdateBudgetBody.safeParse(req.body))));
  },
  async remove(req: Request, res: Response) {
    await budgetsService.remove(requireIdParam(req));
    res.status(204).send();
  },
};
