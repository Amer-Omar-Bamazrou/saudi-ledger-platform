import type { Request, Response } from "express";
import { bankAccountsService } from "../services/bankAccounts.service";
import { requireIdParam } from "../lib/httpParams";

export const bankAccountsController = {
  async list(_req: Request, res: Response) {
    res.json(await bankAccountsService.list());
  },
  async get(req: Request, res: Response) {
    res.json(await bankAccountsService.getById(requireIdParam(req)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await bankAccountsService.create(req.body));
  },
  async update(req: Request, res: Response) {
    res.json(await bankAccountsService.update(requireIdParam(req), req.body));
  },
  async remove(req: Request, res: Response) {
    await bankAccountsService.remove(requireIdParam(req));
    res.status(204).send();
  },
};
