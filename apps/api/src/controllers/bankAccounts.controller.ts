import type { Request, Response } from "express";
import { bankAccountsService } from "../services/bankAccounts.service";

export const bankAccountsController = {
  async list(_req: Request, res: Response) {
    res.json(await bankAccountsService.list());
  },
  async get(req: Request, res: Response) {
    res.json(await bankAccountsService.getById(Number(req.params.id)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await bankAccountsService.create(req.body));
  },
  async update(req: Request, res: Response) {
    res.json(await bankAccountsService.update(Number(req.params.id), req.body));
  },
  async remove(req: Request, res: Response) {
    await bankAccountsService.remove(Number(req.params.id));
    res.status(204).send();
  },
};
