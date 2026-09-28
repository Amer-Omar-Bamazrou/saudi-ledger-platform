import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
import { Building2 } from "lucide-react";
import { DualDate } from "@/components/DualDate";
import { useLanguage } from "@/contexts/LanguageContext";

/**
 * 🔴 THIS PAGE WAS WRITTEN AGAINST AN API THAT DOES NOT EXIST (QA audit, B1).
 *
 * It declared the response as `ApAgingRow[]` — a per-vendor matrix — and called
 * `rows.reduce(...)`. `GET /reports/ap-aging` actually returns an OBJECT:
 * `{ buckets, total, items[] }`. So `reduce` was called on an object, threw
 * `TypeError: rows.reduce is not a function`, and the page rendered a
 * COMPLETELY BLANK screen — zero characters, no error boundary.
 *
 * Two things made it survive:
 *   1. `.catch(() => [])` looks defensive but only catches a REJECTED fetch.
 *      The request succeeded; the shape was wrong, so the fallback never fired.
 *   2. The API was correct the whole time, so every server-side check passed.
 *      Nothing in the suite renders this page.
 *
 * `ArAging.tsx` reads the SAME response shape correctly. The sibling diverged —
 * "green fixes the case, not the class". This file is now aligned with it.
 */
import type { ApAgingReport } from "@workspace/api-client-react";

const EMPTY: ApAgingReport = {
  buckets: { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, over_90: 0 },
  total: 0,
  assets: { supplierCredits: 0, supplierAdvances: 0, supplierDeposits: 0, unidentifiedPayments: 0 },
  netSupplierPosition: 0,
  items: [],
};

/** Which bucket a bill falls in, from its own days-past-due. */
function bucketOf(days: number): keyof ApAgingReport["buckets"] {
  if (days <= 0) return "current";
  if (days <= 30) return "days_1_30";
  if (days <= 60) return "days_31_60";
  if (days <= 90) return "days_61_90";
  return "over_90";
}

const BUCKET_COLORS: Record<string, string> = {
  current: "text-positive",
  days_1_30: "text-attention",
  days_31_60: "text-severe",
  days_61_90: "text-negative",
  over_90: "text-critical",
};

const BUCKET_LABELS: Record<string, { en: string; ar: string }> = {
  current: { en: "Current", ar: "جارٍ" },
  days_1_30: { en: "1–30 Days", ar: "1–30 يومًا" },
  days_31_60: { en: "31–60 Days", ar: "31–60 يومًا" },
  days_61_90: { en: "61–90 Days", ar: "61–90 يومًا" },
  over_90: { en: "Over 90", ar: "أكثر من 90" },
};

