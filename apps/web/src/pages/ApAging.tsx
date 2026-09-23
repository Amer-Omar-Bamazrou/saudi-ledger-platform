import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  days_31_60: "text-orange-400",
  days_61_90: "text-negative",
  over_90: "text-red-600",
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("AP Aging", "أعمار الذمم الدائنة")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Accounts Payable aging — overdue bills by vendor", "أعمار الذمم الدائنة — الفواتير المتأخرة حسب المورّد")}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {(Object.keys(BUCKET_LABELS) as (keyof ApAgingReport["buckets"])[]).map((key) => (
          <Card key={key} className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground">{t(BUCKET_LABELS[key].en, BUCKET_LABELS[key].ar)}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-xl font-bold font-mono ${BUCKET_COLORS[key]}`}>{fmtNum(totals[key])}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/*
        B6 (2026-09-22): the buckets carry ONLY real payable exposure. What the
        SUPPLIER holds is shown BESIDE the ageing — as the assets it is — never
        folded into a bucket as a negative payable, which would make an overdue
        bill read as less overdue because unrelated money sits with the same
        supplier. The net is derived and labelled so.
      */}
      <Card className="border-border bg-card">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Payable vs what suppliers hold", "الذمم الدائنة مقابل ما يحتفظ به الموردون")}</CardTitle></CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 text-sm">
            <div className="rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">{t("Total AP (Σ buckets)", "إجمالي الذمم (مجموع الفئات)")}</p>
              <p className="font-mono font-semibold text-lg" data-testid="ap-recon-total">{fmtNum(report.total)}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">{t("− Supplier credit notes", "− إشعارات دائن من الموردين")}</p>
              <p className="font-mono font-semibold text-lg text-info" data-testid="ap-recon-credits">{fmtNum(report.assets.supplierCredits)}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">{t("− Advances paid", "− دفعات مقدمة مدفوعة")}</p>
              <p className="font-mono font-semibold text-lg text-info" data-testid="ap-recon-advances">{fmtNum(report.assets.supplierAdvances)}</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">{t("− Deposits & unidentified", "− تأمينات ومدفوعات غير محددة")}</p>
              <p className="font-mono font-semibold text-lg text-info" data-testid="ap-recon-deposits">{fmtNum(report.assets.supplierDeposits + report.assets.unidentifiedPayments)}</p>
            </div>
            <div className="rounded-md border border-primary/40 p-3">
              <p className="text-xs text-muted-foreground">{t("= Net supplier position (derived)", "= صافي مركز الموردين (مشتق)")}</p>
              <p className="font-mono font-semibold text-lg" data-testid="ap-recon-net">{fmtNum(report.netSupplierPosition)}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            {t("Advances, deposits and unapplied credit notes are ASSETS — money the supplier holds or owes back. They never appear inside an ageing bucket.", "الدفعات المقدمة والتأمينات وإشعارات الدائن غير المطبقة أصول — أموال يحتفظ بها المورد أو يدين بها. ولا تظهر أبدًا داخل فئة أعمار.")}
          </p>
        </CardContent>
      </Card>

      <Card className="border-border bg-card">
        <CardContent className="pt-6">
          {isLoading ? <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>
          : isError ? (
            /* 🔴 A failed load is NOT an empty report. Saying "no outstanding
               payables" when the request failed would be a confident wrong
               answer about money owed. */
            <div className="text-center py-16 text-muted-foreground">
              <Building2 className="w-8 h-8 mx-auto mb-3 opacity-40 text-negative" />
              <p className="text-sm text-negative">{t("Could not load accounts payable.", "تعذّر تحميل الذمم الدائنة.")}</p>
              <p className="text-xs mt-1 opacity-60">{(error as Error)?.message ?? t("Please try again.", "يرجى المحاولة مرة أخرى.")}</p>
            </div>
          ) : report.items.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Building2 className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No outstanding payables.", "لا توجد ذمم دائنة مستحقة.")}</p>
              <p className="text-xs mt-1 opacity-60">{t("All bills are paid or no bills have been created.", "جميع الفواتير مدفوعة أو لم يتم إنشاء أي فاتورة.")}</p>
            </div>
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[t("Bill", "الفاتورة"), t("Vendor", "المورد"), t("Due", "الاستحقاق"), t("Bucket", "الفئة"), t("Outstanding", "المستحق")].map(h => (
                    <th key={h} className="text-start pb-2 pe-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.items.map(item => {
                  const bucket = bucketOf(item.daysPastDue);
                  return (
                    <tr key={item.id} className="border-b border-border/50 hover:bg-secondary/20">
                      <td className="py-3 pe-4 font-mono text-xs text-primary">{item.billNumber}</td>
                      <td className="py-3 pe-4 font-medium">{item.vendorName}</td>
                      <td className="py-3 pe-4 text-xs text-muted-foreground">
                        {item.dueDate ? <DualDate date={item.dueDate} /> : <span className="opacity-60">{t("No due date", "بدون تاريخ استحقاق")}</span>}
                      </td>
                      <td className="py-3 pe-4">
                        <span className={`font-mono text-xs ${BUCKET_COLORS[bucket]}`}>
                          {t(BUCKET_LABELS[bucket].en, BUCKET_LABELS[bucket].ar)}
                          {item.daysPastDue > 0 && <span className="opacity-70"> · {item.daysPastDue}d</span>}
                        </span>
                      </td>
                      <td className="py-3 font-mono font-semibold">{fmtNum(item.outstanding)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td className="pt-3 text-xs text-muted-foreground" colSpan={4}>{t("Total outstanding", "إجمالي المستحق")}</td>
                  <td className="pt-3 font-mono text-xs font-bold">{fmtNum(report.total)}</td>
                </tr>
              </tfoot>
            </table></div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
