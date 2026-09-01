/**
 * Customers controller — HTTP orchestration only. No business logic, no DB.
 * Async throws propagate to the centralized errorHandler (Express 5).
 */
import type { Request, Response } from "express";
import { CreateCustomerBody, UpdateCustomerBody } from "@workspace/api-zod";
import { customersService } from "../services/customers.service";
import { pageParams, requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

export const customersController = {
  async list(req: Request, res: Response) {
    const { search, is_active } = req.query as Record<string, string>;
    res.json(
      await customersService.list({
        search,
        isActive: is_active !== undefined ? is_active === "true" : undefined,
        ...pageParams(req.query as Record<string, unknown>),
      }),
    );
  },

  async get(req: Request, res: Response) {
    const out = await customersService.getById(requireIdParam(req));
    res.json(out);
  },

  // 🔴 Contract batch 2: the body is validated against the GENERATED schema, so
  // the constraint the spec declares is the constraint the server enforces
  // (§3: a declared-but-unenforced constraint reads as coverage twice).
  async create(req: Request, res: Response) {
    const body = CreateCustomerBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    const row = await customersService.create(body.data);
    res.status(201).json(row);
  },

  async update(req: Request, res: Response) {
    const body = UpdateCustomerBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    const row = await customersService.update(requireIdParam(req), body.data);
    res.json(row);
  },

  async remove(req: Request, res: Response) {
    await customersService.remove(requireIdParam(req));
    res.status(204).send();
  },
};
