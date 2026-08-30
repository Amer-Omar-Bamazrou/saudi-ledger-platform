import type { Request, Response } from "express";
import { quotationsService } from "../services/quotations.service";
import { quotationConversionService } from "../services/quotationConversion.service";
import { can } from "../lib/rbac";
import { BadRequestError } from "../lib/errors";
// Ids validated, not merely coerced — this controller's local helper became
// lib/httpParams when the queued ~9-controller finding was fixed (2026-08-23).
import { pageParams, requireIdParam as requireId } from "../lib/httpParams";

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
        ...pageParams(req.query as Record<string, unknown>),
      }),
    );
  },

  async get(req: Request, res: Response) {
    res.json(await quotationsService.getById(requireId(req)));
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
    const out = await quotationsService.create(req.body, req.session?.userId ?? null);
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

  /**
   * Convert part or all of a quotation into an invoice (M21.2).
   *
   * 🔴 Conversion ALWAYS produces a draft, for every role — note the absence
   * of a `can(...)` check here, which is the point rather than an omission.
   * Issuance consumes an ICV irreversibly and a conversion cannot be undone,
   * so the approver looks at the invoice before it becomes a legal document.
   * See the service for the full reasoning.
   */
  async convert(req: Request, res: Response) {
    const out = await quotationConversionService.convert(
      requireId(req),
      req.body ?? {},
      req.session?.userId ?? null,
    );
    res.status(201).json(out);
  },

  /** The dated conversion history — what became an invoice, and when. */
  async conversions(req: Request, res: Response) {
    res.json(await quotationConversionService.history(requireId(req)));
  },

  async remove(req: Request, res: Response) {
    await quotationsService.deleteDraft(requireId(req));
    res.status(204).send();
  },
};
