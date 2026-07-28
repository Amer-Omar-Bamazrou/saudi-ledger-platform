import type { Request, Response } from "express";
import { employeesService } from "../services/employees.service";

export const employeesController = {
  async list(req: Request, res: Response) {
    const { search, status, department } = req.query as Record<string, string>;
    res.json(await employeesService.list({ search, status, department }));
  },
  async get(req: Request, res: Response) {
    res.json(await employeesService.getById(Number(req.params.id)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await employeesService.create(req.body));
  },
  async update(req: Request, res: Response) {
    res.json(await employeesService.update(Number(req.params.id), req.body));
  },
  async remove(req: Request, res: Response) {
    await employeesService.remove(Number(req.params.id));
    res.status(204).send();
  },
};
