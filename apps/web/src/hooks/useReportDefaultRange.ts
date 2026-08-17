/**
 * The default window a report OPENS with (M20.1, design-fiscal-periods F1/F11).
 *
 * 🔴 WHY THIS EXISTS. Every report page used to open on a hardcoded
 * `${thisYear}-01-01 → -12-31` — not an absence of fiscal awareness but an
 * ACTIVE ASSERTION that the year runs January to December. A tenant whose year
 * starts in April opened the income statement on the wrong twelve months, saw a
 * plausible figure, and nothing said which period it covered relative to their
 * year (owner: "same family as the SAR 0.00 Zakat" — a confidently wrong number
 * from a premise nobody stated). The accountant research made it concrete:
 * fiscal years genuinely vary across real clients.
 *
 * The decision (F1/F11):
 *   - declared fiscal year  → open on the CURRENT fiscal year;
 *   - undeclared            → a ROLLING LAST 12 MONTHS, and the page says so —
 *     a rolling window asserts nothing about anyone's year, which is the point.
 *     Defaulting to January "just for the default" would rebuild the defect one
 *     layer up.
 *
 * This is a DATA hook, deliberately not a shared date-control component — F5
 * kept the twenty bespoke controls, and this owns only the decision they all
 * start from.
 */
import { getListFiscalYearsQueryKey, useListFiscalYears } from "@workspace/api-client-react";
import { rollingLast12Months } from "@/lib/reportRange";

/** Why the default is what it is — the page's inline message keys off this. */
export type RangeSource =
  | "fiscal" // the tenant's declared fiscal year
  | "rolling-undeclared" // no fiscal year declared — F11's message applies
  | "rolling-unknown"; // the settings fetch failed — rolling, but say nothing

export interface ReportDefaultRange {
  ready: boolean;
  /** ISO dates; empty strings until `ready`. */
  from: string;
  to: string;
  source: RangeSource;
}


export function useReportDefaultRange(): ReportDefaultRange {
  const { data, isLoading, isError } = useListFiscalYears({
    query: {
      queryKey: getListFiscalYearsQueryKey(),
      // Static between Settings edits; CompanySettings invalidates THIS key
      // (the generated one — it is not under the page's own ["company"]
      // prefix) when the declaration changes.
      staleTime: 60 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  });

  if (isLoading) return { ready: false, from: "", to: "", source: "rolling-unknown" };

  if (isError || !data) {
    // A broken settings fetch must not brick every report — but it also must
    // not claim "your fiscal year hasn't been set", because we do not KNOW
    // that. Rolling window, no message: the one state where saying less is
    // the honest option.
    const r = rollingLast12Months();
    return { ready: true, ...r, source: "rolling-unknown" };
  }

  if (data.declared && data.current) {
    return {
      ready: true,
      from: data.current.startDate,
      to: data.current.endDate,
      source: "fiscal",
    };
  }

  const r = rollingLast12Months();
  return { ready: true, ...r, source: "rolling-undeclared" };
}
