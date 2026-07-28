import type { Request, Response } from "express";
import { vendorsService } from "../services/vendors.service";

export const vendorsController = {
  async list(req: Request, res: Response) {
    const { search, is_active } = req.query as Record<string, string>;
    const rows = await vendorsService.list({
      search,
      isActive: is_active !== undefined ? is_active === "true" : undefined,
    });
    res.json(rows);
  },

  async get(req: Request, res: Response) {
    res.json(await vendorsService.getById(Number(req.params.id)));
  },

  async match(req: Request, res: Response) {
    const { vatNumber, vendorName } = req.body as { vatNumber?: string; vendorName?: string };
    res.json(await vendorsService.match({ vatNumber, vendorName }));
  },

  async create(req: Request, res: Response) {
    res.status(201).json(await vendorsService.create(req.body));
  },

  async update(req: Request, res: Response) {
    res.json(await vendorsService.update(Number(req.params.id), req.body));
  },

  async remove(req: Request, res: Response) {
    await vendorsService.remove(Number(req.params.id));
    res.status(204).send();
  },
};
