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
import { postVatFilingClearing } from "./accounting/vatFilingClearing";

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

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** A VAT return is due by the last day of the month after its period (the rule Resolution 1117's cut-off is read against). */
const returnDueOn = (periodTo: string) => addDays(monthAfter(monthAfter(periodTo).slice(0, 7)), -1);
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Decision 9: SAR 15,000 on the NET tax difference — exactly 15,000 needs notification. */
export const VAT_CORRECTION_THRESHOLD = 15_000;
const toCorrection = (row: { id: number; correctsZatcaReference: string; description: string; netTaxDifference: string; discoveredOn: string; apparentOn: string | null; createdBy: number | null; createdAt: Date }) => ({
  id: row.id, correctsZatcaReference: row.correctsZatcaReference, description: row.description, netTaxDifference: Number(row.netTaxDifference),
  discoveredOn: row.discoveredOn, apparentOn: row.apparentOn, createdBy: row.createdBy, createdAt: row.createdAt.toISOString(),
});
/** Decision 12, as recorded (register, research 2026-10-26): Resolution 1117's cut-off and condition date. */
const RESOLUTION_1117 = { dueBefore: "2026-07-01", conditionsBy: "2026-12-31" };

type Filing = { zatcaReference: string; kind: string; periodFrom: string; periodTo: string; filedOn: string };
type Correction = { correctsZatcaReference: string; netTaxDifference: number; discoveredOn: string };

/**
 * 🔴 Phase 18 G2a — OWNER DECISIONS 9, 11 AND 12 (2026-10-27): the route of the
 * corrections to each FILED return. Pure; one definition.
 *  - 9: every error of one return is AGGREGATED (an amendment's errors count to
 *    the return it amends); the threshold reads the NET; exactly 15,000 counts;
 *    errors in two or more returns are flagged for review.
 *  - 11 (Art. 63): at or above the threshold, amend the original and notify
 *    within 20 days of the discovery that reached it; below it, the return for
 *    the period of discovery (Art. 63(3), in force since 18 Apr 2025); where
 *    that return is already filed, the user's choice, with a note to obtain
 *    ZATCA's direction. Nothing is automated.
 *  - 12: no Art. 42(2) waiver is automated; Resolution 1117's recorded
 *    conditions apply to a return DUE before 1 July 2026.
 */
export function assessVatCorrections(filings: Filing[], corrections: Correction[]) {
  const periodOf = new Map(filings.map((f) => [f.zatcaReference, `${f.periodFrom}|${f.periodTo}`]));
  const covers = (month: string) => filings.some((f) => f.periodFrom <= month && month <= f.periodTo);
  const originals = filings.filter((f) => f.kind === "original");
  const byPeriod = new Map<string, Correction[]>();
  for (const c of corrections) {
    const key = periodOf.get(c.correctsZatcaReference);
    if (key) byPeriod.set(key, [...(byPeriod.get(key) ?? []), c]);
  }
  const repeatedErrors = byPeriod.size >= 2;
  return originals.map((f) => {
    const errs = [...(byPeriod.get(`${f.periodFrom}|${f.periodTo}`) ?? [])].sort((a, b) => a.discoveredOn.localeCompare(b.discoveredOn));
    const net = r2(errs.reduce((s, c) => s + c.netTaxDifference, 0));
    const dueOn = returnDueOn(f.periodTo);
    const base = {
      zatcaReference: f.zatcaReference, periodFrom: f.periodFrom, periodTo: f.periodTo, filedOn: f.filedOn, dueOn,
      errors: errs.length, netTaxDifference: net, repeatedErrors: errs.length > 0 && repeatedErrors,
      penaltyWaiverAutomated: false as const,
      resolution1117: { returnDueOn: dueOn, mayQualify: dueOn < RESOLUTION_1117.dueBefore, conditionsBy: RESOLUTION_1117.conditionsBy },
    };
    if (errs.length === 0) return { ...base, route: null, notifyBy: null, discoveryPeriod: null, discoveryReturnFiled: null, routeNote: null };
    if (Math.abs(net) >= VAT_CORRECTION_THRESHOLD) {
      let running = 0;
      const reached = errs.find((c) => Math.abs((running = r2(running + c.netTaxDifference))) >= VAT_CORRECTION_THRESHOLD) ?? errs[errs.length - 1]!;
      const notifyBy = addDays(reached.discoveredOn, 20);
      return { ...base, route: "amend_and_notify" as const, notifyBy, discoveryPeriod: null, discoveryReturnFiled: null,
        routeNote: `The net tax difference (${net.toFixed(2)}) reaches SAR 15,000: amend the original return and notify ZATCA by ${notifyBy} (VAT IR Art. 63(1)).` };
    }
    const discoveryPeriod = errs[errs.length - 1]!.discoveredOn.slice(0, 7);
    const filed = covers(discoveryPeriod);
    return { ...base, route: filed ? ("user_choice" as const) : ("discovery_period_return" as const), notifyBy: null, discoveryPeriod, discoveryReturnFiled: filed,
      routeNote: filed
        ? `Below SAR 15,000, the correction belongs in the return for the period of discovery (${discoveryPeriod}), which is already filed. Choose how to correct it, and obtain ZATCA's direction first. Nothing is done automatically.`
        : `Below SAR 15,000: include the correction in the return for the period of discovery, ${discoveryPeriod} (VAT IR Art. 63(3)).` };
  });
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
    // 🔴 Phase 18 G2b (A5(c)): the filing posts the entry clearing output and input VAT to VAT payable
    // (receivable) — in this same transaction, so a refused posting (a closed month) records no filing.
    const clearing = await postVatFilingClearing({ ...row!, filedOn: String(row!.filedOn) });
    return { ...row!, clearing };
  },

  /** Phase 18 G2a: every error found in a filed return, and the route of each return's corrections. */
  async vatCorrections() {
    const [filings, rows] = await Promise.all([periodRecordsRepository.vatFilings(), periodRecordsRepository.vatCorrections()]);
    const items = rows.map(toCorrection);
    return { items, returns: assessVatCorrections(filings, items) };
  },

  /**
   * 🔴 Phase 18 G2a — an error found in a FILED VAT return, recorded (never
   * changed). Decision 10: the ACTUAL discovery date is required — real, never
   * in the future, never before the corrected period ends; an earlier date on
   * which it arguably became apparent is kept separately, never after it.
   * Recording it routes nothing and posts nothing (decision 11).
   */
  async recordVatCorrection(body: Record<string, unknown>, userId: number | null) {
    const reference = text(body.correctsZatcaReference);
    if (!reference) throw new BusinessRuleError(400, { code: "reference_required", error: "Name the ZATCA reference of the filed return the error is in.", field: "correctsZatcaReference" });
    const description = text(body.description);
    if (!description) throw new BusinessRuleError(400, { code: "description_required", error: "Describe the error found.", field: "description" });
    const net = typeof body.netTaxDifference === "number" ? body.netTaxDifference : Number.NaN;
    if (!Number.isFinite(net)) throw new BusinessRuleError(400, { code: "net_tax_difference_invalid", error: "netTaxDifference is a number: + where the tax was understated, − where it was overstated.", field: "netTaxDifference" });
    if (body.discoveredOn == null || body.discoveredOn === "") {
      throw new BusinessRuleError(400, { code: "discovered_on_required", error: "Enter the date the error was actually discovered.", field: "discoveredOn" });
    }
    if (typeof body.discoveredOn !== "string" || !isCalendarDate(body.discoveredOn)) refuse("date_invalid", "discoveredOn is a real calendar date (YYYY-MM-DD).", "discoveredOn");
    const discoveredOn = body.discoveredOn as string;
    if (discoveredOn > businessToday()) refuse("discovered_on_in_future", "The discovery date has already happened: it is never in the future.", "discoveredOn");
    const [filing] = await periodRecordsRepository.vatFilingByReference(reference);
    if (!filing) refuse("corrected_filing_not_found", `No VAT filing with the reference ${reference} is recorded for this company.`, "correctsZatcaReference");
    if (discoveredOn < monthAfter(filing!.periodTo)) {
      refuse("discovered_before_period_end", `An error in the return for ${filing!.periodFrom}–${filing!.periodTo} is discovered after that period ends.`, "discoveredOn");
    }
    let apparentOn: string | null = null;
    if (body.apparentOn != null && body.apparentOn !== "") {
      if (typeof body.apparentOn !== "string" || !isCalendarDate(body.apparentOn)) refuse("date_invalid", "apparentOn is a real calendar date (YYYY-MM-DD).", "apparentOn");
      apparentOn = body.apparentOn as string;
      if (apparentOn > discoveredOn) refuse("apparent_after_discovery", "The date the error arguably became apparent is on or before the date it was actually discovered.", "apparentOn");
    }
    if (r2(net) === 0) refuse("net_tax_difference_zero", "An error with no tax difference changes no return: nothing to record.", "netTaxDifference");
    const [row] = await periodRecordsRepository.insertVatCorrection({
      correctsZatcaReference: filing!.zatcaReference, description, netTaxDifference: r2(net).toFixed(2), discoveredOn, apparentOn, createdBy: userId,
    });
    await auditService.created("vat_correction", row!.id, row);
    return toCorrection(row!);
  },

  /** Phase 18 G2a (A5(a)): the VAT entries recorded after a filing, dated in its period. */
  async entriesAfterFiling() {
    return { items: await periodRecordsRepository.entriesAfterFiling() };
  },

  /**
   * Phase 18 G2a (A5(a)): the filed VAT return whose period holds `date`, or
   * null. A document dated there is allowed; its read carries this, and the
   * screen warns that an Art. 63 correction may be needed.
   */
  async filedVatPeriodOf(date: string | null | undefined) {
    if (!date) return null;
    const month = date.slice(0, 7);
    const f = (await periodRecordsRepository.vatFilings()).find((x) => x.kind === "original" && x.periodFrom <= month && month <= x.periodTo);
    return f ? { zatcaReference: f.zatcaReference, periodFrom: f.periodFrom, periodTo: f.periodTo, filedOn: f.filedOn } : null;
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
