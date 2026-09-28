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
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
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
      <PageHeader
        title={t("Fixed Asset Schedule", "جدول الأصول الثابتة")}
        description={t("Cost, depreciation posted, carrying amount — and the Saudi tax facts each asset carries", "التكلفة والإهلاك المرحَّل والقيمة الدفترية — والحقائق الضريبية السعودية لكل أصل")}
      />

      <StatStrip cols={4}>
        <Stat label={t("In service", "في الخدمة")} value={String(totals?.inService ?? 0)} />
        <Stat label={t("Cost", "التكلفة")} value={fmtNum(totals?.cost ?? 0)} />
        <Stat label={t("Accumulated depreciation", "مجمع الإهلاك")} value={fmtNum(totals?.accumulatedDepreciation ?? 0)} />
        <Stat label={t("Carrying amount", "القيمة الدفترية")} value={fmtNum(totals?.carryingAmount ?? 0)} />
      </StatStrip>

      <Panel flush>
          {isLoading ? <div className="text-sm text-muted-foreground p-5">{t("Loading…", "جارٍ التحميل…")}</div>
          : assets.length === 0 ? (
            <EmptyState
              icon={Package}
              title={t("No fixed assets registered.", "لا توجد أصول ثابتة مسجّلة.")}
              description={t("Register assets under Fixed Assets to see them here.", "سجّل الأصول في صفحة الأصول الثابتة لتظهر هنا.")}
            />
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {([[t("Asset", "الأصل"), false], [t("Category", "الفئة"), false], [t("Acquired", "الاقتناء"), false], [t("Cost", "التكلفة"), true], [t("Life", "العمر"), true], [t("Method", "الطريقة"), false], [t("Tax group", "مجموعة الضريبة"), false], [t("VAT class", "فئة ض.ق.م"), false], [t("Acc. dep.", "مجمع الإهلاك"), true], [t("Carrying", "القيمة الدفترية"), true], [t("Status", "الحالة"), false]] as const).map(([h, num]) => (
                    <th key={h} className={`px-3 ${num ? "text-end" : "text-start"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors" data-testid={`schedule-row-${a.assetNumber}`}>
                    <td className="py-3 px-3 font-medium min-w-[10rem]">{lang === "ar" && a.nameAr ? a.nameAr : a.name}<span className="block text-xs font-normal tabular-nums text-muted-foreground" dir="ltr">{a.assetNumber}</span></td>
                    <td className="py-3 px-3 text-muted-foreground text-[13px]">{a.categoryName ?? "—"}</td>
                    <td className="py-3 px-3 text-muted-foreground whitespace-nowrap"><DualDate date={a.acquisitionDate} /></td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(a.cost)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-[13px]">{a.postedPeriods}/{a.usefulLifeMonths} {t("mo", "شهر")}</td>
                    <td className="py-3 px-3 text-[13px] text-muted-foreground whitespace-nowrap">{method(a.depreciationMethod)}</td>
                    <td className="py-3 px-3 text-[13px] whitespace-nowrap">{a.incomeTaxGroup} · {a.incomeTaxRatePct}%</td>
                    <td className="py-3 px-3 text-[13px] whitespace-nowrap">{vatClass(a.vatCapitalAssetClass)}{a.vatAdjustmentPeriodYears != null ? ` · ${a.vatAdjustmentPeriodYears} ${t("y", "س")}` : ""}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{fmtNum(a.accumulatedDepreciation)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums font-semibold">{fmtNum(a.carryingAmount)}</td>
                    <td className="py-3 px-3"><Badge className={`text-xs capitalize ${STATUS_STYLES[a.status] ?? ""}`}>{statusLabel(t, a)}</Badge></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td colSpan={3} className="py-3 px-3 text-[13px]">{t("Total (in service, over the whole register)", "الإجمالي (في الخدمة، على السجل كله)")}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(totals?.cost ?? 0)}</td>
                  <td colSpan={4} />
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(totals?.accumulatedDepreciation ?? 0)}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(totals?.carryingAmount ?? 0)}</td>
                  <td />
                </tr>
              </tfoot>
            </table></div>
          )}
          <div className="border-t border-border px-5 pb-3 empty:hidden">
            <ListPagination page={paged?.page} shown={assets.length} onPrev={() => setPage((p) => Math.max(0, p - 1))} onNext={() => setPage((p) => p + 1)} />
          </div>
      </Panel>
    </div>
  );
}
