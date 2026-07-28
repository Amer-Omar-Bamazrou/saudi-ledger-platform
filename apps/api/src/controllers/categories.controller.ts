import type { Request, Response } from "express";
import { CreateCategoryBody } from "@workspace/api-zod";
import { BadRequestError } from "../lib/errors";
import { categoriesService } from "../services/categories.service";

export const categoriesController = {
  async list(_req: Request, res: Response) {
    res.json(await categoriesService.list());
  },

  async create(req: Request, res: Response) {
    const body = CreateCategoryBody.safeParse(req.body);
    if (!body.success) {
      throw new BadRequestError(body.error.message);
    }
    res.status(201).json(await categoriesService.create(body.data));
  },
};
