import { Fragment, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, ChevronDown, ChevronRight, XCircle } from "lucide-react";
import { useFiscalYearsQuery, useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { CompareSelect, ComparisonUnavailable, priorRangeLabel, type CompareSetting } from "@/components/Comparison";
import { derivePriorRange, fmtPctChange } from "@/lib/priorPeriod";
import { fmtDate } from "@/lib/api";
import { ReportExportButtons } from "@/components/reports/ReportExport";
import { glDrillHref } from "@/lib/reportDrill";

import type { CashFlowReport, CashFlowSection } from "@workspace/api-client-react";

/**
 * Phase 14 — the statement of cash flows, DIRECT method, from THE LEDGER
 * (D14-07). Read top to bottom like the statement it is: opening cash, the
 * three activities (each a few classes of receipts and payments, each made of
 * the accounts on the other side of the cash), the movements that are not
 * cash flows, and closing cash — with the server's reconciliation check.
 *
 * Lines carry stable KEYS (a class of flows), so a comparison is line by line
 * — which the old per-bank-movement items could not support. Every line shows
 * its accounts; an account opens its ledger for the window (D14-09).
 */
type Line = CashFlowSection["items"][number];

export default function CashFlow() {
  // M20.1 — the report does not mount until its default window is known.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <CashFlowInner range={range} />;
}

function CashFlowInner({ range }: { range: ReportDefaultRange }) {
  const { t, n, lang } = useLanguage();
  const [dateFrom, setDateFrom] = useState(range.from);
  const [dateTo, setDateTo] = useState(range.to);
  const [applied, setApplied] = useState({ from: range.from, to: range.to });
  const [compare, setCompare] = useState<CompareSetting>("off");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const { data: fiscalYears } = useFiscalYearsQuery();
  const periods = fiscalYears?.periods ?? [];

  const { data, isLoading } = useQuery<CashFlowReport>({
    queryKey: ["cash-flow", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/cash-flow?date_from=${applied.from}&date_to=${applied.to}`),
  });

  const prior = compare !== "off" ? derivePriorRange(applied.from, applied.to, periods, compare) : null;
  const { data: priorData } = useQuery<CashFlowReport>({
    queryKey: ["cash-flow", prior?.from, prior?.to],
    queryFn: () => apiFetch(`/reports/cash-flow?date_from=${prior!.from}&date_to=${prior!.to}`),
    enabled: !!prior,
  });
  const priorEmpty = !!priorData && priorData.openingCash === 0 && priorData.closingCash === 0 && priorData.netChange === 0;
  const comparing = !!prior && !!priorData && !priorEmpty;

  const amountCells = (current: number, priorAmount: number | undefined) => (
    <>
      <td className="py-1.5 text-end font-mono whitespace-nowrap">{fmtNum(current)}</td>
      {comparing && <td className="py-1.5 text-end font-mono text-muted-foreground whitespace-nowrap hidden sm:table-cell">{fmtNum(priorAmount ?? 0)}</td>}
      {comparing && <td className="py-1.5 text-end font-mono text-muted-foreground whitespace-nowrap">{fmtPctChange(current, priorAmount ?? 0)}</td>}
    </>
  );

  const section = (key: "operating" | "investing" | "financing", title: string, titleAr: string) => {
    if (!data) return null;
    const cur = data[key];
    const pri = comparing ? priorData![key] : undefined;
    const keys = [...cur.items.map((i) => i.key), ...(pri?.items ?? []).map((i) => i.key).filter((k) => !cur.items.some((i) => i.key === k))];
    return (
      <>
        <tr className="bg-secondary/20" data-testid={`cf-section-${key}`}>
          <td colSpan={comparing ? 4 : 2} className="py-2 px-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">{t(title, titleAr)}</td>
        </tr>
        {keys.length === 0 && (
          <tr><td colSpan={comparing ? 4 : 2} className="py-2 px-4 text-xs text-muted-foreground">{t("No cash moved in this activity.", "لم يتحرك نقد في هذا النشاط.")}</td></tr>
        )}
        {keys.map((k) => {
          const line: Line | undefined = cur.items.find((i) => i.key === k);
          const pLine = pri?.items.find((i) => i.key === k);
          const shown = line ?? { ...pLine!, amount: 0, accounts: [] };
          const isOpen = !!open[`${key}:${k}`];
          return (
            <Fragment key={k}>
              <tr className="border-b border-border/30" data-testid={`cf-line-${k}`}>
                <td className="py-1.5 ps-4 pe-2">
                  <button type="button" className="inline-flex items-center gap-1 text-start hover:text-primary" onClick={() => setOpen({ ...open, [`${key}:${k}`]: !isOpen })} aria-expanded={isOpen}>
                    {isOpen ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0 rtl:rotate-180" />}
                    {n(shown.name, shown.nameAr)}
                  </button>
                </td>
                {amountCells(shown.amount, pLine?.amount)}
              </tr>
              {isOpen && shown.accounts.map((a) => (
                <tr key={a.key} className="text-xs text-muted-foreground" data-testid={`cf-account-${a.key}`}>
                  <td className="py-1 ps-10 pe-2">
                    {/^\d+$/.test(a.key) ? <Link href={glDrillHref(Number(a.key), applied.from, applied.to)} className="hover:text-primary hover:underline">{n(a.name, a.nameAr)}</Link> : n(a.name, a.nameAr)}
                  </td>
                  <td className="py-1 text-end font-mono">{fmtNum(a.amount)}</td>
                  {comparing && <td className="hidden sm:table-cell" />}
                  {comparing && <td />}
                </tr>
              ))}
            </Fragment>
          );
        })}
        <tr className="border-b border-border font-semibold" data-testid={`cf-total-${key}`}>
          <td className="py-2 ps-2 text-xs uppercase tracking-wide">{t(`Net cash from ${title.toLowerCase()}`, `صافي النقد من ${titleAr}`)}</td>
          {amountCells(cur.total, pri?.total)}
        </tr>
      </>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Cash Flow Statement", "قائمة التدفق النقدي")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Direct method, from the posted ledger · Operating · Investing · Financing", "الطريقة المباشرة، من الدفتر المرحَّل · الأنشطة التشغيلية · الاستثمارية · التمويلية")}</p>
        </div>
        <ReportExportButtons report="cash-flow" params={{ date_from: applied.from, date_to: applied.to }} />
      </div>

      <FiscalRangeNotice source={range.source} />

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-end gap-4">
            <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" data-testid="cf-from" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" data-testid="cf-to" /></div>
            <Button size="sm" className="h-8" onClick={()=>setApplied({from:dateFrom,to:dateTo})} data-testid="cf-generate">{t("Generate", "إنشاء")}</Button>
            <CompareSelect value={compare} onChange={setCompare} />
            {data && (
              <div className={`flex items-center gap-2 ms-auto px-3 py-1.5 rounded-lg border text-sm ${data.reconciles ? "border-positive-surface/30 bg-positive-surface/10 text-positive" : "border-negative-surface/30 bg-negative-surface/10 text-negative"}`} data-testid="cf-reconciles">
                {data.reconciles ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                {data.reconciles ? t("Reconciles to the cash accounts", "تتطابق مع حسابات النقد") : t("Does not reconcile to the cash accounts", "لا تتطابق مع حسابات النقد")}
              </div>
            )}
          </div>
          <div className="mt-3">
            <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied(r);}} />
          </div>
        </CardContent>
      </Card>

      {compare !== "off" && !prior && (
        <ComparisonUnavailable reason={t("No earlier fiscal year is known to compare against.", "لا توجد سنة مالية سابقة معروفة للمقارنة.")} />
      )}
      {comparing && prior && <p className="text-xs text-muted-foreground">{priorRangeLabel(prior, lang)}</p>}
      {prior && priorEmpty && (
        <ComparisonUnavailable reason={`${t("No cash recorded between", "لا يوجد نقد مسجل بين")} ${fmtDate(prior.from)} ${t("and", "و")} ${fmtDate(prior.to)} — ${t("nothing to compare against.", "لا يوجد ما يُقارن به.")}`} />
      )}

      {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Loading...", "جارٍ التحميل...")}</div> : !data ? null : (
        <Card className="border-border bg-card">
          <CardContent className="pt-4">
            <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="cf-statement">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground uppercase">
                  <th className="text-start pb-2">{t("Line", "البند")}</th>
                  <th className="text-end pb-2">{t("Amount", "المبلغ")}</th>
                  {comparing && <th className="text-end pb-2 hidden sm:table-cell">{t("Prior", "السابق")}</th>}
                  {comparing && <th className="text-end pb-2">Δ%</th>}
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border font-semibold" data-testid="cf-opening">
                  <td className="py-2 ps-2">{t("Cash at the beginning of the period", "النقد في بداية الفترة")}</td>
                  {amountCells(data.openingCash, priorData?.openingCash)}
                </tr>
                {section("operating", "Operating activities", "الأنشطة التشغيلية")}
                {section("investing", "Investing activities", "الأنشطة الاستثمارية")}
                {section("financing", "Financing activities", "الأنشطة التمويلية")}
                {/* Not cash flows (IAS 7.9): own-account transfers in transit / awaiting declaration, and migration openings */}
                {data.internal.items.map((i) => (
                  <tr key={i.key} className="border-b border-border/30 text-muted-foreground" data-testid={`cf-internal-${i.key}`}>
                    <td className="py-1.5 ps-2 italic">{n(i.name, i.nameAr)}</td>
                    {amountCells(i.amount, priorData?.internal.items.find((p) => p.key === i.key)?.amount)}
                  </tr>
                ))}
                {data.migrationOpeningCash !== 0 && (
                  <tr className="border-b border-border/30 text-muted-foreground" data-testid="cf-migration">
                    <td className="py-1.5 ps-2 italic">{t("Opening balances brought in by migration (not a cash flow)", "أرصدة افتتاحية مُدخلة بالترحيل (ليست تدفقاً نقدياً)")}</td>
                    {amountCells(data.migrationOpeningCash, priorData?.migrationOpeningCash)}
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-bold" data-testid="cf-closing">
                  <td className="pt-3 ps-2">{t("Cash at the end of the period", "النقد في نهاية الفترة")}</td>
                  {amountCells(data.closingCash, priorData?.closingCash)}
                </tr>
              </tfoot>
            </table></div>
            <ul className="mt-4 space-y-1 text-xs text-muted-foreground" data-testid="cf-notes">
              <li>{t("Receipts and payments are shown inclusive of VAT; VAT settled with ZATCA is its own operating line.", "تظهر المقبوضات والمدفوعات شاملة ضريبة القيمة المضافة؛ وتظهر الضريبة المسددة لهيئة الزكاة والضريبة والجمارك في سطر تشغيلي مستقل.")}</li>
              <li>{t("Transfers between the company's own accounts are not cash flows; one still in transit, or awaiting its destination, is shown apart.", "التحويلات بين حسابات المنشأة ليست تدفقات نقدية؛ وما كان منها قيد التحويل أو بانتظار تحديد وجهته يظهر منفصلاً.")}</li>
              <li>{t("Known limits: a supplier payment for a bill that bought a fixed asset reads as operating; a short-term loan on a current liability account reads as operating.", "حدود معروفة: يظهر سداد فاتورة مورد لشراء أصل ثابت ضمن الأنشطة التشغيلية؛ ويظهر القرض قصير الأجل المسجّل في حساب التزام متداول ضمن التشغيلية.")}</li>
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
