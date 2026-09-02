import type { Request, Response } from "express";
import { CreateEmployeeBody, UpdateEmployeeBody } from "@workspace/api-zod";
import { employeesService } from "../services/employees.service";
import { pageParams, requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

/** Contract batch 4: the declared body constraint is the enforced one. */
function parseOr400<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): T {
  if (result.success) return result.data;
  throw new BadRequestError(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}

export const employeesController = {
  async list(req: Request, res: Response) {
    const { search, status, department } = req.query as Record<string, string>;
    res.json(
      await employeesService.list({
        search,
        status,
        department,
        ...pageParams(req.query as Record<string, unknown>),
      }),
    );
  },
  async get(req: Request, res: Response) {
    res.json(await employeesService.getById(requireIdParam(req)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await employeesService.create(parseOr400(CreateEmployeeBody.safeParse(req.body))));
  },
  async update(req: Request, res: Response) {
    res.json(await employeesService.update(requireIdParam(req), parseOr400(UpdateEmployeeBody.safeParse(req.body))));
  },
  async remove(req: Request, res: Response) {
    await employeesService.remove(requireIdParam(req));
    res.status(204).send();
  },
};
