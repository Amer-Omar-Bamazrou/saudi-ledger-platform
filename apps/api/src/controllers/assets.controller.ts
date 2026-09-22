import type { Request, Response } from "express";
import { assetsService } from "../services/assets.service";
import { pageParams, requireIdParam } from "../lib/httpParams";

const userOf = (req: Request) => req.session?.userId ?? null;

export const assetsController = {
  // ── categories ──
  async listCategories(req: Request, res: Response) {
    res.json(await assetsService.listCategories(req.query.includeInactive === "true"));
  },
  async createCategory(req: Request, res: Response) {
    res.status(201).json(await assetsService.createCategory(req.body ?? {}, userOf(req)));
  },
  async updateCategory(req: Request, res: Response) {
    res.json(await assetsService.updateCategory(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
  // ── assets ──
  async list(req: Request, res: Response) {
    const q = req.query as Record<string, string | undefined>;
    const categoryId = q.category_id ? Number(q.category_id) : undefined;
    res.json(await assetsService.list(pageParams(req.query as Record<string, unknown>), { status: q.status || undefined, categoryId: Number.isInteger(categoryId) ? categoryId : undefined }));
  },
  async get(req: Request, res: Response) {
    res.json(await assetsService.getById(requireIdParam(req)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await assetsService.create(req.body ?? {}, userOf(req)));
  },
  async update(req: Request, res: Response) {
    res.json(await assetsService.update(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
  async cancel(req: Request, res: Response) {
    res.json(await assetsService.cancel(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
};
