import type { Request, Response } from "express";
import { purchaseOrdersService } from "../services/purchaseOrders.service";
import { purchaseOrderConversionService } from "../services/purchaseOrderConversion.service";
import { can } from "../lib/rbac";
import { BadRequestError } from "../lib/errors";
/** Validated, not merely coerced — see lib/httpParams. */
import { requireIdParam as requireId } from "../lib/httpParams";

export const purchaseOrdersController = {
  async list(req: Request, res: Response) {
    const { status, vendor_id, outcome } = req.query as Record<string, string>;
    if (outcome && !["live", "cancelled", "closed"].includes(outcome)) {
      throw new BadRequestError("outcome must be one of: live, cancelled, closed");
    }
    res.json(
      await purchaseOrdersService.list({
        status: status || undefined,
        vendorId: vendor_id ? Number(vendor_id) : undefined,
        outcome: (outcome as "live" | "cancelled" | "closed") || undefined,
      }),
    );
  },

  async get(req: Request, res: Response) {
    res.json(await purchaseOrdersService.getById(requireId(req)));
  },

  async create(req: Request, res: Response) {
    // An approver issues the order in one call; a bookkeeper's stays a draft.
    // (This is the ORDER's own approval — it moves nothing either way.)
    const role = req.tenant?.role ?? "";
    const autoApprove = await can(role, "purchase_orders", "approve");
    const out = await purchaseOrdersService.create(req.body, req.session?.userId ?? null, { autoApprove });
    res.status(201).json(out);
  },

  async update(req: Request, res: Response) {
    res.json(await purchaseOrdersService.update(requireId(req), req.body));
  },

  async submit(req: Request, res: Response) {
    res.json(await purchaseOrdersService.submit(requireId(req), req.session?.userId ?? null));
  },

  async approve(req: Request, res: Response) {
    res.json(await purchaseOrdersService.approve(requireId(req), req.session?.userId ?? null));
  },

  async sendBack(req: Request, res: Response) {
    const note = (req.body as { note?: string })?.note;
    res.json(await purchaseOrdersService.sendBack(requireId(req), req.session?.userId ?? null, note));
  },

  async reject(req: Request, res: Response) {
    await purchaseOrdersService.reject(requireId(req), req.session?.userId ?? null);
    res.status(204).send();
  },

  /** 🔴 CANCELLED, not "declined" — we withdraw an order; the supplier does not refuse it. */
  async cancel(req: Request, res: Response) {
    res.json(await purchaseOrdersService.setOutcome(requireId(req), "cancelled"));
  },

  async close(req: Request, res: Response) {
    res.json(await purchaseOrdersService.setOutcome(requireId(req), "closed"));
  },

  async reopen(req: Request, res: Response) {
    res.json(await purchaseOrdersService.reopen(requireId(req)));
  },

  /**
   * Record the supplier's bill against this order.
   *
   * 🔴 No `can(...)` check, and that is the point: the bill is ALWAYS a draft,
   * for every role. Posting a bill moves AP and claims input VAT, and a
   * conversion cannot be undone.
   */
  async convert(req: Request, res: Response) {
    const out = await purchaseOrderConversionService.convert(
      requireId(req),
      req.body ?? {},
      req.session?.userId ?? null,
    );
    res.status(201).json(out);
  },

  async conversions(req: Request, res: Response) {
    res.json(await purchaseOrderConversionService.history(requireId(req)));
  },

  async remove(req: Request, res: Response) {
    await purchaseOrdersService.remove(requireId(req));
    res.status(204).send();
  },
};
