import type { Request, Response } from "express";
import { CreateSupplierAdvanceInvoiceBody, CreateSupplierAdvanceCreditNoteBody } from "@workspace/api-zod";
import { supplierAdvanceInvoicesService } from "../services/accounting/supplierAdvanceInvoices.service";
import { billsService } from "../services/bills.service";
import { requireIdParam } from "../lib/httpParams";
import { BadRequestError } from "../lib/errors";

const userOf = (req: Request) => req.session?.userId ?? null;
const parse = <T,>(r: { success: true; data: T } | { success: false; error: { message: string } }): T => {
  if (!r.success) throw new BadRequestError(r.error.message);
  return r.data;
};

/**
 * Z-AP1 — the supplier's advance tax invoice and its credit note are RECORDED
 * here as drafts; they are approved through the one bill approval path
 * (POST /bills/{id}/approve), which claims or reverses their input VAT.
 */
export const supplierAdvanceInvoicesController = {
  async createAdvanceInvoice(req: Request, res: Response) {
    const body = parse(CreateSupplierAdvanceInvoiceBody.safeParse(req.body));
    const bill = await supplierAdvanceInvoicesService.createFromPayment(requireIdParam(req), body, userOf(req));
    res.status(201).json(await billsService.getById(bill.id));
  },
  async createAdvanceCreditNote(req: Request, res: Response) {
    const body = parse(CreateSupplierAdvanceCreditNoteBody.safeParse(req.body));
    const note = await supplierAdvanceInvoicesService.createCreditNote(requireIdParam(req), body, userOf(req));
    res.status(201).json(await billsService.getById(note.id));
  },
  async openForVendor(req: Request, res: Response) {
    const rows = await supplierAdvanceInvoicesService.openForVendor(requireIdParam(req));
    res.json({
      items: rows.map((i) => ({
        id: i.id, billNumber: i.billNumber, supplierReference: i.vendorReference, date: i.date, vatRate: i.vatRate,
        total: i.total, taxable: i.taxable, tax: i.tax, credited: i.credited, adjusted: i.adjusted, open: i.open, openTax: i.openTax,
      })),
    });
  },
};
