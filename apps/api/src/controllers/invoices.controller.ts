import type { Request, Response } from "express";
import { CreateInvoiceBody, PayInvoiceBody, UpdateInvoiceBody } from "@workspace/api-zod";
import { invoicesService } from "../services/invoices.service";
import { can } from "../lib/rbac";
import { requireIdParam } from "../lib/httpParams";
import { BadRequestError, BusinessRuleError } from "../lib/errors";
import { buildInvoiceDocModel, findSignedXml, renderInvoicePdf } from "../services/invoiceDocument/invoiceDocument.service";

/**
 * 🔴 Contract batch 3: bodies are validated against the GENERATED schemas, so
 * the constraint the spec declares is the constraint the server enforces. The
 * one structured code the UI keys on (AUD-13's `invoice_has_no_lines`) is kept
 * stable: an empty `items` array fails the schema's `minItems`, and that
 * failure is answered with the same code the service would have given.
 */
function parseOr400<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; code: string; message: string }[] } }): T {
  if (result.success) return result.data;
  const noLines = result.error.issues.find((i) => i.path[0] === "items" && i.path.length === 1);
  if (noLines) {
    throw new BusinessRuleError(400, {
      error:
        "An invoice needs at least one line. A zero-line invoice is issued at SAR 0.00 and, " +
        "once issued, cannot be corrected or deleted.",
      code: "invoice_has_no_lines",
      field: "items",
    });
  }
  throw new BadRequestError(result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}

/** 1..200, default 50. A page the caller cannot turn into "everything". */
function clampPage(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(200, Math.floor(n));
}

export const invoicesController = {
  async list(req: Request, res: Response) {
    const { status, customer_id, date_from, date_to, limit, offset } = req.query as Record<string, string>;
    /**
     * `status=overdue` is answered from the DATES, not from a status value.
     * The value no longer exists on the column; the query alias stays because
     * overdue is what a user is asking for, and the repository is the single
     * place that decides what it means.
     */
    const overdue = status === "overdue";
    res.json(
      await invoicesService.list({
        status: overdue ? undefined : status || undefined,
        overdue: overdue || undefined,
        customerId: customer_id ? Number(customer_id) : undefined,
        dateFrom: date_from || undefined,
        dateTo: date_to || undefined,
        // Bounded so a hand-built request cannot ask for the whole ledger, and
        // NaN falls back to the default rather than to `LIMIT NaN`.
        limit: clampPage(limit),
        offset: Math.max(0, Number(offset) || 0),
      }),
    );
  },
  async get(req: Request, res: Response) {
    res.json(await invoicesService.getById(requireIdParam(req)));
  },
  /**
   * L1 — the invoice leaves the product. `?lang=ar` (default) is THE tax
   * invoice; `?lang=en` is the labelled translation. PDF/A-3B either way,
   * with the signed ZATCA XML attached when the invoice has one.
   */
  async document(req: Request, res: Response) {
    const id = requireIdParam(req);
    const langRaw = String(req.query.lang ?? "ar");
    if (langRaw !== "ar" && langRaw !== "en") {
      res.status(400).json({ error: "lang must be 'ar' or 'en'.", code: "invalid_lang", field: "lang" });
      return;
    }
    const model = await buildInvoiceDocModel(id, langRaw);
    const xml = await findSignedXml(id);
    const pdf = await renderInvoicePdf(model, xml);
    res
      .status(200)
      .type("application/pdf")
      .setHeader(
        "Content-Disposition",
        `attachment; filename="${model.invoiceNumber.replace(/[^A-Za-z0-9._-]/g, "_")}-${langRaw}.pdf"`,
      )
      .send(Buffer.from(pdf));
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
    const body = parseOr400(CreateInvoiceBody.safeParse(req.body));
    const out = await invoicesService.create(body, req.session?.userId ?? null);
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
    const body = parseOr400(UpdateInvoiceBody.safeParse(req.body));
    res.json(await invoicesService.update(requireIdParam(req), body));
  },
  async pay(req: Request, res: Response) {
    const body = parseOr400(PayInvoiceBody.safeParse(req.body));
    res.json(await invoicesService.pay(requireIdParam(req), body, req.session?.userId ?? null));
  },
  /** B4 — the dated payment history; backfilled rows are aggregates. */
  async payments(req: Request, res: Response) {
    res.json(await invoicesService.payments(requireIdParam(req)));
  },
  async remove(req: Request, res: Response) {
    await invoicesService.deleteDraft(requireIdParam(req));
    res.status(204).send();
  },
};
