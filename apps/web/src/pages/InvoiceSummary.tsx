import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { FileText } from "lucide-react";
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { DualDate } from "@/components/DualDate";
import { useLanguage } from "@/contexts/LanguageContext";

import type { Invoice, ListInvoices200 } from "@workspace/api-client-react";

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  sent: "bg-info-surface/20 text-info",
  paid: "bg-positive-surface/20 text-positive",

  partial: "bg-attention-surface/20 text-attention",
};

export default function InvoiceSummary() {
  // M20.1 — the report does not mount until its default window is known, so a
  // wrong window (the old hardcoded Jan–Dec) is never queried or rendered,
  // even for a frame.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <InvoiceSummaryInner range={range} />;
}

function InvoiceSummaryInner({ range }: { range: ReportDefaultRange }) {
  const { t } = useLanguage();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);

  const { data: summaryPage, isLoading } = useQuery<ListInvoices200>({
    queryKey: ["invoice-summary", from, to],
    /**
     * 🔴 Reads the PAGE envelope, and no longer swallows a failure into an
     * empty list. The old `.catch(() => [])` turned a shape mismatch into "No
     * invoices in this date range" — a confident empty answer on a report,
     * which is the same defensive-fallback trap that hid the AP-aging break.
     */
    /**
     * 🔴 Contract batch 3: `date_from`/`date_to` are SERVER filters now. This
     * page used to send `from`/`to`, which the server never read — so it got
     * the 200 most recent invoices of all time and filtered them client-side,
     * and every figure below silently covered whatever fell inside that cap.
     * The cap still exists (200); it is now STATED when it bites.
     */
    queryFn: () => apiFetch<ListInvoices200>(`/invoices?limit=200&date_from=${from}&date_to=${to}`),
  });
  const invoices: Invoice[] = summaryPage?.items ?? [];
  const setTotal = summaryPage?.page.total ?? 0;
  const truncated = setTotal > invoices.length;

  const filtered = invoices.filter(i => i.date >= from && i.date <= to);
  const totalRevenue = filtered.reduce((s, i) => s + i.subtotal, 0);
  const totalVat = filtered.reduce((s, i) => s + i.vatAmount, 0);
  const totalOutstanding = filtered.filter(i => i.status !== "paid").reduce((s, i) => s + (i.total - i.paidAmount), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("Invoice Summary", "ملخص الفواتير")}
        description={t("All invoices with totals and status breakdown", "جميع الفواتير مع الإجماليات وتوزيع الحالات")}
      />
      {/* Export removed 2026-09-01: it had no onClick — the seventh dead Export
          button found in one sweep. Omit the control rather than promise nothing
          (the VendorDetail precedent); export belongs to L1 artifact design. */}

      <FiscalRangeNotice source={range.source} />

      <Panel>
        <div className="flex flex-wrap gap-4 items-end">
          <div><Label className="text-[13px] text-muted-foreground">{t("From", "من")}</Label>
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="mt-1.5 w-40" /></div>
          <div><Label className="text-[13px] text-muted-foreground">{t("To", "إلى")}</Label>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="mt-1.5 w-40" /></div>
        </div>
        <div className="mt-3">
          <PeriodShortcuts from={from} to={to} onSelect={(r)=>{setFrom(r.from);setTo(r.to);}} />
        </div>
      </Panel>

      {truncated && (
        <p className="text-[13px] text-attention" data-testid="summary-truncated">
          {t("Showing", "يعرض")} {invoices.length} {t("of", "من")} {setTotal} {t("invoices in this range — the figures below cover only the rows shown. Narrow the range for a complete total.", "فاتورة في هذه الفترة — الأرقام أدناه تغطي الصفوف المعروضة فقط. ضيّق الفترة للحصول على إجمالي كامل.")}
        </p>
      )}
      <StatStrip cols={4}>
        <Stat label={t("Total Invoices", "إجمالي الفواتير")} value={filtered.length} />
        <Stat label={t("Revenue (excl. VAT)", "الإيراد (دون الضريبة)")} value={fmtNum(totalRevenue)} />
        <Stat label={t("VAT Charged", "الضريبة المحصلة")} value={fmtNum(totalVat)} />
        <Stat label={t("Outstanding", "المستحق")} value={fmtNum(totalOutstanding)} />
      </StatStrip>

      <Panel flush>
        {isLoading ? <div className="text-sm text-muted-foreground p-5">{t("Loading…", "جارٍ التحميل…")}</div>
        : filtered.length === 0 ? (
          <EmptyState icon={FileText} title={t("No invoices in this date range.", "لا توجد فواتير في هذا النطاق الزمني.")} />
        ) : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {([
                  [t("Invoice #", "رقم الفاتورة"), false],
                  [t("Customer", "العميل"), false],
                  [t("Date", "التاريخ"), false],
                  [t("Due Date", "تاريخ الاستحقاق"), false],
                  [t("Subtotal", "المجموع الفرعي"), true],
                  [t("VAT", "الضريبة"), true],
                  [t("Total", "الإجمالي"), true],
                  [t("Outstanding", "المستحق"), true],
                  [t("Status", "الحالة"), false],
                ] as const).map(([h, num]) => (
                  <th key={h} className={`${num ? "text-end" : "text-start"} px-3`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(i => (
                <tr key={i.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors">
                  <td className="py-3 px-3 whitespace-nowrap font-medium text-primary">{i.invoiceNumber}</td>
                  <td className="py-3 px-3 min-w-[10rem]">{i.customerName}</td>
                  <td className="py-3 px-3 whitespace-nowrap text-muted-foreground"><DualDate date={i.date} /></td>
                  <td className="py-3 px-3 whitespace-nowrap text-muted-foreground"><DualDate date={i.dueDate} /></td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(i.subtotal)}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{fmtNum(i.vatAmount)}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums font-semibold">{fmtNum(i.total)}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(i.total - i.paidAmount)}</td>
                  <td className="py-3 px-3"><Badge className={`text-xs capitalize ${STATUS_STYLES[i.status] ?? ""}`}>{i.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Panel>
    </div>
  );
}
