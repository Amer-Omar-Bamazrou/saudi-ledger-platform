import type { Request, Response } from "express";
import { assetsService } from "../services/assets.service";

export const assetsController = {
  async list(_req: Request, res: Response) {
    res.json(await assetsService.list());
  },
  async get(req: Request, res: Response) {
    res.json(await assetsService.getById(Number(req.params.id)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await assetsService.create(req.body));
  },
  async update(req: Request, res: Response) {
    res.json(await assetsService.update(Number(req.params.id), req.body));
  },
  async depreciate(req: Request, res: Response) {
    const { period } = req.body as { period: string };
    res.json(await assetsService.depreciate(Number(req.params.id), period));
  },
  async remove(req: Request, res: Response) {
    await assetsService.remove(Number(req.params.id));
    res.status(204).send();
  },
};
