import type { Request, Response } from "express";
import { employeesService } from "../services/employees.service";
import { pageParams, requireIdParam } from "../lib/httpParams";

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
    res.status(201).json(await employeesService.create(req.body));
  },
  async update(req: Request, res: Response) {
    res.json(await employeesService.update(requireIdParam(req), req.body));
  },
  async remove(req: Request, res: Response) {
    await employeesService.remove(requireIdParam(req));
    res.status(204).send();
  },
};
