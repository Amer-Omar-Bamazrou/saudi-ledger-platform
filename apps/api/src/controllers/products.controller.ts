import type { Request, Response } from "express";
import { productsService } from "../services/products.service";
import { pageParams, requireIdParam } from "../lib/httpParams";

export const productsController = {
  async list(req: Request, res: Response) {
    const { search, type, is_active } = req.query as Record<string, string>;
    res.json(
      await productsService.list({
        search,
        type,
        isActive: is_active !== undefined ? is_active === "true" : undefined,
        ...pageParams(req.query as Record<string, unknown>),
      }),
    );
  },

  async get(req: Request, res: Response) {
    res.json(await productsService.getById(requireIdParam(req)));
  },

  async create(req: Request, res: Response) {
    res.status(201).json(await productsService.create(req.body));
  },

  async update(req: Request, res: Response) {
    res.json(await productsService.update(requireIdParam(req), req.body));
  },

  async remove(req: Request, res: Response) {
    await productsService.remove(requireIdParam(req));
    res.status(204).send();
  },
};
