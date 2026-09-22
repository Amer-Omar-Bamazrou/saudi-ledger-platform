/**
 * FIXED ASSET SCHEDULE (FA-A, 2026-09-22) — the register with cost, the
 * depreciation posted so far and the carrying amount, plus the tax facts every
 * row carries: the Income Tax Law Art. 17 group (and its rate) and the VAT
 * Art. 52 capital-asset class (and its adjustment period). Every figure is
 * the server's, derived from the posted schedule rows.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Package } from "lucide-react";
import { DualDate } from "@/components/DualDate";
import { ListPagination } from "@/components/ListPagination";
import { PAGE_SIZE, type Paged } from "@/lib/pagedList";
import { useLanguage } from "@/contexts/LanguageContext";
import { statusLabel } from "./Assets";
import type { Asset, AssetTotals } from "@workspace/api-client-react";

const STATUS_STYLES: Record<string, string> = { draft: "bg-secondary text-muted-foreground", in_service: "bg-positive-surface/20 text-positive", disposed: "bg-negative-surface/20 text-negative" };

export default function AssetSchedule() {
  const [page, setPage] = useState(0);
  const { t, lang } = useLanguage();
  const { data: paged, isLoading } = useQuery<Paged<Asset, AssetTotals>>({
    queryKey: ["asset-schedule", page],
    queryFn: () => apiFetch(`/assets?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`),
  });
  const assets = paged?.items ?? [];
  const totals = paged?.totals;
  const method = (m: string) => ({ straight_line: t("Straight-line", "القسط الثابت"), declining_balance: t("Declining balance", "القسط المتناقص"), units_of_production: t("Units of production", "وحدات الإنتاج") } as Record<string, string>)[m] ?? m;
  const vatClass = (c: string) => ({ movable: t("movable", "منقول"), immovable: t("immovable", "غير منقول"), not_capital: t("not capital", "غير رأسمالي") } as Record<string, string>)[c] ?? c;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("Fixed Asset Schedule", "جدول الأصول الثابتة")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t("Cost, depreciation posted, carrying amount — and the Saudi tax facts each asset carries", "التكلفة والإهلاك المرحَّل والقيمة الدفترية — والحقائق الضريبية السعودية لكل أصل")}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          [t("In service", "في الخدمة"), String(totals?.inService ?? 0), "text-primary"],
          [t("Cost", "التكلفة"), fmtNum(totals?.cost ?? 0), "text-primary"],
          [t("Accumulated depreciation", "مجمع الإهلاك"), fmtNum(totals?.accumulatedDepreciation ?? 0), "text-negative"],
          [t("Carrying amount", "القيمة الدفترية"), fmtNum(totals?.carryingAmount ?? 0), "text-positive"],
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
              <p className="text-xs mt-1 opacity-60">{t("Register assets under Fixed Assets to see them here.", "سجّل الأصول في صفحة الأصول الثابتة لتظهر هنا.")}</p>
            </div>
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[t("Asset", "الأصل"), t("Category", "الفئة"), t("Acquired", "الاقتناء"), t("Cost", "التكلفة"), t("Life", "العمر"), t("Method", "الطريقة"), t("Tax group", "مجموعة الضريبة"), t("VAT class", "فئة ض.ق.م"), t("Acc. dep.", "مجمع الإهلاك"), t("Carrying", "القيمة الدفترية"), t("Status", "الحالة")].map((h) => (
                    <th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.id} className="border-b border-border/50 hover:bg-secondary/20" data-testid={`schedule-row-${a.assetNumber}`}>
                    <td className="py-2 pe-3 font-medium text-xs">{lang === "ar" && a.nameAr ? a.nameAr : a.name}<span className="block font-mono text-muted-foreground" dir="ltr">{a.assetNumber}</span></td>
                    <td className="py-2 pe-3 text-muted-foreground text-xs">{a.categoryName ?? "—"}</td>
                    <td className="py-2 pe-3 text-muted-foreground text-xs"><DualDate date={a.acquisitionDate} /></td>
                    <td className="py-2 pe-3 font-mono text-xs">{fmtNum(a.cost)}</td>
                    <td className="py-2 pe-3 font-mono text-xs">{a.postedPeriods}/{a.usefulLifeMonths} {t("mo", "شهر")}</td>
                    <td className="py-2 pe-3 text-xs text-muted-foreground">{method(a.depreciationMethod)}</td>
                    <td className="py-2 pe-3 text-xs">{a.incomeTaxGroup} · {a.incomeTaxRatePct}%</td>
                    <td className="py-2 pe-3 text-xs">{vatClass(a.vatCapitalAssetClass)}{a.vatAdjustmentPeriodYears != null ? ` · ${a.vatAdjustmentPeriodYears} ${t("y", "س")}` : ""}</td>
                    <td className="py-2 pe-3 font-mono text-xs text-negative">{fmtNum(a.accumulatedDepreciation)}</td>
                    <td className="py-2 pe-3 font-mono text-xs font-semibold text-positive">{fmtNum(a.carryingAmount)}</td>
                    <td className="py-2"><Badge className={`text-xs ${STATUS_STYLES[a.status] ?? ""}`}>{statusLabel(t, a)}</Badge></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td colSpan={3} className="pt-3 text-xs text-muted-foreground">{t("Total (in service, over the whole register)", "الإجمالي (في الخدمة، على السجل كله)")}</td>
                  <td className="pt-3 font-mono text-xs">{fmtNum(totals?.cost ?? 0)}</td>
                  <td colSpan={4} />
                  <td className="pt-3 font-mono text-xs text-negative">{fmtNum(totals?.accumulatedDepreciation ?? 0)}</td>
                  <td className="pt-3 font-mono text-xs text-positive">{fmtNum(totals?.carryingAmount ?? 0)}</td>
                  <td />
                </tr>
              </tfoot>
            </table></div>
          )}
          <ListPagination page={paged?.page} shown={assets.length} onPrev={() => setPage((p) => Math.max(0, p - 1))} onNext={() => setPage((p) => p + 1)} />
        </CardContent>
      </Card>
    </div>
  );
}
