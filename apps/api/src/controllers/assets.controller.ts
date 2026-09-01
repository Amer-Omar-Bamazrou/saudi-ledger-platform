import type { Request, Response } from "express";
import { CreateAssetBody, DepreciateAssetBody, UpdateAssetBody } from "@workspace/api-zod";
import { assetsService } from "../services/assets.service";
import { pageParams, requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

/** Contract batch 4: the declared body constraint is the enforced one. */
function parseOr400<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): T {
  if (result.success) return result.data;
  throw new BadRequestError(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}

export const assetsController = {
  async list(req: Request, res: Response) {
    res.json(await assetsService.list(pageParams(req.query as Record<string, unknown>)));
  },
  async get(req: Request, res: Response) {
    res.json(await assetsService.getById(requireIdParam(req)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await assetsService.create(parseOr400(CreateAssetBody.safeParse(req.body))));
  },
  async update(req: Request, res: Response) {
    res.json(await assetsService.update(requireIdParam(req), parseOr400(UpdateAssetBody.safeParse(req.body))));
  },
  async depreciate(req: Request, res: Response) {
    const { period } = parseOr400(DepreciateAssetBody.safeParse(req.body));
    res.json(await assetsService.depreciate(requireIdParam(req), period));
  },
  async remove(req: Request, res: Response) {
    await assetsService.remove(requireIdParam(req));
    res.status(204).send();
  },
};
