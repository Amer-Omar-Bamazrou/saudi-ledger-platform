/**
 * 🔴 T1e (Phase 18; DR-10 — owner 2026-10-24: "build all the records it lists,
 * append-only"): the facts a period's corrections and reopenings key on, as the
 * tenant states them:
 *  - a filed VAT return (a month or a quarter) — VAT Regulations Art. 63 needs it;
 *  - a filed Zakat or income-tax return, per fiscal year;
 *  - the date a fiscal year's statements were authorised for issue, and who
 *    authorised them (IAS 10.17). DR-30 reads it: no month of that year reopens.
 * Recording a fact changes no other behaviour; the guards that act on the
 * filings (DR-11 warning, DR-38 settlement) are built in their own batches.
 */
import { businessToday, isCalendarDate } from "@workspace/shared";
import { BusinessRuleError } from "../lib/errors";
import { fiscalYearContaining, isFiscalCalendar, type FiscalCalendar } from "../lib/fiscalYear";
import { companiesRepository } from "../repositories/companies.repository";
import { periodRecordsRepository } from "../repositories/periodRecords.repository";
import { auditService } from "./audit.service";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const refuse = (code: string, error: string, field?: string): never => {
  throw new BusinessRuleError(422, { code, error, ...(field ? { field } : {}) });
};
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const monthAfter = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
};
const monthsBetween = (from: string, to: string) => {
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm) + 1;
};
function pastDate(v: unknown, field: string, what: string): string {
  if (typeof v !== "string" || !isCalendarDate(v)) refuse("date_invalid", `${what} is a real calendar date (YYYY-MM-DD).`, field);
  if ((v as string) > businessToday()) refuse("date_in_future", `${what} has already happened: it is never in the future.`, field);
  return v as string;
}
function kindOf(body: Record<string, unknown>): { kind: "original" | "amendment"; amends: string | null } {
  const kind = body.kind === undefined || body.kind === null ? "original" : body.kind;
  if (kind !== "original" && kind !== "amendment") refuse("kind_invalid", "kind is original or amendment.", "kind");
  const amends = text(body.amendsZatcaReference);
  if (kind === "amendment" && !amends) refuse("amends_required", "An amendment names the ZATCA reference of the filing it amends.", "amendsZatcaReference");
  if (kind === "original" && amends) refuse("amends_on_original", "An original filing amends nothing; leave the amended reference empty.", "amendsZatcaReference");
  return { kind: kind as "original" | "amendment", amends };
}
/** The company's declared fiscal year ending on `end`, or a refusal naming what is missing. */
async function fiscalYearEndingOn(end: string, field: string) {
  const company = await companiesRepository.findCurrent();
  if (company?.fiscalYearStart == null) {
    refuse("fiscal_year_not_declared", "The company has not declared its fiscal year. Declare it in Company Settings first.", field);
  }
  const settings = { fiscalYearStart: company!.fiscalYearStart!, calendar: (isFiscalCalendar(company!.fiscalCalendar) ? company!.fiscalCalendar : "gregorian") as FiscalCalendar };
  const year = fiscalYearContaining(settings, end);
  if (year.endDate !== end) refuse("not_fiscal_year_end", `${end} is not the end of a fiscal year: the fiscal year containing it ends on ${year.endDate}.`, field);
  return year;
}