export default function ApAging() {
  const { t } = useLanguage();
  // 🔴 No `.catch(() => …)` here. A failed request must reach the error state
  // rather than be disguised as an empty report — "no outstanding payables" and
  // "we could not load your payables" are different facts.
  const { data, isLoading, isError, error } = useQuery<ApAgingReport>({
    queryKey: ["ap-aging"],
    queryFn: () => apiFetch<ApAgingReport>("/reports/ap-aging"),
  });

  const report = data ?? EMPTY;
  const totals = report.buckets;

  const reconCell = "bg-card px-5 py-4 min-w-0";
  const reconLabel = "text-[13px] text-muted-foreground";
  const reconValue = "mt-1.5 text-lg font-semibold tabular-nums";

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("AP Aging", "أعمار الذمم الدائنة")}
        description={t("Accounts Payable aging — overdue bills by vendor", "أعمار الذمم الدائنة — الفواتير المتأخرة حسب المورّد")}
      />

      <StatStrip cols={5}>
        {(Object.keys(BUCKET_LABELS) as (keyof ApAgingReport["buckets"])[]).map((key) => (
          <Stat
            key={key}
            label={t(BUCKET_LABELS[key].en, BUCKET_LABELS[key].ar)}
            value={<span className={BUCKET_COLORS[key]}>{fmtNum(totals[key])}</span>}
          />
        ))}
      </StatStrip>

      {/*
        B6 (2026-09-22): the buckets carry ONLY real payable exposure. What the
        SUPPLIER holds is shown BESIDE the ageing — as the assets it is — never
        folded into a bucket as a negative payable, which would make an overdue
        bill read as less overdue because unrelated money sits with the same
        supplier. The net is derived and labelled so.
      */}
      <Panel
        title={t("Payable vs what suppliers hold", "الذمم الدائنة مقابل ما يحتفظ به الموردون")}
        bodyClassName="p-0"
        footer={
          <p className="text-[13px] text-muted-foreground">
            {t("Advances, deposits and unapplied credit notes are ASSETS — money the supplier holds or owes back. They never appear inside an ageing bucket.", "الدفعات المقدمة والتأمينات وإشعارات الدائن غير المطبقة أصول — أموال يحتفظ بها المورد أو يدين بها. ولا تظهر أبدًا داخل فئة أعمار.")}
          </p>
        }
      >
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-px bg-border text-sm">
          <div className={reconCell}>
            <p className={reconLabel}>{t("Total AP (Σ buckets)", "إجمالي الذمم (مجموع الفئات)")}</p>
            <p className={reconValue} data-testid="ap-recon-total">{fmtNum(report.total)}</p>
          </div>
          <div className={reconCell}>
            <p className={reconLabel}>{t("− Supplier credit notes", "− إشعارات دائن من الموردين")}</p>
            <p className={`${reconValue} text-info`} data-testid="ap-recon-credits">{fmtNum(report.assets.supplierCredits)}</p>
          </div>
          <div className={reconCell}>
            <p className={reconLabel}>{t("− Advances paid", "− دفعات مقدمة مدفوعة")}</p>
            <p className={`${reconValue} text-info`} data-testid="ap-recon-advances">{fmtNum(report.assets.supplierAdvances)}</p>
          </div>
          <div className={reconCell}>
            <p className={reconLabel}>{t("− Deposits & unidentified", "− تأمينات ومدفوعات غير محددة")}</p>
            <p className={`${reconValue} text-info`} data-testid="ap-recon-deposits">{fmtNum(report.assets.supplierDeposits + report.assets.unidentifiedPayments)}</p>
          </div>
          <div className={`${reconCell} bg-accent/40`}>
            <p className={reconLabel}>{t("= Net supplier position (derived)", "= صافي مركز الموردين (مشتق)")}</p>
            <p className={reconValue} data-testid="ap-recon-net">{fmtNum(report.netSupplierPosition)}</p>
          </div>
        </div>
      </Panel>

      <Panel flush>
          {isLoading ? <div className="text-sm text-muted-foreground p-5">{t("Loading…", "جارٍ التحميل…")}</div>
          : isError ? (
            /* 🔴 A failed load is NOT an empty report. Saying "no outstanding
               payables" when the request failed would be a confident wrong
               answer about money owed. */
            <EmptyState
              icon={Building2}
              title={<span className="text-negative">{t("Could not load accounts payable.", "تعذّر تحميل الذمم الدائنة.")}</span>}
              description={(error as Error)?.message ?? t("Please try again.", "يرجى المحاولة مرة أخرى.")}
            />
          ) : report.items.length === 0 ? (
            <EmptyState
              icon={Building2}
              title={t("No outstanding payables.", "لا توجد ذمم دائنة مستحقة.")}
              description={t("All bills are paid or no bills have been created.", "جميع الفواتير مدفوعة أو لم يتم إنشاء أي فاتورة.")}
            />
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {([[t("Bill", "الفاتورة"), false], [t("Vendor", "المورد"), false], [t("Due", "الاستحقاق"), false], [t("Bucket", "الفئة"), false], [t("Outstanding", "المستحق"), true]] as const).map(([h, num]) => (
                    <th key={h} className={`${num ? "text-end" : "text-start"} px-3`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.items.map(item => {
                  const bucket = bucketOf(item.daysPastDue);
                  return (
                    <tr key={item.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors">
                      <td className="py-3 px-3 font-medium text-primary whitespace-nowrap">{item.billNumber}</td>
                      <td className="py-3 px-3 font-medium">{item.vendorName}</td>
                      <td className="py-3 px-3 text-muted-foreground whitespace-nowrap">
                        {item.dueDate ? <DualDate date={item.dueDate} /> : <span className="opacity-60">{t("No due date", "بدون تاريخ استحقاق")}</span>}
                      </td>
                      <td className="py-3 px-3 whitespace-nowrap">
                        <span className={`text-[13px] ${BUCKET_COLORS[bucket]}`}>
                          {t(BUCKET_LABELS[bucket].en, BUCKET_LABELS[bucket].ar)}
                          {item.daysPastDue > 0 && <span className="opacity-70 tabular-nums"> · {item.daysPastDue}d</span>}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums font-semibold">{fmtNum(item.outstanding)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td className="py-3 px-3" colSpan={4}>{t("Total outstanding", "إجمالي المستحق")}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(report.total)}</td>
                </tr>
              </tfoot>
            </table></div>
          )}
      </Panel>
    </div>
  );
}
