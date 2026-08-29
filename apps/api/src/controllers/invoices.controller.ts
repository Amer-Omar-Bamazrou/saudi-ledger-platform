import type { Request, Response } from "express";
import { invoicesService } from "../services/invoices.service";
import { can } from "../lib/rbac";
import { requireIdParam } from "../lib/httpParams";

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
    res.json(await invoicesService.getById(requireIdParam(req)));
  },
  async create(req: Request, res: Response) {
    /**
     * 🔴 NO AUTO-APPROVE. A create makes a DRAFT, for every role.
     *
     * This used to take `autoApprove` from the RBAC matrix, so an approver's
     * create ISSUED the document in one call. Owner decision (2026-08-28):
     * removed entirely. Its justification expired when M22 gave the product a
     * real approve button, and what was left contradicted M10's own principle —
     * **approval is an act about a specific document, and auto-approve made it
     * an act about a setting**. On invoices it was also two-thirds of AUD-13's
     * severity: it is the leg that turned a thin form from annoying into
     * unrecoverable, minting an ICV and a ZATCA stamp from a single create call.
     *
     * One extra click on a legal document is not a cost worth arguing about.
     */
    const out = await invoicesService.create(req.body, req.session?.userId ?? null);
    res.status(201).json(out);
  },
  // Draft/approval workflow (M10.4).
  async submit(req: Request, res: Response) {
    res.json(await invoicesService.submit(requireIdParam(req), req.session?.userId ?? null));
  },
  async sendBack(req: Request, res: Response) {
    const note = (req.body as { note?: string })?.note;
    res.json(await invoicesService.sendBack(requireIdParam(req), note, req.session?.userId ?? null));
  },
  async reject(req: Request, res: Response) {
    await invoicesService.reject(requireIdParam(req), req.session?.userId ?? null);
    res.status(204).send();
  },
  async approve(req: Request, res: Response) {
    res.json(await invoicesService.approve(requireIdParam(req), req.session?.userId ?? null));
  },
  async update(req: Request, res: Response) {
    res.json(await invoicesService.update(requireIdParam(req), req.body));
  },
  async pay(req: Request, res: Response) {
    res.json(await invoicesService.pay(requireIdParam(req), req.body, req.session?.userId ?? null));
  },
  /** B4 — the dated payment history; backfilled rows are aggregates. */
  async payments(req: Request, res: Response) {
    res.json(await invoicesService.payments(requireIdParam(req)));
  },
  async remove(req: Request, res: Response) {
    await invoicesService.remove(requireIdParam(req));
    res.status(204).send();
  },
};
