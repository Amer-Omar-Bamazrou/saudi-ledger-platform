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
  // Draft/approval workflow (M10.5).
  async submit(req: Request, res: Response) {
    res.json(await payrollService.submit(Number(req.params.id), req.session?.userId ?? null));
  },
  async sendBack(req: Request, res: Response) {
    const note = (req.body as { note?: string })?.note;
    res.json(await payrollService.sendBack(Number(req.params.id), note, req.session?.userId ?? null));
  },
  async reject(req: Request, res: Response) {
    await payrollService.reject(Number(req.params.id), req.session?.userId ?? null);
    res.status(204).send();
  },
  async approve(req: Request, res: Response) {
    res.json(await payrollService.approve(Number(req.params.id), req.session?.userId ?? null));
  },
};
