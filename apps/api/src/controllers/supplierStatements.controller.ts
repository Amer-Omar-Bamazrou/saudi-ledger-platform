import type { Request, Response } from "express";
import { supplierStatementService } from "../services/accounting/supplierStatement.service";
import { supplierCreditNotesService } from "../services/accounting/supplierCreditNotes.service";
import { requireIdParam } from "../lib/httpParams";

const userOf = (req: Request) => req.session?.userId ?? null;

/** B5 — supplier positions and statements. */
export const supplierStatementsController = {
  async list(req: Request, res: Response) {
    const q = req.query as Record<string, string | undefined>;
    res.json(await supplierStatementService.positions(q.vendorId ? Number(q.vendorId) : undefined));
  },
  async statement(req: Request, res: Response) {
    const q = req.query as Record<string, string | undefined>;
    res.json(await supplierStatementService.statement(requireIdParam(req, "vendorId"), { from: q.from || undefined, to: q.to || undefined }));
  },
};

/** B7 — purchase-side notes. Creation is the BILL path; this is what a note does after. */
export const supplierCreditNotesController = {
  async list(req: Request, res: Response) {
    const q = req.query as Record<string, string | undefined>;
    res.json(await supplierCreditNotesService.list({ vendorId: q.vendorId ? Number(q.vendorId) : undefined }));
  },
  async get(req: Request, res: Response) {
    res.json(await supplierCreditNotesService.getById(requireIdParam(req)));
  },
  async apply(req: Request, res: Response) {
    res.json(await supplierCreditNotesService.apply(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
};
