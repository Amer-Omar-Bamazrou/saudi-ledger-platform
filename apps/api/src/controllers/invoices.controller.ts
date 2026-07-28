import type { Request, Response } from "express";
import { invoicesService } from "../services/invoices.service";

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
    const out = await invoicesService.create(req.body, req.session?.userId ?? null);
    res.status(201).json(out);
  },
  async update(req: Request, res: Response) {
    res.json(await invoicesService.update(Number(req.params.id), req.body));
  },
  async pay(req: Request, res: Response) {
    res.json(await invoicesService.pay(Number(req.params.id), req.body));
  },
  async remove(req: Request, res: Response) {
    await invoicesService.remove(Number(req.params.id));
    res.status(204).send();
  },
};
