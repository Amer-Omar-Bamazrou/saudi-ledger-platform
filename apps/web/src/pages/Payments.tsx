/**
 * Payments — every customer receipt and refund, newest first.
 *
 * Batch 1B Phase F (2026-09-17). The list is PAYMENTS (cash events); a row
 * opens into its ALLOCATIONS. The distinction is the page's whole point: an
 * invoice "paid" here is an invoice with allocations against it, and a
 * receipt with none is a deposit the customer can reclaim.
 *
 * The API pages at 200 (the server's maximum); the page states the cut.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { fetchPickerOptions } from "@/lib/pagedList";
import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Banknote, Plus, Undo2 } from "lucide-react";
import { DualDate } from "@/components/DualDate";
import { PaymentDetail } from "@/components/payments/PaymentDetail";
import { ReceiveDialog } from "@/components/payments/ReceiveDialog";
import { BankName, ClassificationBadge, PaymentStateBadge, PermissionHint, receiptNumber, refundNumber, useCanPostPayments } from "@/components/payments/shared";

import type { Customer, CustomerPayment, CustomerRefund, ListInvoices200 } from "@workspace/api-client-react";

const PAGE = 50;

/** The detail dialog resolves the customer's invoice numbers for its allocation rows. */
function PaymentDialog({ payment, customerName, onClose }: { payment: CustomerPayment; customerName: string; onClose: () => void }) {
  const { t } = useLanguage();
  const { data } = useQuery<ListInvoices200>({
    queryKey: ["invoices", "open-for-customer", payment.customerId],
    queryFn: () => apiFetch(`/invoices?customer_id=${payment.customerId}&limit=200`),
    enabled: payment.customerId != null,
  });
  const numbers = useMemo(() => Object.fromEntries((data?.items ?? []).map((i) => [i.id, i.invoiceNumber])) as Record<number, string>, [data]);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t("Payment", "الدفعة")} {receiptNumber(payment.id)}</DialogTitle></DialogHeader>
        <PaymentDetail payment={payment} customerName={customerName} invoiceNumbers={numbers} />
      </DialogContent>
    </Dialog>
  );
}

