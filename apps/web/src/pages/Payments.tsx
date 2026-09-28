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
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Banknote, Plus, Undo2 } from "lucide-react";
import { DualDate } from "@/components/DualDate";
import { PageHeader, Panel, EmptyState } from "@/components/kit";
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
      <PageHeader
        title={t("Payments", "المدفوعات")}
        description={t("Customer receipts and refunds. A receipt is money in; its allocations say which invoices it settled.", "إيصالات العملاء والمبالغ المردودة. الإيصال مال وارد؛ وتخصيصاته تبيّن أي فواتير سوّى.")}
        actions={
          <Button className="gap-2" disabled={!canPost} onClick={() => setReceiving(true)} data-testid="record-receipt">
            <Plus className="w-4 h-4" />{t("Record receipt", "تسجيل إيصال")}
          </Button>
        }
      >
        <div className="mt-2 empty:hidden"><PermissionHint /></div>
      </PageHeader>

      <Tabs defaultValue="receipts">
        <Panel flush>
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-border px-5">
            <TabsList className="border-b-0">
              <TabsTrigger value="receipts" data-testid="tab-receipts" className="py-3"><Banknote className="w-4 h-4 me-1.5" />{t("Receipts", "الإيصالات")} ({payments.length})</TabsTrigger>
              <TabsTrigger value="refunds" data-testid="tab-refunds" className="py-3"><Undo2 className="w-4 h-4 me-1.5" />{t("Refunds", "المبالغ المردودة")} ({refunds.length})</TabsTrigger>
            </TabsList>
            <div className="flex items-center gap-2 py-2">
              <span className="text-[13px] text-muted-foreground">{t("Customer", "العميل")}</span>
              <Select value={customerId} onValueChange={(v) => { setCustomerId(v); setPage(0); }}>
                <SelectTrigger className="h-9 w-64 max-w-[60vw] text-sm" data-testid="payments-customer-filter"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("All customers", "كل العملاء")}</SelectItem>
                  {(customers?.items ?? []).map((c) => <SelectItem key={c.id} value={String(c.id)}>{n(c.name, c.nameAr)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <TabsContent value="receipts" className="mt-0">
            <p className="px-5 pt-3 pb-1 text-[13px] text-muted-foreground">{t("Receipts, newest first", "الإيصالات، الأحدث أولًا")}</p>
            {isLoading ? (
              <p className="text-sm text-muted-foreground p-5">{t("Loading…", "جارٍ التحميل…")}</p>
            ) : error ? (
              <p className="text-sm text-destructive p-5">{t("Payments could not be loaded.", "تعذر تحميل المدفوعات.")} {(error as Error).message}</p>
            ) : payments.length === 0 ? (
              <EmptyState icon={Banknote} title={t("No payments yet.", "لا توجد مدفوعات بعد.")} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-start px-3">{t("Receipt", "الإيصال")}</th>
                      <th className="text-start px-3">{t("Received", "الاستلام")}</th>
                      <th className="text-start px-3">{t("Customer", "العميل")}</th>
                      <th className="text-start px-3 hidden md:table-cell">{t("Bank", "البنك")}</th>
                      <th className="text-end px-3">{t("Amount", "المبلغ")}</th>
                      <th className="text-end px-3 hidden sm:table-cell">{t("Allocated", "المخصص")}</th>
                      <th className="text-end px-3 hidden sm:table-cell">{t("On account", "على الحساب")}</th>
                      <th className="text-start px-3 hidden lg:table-cell">{t("State", "الحالة")}</th>
                      <th className="text-start px-3 hidden lg:table-cell">{t("Deposit is", "العربون")}</th>
                      <th className="px-3 sticky end-0 bg-muted shadow-[inset_1px_0_0_hsl(var(--border))] rtl:shadow-[inset_-1px_0_0_hsl(var(--border))]" />
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors" data-testid={`payment-row-${p.id}`}>
                        <td className="py-3 px-3 whitespace-nowrap font-medium text-primary">{receiptNumber(p.id)}</td>
                        <td className="py-3 px-3 whitespace-nowrap text-muted-foreground"><DualDate date={p.paidAt} inline /></td>
                        <td className="py-3 px-3 min-w-[11rem]">
                          {p.customerId != null ? <Link href={`/customers/${p.customerId}`} className="text-foreground hover:text-primary hover:underline">{nameOf(p.customerId)}</Link> : <span className="text-muted-foreground">{nameOf(null)}</span>}
                        </td>
                        <td className="py-3 px-3 min-w-[12rem] text-muted-foreground hidden md:table-cell"><BankName id={p.bankAccountId} /></td>
                        <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums font-medium text-positive">{fmtNum(p.amount)}</td>
                        <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums hidden sm:table-cell">{fmtNum(p.allocatedAmount)}</td>
                        <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums hidden sm:table-cell">{fmtNum(p.unappliedAmount)}</td>
                        <td className="py-3 px-3 hidden lg:table-cell"><PaymentStateBadge p={p} /></td>
                        <td className="py-3 px-3 hidden lg:table-cell">{p.unappliedAmount > 0.005 || p.classification ? <ClassificationBadge p={p} /> : <span className="text-xs text-muted-foreground">—</span>}</td>
                        <td className="py-3 px-3 text-end sticky end-0 bg-card shadow-[inset_1px_0_0_hsl(var(--border))] rtl:shadow-[inset_-1px_0_0_hsl(var(--border))]">
                          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setSelected(p)} data-testid={`payment-open-${p.id}`}>{t("Details", "التفاصيل")}</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(page > 0 || payments.length === PAGE) && (
              <div className="flex items-center justify-between border-t border-border px-5 py-3 text-sm text-muted-foreground">
                <span>{t(`Page ${page + 1} · ${PAGE} per page`, `صفحة ${page + 1} · ${PAGE} في الصفحة`)}</span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>{t("Previous", "السابق")}</Button>
                  <Button variant="outline" size="sm" disabled={payments.length < PAGE} onClick={() => setPage((p) => p + 1)}>{t("Next", "التالي")}</Button>
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="refunds" className="mt-0">
            <p className="px-5 pt-3 pb-1 text-[13px] text-muted-foreground">{t("Refunds, newest first — each settled a deposit or a credit-note balance", "المبالغ المردودة، الأحدث أولًا — سوّى كل منها عربونًا أو رصيد إشعار دائن")}</p>
            {refunds.length === 0 ? (
              <EmptyState icon={Undo2} title={t("No refunds yet.", "لا توجد مبالغ مردودة بعد.")} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-start px-3">{t("Refund", "الردّ")}</th>
                      <th className="text-start px-3">{t("Date", "التاريخ")}</th>
                      <th className="text-start px-3">{t("Customer", "العميل")}</th>
                      <th className="text-start px-3">{t("Origin", "المصدر")}</th>
                      <th className="text-start px-3 hidden md:table-cell">{t("Bank", "البنك")}</th>
                      <th className="text-end px-3">{t("Amount", "المبلغ")}</th>
                      <th className="text-start px-3 hidden sm:table-cell">{t("Reason", "السبب")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {refunds.map((r) => (
                      <tr key={r.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors" data-testid={`refund-row-${r.id}`}>
                        <td className="py-3 px-3 whitespace-nowrap font-medium text-primary">{refundNumber(r.id)}</td>
                        <td className="py-3 px-3 whitespace-nowrap text-muted-foreground"><DualDate date={r.refundedAt} inline /></td>
                        <td className="py-3 px-3 min-w-[11rem]"><Link href={`/customers/${r.customerId}`} className="text-foreground hover:text-primary hover:underline">{nameOf(r.customerId)}</Link></td>
                        <td className="py-3 px-3 text-[13px] whitespace-nowrap">
                          {r.origin === "deposit"
                            ? <>{t("Deposit", "عربون")} · <span className="tabular-nums">{receiptNumber(r.paymentId ?? 0)}</span></>
                            : <>{t("Credit note", "إشعار دائن")} · <span className="tabular-nums">#{r.creditNoteId}</span></>}
                        </td>
                        <td className="py-3 px-3 text-muted-foreground hidden md:table-cell"><BankName id={r.bankAccountId} /></td>
                        <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums font-medium text-negative">−{fmtNum(r.amount)}</td>
                        <td className="py-3 px-3 text-[13px] text-muted-foreground hidden sm:table-cell max-w-[16rem] truncate">{r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>
        </Panel>
      </Tabs>

      {current && <PaymentDialog payment={current} customerName={nameOf(current.customerId)} onClose={() => setSelected(null)} />}
      {receiving && <ReceiveDialog open onClose={() => setReceiving(false)} />}
    </div>
  );
}
