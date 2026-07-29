import type { Request, Response } from "express";
import { billsService } from "../services/bills.service";

export const billsController = {
  async list(req: Request, res: Response) {
    const { status, vendor_id } = req.query as Record<string, string>;
    res.json(
      await billsService.list({
        status: status || undefined,
        vendorId: vendor_id ? Number(vendor_id) : undefined,
      }),
    );
  },
  async get(req: Request, res: Response) {
    res.json(await billsService.getById(Number(req.params.id)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await billsService.create(req.body, req.session?.userId ?? null));
  },
  // Draft/approval workflow (M10.3).
  async submit(req: Request, res: Response) {
    res.json(await billsService.submit(Number(req.params.id), req.session?.userId ?? null));
  },
  async sendBack(req: Request, res: Response) {
    const note = (req.body as { note?: string })?.note;
    res.json(await billsService.sendBack(Number(req.params.id), note, req.session?.userId ?? null));
  },
  async reject(req: Request, res: Response) {
    await billsService.reject(Number(req.params.id), req.session?.userId ?? null);
    res.status(204).send();
  },
  async approve(req: Request, res: Response) {
    res.json(await billsService.approve(Number(req.params.id), req.body ?? {}, req.session?.userId ?? null));
  },
  async post(req: Request, res: Response) {
    res.json(await billsService.post(Number(req.params.id), req.body ?? {}, req.session?.userId ?? null));
  },
  async update(req: Request, res: Response) {
    res.json(await billsService.update(Number(req.params.id), req.body));
  },
  async pay(req: Request, res: Response) {
    res.json(await billsService.pay(Number(req.params.id), req.body, req.session?.userId ?? null));
  },
  async remove(req: Request, res: Response) {
    await billsService.remove(Number(req.params.id));
    res.status(204).send();
  },
};
