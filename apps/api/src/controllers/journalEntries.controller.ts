import type { Request, Response } from "express";
import { journalEntriesService } from "../services/journalEntries.service";

export const journalEntriesController = {
  async list(req: Request, res: Response) {
    const { status } = req.query as Record<string, string>;
    res.json(await journalEntriesService.list(status));
  },
  async get(req: Request, res: Response) {
    res.json(await journalEntriesService.getById(Number(req.params.id)));
  },
  async create(req: Request, res: Response) {
    const out = await journalEntriesService.create(req.body, req.session?.userId ?? null);
    res.status(201).json(out);
  },
  async post(req: Request, res: Response) {
    res.json(await journalEntriesService.post(Number(req.params.id)));
  },
  async reverse(req: Request, res: Response) {
    res.json(await journalEntriesService.reverse(Number(req.params.id)));
  },
  async remove(req: Request, res: Response) {
    await journalEntriesService.remove(Number(req.params.id));
    res.status(204).send();
  },
};
