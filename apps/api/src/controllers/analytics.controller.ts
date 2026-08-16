import type { Request, Response } from "express";
import { BadRequestError } from "../lib/errors";
import { analyticsService, monthsBetween, type Dimension } from "../services/analytics.service";
import { cashService } from "../services/cash.service";

const MONTH = /^\d{4}-\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DIMENSIONS: Dimension[] = ["category", "customer", "vendor"];

/**
 * Analytics (M19.3). Validated at the edge for a readable 400 — the services
 * behind these assume well-formed periods, and a malformed one would otherwise
 * surface as an empty chart rather than an error, which is the worse failure.
 */
export const analyticsController = {
  async trend(req: Request, res: Response) {
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    if (!MONTH.test(from) || !MONTH.test(to)) {
      throw new BadRequestError("from and to must be YYYY-MM");
    }
    if (from > to) throw new BadRequestError("from must not be after to");
    res.json(await analyticsService.trend(from, to));
  },

  async cash(req: Request, res: Response) {
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    if (!MONTH.test(from) || !MONTH.test(to)) {
      throw new BadRequestError("from and to must be YYYY-MM");
    }
    if (from > to) throw new BadRequestError("from must not be after to");
    const { points, summary } = await cashService.reconciliation(from, to, monthsBetween(from, to));
    res.json({ ...summary, points });
  },

  async receivablesBridge(req: Request, res: Response) {
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    if (!MONTH.test(from) || !MONTH.test(to)) {
      throw new BadRequestError("from and to must be YYYY-MM");
    }
    if (from > to) throw new BadRequestError("from must not be after to");
    res.json(await analyticsService.receivablesBridge(from, to));
  },

  async decomposition(req: Request, res: Response) {
    const dimension = String(req.query.dimension ?? "") as Dimension;
    if (!DIMENSIONS.includes(dimension)) {
      throw new BadRequestError("dimension must be category, customer or vendor");
    }
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    if (!DATE.test(from) || !DATE.test(to)) {
      throw new BadRequestError("from and to must be YYYY-MM-DD");
    }
    if (from > to) throw new BadRequestError("from must not be after to");
    res.json(await analyticsService.decompose(dimension, from, to));
  },
};
