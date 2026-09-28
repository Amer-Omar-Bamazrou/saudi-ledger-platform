import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { AlertCircle } from "lucide-react";
import { PageHeader, StatStrip, Stat, Panel, EmptyState, type Tone } from "@/components/kit";
import { DualDate } from "@/components/DualDate";
import { useLanguage } from "@/contexts/LanguageContext";

import type { ArAgingReport } from "@workspace/api-client-react";

const BUCKET_COLORS: Record<string, string> = {
  current: "text-positive",
  days_1_30: "text-attention",
  days_31_60: "text-severe",
  days_61_90: "text-negative",
  over_90: "text-critical",
};

/** The strip's tone per bucket: overdue IS a state (CLAUDE.md §4), so it may carry one. */
const BUCKET_TONE: Record<string, Tone> = {
  current: "default",
  days_1_30: "attention",
  days_31_60: "negative",
  days_61_90: "negative",
  over_90: "negative",
};

const BUCKET_LABELS: Record<string, { en: string; ar: string }> = {
  current: { en: "Current", ar: "جارٍ" },
  days_1_30: { en: "1–30 Days", ar: "1–30 يومًا" },
  days_31_60: { en: "31–60 Days", ar: "31–60 يومًا" },
  days_61_90: { en: "61–90 Days", ar: "61–90 يومًا" },
  over_90: { en: "90+ Days", ar: "أكثر من 90 يومًا" },
};

function agingBucket(days: number): string {
  if (days <= 0) return "current";
  if (days <= 30) return "days_1_30";
  if (days <= 60) return "days_31_60";
  if (days <= 90) return "days_61_90";
  return "over_90";
}

