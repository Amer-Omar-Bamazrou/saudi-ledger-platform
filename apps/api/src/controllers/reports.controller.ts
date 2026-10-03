import type { NextFunction, Request, Response } from "express";
import { reportsService, reportParty } from "../services/reports.service";
import { exportReport } from "../services/reporting/reportExport.service";
import { BadRequestError } from "../lib/errors";

/**
 * Reports historically returned `{ error: String(err) }` with 500 on unexpected
 * failures (not the generic message). This wrapper preserves that exactly:
 * typed AppErrors (e.g. the account-statement 400) propagate to the central
 * errorHandler; anything else becomes a 500 with the stringified error.
 */
type Handler = (req: Request, res: Response) => Promise<void>;
const withReportError =
  (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err && typeof (err as { statusCode?: unknown }).statusCode === "number") {
        next(err);
        return;
      }
      req.log.error({ err });
      res.status(500).json({ error: String(err) });
    }
  };

const q = (req: Request) => req.query as Record<string, string>;

export const reportsController = {
  /**
   * D14-10 — an export runs the report's OWN service call (see
   * reportExport.service.ts): same permission, same tenant/company
   * transaction, same filters and date rules as the screen.
   */
  export: withReportError(async (req, res) => {
    const format = String(req.query.format ?? "csv");
    const lang = String(req.query.lang ?? "en");
    if (format !== "csv" && format !== "pdf") throw new BadRequestError("format must be 'csv' or 'pdf'.");
    if (lang !== "en" && lang !== "ar") throw new BadRequestError("lang must be 'en' or 'ar'.");
    const out = await exportReport(String(req.params.report), q(req), format, lang);
    res
      .status(200)
      .type(out.contentType)
      .setHeader("Content-Disposition", `attachment; filename="${out.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`)
      .send(out.body);
  }),
  trialBalance: withReportError(async (req, res) => {
    const { date_from, date_to } = q(req);
    res.json(await reportsService.trialBalance(date_from, date_to));
  }),
  incomeStatement: withReportError(async (req, res) => {
    const { date_from, date_to } = q(req);
    res.json(await reportsService.incomeStatement(date_from, date_to));
  }),
  balanceSheet: withReportError(async (req, res) => {
    res.json(await reportsService.balanceSheet(q(req).as_of));
  }),
  cashFlow: withReportError(async (req, res) => {
    const { date_from, date_to } = q(req);
    res.json(await reportsService.cashFlow(date_from, date_to));
  }),
  journalReport: withReportError(async (req, res) => {
    const { date_from, date_to } = q(req);
    res.json(await reportsService.journalReport(date_from, date_to));
  }),
  generalLedger: withReportError(async (req, res) => {
    const { account_id, account_name, date_from, date_to, party_type, customer_id, vendor_id } = q(req);
    res.json(await reportsService.generalLedger(account_id, account_name, date_from, date_to, reportParty(party_type, customer_id, vendor_id)));
  }),
  accountStatement: withReportError(async (req, res) => {
    const { account_id, account_name, date_from, date_to } = q(req);
    res.json(await reportsService.accountStatement(account_id, account_name, date_from, date_to));
  }),
  accountSummary: withReportError(async (req, res) => {
    const { date_from, date_to } = q(req);
    res.json(await reportsService.accountSummary(date_from, date_to));
  }),
  customerLedger: withReportError(async (req, res) => {
    const { customer_id, date_from, date_to } = q(req);
    res.json(await reportsService.customerLedger(customer_id, date_from, date_to));
  }),
  ownerEquity: withReportError(async (req, res) => {
    const { date_from, date_to } = q(req);
    res.json(await reportsService.ownerEquity(date_from, date_to));
  }),
  arAging: withReportError(async (req, res) => {
    res.json(await reportsService.arAging(q(req).as_of));
  }),
  apAging: withReportError(async (req, res) => {
    res.json(await reportsService.apAging(q(req).as_of));
  }),
  taxJournalEntries: withReportError(async (req, res) => {
    const { date_from, date_to } = q(req);
    res.json(await reportsService.taxJournalEntries(date_from, date_to));
  }),
  activity: withReportError(async (req, res) => {
    const { date_from, date_to } = q(req);
    res.json(await reportsService.activity(date_from, date_to));
  }),
  vatReturn: withReportError(async (req, res) => {
    const { period_from, period_to } = q(req);
    res.json(await reportsService.vatReturn(period_from, period_to));
  }),
};
