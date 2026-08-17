import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Users, Download, ChevronDown, ChevronRight } from "lucide-react";
import { useState as useToggle } from "react";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";

interface Customer { id: number; name: string; }
interface InvoiceRow { id: number; invoiceNumber: string; date: string; dueDate: string; status: string; total: number; paidAmount: number; outstanding: number; vatAmount: number; subtotal: number; }
interface CustomerBalance { customerId: number; customerName: string; taxNumber: string | null; invoices: InvoiceRow[]; totalInvoiced: number; totalPaid: number; balance: number; }
interface LedgerData { customers: CustomerBalance[]; totalBalance: number; }

const STATUS_STYLES: Record<string, string> = { draft: "bg-secondary text-muted-foreground", sent: "bg-blue-500/20 text-blue-400", paid: "bg-emerald-500/20 text-emerald-400", overdue: "bg-red-500/20 text-red-400", partial: "bg-amber-500/20 text-amber-400" };

function CustomerRow({ cust }: { cust: CustomerBalance }) {
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
          {cust.taxNumber && <span className="text-xs text-muted-foreground">VAT: {cust.taxNumber}</span>}
          <Badge variant="outline" className="text-xs">{cust.invoices.length} invoice{cust.invoices.length !== 1 ? "s" : ""}</Badge>
        </div>
        <div className="flex items-center gap-6 text-sm font-mono">
          <span className="text-muted-foreground">Invoiced: <span className="text-foreground">{fmtNum(cust.totalInvoiced)}</span></span>
          <span className="text-muted-foreground">Paid: <span className="text-emerald-400">{fmtNum(cust.totalPaid)}</span></span>
          <span className="text-muted-foreground">Balance: <span className={cust.balance > 0 ? "text-red-400 font-bold" : "text-emerald-400"}>{fmtNum(cust.balance)}</span></span>
        </div>
      </button>
      {expanded && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-muted-foreground text-xs uppercase bg-card">
              {["Invoice #", "Date", "Due Date", "Subtotal", "VAT", "Total", "Paid", "Outstanding", "Status"].map(h => (
                <th key={h} className="text-left py-2 px-4 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cust.invoices.map(inv => (
              <tr key={inv.id} className="border-b border-border/30 hover:bg-secondary/10">
                <td className="py-2 px-4 font-mono text-xs text-primary">{inv.invoiceNumber}</td>
                <td className="py-2 px-4 text-xs text-muted-foreground">{fmtDate(inv.date)}</td>
                <td className="py-2 px-4 text-xs text-muted-foreground">{inv.dueDate ? fmtDate(inv.dueDate) : "—"}</td>
                <td className="py-2 px-4 font-mono text-xs">{fmtNum(inv.subtotal)}</td>
                <td className="py-2 px-4 font-mono text-xs text-amber-400">{fmtNum(inv.vatAmount)}</td>
                <td className="py-2 px-4 font-mono text-xs font-semibold">{fmtNum(inv.total)}</td>
                <td className="py-2 px-4 font-mono text-xs text-emerald-400">{fmtNum(inv.paidAmount)}</td>
                <td className="py-2 px-4 font-mono text-xs text-red-400">{fmtNum(inv.outstanding)}</td>
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

function CustomerLedgerInner({ range }: { range: ReportDefaultRange }) {
  const [customerId, setCustomerId] = useState("all");
  const [dateFrom,   setDateFrom]   = useState(range.from);
  const [dateTo,     setDateTo]     = useState(range.to);
  const [applied,    setApplied]    = useState({ customerId: "all", from: range.from, to: range.to });

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: () => apiFetch("/customers"),
  });

  const { data, isLoading } = useQuery<LedgerData>({
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
          <h1 className="text-2xl font-bold text-foreground">Customer Ledger Report <span className="ml-2 text-xs font-normal px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/20">New</span></h1>
          <p className="text-muted-foreground text-sm mt-1">All invoices and balances per customer</p>
        </div>
        <Button variant="outline" className="gap-2"><Download className="w-4 h-4" /> Export</Button>
      </div>

      <FiscalRangeNotice source={range.source} />

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4 flex-wrap">
            <div className="min-w-48">
              <Label className="text-xs text-muted-foreground">Customer</Label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Customers</SelectItem>
                  {customers.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label className="text-xs text-muted-foreground">From</Label><Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">To</Label><Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <Button size="sm" className="h-8" onClick={() => setApplied({ customerId, from: dateFrom, to: dateTo })}>Generate</Button>
          </div>
          <div className="mt-3">
            <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied({customerId,from:r.from,to:r.to});}} />
          </div>
        </CardContent>
      </Card>

      {data && (
        <div className="grid grid-cols-3 gap-4">
          {[
            ["Customers", data.customers.length, "text-primary"],
            ["Total AR Balance", fmtNum(data.totalBalance), "text-red-400"],
            ["Zero Balance", data.customers.filter(c => c.balance <= 0).length, "text-emerald-400"],
          ].map(([l, v, c]) => (
            <Card key={String(l)} className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
              <CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent>
            </Card>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground p-4">Loading…</div>
      ) : !data || data.customers.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Users className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <p className="text-sm">No customer data for this period.</p>
        </div>
      ) : (
        <div>
          {data.customers.map(cust => <CustomerRow key={cust.customerId} cust={cust} />)}
        </div>
      )}
    </div>
  );
}
