import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
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

interface BSItem { key: string; name: string; nameAr?: string; amount: number; }
interface BSData {
  assets: { items: BSItem[]; accountsReceivable: number; total: number };
  liabilities: { items: BSItem[]; accountsPayable: number; total: number };
  equity: { retainedEarnings: number; total: number };
  totalLiabilitiesAndEquity: number;
  asOf: string;
}

function Section({ title, titleAr, color, rows, extra, total, priorRows, priorExtra, priorTotal }: {
  title: string; titleAr: string; color: string; rows: BSItem[];
  extra?: { label: string; labelAr: string; amount: number }[]; total: number;
  /** F7-cmp — when present, the section renders Prior / Δ / Δ% columns, merged by KEY. */
  priorRows?: BSItem[];
  priorExtra?: number[];
  priorTotal?: number;
}) {
  const { n, t } = useLanguage();
  const comparing = priorRows !== undefined;
  const priorByKey = new Map((priorRows ?? []).map((r) => [r.key, r]));
  const currentKeys = new Set(rows.map((r) => r.key));
  const merged: { item: BSItem; prior: number }[] = [
    ...rows.map((r) => ({ item: r, prior: priorByKey.get(r.key)?.amount ?? 0 })),
    ...(priorRows ?? []).filter((p) => !currentKeys.has(p.key)).map((p) => ({ item: { ...p, amount: 0 }, prior: p.amount })),
  ];

  const cells = (current: number, prior: number) =>
    !comparing ? null : (
      <>
        <span className="font-mono text-muted-foreground w-24 text-end shrink-0">{fmtNum(prior)}</span>
        <span className="font-mono text-muted-foreground w-24 text-end shrink-0">{current - prior >= 0 ? "+" : ""}{fmtNum(current - prior)}</span>
        <span className="font-mono text-muted-foreground w-16 text-end shrink-0">{fmtPctChange(current, prior)}</span>
      </>
    );

  return (
    <div className="space-y-1">
      <div className={`text-xs font-bold uppercase tracking-widest py-2 px-2 rounded ${color}`}>{t(title, titleAr)}</div>
      {comparing && (
        <div className="flex justify-end gap-0 px-2 text-[10px] uppercase text-muted-foreground">
          <span className="w-24 text-end shrink-0">{t("Prior", "السابق")}</span>
          <span className="w-24 text-end shrink-0">Δ</span>
          <span className="w-16 text-end shrink-0">Δ%</span>
        </div>
      )}
      {merged.map(({ item, prior }) => (
        <div key={item.key} className="flex justify-between items-center gap-2 py-1.5 px-2 hover:bg-secondary/10 rounded text-sm">
          <span className="text-foreground flex-1">{n(item.name, item.nameAr)}</span>
          <span className="font-mono w-24 text-end shrink-0">{fmtNum(item.amount)}</span>
          {cells(item.amount, prior)}
        </div>
      ))}
      {extra?.map((e, i) => (
        <div key={`ex-${i}`} className="flex justify-between items-center gap-2 py-1.5 px-2 hover:bg-secondary/10 rounded text-sm">
          <span className="text-foreground flex-1">{t(e.label, e.labelAr)}</span>
          <span className="font-mono w-24 text-end shrink-0">{fmtNum(e.amount)}</span>
          {cells(e.amount, priorExtra?.[i] ?? 0)}
        </div>
      ))}
      <div className="flex justify-between items-center gap-2 py-2 px-2 border-t border-border font-bold text-sm mt-1">
        <span className="text-muted-foreground uppercase text-xs tracking-wide flex-1">{t("Total", "الإجمالي")} {t(title, titleAr)}</span>
        <span className="font-mono text-base w-24 text-end shrink-0">{fmtNum(total)}</span>
        {cells(total, priorTotal ?? 0)}
      </div>
    </div>
  );
}

