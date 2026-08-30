import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Building2, Download } from "lucide-react";
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
interface ApAgingData {
  buckets: { current: number; days_1_30: number; days_31_60: number; days_61_90: number; over_90: number };
  total: number;
  items: {
    id: number; billNumber: string; vendorName: string; vendorNameAr?: string | null;
    dueDate: string | null; outstanding: number; daysPastDue: number;
  }[];
}

const EMPTY: ApAgingData = {
  buckets: { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, over_90: 0 },
  total: 0,
  items: [],
};

/** Which bucket a bill falls in, from its own days-past-due. */
function bucketOf(days: number): keyof ApAgingData["buckets"] {
  if (days <= 0) return "current";
  if (days <= 30) return "days_1_30";
  if (days <= 60) return "days_31_60";
  if (days <= 90) return "days_61_90";
  return "over_90";
}

const BUCKET_COLORS: Record<string, string> = {
  current: "text-emerald-400",
  days_1_30: "text-amber-400",
  days_31_60: "text-orange-400",
  days_61_90: "text-red-400",
  over_90: "text-red-600",
};

const BUCKET_LABELS: Record<string, string> = {
  current: "Current",
  days_1_30: "1–30 Days",
  days_31_60: "31–60 Days",
  days_61_90: "61–90 Days",
  over_90: "Over 90",
};

export default function ApAging() {
  const { t } = useLanguage();
  // 🔴 No `.catch(() => …)` here. A failed request must reach the error state
  // rather than be disguised as an empty report — "no outstanding payables" and
  // "we could not load your payables" are different facts.
  const { data, isLoading, isError, error } = useQuery<ApAgingData>({
    queryKey: ["ap-aging"],
    queryFn: () => apiFetch<ApAgingData>("/reports/ap-aging"),
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
        <Button variant="outline" className="gap-2"><Download className="w-4 h-4" /> Export</Button>
      </div>

      <div className="grid grid-cols-5 gap-3">
        {(Object.keys(BUCKET_LABELS) as (keyof ApAgingData["buckets"])[]).map((key) => (
          <Card key={key} className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground">{BUCKET_LABELS[key]}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-xl font-bold font-mono ${BUCKET_COLORS[key]}`}>{fmtNum(totals[key])}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-6">
          {isLoading ? <div className="text-sm text-muted-foreground p-4">Loading…</div>
          : isError ? (
            /* 🔴 A failed load is NOT an empty report. Saying "no outstanding
               payables" when the request failed would be a confident wrong
               answer about money owed. */
            <div className="text-center py-16 text-muted-foreground">
              <Building2 className="w-8 h-8 mx-auto mb-3 opacity-40 text-red-400" />
              <p className="text-sm text-red-400">{t("Could not load accounts payable.", "تعذّر تحميل الذمم الدائنة.")}</p>
              <p className="text-xs mt-1 opacity-60">{(error as Error)?.message ?? "Please try again."}</p>
            </div>
          ) : report.items.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Building2 className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No outstanding payables.", "لا توجد ذمم دائنة مستحقة.")}</p>
              <p className="text-xs mt-1 opacity-60">{t("All bills are paid or no bills have been created.", "جميع الفواتير مدفوعة أو لم يتم إنشاء أي فاتورة.")}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Bill", "Vendor", "Due", "Bucket", "Outstanding"].map(h => (
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
                          {BUCKET_LABELS[bucket]}
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
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
