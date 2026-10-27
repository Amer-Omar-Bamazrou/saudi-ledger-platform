import type { Request, Response } from "express";
import { periodRecordsService } from "../services/periodRecords.service";

/** 🔴 T1e (DR-10): the period records — append-only (record and read; nothing changes or deletes one). */
export const periodRecordsController = {
  async vatFilings(_req: Request, res: Response) {
    res.json(await periodRecordsService.vatFilings());
  },
  async recordVatFiling(req: Request, res: Response) {
    res.status(201).json(await periodRecordsService.recordVatFiling((req.body ?? {}) as Record<string, unknown>, req.session?.userId ?? null));
  },
  async zakatIncomeTaxFilings(_req: Request, res: Response) {
    res.json(await periodRecordsService.zakatIncomeTaxFilings());
  },
  async recordZakatIncomeTaxFiling(req: Request, res: Response) {
    res.status(201).json(await periodRecordsService.recordZakatIncomeTaxFiling((req.body ?? {}) as Record<string, unknown>, req.session?.userId ?? null));
  },
  async authorisations(_req: Request, res: Response) {
    res.json(await periodRecordsService.authorisations());
  },
  async recordAuthorisation(req: Request, res: Response) {
    res.status(201).json(await periodRecordsService.recordAuthorisation((req.body ?? {}) as Record<string, unknown>, req.session?.userId ?? null));
  },
};
