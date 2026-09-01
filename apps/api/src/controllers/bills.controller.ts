import type { Request, Response } from "express";
import { CreateBillBody, PayBillBody, PostBillBody, UpdateBillBody } from "@workspace/api-zod";
import { billsService } from "../services/bills.service";
import { requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

/** Contract batch 3: the declared body constraint is the enforced one. */
function parseOr400<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): T {
  if (result.success) return result.data;
  throw new BadRequestError(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}

/** 1..200, default 50 — a page the caller cannot turn into "everything". */
function clampPage(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(200, Math.floor(n));
}

export const billsController = {
  async list(req: Request, res: Response) {
    const { status, vendor_id, limit, offset } = req.query as Record<string, string>;
    // See the note in invoices.controller — overdue is derived, not stored.
    const overdue = status === "overdue";
    res.json(
      await billsService.list({
        status: overdue ? undefined : status || undefined,
        overdue: overdue || undefined,
        vendorId: vendor_id ? Number(vendor_id) : undefined,
        limit: clampPage(limit),
        offset: Math.max(0, Number(offset) || 0),
      }),
    );
  },
  async get(req: Request, res: Response) {
    res.json(await billsService.getById(requireIdParam(req)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await billsService.create(parseOr400(CreateBillBody.safeParse(req.body)), req.session?.userId ?? null));
  },
  // Draft/approval workflow (M10.3).
  async submit(req: Request, res: Response) {
    res.json(await billsService.submit(requireIdParam(req), req.session?.userId ?? null));
  },
  async sendBack(req: Request, res: Response) {
    const note = (req.body as { note?: string })?.note;
    res.json(await billsService.sendBack(requireIdParam(req), note, req.session?.userId ?? null));
  },
  async reject(req: Request, res: Response) {
    await billsService.reject(requireIdParam(req), req.session?.userId ?? null);
    res.status(204).send();
  },
  async approve(req: Request, res: Response) {
    res.json(await billsService.approve(requireIdParam(req), req.body ?? {}, req.session?.userId ?? null));
  },
  async post(req: Request, res: Response) {
    const raw = req.body == null || Object.keys(req.body).length === 0 ? {} : parseOr400(PostBillBody.safeParse(req.body));
    const opts = { debitAccount: raw.debitAccount ?? undefined, force: raw.force ?? undefined, captureId: raw.captureId ?? undefined };
    res.json(await billsService.post(requireIdParam(req), opts, req.session?.userId ?? null));
  },
  async update(req: Request, res: Response) {
    res.json(await billsService.update(requireIdParam(req), parseOr400(UpdateBillBody.safeParse(req.body))));
  },
  async pay(req: Request, res: Response) {
    res.json(await billsService.pay(requireIdParam(req), parseOr400(PayBillBody.safeParse(req.body)), req.session?.userId ?? null));
  },
  /** B4 — the dated payment history; backfilled rows are aggregates. */
  async payments(req: Request, res: Response) {
    res.json(await billsService.payments(requireIdParam(req)));
  },
  async remove(req: Request, res: Response) {
    await billsService.deleteDraft(requireIdParam(req));
    res.status(204).send();
  },
};
