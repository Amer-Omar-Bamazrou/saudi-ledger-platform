import type { Request, Response } from "express";
import { invoicesService } from "../services/invoices.service";
import { can } from "../lib/rbac";

export const invoicesController = {
  async list(req: Request, res: Response) {
    const { status, customer_id } = req.query as Record<string, string>;
    res.json(
      await invoicesService.list({
        status: status || undefined,
        customerId: customer_id ? Number(customer_id) : undefined,
      }),
    );
  },
  async get(req: Request, res: Response) {
    res.json(await invoicesService.getById(Number(req.params.id)));
  },
  async create(req: Request, res: Response) {
    // Self-approve on create: an approver (admin/accountant) issues the invoice
    // immediately; a bookkeeper's create stays a draft awaiting approval.
    const role = req.tenant?.role ?? "";
    const autoApprove = await can(role, "invoices", "approve");
    const out = await invoicesService.create(req.body, req.session?.userId ?? null, { autoApprove });
    res.status(201).json(out);
  },
  // Draft/approval workflow (M10.4).
  async submit(req: Request, res: Response) {
    res.json(await invoicesService.submit(Number(req.params.id), req.session?.userId ?? null));
  },
  async sendBack(req: Request, res: Response) {
    const note = (req.body as { note?: string })?.note;
    res.json(await invoicesService.sendBack(Number(req.params.id), note, req.session?.userId ?? null));
  },
  async reject(req: Request, res: Response) {
    await invoicesService.reject(Number(req.params.id), req.session?.userId ?? null);
    res.status(204).send();
  },
  async approve(req: Request, res: Response) {
    res.json(await invoicesService.approve(Number(req.params.id), req.session?.userId ?? null));
  },
  async update(req: Request, res: Response) {
    res.json(await invoicesService.update(Number(req.params.id), req.body));
  },
  async pay(req: Request, res: Response) {
    res.json(await invoicesService.pay(Number(req.params.id), req.body, req.session?.userId ?? null));
  },
  async remove(req: Request, res: Response) {
    await invoicesService.remove(Number(req.params.id));
    res.status(204).send();
  },
};
