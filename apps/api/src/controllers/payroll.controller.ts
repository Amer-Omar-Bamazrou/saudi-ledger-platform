import type { Request, Response } from "express";
import { payrollService } from "../services/payroll.service";
import { requireIdParam } from "../lib/httpParams";

export const payrollController = {
  async list(_req: Request, res: Response) {
    res.json(await payrollService.list());
  },
  async get(req: Request, res: Response) {
    res.json(await payrollService.getById(requireIdParam(req)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await payrollService.create(req.body, req.session?.userId ?? null));
  },
  // Draft/approval workflow (M10.5).
  async submit(req: Request, res: Response) {
    res.json(await payrollService.submit(requireIdParam(req), req.session?.userId ?? null));
  },
  async sendBack(req: Request, res: Response) {
    const note = (req.body as { note?: string })?.note;
    res.json(await payrollService.sendBack(requireIdParam(req), note, req.session?.userId ?? null));
  },
  async reject(req: Request, res: Response) {
    await payrollService.reject(requireIdParam(req), req.session?.userId ?? null);
    res.status(204).send();
  },
  async approve(req: Request, res: Response) {
    res.json(await payrollService.approve(requireIdParam(req), req.session?.userId ?? null));
  },
};
