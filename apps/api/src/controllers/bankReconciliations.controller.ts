import type { Request, Response } from "express";
import {
  CompleteBankReconciliationBody, ReopenBankReconciliationBody,
  GetBankReconciliationPositionQueryParams, ListBankReconciliationsQueryParams,
} from "@workspace/api-zod";
import { bankReconciliationsService } from "../services/accounting/bankReconciliations.service";
import { requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

const userOf = (req: Request) => req.session?.userId ?? null;

/**
 * Phase 12D — completed reconciliations, their terms, the exceptions, and the
 * cash position. Thin: the identity, the zero-difference rule and the lock
 * belong to the service and the database.
 */
export const bankReconciliationsController = {
  async list(req: Request, res: Response) {
    const q = ListBankReconciliationsQueryParams.safeParse(req.query);
    if (!q.success) throw new BadRequestError(q.error.message);
    res.json(await bankReconciliationsService.list(q.data));
  },
  async position(req: Request, res: Response) {
    const q = GetBankReconciliationPositionQueryParams.safeParse(req.query);
    if (!q.success) throw new BadRequestError(q.error.message);
    res.json(await bankReconciliationsService.position(q.data));
  },
  async exceptions(_req: Request, res: Response) {
    res.json(await bankReconciliationsService.exceptions());
  },
  async get(req: Request, res: Response) {
    res.json(await bankReconciliationsService.get(requireIdParam(req)));
  },
  async complete(req: Request, res: Response) {
    const body = CompleteBankReconciliationBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    res.json(await bankReconciliationsService.complete(body.data, userOf(req)));
  },
  async reopen(req: Request, res: Response) {
    const body = ReopenBankReconciliationBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    res.json(await bankReconciliationsService.reopen(requireIdParam(req), body.data, userOf(req)));
  },
  async cashPosition(_req: Request, res: Response) {
    res.json(await bankReconciliationsService.cashPosition());
  },
};