export default function BalanceSheet() {
  const { t, lang } = useLanguage();
  const [asOf, setAsOf] = useState(new Date().toISOString().split("T")[0]);
  const [applied, setApplied] = useState(new Date().toISOString().split("T")[0]);
  const [compare, setCompare] = useState<CompareSetting>("off");

  const { data: fiscalYears } = useFiscalYearsQuery();
  const periods = fiscalYears?.periods ?? [];

  const { data, isLoading } = useQuery<BSData>({
    queryKey: ["balance-sheet", applied],
    queryFn: () => apiFetch(`/reports/balance-sheet?as_of=${applied}`),
  });

  // F7-cmp — a fiscal year-end compares against the RESOLVER's preceding
  // year-end (never calendar-minus-one, which is ~11 days off a Hijri year);
  // a month-end stays a month-end; anything else shifts clamped, labelled.
  const prior = compare !== "off" ? derivePriorAsOf(applied, periods, compare) : null;
  const { data: priorData } = useQuery<BSData>({
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Balance Sheet", "الميزانية العمومية")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Assets = Liabilities + Equity · Statement of Financial Position", "الأصول = الخصوم + حقوق الملكية · قائمة المركز المالي")}</p>
        </div>
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4">
            <div><Label className="text-xs text-muted-foreground">{t("As of Date", "بتاريخ")}</Label><Input type="date" value={asOf} onChange={e=>setAsOf(e.target.value)} className="mt-1 h-8 text-sm w-44" /></div>
            <Button size="sm" className="h-8" onClick={()=>setApplied(asOf)}>{t("Generate", "إنشاء")}</Button>
            <CompareSelect value={compare} onChange={setCompare} />
            <AsOfShortcuts value={asOf} onSelect={(d)=>{setAsOf(d);setApplied(d);}} />
            {data && (
              <div className={`flex items-center gap-2 ms-auto px-4 py-2 rounded-lg border ${balanced ? "border-emerald-500/30 bg-emerald-500/10" : "border-red-500/30 bg-red-500/10"}`}>
                {balanced ? <CheckCircle className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-red-400" />}
                <span className={`text-sm font-medium ${balanced ? "text-emerald-400" : "text-red-400"}`}>{balanced ? t("Balanced", "متوازن") : t("Check entries", "تحقق من القيود")}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

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
          <div className="grid grid-cols-2 gap-4">
            {[
              [t("Total Assets", "إجمالي الأصول"), fmtNum(data.assets.total), "text-blue-400"],
              [t("Total Liabilities", "إجمالي الخصوم"), fmtNum(data.liabilities.total), "text-amber-400"],
              [t("Equity", "حقوق الملكية"), fmtNum(data.equity.total), "text-purple-400"],
              [t("Liab + Equity", "الخصوم + حقوق الملكية"), fmtNum(totalLE), balanced ? "text-emerald-400" : "text-red-400"],
            ].map(([l, v, c]) => (
              <Card key={String(l)} className="border-border bg-card">
                <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
                <CardContent><div className={`text-xl font-bold font-mono ${c}`}>{v}</div></CardContent>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Card className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground uppercase tracking-wide">{t("Assets", "الأصول")}</CardTitle></CardHeader>
              <CardContent>
                <Section
                  title="Assets"
                  titleAr="الأصول"
                  color="bg-blue-500/10 text-blue-400"
                  rows={data.assets.items}
                  extra={[{ label: "Accounts Receivable (AR)", labelAr: "ذمم مدينة (AR)", amount: data.assets.accountsReceivable }]}
                  total={data.assets.total}
                  priorRows={comparing ? priorData!.assets.items : undefined}
                  priorExtra={comparing ? [priorData!.assets.accountsReceivable] : undefined}
                  priorTotal={comparing ? priorData!.assets.total : undefined}
                />
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card className="border-border bg-card">
                <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground uppercase tracking-wide">{t("Liabilities", "الخصوم")}</CardTitle></CardHeader>
                <CardContent>
                  <Section
                    title="Liabilities"
                    titleAr="الخصوم"
                    color="bg-amber-500/10 text-amber-400"
                    rows={data.liabilities.items}
                    extra={[{ label: "Accounts Payable (AP)", labelAr: "ذمم دائنة (AP)", amount: data.liabilities.accountsPayable }]}
                    total={data.liabilities.total}
                    priorRows={comparing ? priorData!.liabilities.items : undefined}
                    priorExtra={comparing ? [priorData!.liabilities.accountsPayable] : undefined}
                    priorTotal={comparing ? priorData!.liabilities.total : undefined}
                  />
                </CardContent>
              </Card>

              <Card className="border-border bg-card">
                <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground uppercase tracking-wide">{t("Equity", "حقوق الملكية")}</CardTitle></CardHeader>
                <CardContent>
                  <Section
                    title="Equity"
                    titleAr="حقوق الملكية"
                    color="bg-purple-500/10 text-purple-400"
                    rows={[{ key: "retained-earnings", name: "Retained Earnings", nameAr: "الأرباح المحتجزة", amount: data.equity.retainedEarnings }]}
                    total={data.equity.total}
                    priorRows={comparing ? [{ key: "retained-earnings", name: "Retained Earnings", nameAr: "الأرباح المحتجزة", amount: priorData!.equity.retainedEarnings }] : undefined}
                    priorTotal={comparing ? priorData!.equity.total : undefined}
                  />
                </CardContent>
              </Card>

              <div className={`rounded-lg px-4 py-3 border flex justify-between items-center ${balanced ? "bg-emerald-500/10 border-emerald-500/20" : "bg-red-500/10 border-red-500/20"}`}>
                <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{t("Total Liabilities + Equity", "إجمالي الخصوم + حقوق الملكية")}</span>
                <span className={`font-mono font-bold text-lg ${balanced ? "text-emerald-400" : "text-red-400"}`}>{fmtNum(totalLE)}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
