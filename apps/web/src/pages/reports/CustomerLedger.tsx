import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { fetchPickerOptions } from "@/lib/pagedList";
import { PickerLimitNotice } from "@/components/PickerLimitNotice";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Users, ChevronDown, ChevronRight } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useState as useToggle } from "react";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { DualDate } from "@/components/DualDate";

interface Customer { id: number; name: string; }
import type { CustomerLedgerCustomer, CustomerLedgerReport } from "@workspace/api-client-react";

const STATUS_STYLES: Record<string, string> = { draft: "bg-secondary text-muted-foreground", sent: "bg-info-surface/20 text-info", paid: "bg-positive-surface/20 text-positive", partial: "bg-attention-surface/20 text-attention" };

function CustomerRow({ cust }: { cust: CustomerLedgerCustomer }) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="border border-border rounded-lg overflow-hidden mb-3">
      <button
        onClick={() => setExpanded(p => !p)}
        className="w-full flex items-center justify-between px-4 py-3 bg-secondary/20 hover:bg-secondary/40 transition-colors"
      >
        <div className="flex items-center gap-3">
          {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          <span className="font-semibold text-sm text-foreground">{cust.customerName}</span>
          {cust.taxNumber && <span className="text-xs text-muted-foreground">{t("VAT:", "الرقم الضريبي:")} {cust.taxNumber}</span>}
          <Badge variant="outline" className="text-xs">{cust.invoices.length} {t(cust.invoices.length !== 1 ? "invoices" : "invoice", cust.invoices.length !== 1 ? "فواتير" : "فاتورة")}</Badge>
        </div>
        <div className="flex items-center gap-6 text-sm font-mono">
          <span className="text-muted-foreground">{t("Invoiced:", "المفوتر:")} <span className="text-foreground">{fmtNum(cust.totalInvoiced)}</span></span>
          <span className="text-muted-foreground">{t("Paid:", "المدفوع:")} <span className="text-positive">{fmtNum(cust.totalPaid)}</span></span>
          <span className="text-muted-foreground">{t("Balance:", "الرصيد:")} <span className={cust.balance > 0 ? "text-negative font-bold" : "text-positive"}>{fmtNum(cust.balance)}</span></span>
        </div>
      </button>
      {expanded && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-muted-foreground text-xs uppercase bg-card">
              {[t("Invoice #", "رقم الفاتورة"), t("Date", "التاريخ"), t("Due Date", "الاستحقاق"), t("Subtotal", "الإجمالي الفرعي"), t("VAT", "الضريبة"), t("Total", "الإجمالي"), t("Paid", "المدفوع"), t("Outstanding", "المتبقي"), t("Status", "الحالة")].map(h => (
                <th key={h} className="text-start py-2 px-4 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cust.invoices.map(inv => (
              <tr key={inv.id} className="border-b border-border/30 hover:bg-secondary/10">
                <td className="py-2 px-4 font-mono text-xs text-primary">{inv.invoiceNumber}</td>
                <td className="py-2 px-4 text-xs text-muted-foreground"><DualDate date={inv.date} /></td>
                <td className="py-2 px-4 text-xs text-muted-foreground"><DualDate date={inv.dueDate} /></td>
                <td className="py-2 px-4 font-mono text-xs">{fmtNum(inv.subtotal)}</td>
                <td className="py-2 px-4 font-mono text-xs text-attention">{fmtNum(inv.vatAmount)}</td>
                <td className="py-2 px-4 font-mono text-xs font-semibold">{fmtNum(inv.total)}</td>
                <td className="py-2 px-4 font-mono text-xs text-positive">{fmtNum(inv.paidAmount)}</td>
                <td className="py-2 px-4 font-mono text-xs text-negative">{fmtNum(inv.outstanding)}</td>
                <td className="py-2 px-4"><Badge className={`text-xs ${STATUS_STYLES[inv.status] ?? ""}`}>{inv.status}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function CustomerLedger() {
  // M20.1 — the report does not mount until its default window is known, so a
  // wrong window (the old hardcoded Jan–Dec) is never queried or rendered,
  // even for a frame.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <CustomerLedgerInner range={range} />;
}

/**
 * 🔴 The deep link carries a customer, so the report must READ it.
 *
 * `CustomerDetail` links here as "Open statement" with `?customer_id=<id>`.
 * This page supported the filter all along — the dropdown sets it — but the
 * initial state was hardcoded to "all", so arriving from a specific customer's
 * page silently produced every customer's statement. Nothing errored and no
 * number was wrong; the act just did not carry the scope the user chose, which
 * is the navigation half of "a destructive act's scope must match what the
 * user can see". Found by clicking it, not by a test.
 */
function initialCustomerId(): string {
  if (typeof window === "undefined") return "all";
  const raw = new URLSearchParams(window.location.search).get("customer_id");
  // Only a positive integer is a customer id; anything else falls back to "all"
  // rather than being sent to the API as a filter that matches nothing.
  return raw && /^\d+$/.test(raw) && Number(raw) > 0 ? raw : "all";
}

function CustomerLedgerInner({ range }: { range: ReportDefaultRange }) {
  const { t } = useLanguage();
  const initialCustomer = initialCustomerId();
  const [customerId, setCustomerId] = useState(initialCustomer);
  const [dateFrom,   setDateFrom]   = useState(range.from);
  const [dateTo,     setDateTo]     = useState(range.to);
  const [applied,    setApplied]    = useState({ customerId: initialCustomer, from: range.from, to: range.to });

  const { data: customersPage } = useQuery<{ items: Customer[]; total: number }>({
    queryKey: ["customers", "picker"],
    queryFn: () => fetchPickerOptions<Customer>("/customers"),
  });
  const customers = customersPage?.items ?? [];

  const { data, isLoading } = useQuery<CustomerLedgerReport>({
    queryKey: ["customer-ledger", applied],
    queryFn: () => {
      const params = new URLSearchParams({ date_from: applied.from, date_to: applied.to });
      if (applied.customerId !== "all") params.set("customer_id", applied.customerId);
      return apiFetch(`/reports/customer-ledger?${params}`);
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Customer Ledger Report", "تقرير كشف حساب العملاء")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("All invoices and balances per customer", "كل الفواتير والأرصدة لكل عميل")}</p>
        </div>
        {/* Export removed: no onClick — one of seven dead Export buttons
            (2026-09-01). Export belongs to L1's artifact design. */}
      </div>

      <FiscalRangeNotice source={range.source} />

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4 flex-wrap">
            <div className="min-w-48">
              <Label className="text-xs text-muted-foreground">{t("Customer", "العميل")}</Label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("All Customers", "كل العملاء")}</SelectItem>
                  {customers.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                <PickerLimitNotice shown={customers.length} total={customersPage?.total ?? customers.length} /></SelectContent>
              </Select>
            </div>
            <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <Button size="sm" className="h-8" onClick={() => setApplied({ customerId, from: dateFrom, to: dateTo })}>{t("Generate", "إنشاء")}</Button>
          </div>
          <div className="mt-3">
            <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied({customerId,from:r.from,to:r.to});}} />
          </div>
        </CardContent>
      </Card>

      {data && (
        <div className="grid grid-cols-3 gap-4">
          {[
            [t("Customers", "العملاء"), data.customers.length, "text-primary"],
            [t("Total AR Balance", "إجمالي رصيد الذمم"), fmtNum(data.totalBalance), "text-negative"],
            [t("Zero Balance", "رصيد صفري"), data.customers.filter(c => c.balance <= 0).length, "text-positive"],
          ].map(([l, v, c]) => (
            <Card key={String(l)} className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
              <CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent>
            </Card>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>
      ) : !data || data.customers.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Users className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <p className="text-sm">{t("No customer data for this period.", "لا توجد بيانات عملاء لهذه الفترة.")}</p>
        </div>
      ) : (
        <div>
          {data.customers.map(cust => <CustomerRow key={cust.customerId} cust={cust} />)}
        </div>
      )}
    </div>
  );
}