export default function ArAging() {
  const { t, n } = useLanguage();
  const { data, isLoading } = useQuery<ArAgingReport>({
    queryKey: ["ar-aging"],
    queryFn: () => apiFetch("/reports/ar-aging"),
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-6 max-w-6xl">
      <PageHeader
        title={t("AR Aging Report", "تقرير أعمار الذمم المدينة")}
        description={t("Outstanding customer balances by age · Auto-refreshes every minute", "أرصدة العملاء المستحقة حسب العمر · تحديث تلقائي كل دقيقة")}
      />

      {data && (
        <>
          <StatStrip cols={5}>
            {Object.entries(BUCKET_LABELS).map(([key, label], i, all) => (
              <Stat
                key={key}
                className={i === all.length - 1 ? "col-span-2 lg:col-span-1" : undefined}
                label={t(label.en, label.ar)}
                value={fmtNum((data.buckets as any)[key] ?? 0)}
                tone={((data.buckets as any)[key] ?? 0) > 0 ? BUCKET_TONE[key] : "default"}
                hint={`${((((data.buckets as any)[key] ?? 0) / (data.total || 1)) * 100).toFixed(0)}%`}
              />
            ))}
          </StatStrip>

          {/* Visual bar */}
          <Panel>
            <div className="flex items-center gap-1 h-3 rounded-full overflow-hidden bg-muted">
              {Object.entries(BUCKET_LABELS).map(([key]) => {
                const pct = data.total > 0 ? ((data.buckets as any)[key] / data.total) * 100 : 0;
                if (pct === 0) return null;
                const bg: Record<string, string> = { current: "bg-positive-surface", days_1_30: "bg-attention-surface", days_31_60: "bg-severe", days_61_90: "bg-negative-surface", over_90: "bg-critical" };
                return <div key={key} style={{ width: `${pct}%` }} className={`h-full transition-all ${bg[key]}`} title={`${t(BUCKET_LABELS[key].en, BUCKET_LABELS[key].ar)}: ${fmtNum((data.buckets as any)[key])}`} />;
              })}
            </div>
            <div className="flex flex-wrap justify-between gap-2 mt-3 text-xs text-muted-foreground">
              <span>{t("Least overdue", "الأقل تأخرًا")} ←</span>
              <span className="font-semibold text-sm text-foreground tabular-nums" data-testid="aging-total">{t("Total receivable", "إجمالي الذمم المدينة")}: {fmtNum(data.total)}</span>
              <span>→ {t("Most overdue", "الأكثر تأخرًا")}</span>
            </div>
          </Panel>

          {/*
            Phase E/F (2026-09-17): the buckets carry ONLY real receivable
            exposure (every item ≥ 0). What we owe customers is shown BESIDE
            the ageing — as the two liabilities it is — never folded into a
            bucket as a negative amount. The net is derived and labelled so.
          */}
          <Panel
            title={t("Receivable vs what we owe customers", "الذمم المدينة مقابل ما ندين به للعملاء")}
            description={t("Credits and deposits are liabilities we owe, not negative receivables; they never appear inside an ageing bucket.", "الأرصدة الدائنة والعرابين التزامات ندين بها، وليست ذممًا سالبة؛ ولا تظهر أبدًا داخل فئة أعمار.")}
          >
            <StatStrip cols={4} className="mb-0">
              <Stat label={t("Total AR (Σ buckets)", "إجمالي الذمم (مجموع الفئات)")} value={<span data-testid="recon-total">{fmtNum(data.total)}</span>} />
              <Stat label={t("− Customer credits (credit-note balances)", "− أرصدة دائنة (أرصدة إشعارات الدائن)")} value={<span data-testid="recon-credits">{fmtNum(data.liabilities.customerCredits)}</span>} />
              <Stat label={t("− Customer deposits (unapplied receipts)", "− عرابين العملاء (إيصالات غير مخصصة)")} value={<span data-testid="recon-deposits">{fmtNum(data.liabilities.customerDeposits)}</span>} />
              <Stat label={t("= Net customer position (derived)", "= صافي مركز العملاء (مشتق)")} value={<span data-testid="recon-net">{fmtNum(data.netCustomerPosition)}</span>} className="bg-accent/40" />
            </StatStrip>
          </Panel>
        </>
      )}

      <Panel flush title={t("Outstanding Invoices", "الفواتير المستحقة")}>
        {isLoading ? <div className="text-muted-foreground text-sm p-5">{t("Loading...", "جارٍ التحميل...")}</div> : !data || data.items.length === 0 ? (
          <EmptyState icon={AlertCircle} title={t("No outstanding invoices. All payments are current.", "لا توجد فواتير مستحقة. جميع المدفوعات محدّثة.")} />
        ) : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {([
                  [t("Invoice #", "رقم الفاتورة"), false],
                  [t("Customer", "العميل"), false],
                  [t("Due Date", "تاريخ الاستحقاق"), false],
                  [t("Days Past Due", "أيام التأخر"), true],
                  [t("Outstanding", "المستحق"), true],
                  [t("Aging", "التقادم"), false],
                ] as const).map(([h, num]) => (
                  <th key={h} className={`${num ? "text-end" : "text-start"} px-3`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map(item => {
                const bucket = agingBucket(item.daysPastDue);
                return (
                  <tr key={item.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors">
                    <td className="py-3 px-3 whitespace-nowrap font-medium text-primary">{item.invoiceNumber}</td>
                    <td className="py-3 px-3 min-w-[10rem]">{n(item.customerName, item.customerNameAr)}</td>
                    <td className="py-3 px-3 whitespace-nowrap text-muted-foreground"><DualDate date={item.dueDate} /></td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">
                      <span className={`font-medium ${BUCKET_COLORS[bucket]}`}>
                        {item.daysPastDue <= 0 ? t("Current", "جارٍ") : `${item.daysPastDue}${t("d", " يوم")}`}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums font-semibold text-foreground">{fmtNum(item.outstanding)}</td>
                    <td className="py-3 px-3">
                      <Badge className={`text-xs ${bucket === "current" ? "bg-positive-surface/20 text-positive" : bucket === "days_1_30" ? "bg-attention-surface/20 text-attention" : "bg-negative-surface/20 text-negative"}`}>
                        {t(BUCKET_LABELS[bucket].en, BUCKET_LABELS[bucket].ar)}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </Panel>
    </div>
  );
}
