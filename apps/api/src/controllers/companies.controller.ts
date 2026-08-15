import type { Request, Response } from "express";
import { UpdateCurrentCompanyBody } from "@workspace/api-zod";
import { BadRequestError } from "../lib/errors";
import { companiesService } from "../services/companies.service";

export const companiesController = {
  async getCurrent(_req: Request, res: Response) {
    res.json(await companiesService.getCurrent());
  },

  async fiscalYears(_req: Request, res: Response) {
    res.json(await companiesService.fiscalYears());
  },

  async updateCurrent(req: Request, res: Response) {
    const body = UpdateCurrentCompanyBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    res.json(await companiesService.updateCurrent(body.data));
  },
};
