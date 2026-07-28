import type { Request, Response } from "express";
import { payrollService } from "../services/payroll.service";

export const payrollController = {
  async list(_req: Request, res: Response) {
    res.json(await payrollService.list());
  },
  async get(req: Request, res: Response) {
    res.json(await payrollService.getById(Number(req.params.id)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await payrollService.create(req.body, req.session?.userId ?? null));
  },
  async approve(req: Request, res: Response) {
    res.json(await payrollService.approve(Number(req.params.id)));
  },
};
