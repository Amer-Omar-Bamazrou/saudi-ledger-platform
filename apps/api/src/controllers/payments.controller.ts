import type { Request, Response } from "express";
import { ReceivePaymentBody, AllocatePaymentBody, ApplyCreditNoteBody, UnallocateBody, RefundCustomerBody } from "@workspace/api-zod";
import { paymentsService } from "../services/payments.service";
import { requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

/** Bodies are validated against the GENERATED schemas — the spec's constraint is the server's. */
function parseOr400<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): T {
  if (result.success) return result.data;
  throw new BadRequestError(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}

function clamp(raw: string | undefined, dflt: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(max, Math.floor(n));
}

export const paymentsController = {
  async list(req: Request, res: Response) {
    const { customer_id, limit, offset } = req.query as Record<string, string>;
    const customerId = customer_id ? Number(customer_id) : undefined;
    if (customer_id && (!Number.isInteger(customerId) || customerId! <= 0)) throw new BadRequestError("customer_id must be a positive integer");
    res.json(await paymentsService.list({ customerId, limit: clamp(limit, 50, 200), offset: offset ? clamp(offset, 0, 1_000_000) : 0 }));
  },

  async get(req: Request, res: Response) {
    res.json(await paymentsService.get(requireIdParam(req)));
  },

  async receive(req: Request, res: Response) {
    const body = parseOr400(ReceivePaymentBody.safeParse(req.body));
    res.status(201).json(await paymentsService.receive(body, req.session?.userId ?? null));
  },

  async allocate(req: Request, res: Response) {
    const body = parseOr400(AllocatePaymentBody.safeParse(req.body));
    res.json(await paymentsService.allocate(requireIdParam(req), body, req.session?.userId ?? null));
  },

  /** Apply a credit note's unconsumed balance to invoices of the same customer. */
  async applyCredit(req: Request, res: Response) {
    const body = parseOr400(ApplyCreditNoteBody.safeParse(req.body));
    res.json(await paymentsService.applyCreditNote(requireIdParam(req), body, req.session?.userId ?? null));
  },

  async creditApplications(req: Request, res: Response) {
    res.json(await paymentsService.creditNoteApplications(requireIdParam(req)));
  },

  // ── Phase A ──
  async getAllocation(req: Request, res: Response) {
    res.json(await paymentsService.allocation(requireIdParam(req)));
  },

  async unallocate(req: Request, res: Response) {
    const body = parseOr400(UnallocateBody.safeParse(req.body));
    res.json(await paymentsService.unallocate(requireIdParam(req), body, req.session?.userId ?? null));
  },

  // ── Phase C ──
  async refund(req: Request, res: Response) {
    const body = parseOr400(RefundCustomerBody.safeParse(req.body));
    res.status(201).json(await paymentsService.refund(body, req.session?.userId ?? null));
  },

  async getRefund(req: Request, res: Response) {
    res.json(await paymentsService.getRefund(requireIdParam(req)));
  },

  async listRefunds(req: Request, res: Response) {
    const { customer_id, limit, offset } = req.query as Record<string, string>;
    const customerId = customer_id ? Number(customer_id) : undefined;
    if (customer_id && (!Number.isInteger(customerId) || customerId! <= 0)) throw new BadRequestError("customer_id must be a positive integer");
    res.json(await paymentsService.listRefunds({ customerId, limit: clamp(limit, 50, 200), offset: offset ? clamp(offset, 0, 1_000_000) : 0 }));
  },
};
