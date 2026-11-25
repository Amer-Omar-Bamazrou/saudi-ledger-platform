import type { NextFunction, Request, Response } from "express";
import { reportsService, reportParty } from "../services/reports.service";
import { exportReport } from "../services/reporting/reportExport.service";
import { BadRequestError } from "../lib/errors";
import { peekPermissions } from "../lib/rbac";
import { deciderFor } from "../lib/fieldClasses/seam";
import { DATASETS, JOURNAL_LINES } from "../lib/reports/datasets";
import type { Has } from "../lib/reports/decide";
import { reportDatasetsService } from "../services/reporting/reportDatasets.service";

/**
 * 🔴 The error-handling work package (2026-11-17): every failure goes to the central errorHandler. This wrapper used
 * to answer an unexpected failure with `{ error: String(err) }` — the exception's own text (a SQL message, a table
 * name) sent to the browser. The central boundary logs it with the request id and answers `internal_error` in the one
 * safe shape; a typed AppError (e.g. the account-statement 400) and A29's ended-transaction refusal are handled there
 * exactly as before.
 */
type Handler = (req: Request, res: Response) => Promise<void>;
export const withReportError =
  (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

const q = (req: Request) => req.query as Record<string, string>;

/** 19B S4: the role's grants, as decide() asks them — from the one matrix, the cache `requirePermission` just read. */
const hasFor = (req: Request): Has => {
  const role = req.tenant?.role;
  const grants = peekPermissions();
  return (resource, action) => !!role && !!grants && grants.has(`${role}:${resource}:${action}`);
};

export const reportsController = {
  /** 19B S4: the datasets this role may run, its acts on each, each column's level. */
  datasets: withReportError(async (req, res) => {
    res.json(reportDatasetsService.list(hasFor(req)));
  }),
  journalLinesRows: withReportError(async (req, res) => {
    res.json(await reportDatasetsService.journalLinesRows(JOURNAL_LINES, hasFor(req), q(req)));
  }),
  journalLinesExport: withReportError(async (req, res) => {
    const lang = String(req.query.lang ?? "en");
    if (lang !== "en" && lang !== "ar") throw new BadRequestError("lang must be 'en' or 'ar'.");
    const t = req.tenant!;
    const out = await reportDatasetsService.journalLinesExport(JOURNAL_LINES, hasFor(req), { userId: t.userId, organizationId: t.organizationId, companyId: t.companyId }, q(req), lang, deciderFor(t.role, peekPermissions()));
    // never cached: an export is report data, and the browser's cache is no place to keep it
    res.setHeader("Cache-Control", "no-store");
    res
      .status(200)
      .type(out.contentType)
      .setHeader("Content-Disposition", `attachment; filename="${out.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`)
      .send(out.body);
  }),
  /** 19B S5: a remaining dataset's rows, by name — decide() decides the role, the act and each column. */
  datasetRows: (name: string) => withReportError(async (req, res) => {
    res.json(await reportDatasetsService.rows(DATASETS[name]!, hasFor(req), q(req)));
  }),
  /** 19B S5: a remaining dataset's CSV, by name — recorded before it is sent, never cached. */
  datasetExport: (name: string) => withReportError(async (req, res) => {
    const lang = String(req.query.lang ?? "en");
    if (lang !== "en" && lang !== "ar") throw new BadRequestError("lang must be 'en' or 'ar'.");
    const t = req.tenant!;
    const out = await reportDatasetsService.export(DATASETS[name]!, hasFor(req), { userId: t.userId, organizationId: t.organizationId, companyId: t.companyId }, q(req), lang, deciderFor(t.role, peekPermissions()));
    res.setHeader("Cache-Control", "no-store");
    res
      .status(200)
      .type(out.contentType)
      .setHeader("Content-Disposition", `attachment; filename="${out.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`)
      .send(out.body);
  }),
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
    const out = await exportReport(String(req.params.report), q(req), format, lang, deciderFor(req.tenant?.role, peekPermissions()));
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
