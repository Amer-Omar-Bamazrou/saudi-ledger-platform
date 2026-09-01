import type { Request, Response } from "express";
import { CreateVendorBody, MatchVendorBody, UpdateVendorBody } from "@workspace/api-zod";
import { vendorsService } from "../services/vendors.service";
import { pageParams, requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

export const vendorsController = {
  async list(req: Request, res: Response) {
    const { search, is_active } = req.query as Record<string, string>;
    res.json(
      await vendorsService.list({
        search,
        isActive: is_active !== undefined ? is_active === "true" : undefined,
        ...pageParams(req.query as Record<string, unknown>),
      }),
    );
  },

  async get(req: Request, res: Response) {
    res.json(await vendorsService.getById(requireIdParam(req)));
  },

  // 🔴 Contract batch 2: bodies validated against the GENERATED schemas — the
  // declared constraint is the enforced one.
  async match(req: Request, res: Response) {
    const body = MatchVendorBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    res.json(await vendorsService.match(body.data));
  },

  async create(req: Request, res: Response) {
    const body = CreateVendorBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    res.status(201).json(await vendorsService.create(body.data));
  },

  async update(req: Request, res: Response) {
    const body = UpdateVendorBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    res.json(await vendorsService.update(requireIdParam(req), body.data));
  },

  async remove(req: Request, res: Response) {
    await vendorsService.remove(requireIdParam(req));
    res.status(204).send();
  },
};
