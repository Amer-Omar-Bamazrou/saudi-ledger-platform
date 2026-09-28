import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel, EmptyState, SectionTitle } from "@/components/kit";
import { useLanguage } from "@/contexts/LanguageContext";
import { AlertCircle, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { DualDate } from "@/components/DualDate";

import type { ApAgingReport, ArAgingReport } from "@workspace/api-client-react";

/**
 * One row shape for both tables. The generated AR and AP item types differ
 * only in which party and which document number they carry, so the page
 * normalises them ONCE here instead of indexing a union with string keys.
 */
type AgingRow = { id: number; number: string; name: string; nameAr: string; dueDate: string | null; outstanding: number; daysPastDue: number };
type AgingView = { buckets: ArAgingReport["buckets"]; total: number; rows: AgingRow[] };

function viewOf(data: ArAgingReport | ApAgingReport): AgingView {
  const rows: AgingRow[] = "items" in data
    ? data.items.map((i) =>
        "invoiceNumber" in i
          ? { id: i.id, number: i.invoiceNumber, name: i.customerName, nameAr: i.customerNameAr, dueDate: i.dueDate, outstanding: i.outstanding, daysPastDue: i.daysPastDue }
          : { id: i.id, number: i.billNumber, name: i.vendorName, nameAr: i.vendorNameAr, dueDate: i.dueDate, outstanding: i.outstanding, daysPastDue: i.daysPastDue },
      )
    : [];
  return { buckets: data.buckets, total: data.total, rows };
}

const BUCKET_LABELS = [
  { key: "current",    en: "Current",      ar: "جارٍ",             color: "text-positive" },
  { key: "days_1_30",  en: "1–30 Days",    ar: "1–30 يومًا",       color: "text-attention" },
  { key: "days_31_60", en: "31–60 Days",   ar: "31–60 يومًا",      color: "text-severe" },
  { key: "days_61_90", en: "61–90 Days",   ar: "61–90 يومًا",      color: "text-negative" },
  { key: "over_90",    en: "Over 90 Days", ar: "أكثر من 90 يومًا", color: "text-critical" },
] as const;

function AgingTable({ data, type }: { data: AgingView; type: "ar" | "ap" }) {
  const items = data.rows;
  const { n, t } = useLanguage();
  const numLabel  = type === "ar" ? t("Invoice #", "رقم الفاتورة") : t("Bill #", "رقم فاتورة المورد");
  const partyLabel = type === "ar" ? t("Customer", "العميل") : t("Vendor", "المورد");

  return (
    <>
      {/* Buckets */}
      <StatStrip cols={5}>
        {BUCKET_LABELS.map(b => (
          <Stat key={b.key} label={t(b.en, b.ar)} value={<span className={b.color}>{fmtNum(data.buckets[b.key])}</span>} />
        ))}
      </StatStrip>

      {/* Table */}
      <Panel flush>
      {items.length === 0 ? (
        <EmptyState
          icon={type === "ar" ? AlertCircle : Building2}
          title={type === "ar" ? t("No outstanding receivables.", "لا توجد ذمم مدينة معلقة.") : t("No outstanding payables.", "لا توجد ذمم دائنة معلقة.")}
        />
      ) : (
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              {([
                [numLabel, false],
                [partyLabel, false],
                [t("Due Date", "تاريخ الاستحقاق"), false],
                [t("Outstanding", "المبلغ المستحق"), true],
                [t("Days Overdue", "أيام التأخر"), true],
              ] as const).map(([h, num]) => (
                <th key={h} className={`${num ? "text-end" : "text-start"} px-3`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map(item => {
              const bucket = item.daysPastDue <= 0 ? "current" : item.daysPastDue <= 30 ? "days_1_30" : item.daysPastDue <= 60 ? "days_31_60" : item.daysPastDue <= 90 ? "days_61_90" : "over_90";
              const color  = BUCKET_LABELS.find(b => b.key === bucket)?.color ?? "";
              return (
                <tr key={item.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors">
                  <td className="py-3 px-3 font-medium text-primary whitespace-nowrap">{item.number}</td>
                  <td className="py-3 px-3 font-medium">{n(item.name, item.nameAr)}</td>
                  <td className="py-3 px-3 text-muted-foreground whitespace-nowrap"><DualDate date={item.dueDate} /></td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums font-semibold">{fmtNum(item.outstanding)}</td>
                  <td className={cn("py-3 px-3 text-end whitespace-nowrap tabular-nums", color)}>{item.daysPastDue > 0 ? `${item.daysPastDue} ${t("days", "أيام")}` : t("Current", "حالي")}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td colSpan={3} className="py-3.5 px-3">{t("Total Outstanding", "إجمالي المستحق")}</td>
              <td className="py-3.5 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(data.total)}</td>
              <td />
            </tr>
          </tfoot>
        </table></div>
      )}
      </Panel>
    </>
  );
}

export default function AgingReports() {
  const { t } = useLanguage();
  const { data: arData, isLoading: arLoading } = useQuery<ArAgingReport>({
    queryKey: ["ar-aging"],
    queryFn: () => apiFetch("/reports/ar-aging"),
  });
  const { data: apData, isLoading: apLoading } = useQuery<ApAgingReport>({
    queryKey: ["ap-aging"],
    queryFn: () => apiFetch("/reports/ap-aging"),
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={
          <>
            {t("Aging Reports", "تقارير الأعمار")}
            <span className="ms-2 align-middle text-xs font-normal px-1.5 py-0.5 rounded-full bg-attention-surface/15 text-attention border border-attention-surface/20">{t("New", "جديد")}</span>
          </>
        }
        description={t("Accounts Receivable and Accounts Payable aged by overdue days", "الذمم المدينة والدائنة مصنّفة حسب أيام التأخر")}
      />

      {/* AR */}
      <section>
        <SectionTitle
          className="mt-0"
          actions={arData && <span className="text-[13px] text-muted-foreground">{t("Total:", "الإجمالي:")} <span className="tabular-nums font-semibold text-foreground">{fmtNum(arData.total)}</span></span>}
        >
          {t("Accounts Receivable Aging", "تقرير أعمار الذمم المدينة")}
        </SectionTitle>
        {arLoading ? <div className="text-sm text-muted-foreground">{t("Loading AR…", "جارٍ تحميل الذمم المدينة…")}</div> : arData ? <AgingTable data={viewOf(arData)} type="ar" /> : null}
      </section>

      {/* AP */}
      <section>
        <SectionTitle
          actions={apData && <span className="text-[13px] text-muted-foreground">{t("Total:", "الإجمالي:")} <span className="tabular-nums font-semibold text-foreground">{fmtNum(apData.total)}</span></span>}
        >
          {t("Accounts Payable Aging", "تقرير أعمار الذمم الدائنة")}
        </SectionTitle>
        {apLoading ? <div className="text-sm text-muted-foreground">{t("Loading AP…", "جارٍ تحميل الذمم الدائنة…")}</div> : apData ? <AgingTable data={viewOf(apData)} type="ap" /> : null}
      </section>
    </div>
  );
}
