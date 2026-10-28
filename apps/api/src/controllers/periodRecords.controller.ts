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
  // Phase 18 G2a (decisions 9–12; A5(a)): errors found in a filed return, their route, and the entries recorded after a filing.
  async vatCorrections(_req: Request, res: Response) {
    res.json(await periodRecordsService.vatCorrections());
  },
  async recordVatCorrection(req: Request, res: Response) {
    res.status(201).json(await periodRecordsService.recordVatCorrection((req.body ?? {}) as Record<string, unknown>, req.session?.userId ?? null));
  },
  async entriesAfterFiling(_req: Request, res: Response) {
    res.json(await periodRecordsService.entriesAfterFiling());
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
