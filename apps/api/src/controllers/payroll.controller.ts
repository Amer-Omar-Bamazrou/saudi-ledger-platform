import type { Request, Response } from "express";
import { CreatePayrollRunBody, PayPayrollRunBody, PayPayrollRunGosiBody } from "@workspace/api-zod";
import { payrollService } from "../services/payroll.service";
import { requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

/** Contract batch 4: the declared body constraint is the enforced one. */
function parseOr400<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): T {
  if (result.success) return result.data;
  throw new BadRequestError(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}

export const payrollController = {
  async list(_req: Request, res: Response) {
    res.json(await payrollService.list());
  },
  async get(req: Request, res: Response) {
    res.json(await payrollService.getById(requireIdParam(req)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await payrollService.create(parseOr400(CreatePayrollRunBody.safeParse(req.body)), req.session?.userId ?? null));
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
  // DR-41 / DR-39 (Phase 18): pay an approved run's net pay from a bank (approver-only: `/:id/pay` is an approve route).
  async pay(req: Request, res: Response) {
    res.json(await payrollService.pay(requireIdParam(req), parseOr400(PayPayrollRunBody.safeParse(req.body)), req.session?.userId ?? null));
  },
  // GOSI (Phase 18): pay a run's GOSI contributions from a bank (approver-only: the path ends in `/pay`, an approve route).
  async payGosi(req: Request, res: Response) {
    res.json(await payrollService.payGosi(requireIdParam(req), parseOr400(PayPayrollRunGosiBody.safeParse(req.body)), req.session?.userId ?? null));
  },
};