export const periodRecordsService = {
  async vatFilings() {
    return periodRecordsRepository.vatFilings();
  },

  async recordVatFiling(body: Record<string, unknown>, userId: number | null) {
    const periodFrom = body.periodFrom, periodTo = body.periodTo;
    if (typeof periodFrom !== "string" || !MONTH.test(periodFrom)) refuse("period_invalid", "periodFrom is a real month (YYYY-MM).", "periodFrom");
    if (typeof periodTo !== "string" || !MONTH.test(periodTo)) refuse("period_invalid", "periodTo is a real month (YYYY-MM).", "periodTo");
    const span = monthsBetween(periodFrom as string, periodTo as string);
    if (span < 1 || span > 3) refuse("period_invalid", "A VAT return covers one month or a quarter: periodFrom to periodTo is 1 to 3 months.", "periodTo");
    const filedOn = pastDate(body.filedOn, "filedOn", "The filing date");
    if (filedOn < monthAfter(periodTo as string)) refuse("filed_before_period_end", `A return for ${periodFrom}–${periodTo} is filed after ${periodTo} ends.`, "filedOn");
    const zatcaReference = text(body.zatcaReference);
    if (!zatcaReference || zatcaReference.length < 3) refuse("reference_required", "The ZATCA reference of the filing is required.", "zatcaReference");
    const { kind, amends } = kindOf(body);
    if (amends && (await periodRecordsRepository.vatFilingByReference(amends)).length === 0) {
      refuse("amended_filing_not_found", `No VAT filing with the reference ${amends} is recorded for this company.`, "amendsZatcaReference");
    }
    const [row] = await periodRecordsRepository.insertVatFiling({
      periodFrom: periodFrom as string, periodTo: periodTo as string, kind, amendsZatcaReference: amends,
      filedOn, zatcaReference: zatcaReference!, notes: text(body.notes), createdBy: userId,
    });
    await auditService.created("vat_return_filing", row!.id, row);
    return row!;
  },

  async zakatIncomeTaxFilings() {
    return periodRecordsRepository.zakatIncomeTaxFilings();
  },

  async recordZakatIncomeTaxFiling(body: Record<string, unknown>, userId: number | null) {
    const tax = body.kind === "zakat" || body.kind === "income_tax" ? body.kind : body.tax;
    if (tax !== "zakat" && tax !== "income_tax") refuse("tax_invalid", "The return is zakat or income_tax.", "kind");
    if (typeof body.fiscalYearEnd !== "string" || !isCalendarDate(body.fiscalYearEnd)) refuse("date_invalid", "fiscalYearEnd is a real calendar date (YYYY-MM-DD).", "fiscalYearEnd");
    const year = await fiscalYearEndingOn(body.fiscalYearEnd as string, "fiscalYearEnd");
    const filedOn = pastDate(body.filedOn, "filedOn", "The filing date");
    if (filedOn <= year.endDate) refuse("filed_before_year_end", `A return for the year ending ${year.endDate} is filed after that day.`, "filedOn");
    const zatcaReference = text(body.zatcaReference);
    if (!zatcaReference || zatcaReference.length < 3) refuse("reference_required", "The ZATCA reference of the filing is required.", "zatcaReference");
    const filing = kindOf({ kind: body.filingKind, amendsZatcaReference: body.amendsZatcaReference });
    if (filing.amends && (await periodRecordsRepository.zakatIncomeTaxFilingByReference(filing.amends)).length === 0) {
      refuse("amended_filing_not_found", `No Zakat or income-tax filing with the reference ${filing.amends} is recorded for this company.`, "amendsZatcaReference");
    }
    const [row] = await periodRecordsRepository.insertZakatIncomeTaxFiling({
      tax: tax as string, fiscalYearEnd: year.endDate, kind: filing.kind, amendsZatcaReference: filing.amends,
      filedOn, zatcaReference: zatcaReference!, notes: text(body.notes), createdBy: userId,
    });
    await auditService.created("zakat_income_tax_filing", row!.id, row);
    return row!;
  },

  async authorisations() {
    return periodRecordsRepository.authorisations();
  },

  async recordAuthorisation(body: Record<string, unknown>, userId: number | null) {
    if (typeof body.fiscalYearEnd !== "string" || !isCalendarDate(body.fiscalYearEnd)) refuse("date_invalid", "fiscalYearEnd is a real calendar date (YYYY-MM-DD).", "fiscalYearEnd");
    const year = await fiscalYearEndingOn(body.fiscalYearEnd as string, "fiscalYearEnd");
    const authorisedOn = pastDate(body.authorisedOn, "authorisedOn", "The authorisation date");
    if (authorisedOn <= year.endDate) refuse("authorised_before_year_end", `Statements for the year ending ${year.endDate} are authorised after that day (IAS 10).`, "authorisedOn");
    const authorisedBy = text(body.authorisedBy);
    if (!authorisedBy || authorisedBy.length < 2) refuse("authorised_by_required", "Say who authorised the statements for issue (IAS 10.17), for example the board of directors.", "authorisedBy");
    const [row] = await periodRecordsRepository.insertAuthorisation({
      fiscalYearStart: year.startDate, fiscalYearEnd: year.endDate, authorisedOn, authorisedBy: authorisedBy!, notes: text(body.notes), recordedBy: userId,
    });
    await auditService.created("statement_authorisation", row!.id, row);
    return row!;
  },
};
