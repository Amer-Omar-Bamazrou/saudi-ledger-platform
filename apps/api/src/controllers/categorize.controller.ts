import type { Request, Response } from "express";
import { RunCategorizationBody } from "@workspace/api-zod";
import { BadRequestError } from "../lib/errors";
import { categorizeService } from "../services/categorize.service";

export const categorizeController = {
  async run(req: Request, res: Response) {
    const body = RunCategorizationBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    res.json(await categorizeService.run(body.data));
  },
};
