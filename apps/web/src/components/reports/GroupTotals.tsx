/**
 * 🔴 19B 19.12 — A GROUPED REPORT'S SUBTOTALS, as the server worked them out (the builder and an opened delivered copy
 * share this). The screen adds nothing up: every figure here is the response's. A total the role is not given is marked
 * withheld in its place, never shown as zero; where the report has no grand total, that is said in words.
 */
import type { ReportDatasetColumn, ReportDatasetGroup, ReportDatasetTotals, ReportDatasetWithheld } from "@workspace/api-client-react";
import { fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";

const TOTAL_PATH = "groups[].totals.";

export interface GroupTotalsProps {
  groupedBy: string;
  groups: ReportDatasetGroup[];
  grandTotal: ReportDatasetTotals | null | undefined;
  columns: ReportDatasetColumn[];
  withheld: ReportDatasetWithheld[];
  /** Every column of the dataset, for naming a grouping column the report does not show. */
  names?: ReportDatasetColumn[];
  testId: string;
}

export function GroupTotals({ groupedBy, groups, grandTotal, columns, withheld, names, testId }: GroupTotalsProps) {
  const { t, lang } = useLanguage();
  const name = (key: string) => { const c = [...columns, ...(names ?? [])].find((x) => x.key === key); return c ? (lang === "ar" ? c.labelAr : c.label) : key; };
  const withheldKeys = withheld.filter((w) => w.path.startsWith(TOTAL_PATH)).map((w) => w.path.slice(TOTAL_PATH.length));
  const totalled = [...new Set([...groups, ...(grandTotal ? [grandTotal] : [])].flatMap((g) => g.totals.map((x) => x.column)))];
  // in the order the report shows its columns
  const keys = columns.map((c) => c.key).filter((k) => totalled.includes(k) || withheldKeys.includes(k));
  const by = [...columns, ...(names ?? [])].find((c) => c.key === groupedBy);
  const byMonth = by?.kind === "date";
  const mixed = [...groups, ...(grandTotal ? [grandTotal] : [])].some((g) => g.mixedCurrency);

  const figure = (g: ReportDatasetTotals, key: string) => {
    if (withheldKeys.includes(key)) return <span className="text-[11px] text-muted-foreground italic" data-testid={`${testId}-withheld`}>{t("withheld", "محجوب")}</span>;
    const x = g.totals.find((y) => y.column === key);
    return x ? fmtNum(x.total) : "—";
  };

  return (
    <div className="pb-4" data-testid={testId}>
      <h2 className="text-sm font-semibold text-foreground pb-2">
        {t(`Subtotals by ${name(groupedBy)}${byMonth ? " (month)" : ""}`, `المجاميع الفرعية حسب ${name(groupedBy)}${byMonth ? " (الشهر)" : ""}`)}
      </h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground border-b border-border">
            <th className="text-start py-2 pe-3 font-medium">{name(groupedBy)}</th>
            <th className="text-start py-2 pe-3 font-medium">{t("Rows", "السطور")}</th>
            {keys.map((k) => <th key={k} className="text-start py-2 pe-3 font-medium">{name(k)}</th>)}
          </tr>
        </thead>
        <tbody>
          {groups.map((g, i) => (
            <tr key={i} className="border-b border-border/50" data-testid={`${testId}-group`}>
              <td className="py-2 pe-3">
                {g.key == null ? <span className="text-muted-foreground">{t("(none)", "(بدون قيمة)")}</span> : <><span dir="ltr">{g.key}</span>{g.label ? <span className="text-muted-foreground"> · {g.label}</span> : null}</>}
              </td>
              <td className="py-2 pe-3"><span dir="ltr">{g.count}</span></td>
              {keys.map((k) => <td key={k} className="py-2 pe-3 font-mono">{figure(g, k)}</td>)}
            </tr>
          ))}
          {grandTotal && (
            <tr className="border-t-2 border-border font-semibold" data-testid={`${testId}-grand`}>
              <td className="py-2 pe-3">{t("Total", "الإجمالي")}</td>
              <td className="py-2 pe-3"><span dir="ltr">{grandTotal.count}</span></td>
              {keys.map((k) => <td key={k} className="py-2 pe-3 font-mono">{figure(grandTotal, k)}</td>)}
            </tr>
          )}
        </tbody>
      </table>
      {!grandTotal && (
        <p className="text-xs text-muted-foreground pt-2" data-testid={`${testId}-no-grand`}>
          {t("This report has no grand total: a total over all its rows would not be a figure of the books.", "لا يوجد إجمالي عام لهذا التقرير: مجموع كل سطوره ليس رقماً من أرقام الدفاتر.")}
        </p>
      )}
      {withheldKeys.length > 0 && (
        <p className="text-xs text-muted-foreground pt-2">{t("A total of a value withheld for your role is not worked out.", "مجموع القيمة المحجوبة لدورك لا يُحسب.")}</p>
      )}
      {mixed && <p className="text-xs text-muted-foreground pt-2">{t("A set that mixes currencies has no money total.", "المجموعة التي تختلط فيها العملات ليس لها مجموع مالي.")}</p>}
      <p className="text-[11px] text-muted-foreground pt-2">{t("Subtotals cover every row of the period, not only the page below.", "المجاميع الفرعية تشمل كل سطور الفترة، لا الصفحة أدناه فقط.")}</p>
    </div>
  );
}
