import type { Request, Response } from "express";
import { journalEntriesService } from "../services/journalEntries.service";
import { requireIdParam } from "../lib/httpParams";

export const journalEntriesController = {
  async list(req: Request, res: Response) {
    const { status } = req.query as Record<string, string>;
    res.json(await journalEntriesService.list(status));
  },
  async get(req: Request, res: Response) {
    res.json(await journalEntriesService.getById(requireIdParam(req)));
  },
  async create(req: Request, res: Response) {
    const out = await journalEntriesService.create(req.body, req.session?.userId ?? null);
    res.status(201).json(out);
  },
  async approve(req: Request, res: Response) {
    res.json(await journalEntriesService.approve(requireIdParam(req), req.session?.userId ?? null));
  },
  async post(req: Request, res: Response) {
    res.json(await journalEntriesService.post(requireIdParam(req), req.session?.userId ?? null));
  },
  async reject(req: Request, res: Response) {
    await journalEntriesService.reject(requireIdParam(req), req.session?.userId ?? null);
    res.status(204).send();
  },
  async reverse(req: Request, res: Response) {
    res.json(await journalEntriesService.reverse(requireIdParam(req)));
  },
  async remove(req: Request, res: Response) {
    await journalEntriesService.deleteDraft(requireIdParam(req));
    res.status(204).send();
  },
};
