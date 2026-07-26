import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { AlertCircle, Building2, Download } from "lucide-react";
import { cn } from "@/lib/utils";

interface AgingItem { id: number; date: string; dueDate: string; outstanding: number; daysPastDue: number; }
interface ArItem extends AgingItem { invoiceNumber: string; customerName: string; customerNameAr?: string; }
interface ApItem extends AgingItem { billNumber: string; vendorName: string; vendorNameAr?: string; }
interface Buckets { current: number; days_1_30: number; days_31_60: number; days_61_90: number; over_90: number; }
interface AgingData { buckets: Buckets; total: number; items: (ArItem | ApItem)[]; }

const BUCKET_LABELS = [
  { key: "current",    label: "Current",      color: "text-emerald-400" },
  { key: "days_1_30",  label: "1–30 Days",    color: "text-amber-400" },
  { key: "days_31_60", label: "31–60 Days",   color: "text-orange-400" },
  { key: "days_61_90", label: "61–90 Days",   color: "text-red-400" },
  { key: "over_90",    label: "Over 90 Days", color: "text-red-600" },
] as const;

function AgingTable({ data, type }: { data: AgingData; type: "ar" | "ap" }) {
  const items = data.items as any[];
  const { n, t } = useLanguage();
  const nameKey   = type === "ar" ? "customerName" : "vendorName";
  const nameArKey = type === "ar" ? "customerNameAr" : "vendorNameAr";
  const numKey    = type === "ar" ? "invoiceNumber" : "billNumber";
  const numLabel  = type === "ar" ? t("Invoice #", "رقم الفاتورة") : t("Bill #", "رقم فاتورة المورد");
  const partyLabel = type === "ar" ? t("Customer", "العميل") : t("Vendor", "المورد");

  return (
    <div className="space-y-4">
      {/* Buckets */}
      <div className="grid grid-cols-5 gap-3">
        {BUCKET_LABELS.map(b => (
          <Card key={b.key} className="border-border bg-card">
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">{b.label}</CardTitle></CardHeader>
            <CardContent><div className={cn("text-lg font-bold font-mono", b.color)}>{fmtNum((data.buckets as any)[b.key])}</div></CardContent>
          </Card>
        ))}
      </div>

      {/* Table */}
      {items.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {type === "ar" ? <AlertCircle className="w-8 h-8 mx-auto mb-3 opacity-40" /> : <Building2 className="w-8 h-8 mx-auto mb-3 opacity-40" />}
          <p className="text-sm">{type === "ar" ? t("No outstanding receivables.", "لا توجد ذمم مدينة معلقة.") : t("No outstanding payables.", "لا توجد ذمم دائنة معلقة.")}</p>
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-muted-foreground text-xs uppercase">
              {[numLabel, partyLabel, t("Due Date", "تاريخ الاستحقاق"), t("Outstanding", "المبلغ المستحق"), t("Days Overdue", "أيام التأخر")].map(h => (
                <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map(item => {
              const bucket = item.daysPastDue <= 0 ? "current" : item.daysPastDue <= 30 ? "days_1_30" : item.daysPastDue <= 60 ? "days_31_60" : item.daysPastDue <= 90 ? "days_61_90" : "over_90";
              const color  = BUCKET_LABELS.find(b => b.key === bucket)?.color ?? "";
              return (
                <tr key={item.id} className="border-b border-border/30 hover:bg-secondary/10">
                  <td className="py-2.5 pr-4 font-mono text-xs text-primary">{item[numKey]}</td>
                  <td className="py-2.5 pr-4 font-medium text-sm">{n(String((item as any)[nameKey] ?? ""), (item as any)[nameArKey])}</td>
                  <td className="py-2.5 pr-4 text-xs text-muted-foreground">{item.dueDate ? fmtDate(item.dueDate) : "—"}</td>
                  <td className="py-2.5 pr-4 font-mono text-sm font-semibold">{fmtNum(item.outstanding)}</td>
                  <td className={cn("py-2.5 font-mono text-sm", color)}>{item.daysPastDue > 0 ? `${item.daysPastDue} ${t("days", "أيام")}` : t("Current", "حالي")}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border font-bold">
              <td colSpan={3} className="pt-3 text-xs text-muted-foreground">{t("Total Outstanding", "إجمالي المستحق")}</td>
              <td className="pt-3 font-mono text-sm">{fmtNum(data.total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

export default function AgingReports() {
  const { t } = useLanguage();
  const { data: arData, isLoading: arLoading } = useQuery<AgingData>({
    queryKey: ["ar-aging"],
    queryFn: () => apiFetch("/reports/ar-aging"),
  });
  const { data: apData, isLoading: apLoading } = useQuery<AgingData>({
    queryKey: ["ap-aging"],
    queryFn: () => apiFetch("/reports/ap-aging"),
  });

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {t("Aging Reports", "تقارير الأعمار")}
            <span className="ml-2 text-xs font-normal px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/20">{t("New", "جديد")}</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Accounts Receivable and Accounts Payable aged by overdue days", "الذمم المدينة والدائنة مصنّفة حسب أيام التأخر")}</p>
        </div>
        <Button variant="outline" className="gap-2"><Download className="w-4 h-4" /> {t("Export", "تصدير")}</Button>
      </div>

      {/* AR */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <AlertCircle className="w-4 h-4 text-blue-400" />
          <h2 className="font-semibold text-base text-foreground">{t("Accounts Receivable Aging", "تقرير أعمار الذمم المدينة")}</h2>
          {arData && <span className="text-xs text-muted-foreground ml-auto">{t("Total:", "الإجمالي:")} <span className="font-mono font-semibold text-foreground">{fmtNum(arData.total)}</span></span>}
        </div>
        {arLoading ? <div className="text-sm text-muted-foreground">{t("Loading AR…", "جارٍ تحميل الذمم المدينة…")}</div> : arData ? <AgingTable data={arData} type="ar" /> : null}
      </div>

      <div className="h-px bg-border" />

      {/* AP */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Building2 className="w-4 h-4 text-amber-400" />
          <h2 className="font-semibold text-base text-foreground">{t("Accounts Payable Aging", "تقرير أعمار الذمم الدائنة")}</h2>
          {apData && <span className="text-xs text-muted-foreground ml-auto">{t("Total:", "الإجمالي:")} <span className="font-mono font-semibold text-foreground">{fmtNum(apData.total)}</span></span>}
        </div>
        {apLoading ? <div className="text-sm text-muted-foreground">{t("Loading AP…", "جارٍ تحميل الذمم الدائنة…")}</div> : apData ? <AgingTable data={apData} type="ap" /> : null}
      </div>
    </div>
  );
}
