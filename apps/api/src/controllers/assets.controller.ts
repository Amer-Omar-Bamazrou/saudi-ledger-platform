import type { Request, Response } from "express";
import { assetsService } from "../services/assets.service";
import { pageParams, requireIdParam } from "../lib/httpParams";

export const assetsController = {
  async list(req: Request, res: Response) {
    res.json(await assetsService.list(pageParams(req.query as Record<string, unknown>)));
  },
  async get(req: Request, res: Response) {
    res.json(await assetsService.getById(requireIdParam(req)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await assetsService.create(req.body));
  },
  async update(req: Request, res: Response) {
    res.json(await assetsService.update(requireIdParam(req), req.body));
  },
  async depreciate(req: Request, res: Response) {
    const { period } = req.body as { period: string };
    res.json(await assetsService.depreciate(requireIdParam(req), period));
  },
  async remove(req: Request, res: Response) {
    await assetsService.remove(requireIdParam(req));
    res.status(204).send();
  },
};
