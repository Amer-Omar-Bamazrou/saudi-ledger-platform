/**
 * Period shortcuts on the report date controls (M20.2, F2/F6/F12).
 *
 * F6 — a shortcut, never a mode: picking one SETS the dates (and applies
 * them); the inputs stay editable, and which chip is lit is DERIVED by
 * comparing the current inputs against each shortcut's range — so "Custom
 * when touched" needs no state to get stale. Editing an input simply stops
 * anything matching.
 *
 * F12 — six shortcuts: This month / Last month / This quarter / Last quarter /
 * This fiscal year / Last fiscal year. Month and quarter are CALENDAR periods
 * (the filing rhythm — see the note in lib/reportRange.ts); the two fiscal
 * ones use the resolver's boundaries via the API, never recomputed here, and
 * are simply absent while no fiscal year is declared — the FiscalRangeNotice
 * on the same page already says why and where to fix it. F5 kept the twenty
 * bespoke date CONTROLS; this bar is a new, single-purpose strip beside them,
 * not a unification of them.
 */
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { type DateRange, lastMonth, lastQuarter, thisMonth, thisQuarter } from "@/lib/reportRange";
import { useFiscalYearsQuery } from "@/hooks/useReportDefaultRange";

interface Shortcut {
  key: string;
  label: string;
  range: DateRange;
}

/** The tenant's current and immediately preceding fiscal periods, if declared. */
function useFiscalPair(): { current: DateRange | null; previous: DateRange | null } {
  const { data } = useFiscalYearsQuery();
  if (!data?.declared || !data.current) return { current: null, previous: null };
  const cur = { from: data.current.startDate, to: data.current.endDate };
  // `periods` is newest first, a window either side of current — the first
  // entry ending before the current period starts is the one just before it.
  const prev = data.periods.find((p) => p.endDate < data.current!.startDate);
  return { current: cur, previous: prev ? { from: prev.startDate, to: prev.endDate } : null };
}

export function PeriodShortcuts({
  from,
  to,
  onSelect,
  granularity = "day",
}: {
  from: string;
  to: string;
  onSelect: (range: DateRange) => void;
  /** "month" trims ranges to YYYY-MM for the VAT page's month inputs. */
  granularity?: "day" | "month";
}) {
  const { t } = useLanguage();
  const fiscal = useFiscalPair();

  const trim = (r: DateRange): DateRange =>
    granularity === "month" ? { from: r.from.slice(0, 7), to: r.to.slice(0, 7) } : r;

  const shortcuts: Shortcut[] = [
    { key: "this-month", label: t("This month", "هذا الشهر"), range: trim(thisMonth()) },
    { key: "last-month", label: t("Last month", "الشهر الماضي"), range: trim(lastMonth()) },
    { key: "this-quarter", label: t("This quarter", "هذا الربع"), range: trim(thisQuarter()) },
    { key: "last-quarter", label: t("Last quarter", "الربع الماضي"), range: trim(lastQuarter()) },
    ...(fiscal.current
      ? [{ key: "this-fy", label: t("This fiscal year", "السنة المالية الحالية"), range: trim(fiscal.current) }]
      : []),
    ...(fiscal.previous
      ? [{ key: "last-fy", label: t("Last fiscal year", "السنة المالية الماضية"), range: trim(fiscal.previous) }]
      : []),
  ];

  const activeKey = shortcuts.find((s) => s.range.from === from && s.range.to === to)?.key;

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("Period shortcuts", "اختصارات الفترات")}>
      {shortcuts.map((s) => (
        <Button
          key={s.key}
          size="sm"
          variant={s.key === activeKey ? "secondary" : "ghost"}
          className="h-7 px-2 text-xs"
          onClick={() => onSelect(s.range)}
        >
          {s.label}
        </Button>
      ))}
      {!activeKey && (
        <span className="h-7 px-2 inline-flex items-center text-xs text-muted-foreground border border-border rounded-md">
          {t("Custom", "مخصص")}
        </span>
      )}
    </div>
  );
}

/**
 * The Balance Sheet's as-of shortcuts (F2): "as at FY-end", offered for both
 * the current fiscal year (the date this year's statement will carry) and the
 * previous one (the completed year's statement). Absent while undeclared —
 * there is no fiscal fact to offer.
 */
export function AsOfShortcuts({ value, onSelect }: { value: string; onSelect: (date: string) => void }) {
  const { t } = useLanguage();
  const fiscal = useFiscalPair();

  const shortcuts = [
    ...(fiscal.current ? [{ key: "fy-end", label: t("This FY-end", "نهاية السنة المالية الحالية"), date: fiscal.current.to }] : []),
    ...(fiscal.previous ? [{ key: "last-fy-end", label: t("Last FY-end", "نهاية السنة المالية الماضية"), date: fiscal.previous.to }] : []),
  ];
  if (shortcuts.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("Date shortcuts", "اختصارات التاريخ")}>
      {shortcuts.map((s) => (
        <Button
          key={s.key}
          size="sm"
          variant={s.date === value ? "secondary" : "ghost"}
          className="h-7 px-2 text-xs"
          onClick={() => onSelect(s.date)}
        >
          {s.label}
        </Button>
      ))}
    </div>
  );
}
