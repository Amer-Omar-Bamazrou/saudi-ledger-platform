import type { Request, Response } from "express";
import { LinkReconciliationLineBody, ReverseReconciliationLinkBody, ListReconciliationLinesQueryParams } from "@workspace/api-zod";
import { bankReconciliationService } from "../services/accounting/bankReconciliation.service";
import { requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

const userOf = (req: Request) => req.session?.userId ?? null;
const bankOf = (req: Request) => {
  const v = (req.query as Record<string, string | undefined>).bankAccountId;
  return v ? Number(v) : undefined;
};

/**
 * Phase 12B — the reconciliation workbench's HTTP surface. Thin: every
 * refusal, every derived amount and every state change belongs to the
 * service, and the caps to the database. Bodies are parsed through the
 * generated contract, so a declared constraint (minItems, required) binds.
 */
export const bankReconciliationController = {
  async lines(req: Request, res: Response) {
    const q = ListReconciliationLinesQueryParams.safeParse(req.query);
    if (!q.success) throw new BadRequestError(q.error.message);
    res.json(await bankReconciliationService.lines(q.data));
  },
  async line(req: Request, res: Response) {
    res.json(await bankReconciliationService.line(requireIdParam(req)));
  },
  async link(req: Request, res: Response) {
    const body = LinkReconciliationLineBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    res.json(await bankReconciliationService.link(requireIdParam(req), body.data, userOf(req)));
  },
  async unlink(req: Request, res: Response) {
    const body = ReverseReconciliationLinkBody.safeParse(req.body);
    if (!body.success) throw new BadRequestError(body.error.message);
    res.json(await bankReconciliationService.unlink(requireIdParam(req), body.data, userOf(req)));
  },
  async classifyAp(req: Request, res: Response) {
    res.json(await bankReconciliationService.classifyAp({ bankAccountId: bankOf(req) }));
  },
  async applyAp(req: Request, res: Response) {
    res.json(await bankReconciliationService.applyAp({ bankAccountId: bankOf(req) }, userOf(req)));
  },
};
