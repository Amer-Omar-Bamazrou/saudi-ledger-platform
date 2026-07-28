import type { Request, Response } from "express";
import { productsService } from "../services/products.service";

export const productsController = {
  async list(req: Request, res: Response) {
    const { search, type, is_active } = req.query as Record<string, string>;
    const rows = await productsService.list({
      search,
      type,
      isActive: is_active !== undefined ? is_active === "true" : undefined,
    });
    res.json(rows);
  },

  async get(req: Request, res: Response) {
    res.json(await productsService.getById(Number(req.params.id)));
  },

  async create(req: Request, res: Response) {
    res.status(201).json(await productsService.create(req.body));
  },

  async update(req: Request, res: Response) {
    res.json(await productsService.update(Number(req.params.id), req.body));
  },

  async remove(req: Request, res: Response) {
    await productsService.remove(Number(req.params.id));
    res.status(204).send();
  },
};
