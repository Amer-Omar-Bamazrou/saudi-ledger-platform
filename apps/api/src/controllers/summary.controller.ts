import type { Request, Response } from "express";
import {
  GetSummaryQueryParams,
  GetVatSummaryQueryParams,
  GetSummaryByCategoryQueryParams,
} from "@workspace/api-zod";
import { BadRequestError } from "../lib/errors";
import { summaryService } from "../services/summary.service";

export const summaryController = {
  async summary(req: Request, res: Response) {
    const params = GetSummaryQueryParams.safeParse(req.query);
    if (!params.success) throw new BadRequestError(params.error.message);
    res.json(await summaryService.getSummary({ dateFrom: params.data.date_from, dateTo: params.data.date_to }));
  },

  async vat(req: Request, res: Response) {
    const params = GetVatSummaryQueryParams.safeParse(req.query);
    if (!params.success) throw new BadRequestError(params.error.message);
    res.json(await summaryService.getVat({ dateFrom: params.data.date_from, dateTo: params.data.date_to }));
  },

  async byCategory(req: Request, res: Response) {
    const params = GetSummaryByCategoryQueryParams.safeParse(req.query);
    if (!params.success) throw new BadRequestError(params.error.message);
    res.json(await summaryService.getByCategory({ dateFrom: params.data.date_from, dateTo: params.data.date_to }));
  },
};
