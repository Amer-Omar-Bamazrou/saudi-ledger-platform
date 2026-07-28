import type { Request, Response } from "express";
import { periodLocksService } from "../services/periodLocks.service";

export const periodLocksController = {
  async list(_req: Request, res: Response) {
    res.json(await periodLocksService.list());
  },
  async create(req: Request, res: Response) {
    const { period, notes } = req.body;
    const lock = await periodLocksService.lock({ period, notes, userId: req.session?.userId ?? null });
    res.status(201).json(lock);
  },
  async remove(req: Request, res: Response) {
    await periodLocksService.unlock(String(req.params.period));
    res.status(204).send();
  },
};
