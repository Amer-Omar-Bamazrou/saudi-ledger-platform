import type { Request, Response } from "express";
import { recognitionSchedulesService } from "../services/accounting/recognitionSchedules.service";
import { requireIdParam } from "../lib/httpParams";

const userOf = (req: Request) => req.session?.userId ?? null;

export const recognitionSchedulesController = {
  async list(req: Request, res: Response) {
    const q = req.query as Record<string, string | undefined>;
    res.json(await recognitionSchedulesService.list({ kind: q.kind || undefined, status: q.status || undefined }));
  },
  async get(req: Request, res: Response) {
    res.json(await recognitionSchedulesService.getById(requireIdParam(req)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await recognitionSchedulesService.create(req.body ?? {}, userOf(req)));
  },
  async activate(req: Request, res: Response) {
    res.json(await recognitionSchedulesService.activate(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
  async recognise(req: Request, res: Response) {
    res.json(await recognitionSchedulesService.recognise(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
  async cancel(req: Request, res: Response) {
    res.json(await recognitionSchedulesService.cancel(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
  async run(req: Request, res: Response) {
    res.json(await recognitionSchedulesService.runPeriod(req.body ?? {}, userOf(req)));
  },
};
