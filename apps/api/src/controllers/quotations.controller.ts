import type { Request, Response } from "express";
import { quotationsService } from "../services/quotations.service";
import { can } from "../lib/rbac";
import { BadRequestError } from "../lib/errors";

/**
 * 🔴 Ids are validated, not just coerced.
 *
 * The 2026-08-20 audit found `Number(req.params.id)` reaching queries on ~9
 * controllers, where a non-numeric id becomes NaN and surfaces as a raw 500
 * (Postgres 22P02) instead of a 400. That is a queued finding about the
 * EXISTING controllers; this is a new one, so it does not become the tenth
 * instance. Same discipline as "green fixes the case, not the class", applied
 * forwards rather than backwards.
 */
function requireId(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new BadRequestError("Invalid id");
  return id;
}

export const quotationsController = {
  async list(req: Request, res: Response) {
    const { status, customer_id, outcome } = req.query as Record<string, string>;
    if (outcome && !["live", "declined", "closed"].includes(outcome)) {
      throw new BadRequestError("outcome must be one of: live, declined, closed");
    }
    res.json(
      await quotationsService.list({
        status: status || undefined,
        customerId: customer_id ? Number(customer_id) : undefined,
        outcome: (outcome as "live" | "declined" | "closed") || undefined,
      }),
    );
  },

  async get(req: Request, res: Response) {
    res.json(await quotationsService.getById(requireId(req)));
  },

  async create(req: Request, res: Response) {
    // The invoices seam, reused exactly: an approver issues in one call, a
    // bookkeeper's quotation stays a draft awaiting approval. Reused rather
    // than reinvented so the two documents cannot drift in who may issue.
    const role = req.tenant?.role ?? "";
    const autoApprove = await can(role, "quotations", "approve");
    const out = await quotationsService.create(req.body, req.session?.userId ?? null, { autoApprove });
    res.status(201).json(out);
  },

  async update(req: Request, res: Response) {
    res.json(await quotationsService.update(requireId(req), req.body));
  },

  async submit(req: Request, res: Response) {
    res.json(await quotationsService.submit(requireId(req), req.session?.userId ?? null));
  },

  async approve(req: Request, res: Response) {
    res.json(await quotationsService.approve(requireId(req), req.session?.userId ?? null));
  },

  async sendBack(req: Request, res: Response) {
    const note = (req.body as { note?: string })?.note;
    res.json(await quotationsService.sendBack(requireId(req), req.session?.userId ?? null, note));
  },

  async reject(req: Request, res: Response) {
    await quotationsService.reject(requireId(req), req.session?.userId ?? null);
    res.status(204).send();
  },

  /**
   * The tenant's terminal act. `decline` = the customer said no; `close` =
   * abandon what is left. Both are things only the tenant knows, which is why
   * there is a route for them rather than an inference somewhere.
   */
  async decline(req: Request, res: Response) {
    res.json(await quotationsService.setOutcome(requireId(req), "declined", req.session?.userId ?? null));
  },

  async close(req: Request, res: Response) {
    res.json(await quotationsService.setOutcome(requireId(req), "closed", req.session?.userId ?? null));
  },

  async reopen(req: Request, res: Response) {
    res.json(await quotationsService.reopen(requireId(req)));
  },

  async remove(req: Request, res: Response) {
    await quotationsService.remove(requireId(req));
    res.status(204).send();
  },
};
