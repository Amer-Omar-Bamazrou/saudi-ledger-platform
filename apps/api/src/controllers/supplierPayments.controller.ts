import type { Request, Response } from "express";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { requireIdParam } from "../lib/httpParams";

const userOf = (req: Request) => req.session?.userId ?? null;

/**
 * B3/B4 — the AP subledger's HTTP surface. Thin by design: every refusal, every
 * derived figure and every journal entry belongs to the service, which is the
 * one place the accounting is stated.
 */
export const supplierPaymentsController = {
  async list(req: Request, res: Response) {
    const q = req.query as Record<string, string | undefined>;
    res.json(await supplierPaymentsService.list({
      vendorId: q.vendorId ? Number(q.vendorId) : undefined,
      classification: q.classification || undefined,
    }));
  },
  async get(req: Request, res: Response) {
    res.json(await supplierPaymentsService.getById(requireIdParam(req)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await supplierPaymentsService.create(req.body ?? {}, userOf(req)));
  },
  async allocate(req: Request, res: Response) {
    res.json(await supplierPaymentsService.allocate(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
  async classify(req: Request, res: Response) {
    res.json(await supplierPaymentsService.classify(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
  async refund(req: Request, res: Response) {
    res.json(await supplierPaymentsService.refund(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
  async reverseAllocation(req: Request, res: Response) {
    res.json(await supplierPaymentsService.reverseAllocation(requireIdParam(req), req.body ?? {}, userOf(req)));
  },
};
