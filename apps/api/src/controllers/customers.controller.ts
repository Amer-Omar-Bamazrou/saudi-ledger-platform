/**
 * Customers controller — HTTP orchestration only. No business logic, no DB.
 * Async throws propagate to the centralized errorHandler (Express 5).
 */
import type { Request, Response } from "express";
import { customersService } from "../services/customers.service";
import { requireIdParam } from "../lib/httpParams";

export const customersController = {
  async list(req: Request, res: Response) {
    const { search, is_active } = req.query as Record<string, string>;
    const rows = await customersService.list({
      search,
      isActive: is_active !== undefined ? is_active === "true" : undefined,
    });
    res.json(rows);
  },

  async get(req: Request, res: Response) {
    const out = await customersService.getById(requireIdParam(req));
    res.json(out);
  },

  async create(req: Request, res: Response) {
    const row = await customersService.create(req.body);
    res.status(201).json(row);
  },

  async update(req: Request, res: Response) {
    const row = await customersService.update(requireIdParam(req), req.body);
    res.json(row);
  },

  async remove(req: Request, res: Response) {
    await customersService.remove(requireIdParam(req));
    res.status(204).send();
  },
};
