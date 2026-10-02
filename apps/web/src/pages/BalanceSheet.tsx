import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle } from "lucide-react";
import { AsOfShortcuts } from "@/components/PeriodShortcuts";
import { useFiscalYearsQuery } from "@/hooks/useReportDefaultRange";
import { CompareSelect, ComparisonUnavailable, priorAsOfLabel, type CompareSetting } from "@/components/Comparison";
import { derivePriorAsOf, fmtPctChange } from "@/lib/priorPeriod";
import { ReportExportButtons } from "@/components/reports/ReportExport";
import { glDrillHref } from "@/lib/reportDrill";

import type { BalanceSheetReport, BalanceSheetBucket, ReportKeyedAmount } from "@workspace/api-client-react";
import { businessToday } from "@workspace/shared";

/**
 * Phase 14 — the statement of financial position (D14-05).
 *
 * - CLASSIFIED (IAS 1.60): current / non-current, and the accounts not yet
 *   classified shown as their own group — never folded into "current"
 *   (M18.2). The groups are partitions of the server's totals.
 * - EQUITY: the equity accounts, then the profit or loss not yet allocated,
 *   split by the fiscal year containing the date (prior years / current year
 *   to date). 🔴 Those computed lines are never labelled "Retained earnings" —
 *   that is the name of an ACCOUNT (the migrated balance), and the page used to
 *   show two lines with one label (F-04).
 * - 🔴 AR / AP are ordinary ledger accounts among the items. The page used to
 *   add an extra "Accounts Receivable (AR)" / "(AP)" row inside the same
 *   section, so the visible rows summed to MORE than the stated total (F-12).
 *   The AR / AP account rows now carry a marker instead.
 * - `balanced` is the SERVER's exact check, not a client recomputation.
 * - A row opens the ledger of its account from inception to the as-of date
 *   (D14-09).
 */

type Row = ReportKeyedAmount & { marker?: string };

function Rows({ rows, priorRows, comparing, asOf, testidPrefix, markers }: {
  rows: Row[]; priorRows?: Row[]; comparing: boolean; asOf: string; testidPrefix: string; markers: Map<string, string>;
}) {
  const { n } = useLanguage();
  const priorByKey = new Map((priorRows ?? []).map((r) => [r.key, r]));
  const currentKeys = new Set(rows.map((r) => r.key));
  const merged = [
    ...rows.map((r) => ({ item: r, prior: priorByKey.get(r.key)?.amount ?? 0 })),
    ...(priorRows ?? []).filter((p) => !currentKeys.has(p.key)).map((p) => ({ item: { ...p, amount: 0 }, prior: p.amount })),
  ];
  return (
    <>
      {merged.map(({ item, prior }) => {
        const marker = markers.get(item.key);
        return (
          <div key={item.key} className="flex justify-between items-center gap-2 py-1.5 px-2 hover:bg-secondary/10 rounded text-sm" data-testid={marker ? `bs-${marker}` : `${testidPrefix}-${item.key}`}>
            <span className="text-foreground flex-1 min-w-0 break-words">
              {/^\d+$/.test(item.key)
                ? <Link href={glDrillHref(Number(item.key), null, asOf)} className="hover:text-primary hover:underline" data-testid={`bs-drill-${item.key}`}>{n(item.name, item.nameAr)}</Link>
                : n(item.name, item.nameAr)}
              {marker && <span className="ms-1 text-[10px] text-muted-foreground uppercase">({marker.toUpperCase()})</span>}
            </span>
            <span className="font-mono w-28 text-end shrink-0">{fmtNum(item.amount)}</span>
            {comparing && <PriorCells current={item.amount} prior={prior} />}
          </div>
        );
      })}
    </>
  );
}

function PriorCells({ current, prior }: { current: number; prior: number }) {
  return (
    <>
      <span className="font-mono text-muted-foreground w-24 text-end shrink-0 hidden sm:inline">{fmtNum(prior)}</span>
      <span className="font-mono text-muted-foreground w-24 text-end shrink-0 hidden sm:inline">{current - prior >= 0 ? "+" : ""}{fmtNum(current - prior)}</span>
      <span className="font-mono text-muted-foreground w-16 text-end shrink-0">{fmtPctChange(current, prior)}</span>
    </>
  );
}

