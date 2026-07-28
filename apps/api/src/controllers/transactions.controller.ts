import type { Request, Response } from "express";
import {
  ListTransactionsQueryParams,
  CreateTransactionBody,
  GetTransactionParams,
  UpdateTransactionParams,
  UpdateTransactionBody,
  DeleteTransactionParams,
  UploadTransactionsBody,
} from "@workspace/api-zod";
import { BadRequestError } from "../lib/errors";
import { transactionsService } from "../services/transactions.service";

export const transactionsController = {
  async list(req: Request, res: Response) {
    const params = ListTransactionsQueryParams.safeParse(req.query);
    if (!params.success) throw new BadRequestError(params.error.message);
    const p = params.data;
    res.json(
      await transactionsService.list({
        categoryId: p.category_id,
        isZakatRelevant: p.is_zakat_relevant,
        isManuallyOverridden: p.is_manually_overridden,
        type: p.type,
        search: p.search,
        limit: p.limit,
        offset: p.offset,
      }),
    );
  },

  async upload(req: Request, res: Response) {
    const body = UploadTransactionsBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    res.json(await transactionsService.upload(body.data));
  },

  async create(req: Request, res: Response) {
    const body = CreateTransactionBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    res.status(201).json(await transactionsService.create(body.data));
  },

  async get(req: Request, res: Response) {
    const params = GetTransactionParams.safeParse({ id: Number(req.params.id) });
    if (!params.success) throw new BadRequestError("Invalid id");
    res.json(await transactionsService.getById(params.data.id));
  },

  async update(req: Request, res: Response) {
    const idParsed = UpdateTransactionParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) throw new BadRequestError("Invalid id");
    const body = UpdateTransactionBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    res.json(await transactionsService.update(idParsed.data.id, body.data));
  },

  async remove(req: Request, res: Response) {
    const params = DeleteTransactionParams.safeParse({ id: Number(req.params.id) });
    if (!params.success) throw new BadRequestError("Invalid id");
    await transactionsService.remove(params.data.id);
    res.status(204).send();
  },
};
