import type { Request, Response } from "express";
import { CreateBankTransferBody, ReverseBankTransferBody, ListBankTransfersQueryParams } from "@workspace/api-zod";
import { bankTransfersService } from "../services/accounting/bankTransfers.service";
import { requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

const userOf = (req: Request) => req.session?.userId ?? null;

/**
 * Phase 12C — thin: the refusals (same bank, closed period, possible
 * duplicate, reconciled-before-reverse) belong to the service, the shape of
 * the entry to the database. Bodies parse through the generated contract.
 */
export const bankTransfersController = {
  async list(req: Request, res: Response) {
    const q = ListBankTransfersQueryParams.safeParse(req.query);
    if (!q.success) throw new BadRequestError(q.error.message);
    res.json(await bankTransfersService.list(q.data));
  },
  async get(req: Request, res: Response) {
    res.json(await bankTransfersService.getById(requireIdParam(req)));
  },
  async create(req: Request, res: Response) {
    const body = CreateBankTransferBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    res.json(await bankTransfersService.create(body.data, userOf(req)));
  },
  async reverse(req: Request, res: Response) {
    const body = ReverseBankTransferBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    res.json(await bankTransfersService.reverse(requireIdParam(req), body.data, userOf(req)));
  },
};