function Subtotal({ label, amount, prior, comparing, strong, testid }: { label: string; amount: number; prior?: number; comparing: boolean; strong?: boolean; testid?: string }) {
  return (
    <div className={`flex justify-between items-center gap-2 py-2 px-2 border-t border-border ${strong ? "font-bold" : "font-semibold"} text-sm`} data-testid={testid}>
      <span className="text-muted-foreground uppercase text-xs tracking-wide flex-1">{label}</span>
      <span className="font-mono w-28 text-end shrink-0">{fmtNum(amount)}</span>
      {comparing && <PriorCells current={amount} prior={prior ?? 0} />}
    </div>
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
  // year-end (never calendar-minus-one, which is ~11 days off a Hijri year).
  const prior = compare !== "off" ? derivePriorAsOf(applied, periods, compare) : null;
  const { data: priorData } = useQuery<BalanceSheetReport>({
    queryKey: ["balance-sheet", prior?.date],
    queryFn: () => apiFetch(`/reports/balance-sheet?as_of=${prior!.date}`),
    enabled: !!prior,
  });
  const priorEmpty = !!priorData && priorData.assets.items.length === 0 && priorData.liabilities.items.length === 0 && priorData.equity.total === 0;
  const comparing = !!prior && !!priorData && !priorEmpty;

  // AR / AP are marked on their own account rows (by the server's figure), never added again.
  const markers = new Map<string, string>();
  if (data?.assets.accountsReceivableKey) markers.set(data.assets.accountsReceivableKey, "ar");
  if (data?.liabilities.accountsPayableKey) markers.set(data.liabilities.accountsPayableKey, "ap");

  const group = (title: string, titleAr: string, cur: BalanceSheetBucket, pri: BalanceSheetBucket | undefined, prefix: string, showEmpty = false) =>
    cur.items.length === 0 && !(pri?.items.length) && !showEmpty ? null : (
      <div className="space-y-1" data-testid={prefix}>
        <div className="text-[11px] font-semibold text-muted-foreground px-2 pt-2">{t(title, titleAr)}</div>
        <Rows rows={cur.items} priorRows={comparing ? pri?.items : undefined} comparing={comparing} asOf={applied} testidPrefix={prefix} markers={markers} />
        <Subtotal label={t(`Total ${title.toLowerCase()}`, `إجمالي ${titleAr}`)} amount={cur.total} prior={pri?.total} comparing={comparing} testid={`${prefix}-total`} />
      </div>
    );

  const fy = data?.equity.fiscalYear ?? null;
  const equityComputed = (d: BalanceSheetReport): Row[] => d.equity.fiscalYear
    ? [
        { key: "pl-prior-years", name: "Profit / loss — prior fiscal years (not allocated)", nameAr: "أرباح / خسائر سنوات مالية سابقة (غير موزعة)", amount: d.equity.priorYearsProfit },
        { key: "pl-current-year", name: "Profit / loss — current fiscal year to date", nameAr: "أرباح / خسائر السنة المالية الحالية حتى تاريخه", amount: d.equity.currentYearProfit },
      ]
    : [{ key: "pl-to-date", name: "Profit / loss to date (not allocated)", nameAr: "الأرباح / الخسائر حتى تاريخه (غير موزعة)", amount: d.equity.priorYearsProfit }];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Balance Sheet", "الميزانية العمومية")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Assets = Liabilities + Equity · Statement of Financial Position", "الأصول = الخصوم + حقوق الملكية · قائمة المركز المالي")}</p>
        </div>
        <ReportExportButtons report="balance-sheet" params={{ as_of: applied, ...(comparing && prior ? { compare_as_of: prior.date } : {}) }} />
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-end gap-4">
            <div><Label className="text-xs text-muted-foreground">{t("As of Date", "بتاريخ")}</Label><Input type="date" value={asOf} onChange={e=>setAsOf(e.target.value)} className="mt-1 h-8 text-sm w-44" data-testid="bs-as-of" /></div>
            <Button size="sm" className="h-8" onClick={()=>setApplied(asOf)} data-testid="bs-generate">{t("Generate", "إنشاء")}</Button>
            <CompareSelect value={compare} onChange={setCompare} />
            <AsOfShortcuts value={asOf} onSelect={(d)=>{setAsOf(d);setApplied(d);}} />
            {data && (
              <div className={`flex items-center gap-2 ms-auto px-4 py-2 rounded-lg border ${data.balanced ? "border-positive-surface/30 bg-positive-surface/10" : "border-negative-surface/30 bg-negative-surface/10"}`} data-testid="bs-balanced">
                {data.balanced ? <CheckCircle className="w-4 h-4 text-positive" /> : <XCircle className="w-4 h-4 text-negative" />}
                <span className={`text-sm font-medium ${data.balanced ? "text-positive" : "text-negative"}`}>{data.balanced ? t("Balanced", "متوازن") : t("Check entries", "تحقق من القيود")}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {compare !== "off" && !prior && (
        <ComparisonUnavailable reason={t("No earlier fiscal year is known to compare against.", "لا توجد سنة مالية سابقة معروفة للمقارنة.")} />
      )}
      {comparing && prior && <p className="text-xs text-muted-foreground">{priorAsOfLabel(prior, lang)}</p>}
      {prior && priorEmpty && (
        <ComparisonUnavailable reason={`${t("No balances as at", "لا توجد أرصدة بتاريخ")} ${fmtDate(prior.date)} — ${t("nothing to compare against.", "لا يوجد ما يُقارن به.")}`} />
      )}

      {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Generating balance sheet...", "جارٍ التحميل...")}</div> : !data ? null : (
        <>
          {data.warning && (
            <p className="text-sm text-negative rounded-md border border-negative-surface/30 px-3 py-2" data-testid="bs-warning">{data.warning}</p>
          )}
          <div className="grid grid-cols-2 gap-4">
            {[
              [t("Total Assets", "إجمالي الأصول"), fmtNum(data.assets.total), "text-info", "bs-kpi-assets"],
              [t("Total Liabilities", "إجمالي الخصوم"), fmtNum(data.liabilities.total), "text-attention", "bs-kpi-liabilities"],
              [t("Equity", "حقوق الملكية"), fmtNum(data.equity.total), "text-purple-400", "bs-kpi-equity"],
              [t("Liab + Equity", "الخصوم + حقوق الملكية"), fmtNum(data.totalLiabilitiesAndEquity), data.balanced ? "text-positive" : "text-negative", "bs-kpi-le"],
            ].map(([l, v, c, id]) => (
              <Card key={String(l)} className="border-border bg-card">
                <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
                <CardContent><div className={`text-lg sm:text-xl font-bold font-mono ${c}`} data-testid={id}>{v}</div></CardContent>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground uppercase tracking-wide">{t("Assets", "الأصول")}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {group("Current assets", "الأصول المتداولة", data.assets.current, priorData?.assets.current, "bs-assets-current", true)}
                {group("Non-current assets", "الأصول غير المتداولة", data.assets.nonCurrent, priorData?.assets.nonCurrent, "bs-assets-noncurrent", true)}
                {group("Assets not yet classified", "أصول غير مصنفة بعد", data.assets.unclassified, priorData?.assets.unclassified, "bs-assets-unclassified")}
                <Subtotal label={t("Total assets", "إجمالي الأصول")} amount={data.assets.total} prior={priorData?.assets.total} comparing={comparing} strong testid="bs-assets-total" />
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card className="border-border bg-card">
                <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground uppercase tracking-wide">{t("Liabilities", "الخصوم")}</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {group("Current liabilities", "الخصوم المتداولة", data.liabilities.current, priorData?.liabilities.current, "bs-liab-current", true)}
                  {group("Non-current liabilities", "الخصوم غير المتداولة", data.liabilities.nonCurrent, priorData?.liabilities.nonCurrent, "bs-liab-noncurrent", true)}
                  {group("Liabilities not yet classified", "خصوم غير مصنفة بعد", data.liabilities.unclassified, priorData?.liabilities.unclassified, "bs-liab-unclassified")}
                  <Subtotal label={t("Total liabilities", "إجمالي الخصوم")} amount={data.liabilities.total} prior={priorData?.liabilities.total} comparing={comparing} strong testid="bs-liab-total" />
                </CardContent>
              </Card>

              <Card className="border-border bg-card">
                <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground uppercase tracking-wide">{t("Equity", "حقوق الملكية")}</CardTitle></CardHeader>
                <CardContent className="space-y-1" data-testid="bs-equity">
                  <Rows rows={[...data.equity.items, ...equityComputed(data)]} priorRows={comparing ? [...priorData!.equity.items, ...equityComputed(priorData!)] : undefined} comparing={comparing} asOf={applied} testidPrefix="bs-equity" markers={markers} />
                  <Subtotal label={t("Total equity", "إجمالي حقوق الملكية")} amount={data.equity.total} prior={priorData?.equity.total} comparing={comparing} testid="bs-equity-total" />
                  <p className="text-[11px] text-muted-foreground px-2 pt-1" data-testid="bs-fy-note">
                    {fy
                      ? t(`Profit not yet allocated, split by the fiscal year ${fy.startDate} – ${fy.endDate}. No closing entry is required; the ledger is unchanged.`, `الأرباح غير الموزعة مقسّمة حسب السنة المالية ${fy.startDate} – ${fy.endDate}. لا يلزم قيد إقفال؛ والدفتر لم يتغير.`)
                      : t("The fiscal year is not declared, so profit to date is shown as one line.", "لم تُحدَّد السنة المالية، لذا تظهر الأرباح حتى تاريخه في سطر واحد.")}
                  </p>
                </CardContent>
              </Card>

              <div className={`rounded-lg px-4 py-3 border flex justify-between items-center ${data.balanced ? "bg-positive-surface/10 border-positive-surface/20" : "bg-negative-surface/10 border-negative-surface/20"}`}>
                <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{t("Total Liabilities + Equity", "إجمالي الخصوم + حقوق الملكية")}</span>
                <span className={`font-mono font-bold text-lg ${data.balanced ? "text-positive" : "text-negative"}`} data-testid="bs-le-total">{fmtNum(data.totalLiabilitiesAndEquity)}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
