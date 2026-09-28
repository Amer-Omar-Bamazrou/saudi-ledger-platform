import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle } from "lucide-react";
import { AsOfShortcuts } from "@/components/PeriodShortcuts";
import { useFiscalYearsQuery } from "@/hooks/useReportDefaultRange";
import { CompareSelect, ComparisonUnavailable, priorAsOfLabel, type CompareSetting } from "@/components/Comparison";
import { derivePriorAsOf, fmtPctChange } from "@/lib/priorPeriod";

import type { BalanceSheetReport, ReportKeyedAmount } from "@workspace/api-client-react";
import { businessToday } from "@workspace/shared";

/**
 * 🔴 The equity accounts PLUS the retained-earnings line — because that is what
 * `equity.total` is the sum of. Until 2026-09-01 this page rendered only the
 * retained-earnings row against a total that included every equity account
 * (capital, external transfers), so the section did not foot on any tenant
 * with a capital posting. The hand-written interface had simply omitted
 * `equity.items`; the generated type made the omission a compile error.
 */
function equityRows(d: BalanceSheetReport): ReportKeyedAmount[] {
  return [
    ...d.equity.items,
    { key: "retained-earnings", name: "Retained Earnings", nameAr: "الأرباح المحتجزة", amount: d.equity.retainedEarnings },
  ];
}

/**
 * One section of the statement as a <tbody>: a sentence-case heading row, the
 * account lines indented beneath it, and the section total under a single
 * rule (or a double rule when `grand` — total assets closes its side of the
 * equation the way a printed statement does).
 */
function Section({ title, titleAr, rows, extra, total, priorRows, priorExtra, priorTotal, grand = false }: {
  title: string; titleAr: string; rows: ReportKeyedAmount[];
  extra?: { label: string; labelAr: string; amount: number }[]; total: number;
  /** F7-cmp — when present, the section renders Prior / Δ / Δ% columns, merged by KEY. */
  priorRows?: ReportKeyedAmount[];
  priorExtra?: number[];
  priorTotal?: number;
  grand?: boolean;
}) {
  const { n, t } = useLanguage();
  const comparing = priorRows !== undefined;
  const priorByKey = new Map((priorRows ?? []).map((r) => [r.key, r]));
  const currentKeys = new Set(rows.map((r) => r.key));
  const merged: { item: ReportKeyedAmount; prior: number }[] = [
    ...rows.map((r) => ({ item: r, prior: priorByKey.get(r.key)?.amount ?? 0 })),
    ...(priorRows ?? []).filter((p) => !currentKeys.has(p.key)).map((p) => ({ item: { ...p, amount: 0 }, prior: p.amount })),
  ];

  const num = "py-2 px-3 text-end whitespace-nowrap tabular-nums";
  const cells = (current: number, prior: number) =>
    !comparing ? null : (
      <>
        <td className={`${num} text-muted-foreground`}>{fmtNum(prior)}</td>
        <td className={`${num} text-muted-foreground`}>{current - prior >= 0 ? "+" : ""}{fmtNum(current - prior)}</td>
        <td className={`${num} text-muted-foreground`}>{fmtPctChange(current, prior)}</td>
      </>
    );

  return (
    <tbody>
      <tr>
        <td colSpan={comparing ? 5 : 2} className="px-3 pt-6 pb-2 text-[13px] font-semibold text-foreground">{t(title, titleAr)}</td>
      </tr>
      {merged.map(({ item, prior }) => (
        <tr key={item.key} className="hover:bg-muted/40 transition-colors">
          <td className="py-2 px-3 text-foreground"><span className="block ps-4">{n(item.name, item.nameAr)}</span></td>
          <td className={num}>{fmtNum(item.amount)}</td>
          {cells(item.amount, prior)}
        </tr>
      ))}
      {extra?.map((e, i) => (
        <tr key={`ex-${i}`} className="hover:bg-muted/40 transition-colors">
          <td className="py-2 px-3 text-foreground"><span className="block ps-4">{t(e.label, e.labelAr)}</span></td>
          <td className={num}>{fmtNum(e.amount)}</td>
          {cells(e.amount, priorExtra?.[i] ?? 0)}
        </tr>
      ))}
      <tr className={`font-semibold ${grand ? "border-t-[3px] border-double border-foreground/55" : "border-t border-border"}`}>
        <td className="py-2.5 px-3">{t("Total", "الإجمالي")} {t(title, titleAr)}</td>
        <td className={`${num} py-2.5`}>{fmtNum(total)}</td>
        {cells(total, priorTotal ?? 0)}
      </tr>
    </tbody>
  );
}

