import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Package } from "lucide-react";
import { DualDate } from "@/components/DualDate";
import { ListPagination } from "@/components/ListPagination";
import { PAGE_SIZE, type Paged } from "@/lib/pagedList";
import { useLanguage } from "@/contexts/LanguageContext";

/**
 * 🔴 These are GET /assets' real field names, checked by
 * `tests/list-response-shape.test.ts` against the live response.
 *
 * This interface previously named five fields the endpoint has never returned
 * (`category`, `cost`, `usefulLife`, `depreciation`, `bookValue`).
 * `apiFetch<T>` is a cast, so TypeScript agreed — and every money cell on this
 * schedule, including the totals row, rendered **NaN**, with "undefinedy" in
 * the Useful Life column.
 */
import type { AssetListItem, AssetTotals } from "@workspace/api-client-react";

const STATUS_STYLES: Record<string, string> = {
  active: "bg-positive-surface/20 text-positive",
  disposed: "bg-negative-surface/20 text-negative",
  fully_depreciated: "bg-secondary text-muted-foreground",
};


export default function AssetSchedule() {
  const [page, setPage] = useState(0);
  const { t } = useLanguage();
  const { data: paged, isLoading } = useQuery<Paged<AssetListItem, AssetTotals>>({
    queryKey: ["asset-schedule", page],
    queryFn: () => apiFetch(`/assets?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`),
  });
  const assets = paged?.items ?? [];

  /**
   * 🔴 From the server, over the whole register. The `.catch(() => [])` that
   * used to wrap this fetch is gone with it: a caught shape mismatch renders an
   * empty register, which is a confident wrong answer rather than an error.
   */
  const totalCost = paged?.totals.purchaseCost ?? 0;
  const totalAccumDep = paged?.totals.accumulatedDepreciation ?? 0;
  const totalBookValue = paged?.totals.currentBookValue ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Fixed Asset Schedule", "جدول الأصول الثابتة")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Asset register with cost, depreciation, and net book value", "سجل الأصول مع التكلفة والإهلاك وصافي القيمة الدفترية")}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          [t("Total Assets", "إجمالي الأصول"), paged?.totals.activeCount ?? 0, "text-primary"],
          [t("Total Cost", "إجمالي التكلفة"), fmtNum(totalCost), "text-primary"],
          [t("Accumulated Dep.", "مجمع الإهلاك"), fmtNum(totalAccumDep), "text-negative"],
          [t("Net Book Value", "صافي القيمة الدفترية"), fmtNum(totalBookValue), "text-positive"],
        ].map(([l, v, c]) => (
          <Card key={String(l)} className="border-border bg-card">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
            <CardContent><div className={`text-xl sm:text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-6">
          {isLoading ? <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>
          : assets.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Package className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No fixed assets registered.", "لا توجد أصول ثابتة مسجّلة.")}</p>
              <p className="text-xs mt-1 opacity-60">Add assets in Assets &amp; Inventory to see them here.</p>
            </div>
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[t("Asset", "الأصل"), t("Category", "الفئة"), t("Purchase Date", "تاريخ الشراء"), t("Cost", "التكلفة"), t("Useful Life", "العمر الإنتاجي"), t("Method", "الطريقة"), t("Acc. Dep.", "مجمع الإهلاك"), t("Book Value", "القيمة الدفترية"), t("Status", "الحالة")].map(h => (
                    <th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {assets.map(a => (
                  <tr key={a.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-2 pe-3 font-medium text-xs">{a.name}</td>
                    <td className="py-2 pe-3 text-muted-foreground text-xs">{a.categoryName ?? "—"}</td>
                    <td className="py-2 pe-3 text-muted-foreground text-xs"><DualDate date={a.purchaseDate} /></td>
                    <td className="py-2 pe-3 font-mono text-xs">{fmtNum(a.purchaseCost)}</td>
                    <td className="py-2 pe-3 font-mono text-xs">{a.usefulLifeYears}y</td>
                    <td className="py-2 pe-3 text-xs text-muted-foreground">{a.depreciationMethod}</td>
                    <td className="py-2 pe-3 font-mono text-xs text-negative">{fmtNum(a.accumulatedDepreciation)}</td>
                    <td className="py-2 pe-3 font-mono text-xs font-semibold text-positive">{fmtNum(a.currentBookValue)}</td>
                    <td className="py-2"><Badge className={`text-xs ${STATUS_STYLES[a.status] ?? ""}`}>{a.status.replace("_", " ")}</Badge></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td colSpan={3} className="pt-3 text-xs text-muted-foreground">{t("Total", "الإجمالي")}</td>
                  <td className="pt-3 font-mono text-xs">{fmtNum(totalCost)}</td>
                  <td colSpan={2} />
                  <td className="pt-3 font-mono text-xs text-negative">{fmtNum(totalAccumDep)}</td>
                  <td className="pt-3 font-mono text-xs text-positive">{fmtNum(totalBookValue)}</td>
                  <td />
                </tr>
              </tfoot>
            </table></div>
          )}
          <ListPagination
            page={paged?.page}
            shown={assets.length}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