export default function Payments() {
  const { t, n } = useLanguage();
  const canPost = useCanPostPayments();
  const [customerId, setCustomerId] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<CustomerPayment | null>(null);
  const [receiving, setReceiving] = useState(false);

  const { data: customers } = useQuery({ queryKey: ["customers", "picker"], queryFn: () => fetchPickerOptions<Customer>("/customers") });
  const nameOf = (id: number | null) => {
    if (id == null) return t("No identified customer", "بدون عميل محدد");
    const c = customers?.items.find((x) => x.id === id);
    return c ? n(c.name, c.nameAr) : `#${id}`;
  };

  const filter = customerId !== "all" ? `customer_id=${customerId}&` : "";
  const { data: payments = [], isLoading, error } = useQuery<CustomerPayment[]>({
    queryKey: ["payments", "list", customerId, page],
    queryFn: () => apiFetch(`/payments?${filter}limit=${PAGE}&offset=${page * PAGE}`),
  });
  const { data: refunds = [] } = useQuery<CustomerRefund[]>({
    queryKey: ["refunds", "list", customerId, page],
    queryFn: () => apiFetch(`/payments/refunds?${filter}limit=${PAGE}&offset=${page * PAGE}`),
  });

  // Keep the dialog on the fresh row after a write (the list is refetched).
  const current = selected ? payments.find((p) => p.id === selected.id) ?? selected : null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Payments", "المدفوعات")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Customer receipts and refunds. A receipt is money in; its allocations say which invoices it settled.", "إيصالات العملاء والمبالغ المردودة. الإيصال مال وارد؛ وتخصيصاته تبيّن أي فواتير سوّى.")}</p>
        </div>
        <Button className="gap-2" disabled={!canPost} onClick={() => setReceiving(true)} data-testid="record-receipt">
          <Plus className="w-4 h-4" />{t("Record receipt", "تسجيل إيصال")}
        </Button>
      </div>
      <PermissionHint />

      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm text-muted-foreground">{t("Customer", "العميل")}</span>
        <Select value={customerId} onValueChange={(v) => { setCustomerId(v); setPage(0); }}>
          <SelectTrigger className="h-9 w-64 text-sm" data-testid="payments-customer-filter"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("All customers", "كل العملاء")}</SelectItem>
            {(customers?.items ?? []).map((c) => <SelectItem key={c.id} value={String(c.id)}>{n(c.name, c.nameAr)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="receipts">
        <TabsList>
          <TabsTrigger value="receipts" data-testid="tab-receipts"><Banknote className="w-4 h-4 me-1" />{t("Receipts", "الإيصالات")} ({payments.length})</TabsTrigger>
          <TabsTrigger value="refunds" data-testid="tab-refunds"><Undo2 className="w-4 h-4 me-1" />{t("Refunds", "المبالغ المردودة")} ({refunds.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="receipts">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Receipts, newest first", "الإيصالات، الأحدث أولًا")}</CardTitle></CardHeader>
            <CardContent>
              {isLoading ? (
                <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>
              ) : error ? (
                <p className="text-sm text-destructive p-4">{t("Payments could not be loaded.", "تعذر تحميل المدفوعات.")} {(error as Error).message}</p>
              ) : payments.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground"><Banknote className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>{t("No payments yet.", "لا توجد مدفوعات بعد.")}</p></div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                        <th className="text-start pb-2 pe-4 font-medium">{t("Receipt", "الإيصال")}</th>
                        <th className="text-start pb-2 pe-4 font-medium">{t("Received", "الاستلام")}</th>
                        <th className="text-start pb-2 pe-4 font-medium">{t("Customer", "العميل")}</th>
                        <th className="text-start pb-2 pe-4 font-medium hidden md:table-cell">{t("Bank", "البنك")}</th>
                        <th className="text-start pb-2 pe-4 font-medium">{t("Amount", "المبلغ")}</th>
                        <th className="text-start pb-2 pe-4 font-medium hidden sm:table-cell">{t("Allocated", "المخصص")}</th>
                        <th className="text-start pb-2 pe-4 font-medium hidden sm:table-cell">{t("On account", "على الحساب")}</th>
                        <th className="text-start pb-2 pe-4 font-medium hidden lg:table-cell">{t("State", "الحالة")}</th>
                        <th className="text-start pb-2 pe-4 font-medium hidden lg:table-cell">{t("Deposit is", "العربون")}</th>
                        <th className="pb-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((p) => (
                        <tr key={p.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors" data-testid={`payment-row-${p.id}`}>
                          <td className="py-3 pe-4 font-mono text-xs">{receiptNumber(p.id)}</td>
                          <td className="py-3 pe-4 text-muted-foreground"><DualDate date={p.paidAt} inline /></td>
                          <td className="py-3 pe-4">
                            {p.customerId != null ? <Link href={`/customers/${p.customerId}`} className="text-primary hover:underline">{nameOf(p.customerId)}</Link> : nameOf(null)}
                          </td>
                          <td className="py-3 pe-4 text-muted-foreground hidden md:table-cell"><BankName id={p.bankAccountId} /></td>
                          <td className="py-3 pe-4 font-mono text-positive">{fmtNum(p.amount)}</td>
                          <td className="py-3 pe-4 font-mono hidden sm:table-cell">{fmtNum(p.allocatedAmount)}</td>
                          <td className="py-3 pe-4 font-mono hidden sm:table-cell">{fmtNum(p.unappliedAmount)}</td>
                          <td className="py-3 pe-4 hidden lg:table-cell"><PaymentStateBadge p={p} /></td>
                          <td className="py-3 pe-4 hidden lg:table-cell">{p.unappliedAmount > 0.005 || p.classification ? <ClassificationBadge p={p} /> : <span className="text-xs text-muted-foreground">—</span>}</td>
                          <td className="py-3 text-end">
                            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setSelected(p)} data-testid={`payment-open-${p.id}`}>{t("Details", "التفاصيل")}</Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {(page > 0 || payments.length === PAGE) && (
                <div className="flex items-center justify-between mt-4 text-xs text-muted-foreground">
                  <span>{t(`Page ${page + 1} · ${PAGE} per page`, `صفحة ${page + 1} · ${PAGE} في الصفحة`)}</span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>{t("Previous", "السابق")}</Button>
                    <Button variant="outline" size="sm" disabled={payments.length < PAGE} onClick={() => setPage((p) => p + 1)}>{t("Next", "التالي")}</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="refunds">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Refunds, newest first — each settled a deposit or a credit-note balance", "المبالغ المردودة، الأحدث أولًا — سوّى كل منها عربونًا أو رصيد إشعار دائن")}</CardTitle></CardHeader>
            <CardContent>
              {refunds.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground"><Undo2 className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>{t("No refunds yet.", "لا توجد مبالغ مردودة بعد.")}</p></div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                        <th className="text-start pb-2 pe-4 font-medium">{t("Refund", "الردّ")}</th>
                        <th className="text-start pb-2 pe-4 font-medium">{t("Date", "التاريخ")}</th>
                        <th className="text-start pb-2 pe-4 font-medium">{t("Customer", "العميل")}</th>
                        <th className="text-start pb-2 pe-4 font-medium">{t("Origin", "المصدر")}</th>
                        <th className="text-start pb-2 pe-4 font-medium hidden md:table-cell">{t("Bank", "البنك")}</th>
                        <th className="text-start pb-2 pe-4 font-medium">{t("Amount", "المبلغ")}</th>
                        <th className="text-start pb-2 pe-4 font-medium hidden sm:table-cell">{t("Reason", "السبب")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {refunds.map((r) => (
                        <tr key={r.id} className="border-b border-border/50" data-testid={`refund-row-${r.id}`}>
                          <td className="py-3 pe-4 font-mono text-xs">{refundNumber(r.id)}</td>
                          <td className="py-3 pe-4 text-muted-foreground"><DualDate date={r.refundedAt} inline /></td>
                          <td className="py-3 pe-4"><Link href={`/customers/${r.customerId}`} className="text-primary hover:underline">{nameOf(r.customerId)}</Link></td>
                          <td className="py-3 pe-4 text-xs">
                            {r.origin === "deposit"
                              ? <>{t("Deposit", "عربون")} · <span className="font-mono">{receiptNumber(r.paymentId ?? 0)}</span></>
                              : <>{t("Credit note", "إشعار دائن")} · <span className="font-mono">#{r.creditNoteId}</span></>}
                          </td>
                          <td className="py-3 pe-4 text-muted-foreground hidden md:table-cell"><BankName id={r.bankAccountId} /></td>
                          <td className="py-3 pe-4 font-mono text-negative">−{fmtNum(r.amount)}</td>
                          <td className="py-3 pe-4 text-xs text-muted-foreground hidden sm:table-cell max-w-[16rem] truncate">{r.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {current && <PaymentDialog payment={current} customerName={nameOf(current.customerId)} onClose={() => setSelected(null)} />}
      {receiving && <ReceiveDialog open onClose={() => setReceiving(false)} />}
    </div>
  );
}