export default function BalanceSheet() {
  const { t, lang } = useLanguage();
  const [asOf, setAsOf] = useState(businessToday());
  const [applied, setApplied] = useState(businessToday());
  const [compare, setCompare] = useState<CompareSetting>("off");

  const { data: fiscalYears } = useFiscalYearsQuery();
  const periods = fiscalYears?.periods ?? [];

  const { data, isLoading } = useQuery<BalanceSheetReport>({
    queryKey: ["balance-sheet", applied],
    queryFn: () => apiFetch(`/reports/balance-sheet?as_of=${applied}`),
  });

  // F7-cmp — a fiscal year-end compares against the RESOLVER's preceding
  // year-end (never calendar-minus-one, which is ~11 days off a Hijri year);
  // a month-end stays a month-end; anything else shifts clamped, labelled.
  const prior = compare !== "off" ? derivePriorAsOf(applied, periods, compare) : null;
  const { data: priorData } = useQuery<BalanceSheetReport>({
    queryKey: ["balance-sheet", prior?.date],
    queryFn: () => apiFetch(`/reports/balance-sheet?as_of=${prior!.date}`),
    enabled: !!prior,
  });

  // Balances persist through quiet periods, so an all-empty prior sheet
  // almost always means the books did not exist at that date — but the page
  // states only the FACT (no balances), never the inference.
  const priorEmpty =
    !!priorData &&
    priorData.assets.items.length === 0 &&
    priorData.liabilities.items.length === 0 &&
    priorData.equity.total === 0;
  const comparing = !!prior && !!priorData && !priorEmpty;

  const totalLE = data ? data.liabilities.total + data.equity.total : 0;
  const balanced = data ? Math.abs(data.assets.total - totalLE) < 1 : false;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={t("Balance Sheet", "الميزانية العمومية")}
        description={t("Assets = Liabilities + Equity · Statement of Financial Position", "الأصول = الخصوم + حقوق الملكية · قائمة المركز المالي")}
        actions={data && (
          <span className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium ${balanced ? "border-positive/30 bg-positive-surface/15 text-positive" : "border-negative/30 bg-negative-surface/15 text-negative"}`}>
            {balanced ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
            {balanced ? t("Balanced", "متوازن") : t("Check entries", "تحقق من القيود")}
          </span>
        )}
      />

      <Panel>
        <div className="flex flex-wrap items-end gap-3">
          <div><Label className="text-xs text-muted-foreground">{t("As of Date", "بتاريخ")}</Label><Input type="date" value={asOf} onChange={e=>setAsOf(e.target.value)} className="mt-1 h-8 text-sm w-44" /></div>
          <Button size="sm" className="h-8" onClick={()=>setApplied(asOf)}>{t("Generate", "إنشاء")}</Button>
          <CompareSelect value={compare} onChange={setCompare} />
        </div>
        <div className="mt-3">
          <AsOfShortcuts value={asOf} onSelect={(d)=>{setAsOf(d);setApplied(d);}} />
        </div>
      </Panel>

      {compare !== "off" && !prior && (
        <ComparisonUnavailable reason={t(
          "No earlier fiscal year is known to compare against.",
          "لا توجد سنة مالية سابقة معروفة للمقارنة.",
        )} />
      )}
      {comparing && prior && <p className="text-xs text-muted-foreground">{priorAsOfLabel(prior, lang)}</p>}
      {prior && priorEmpty && (
        <ComparisonUnavailable reason={`${t("No balances as at", "لا توجد أرصدة بتاريخ")} ${fmtDate(prior.date)} — ${t("nothing to compare against.", "لا يوجد ما يُقارن به.")}`} />
      )}

      {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Generating balance sheet...", "جارٍ التحميل...")}</div> : !data ? null : (
        <>
          <StatStrip cols={4}>
            <Stat label={t("Total Assets", "إجمالي الأصول")} value={fmtNum(data.assets.total)} />
            <Stat label={t("Total Liabilities", "إجمالي الخصوم")} value={fmtNum(data.liabilities.total)} />
            <Stat label={t("Equity", "حقوق الملكية")} value={fmtNum(data.equity.total)} />
            <Stat label={t("Liab + Equity", "الخصوم + حقوق الملكية")} value={fmtNum(totalLE)} tone={balanced ? "positive" : "negative"} />
          </StatStrip>

          <Panel flush title={t("Balance Sheet", "الميزانية العمومية")} description={`${t("As of Date", "بتاريخ")} ${fmtDate(applied)}`}>
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-start px-3">{t("Account", "الحساب")}</th>
                  <th className="text-end px-3">{t("Amount", "المبلغ")}</th>
                  {comparing && <th className="text-end px-3">{t("Prior", "السابق")}</th>}
                  {comparing && <th className="text-end px-3">Δ</th>}
                  {comparing && <th className="text-end px-3">Δ%</th>}
                </tr>
              </thead>
              <Section
                title="Assets"
                titleAr="الأصول"
                grand
                rows={data.assets.items}
                extra={[{ label: "Accounts Receivable (AR)", labelAr: "ذمم مدينة (AR)", amount: data.assets.accountsReceivable }]}
                total={data.assets.total}
                priorRows={comparing ? priorData!.assets.items : undefined}
                priorExtra={comparing ? [priorData!.assets.accountsReceivable] : undefined}
                priorTotal={comparing ? priorData!.assets.total : undefined}
              />
              <Section
                title="Liabilities"
                titleAr="الخصوم"
                rows={data.liabilities.items}
                extra={[{ label: "Accounts Payable (AP)", labelAr: "ذمم دائنة (AP)", amount: data.liabilities.accountsPayable }]}
                total={data.liabilities.total}
                priorRows={comparing ? priorData!.liabilities.items : undefined}
                priorExtra={comparing ? [priorData!.liabilities.accountsPayable] : undefined}
                priorTotal={comparing ? priorData!.liabilities.total : undefined}
              />
              <Section
                title="Equity"
                titleAr="حقوق الملكية"
                rows={equityRows(data)}
                total={data.equity.total}
                priorRows={comparing ? equityRows(priorData!) : undefined}
                priorTotal={comparing ? priorData!.equity.total : undefined}
              />
              <tfoot>
                <tr className={`font-semibold ${balanced ? "text-positive" : "text-negative"}`}>
                  <td className="py-3.5 px-3">{t("Total Liabilities + Equity", "إجمالي الخصوم + حقوق الملكية")}</td>
                  <td className="py-3.5 px-3 text-end whitespace-nowrap tabular-nums text-base">{fmtNum(totalLE)}</td>
                  {comparing && <td colSpan={3} />}
                </tr>
              </tfoot>
            </table></div>
          </Panel>
        </>
      )}
    </div>
  );
}
