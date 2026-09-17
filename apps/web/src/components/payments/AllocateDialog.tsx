/**
 * Allocate a receipt's unapplied remainder — or apply a credit note's
 * unconsumed balance — to the customer's open invoices.
 *
 * One dialog for both sources because an allocation is the same link either
 * way (payment|credit → invoice, amount); only the endpoint differs. The
 * amounts are the user's explicit act: nothing is pre-filled beyond what they
 * click "fill" on, so an allocation is never inferred (decision pack §4.3).
 * The server refuses anything beyond the source's remainder or an invoice's
 * outstanding — the figures shown here are guidance, the 409/422 is the law.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DualDate } from "@/components/DualDate";
import { invalidatePaymentQueries, isOpenInvoice, newIdempotencyKey, outstandingOf, receiptNumber } from "./shared";

import type { AllocatePaymentInput, ApplyCreditNoteInput, Invoice, ListInvoices200 } from "@workspace/api-client-react";

export type AllocationSource =
  | { kind: "payment"; id: number; customerId: number; available: number; allocatedInvoiceIds: number[] }
  | { kind: "credit_note"; id: number; number: string; customerId: number; available: number; allocatedInvoiceIds: number[] };

const json = {
  allocate: (b: AllocatePaymentInput) => JSON.stringify(b),
  apply: (b: ApplyCreditNoteInput) => JSON.stringify(b),
};

export function AllocateDialog({ source, open, onClose, customerName }: { source: AllocationSource; open: boolean; onClose: () => void; customerName: string }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [key] = useState(() => newIdempotencyKey(source.kind === "payment" ? "alloc" : "apply"));

  const { data, isLoading } = useQuery<ListInvoices200>({
    queryKey: ["invoices", "open-for-customer", source.customerId],
    queryFn: () => apiFetch(`/invoices?customer_id=${source.customerId}&limit=200`),
    enabled: open,
  });
  // A credit note is never a target, and never applies to itself. One ACTIVE
  // allocation per (source, invoice) is the server's rule: an invoice this
  // source already settles is listed as such, not offered twice (the 409 it
  // would earn is explained here instead of after the click).
  const already = new Set(source.allocatedInvoiceIds);
  const targets = useMemo(() => (data?.items ?? []).filter(isOpenInvoice).filter((i) => i.id !== source.id), [data, source.id]);

  const offered = targets.filter((i) => !already.has(i.id));
  const requested = offered.reduce((s, i) => s + (Number(amounts[i.id]) > 0 ? Number(amounts[i.id]) : 0), 0);
  const remaining = Math.round((source.available - requested) * 100) / 100;
  const over = offered.some((i) => Number(amounts[i.id]) > outstandingOf(i) + 0.005);
  const lines = offered.filter((i) => Number(amounts[i.id]) > 0).map((i) => ({ invoiceId: i.id, amount: Number(amounts[i.id]) }));
  const valid = lines.length > 0 && remaining >= -0.005 && !over;

  const mut = useMutation({
    mutationFn: () =>
      source.kind === "payment"
        ? apiFetch(`/payments/${source.id}/allocate`, { method: "POST", body: json.allocate({ allocations: lines, idempotencyKey: key }) })
        : apiFetch(`/payments/credit-notes/${source.id}/apply`, { method: "POST", body: json.apply({ allocations: lines, idempotencyKey: key }) }),
    onSuccess: () => {
      invalidatePaymentQueries(qc);
      toast({ title: source.kind === "payment" ? t("Payment allocated", "تم تخصيص الدفعة") : t("Credit applied", "تم تطبيق الرصيد الدائن") });
      onClose();
    },
  });

  const fill = (inv: Invoice) => {
    const others = requested - (Number(amounts[inv.id]) > 0 ? Number(amounts[inv.id]) : 0);
    const room = Math.max(0, Math.round((source.available - others) * 100) / 100);
    setAmounts((a) => ({ ...a, [inv.id]: Math.min(room, outstandingOf(inv)).toFixed(2) }));
  };

  const title = source.kind === "payment"
    ? t(`Allocate ${receiptNumber(source.id)}`, `تخصيص ${receiptNumber(source.id)}`)
    : t(`Apply credit note ${source.number}`, `تطبيق إشعار الدائن ${source.number}`);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-2xl" data-testid="allocate-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t(`${customerName} · available to allocate: ${fmtNum(source.available)}. Each allocation links this source to one invoice for the amount you enter.`,
               `${customerName} · المتاح للتخصيص: ${fmtNum(source.available)}. كل تخصيص يربط هذا المصدر بفاتورة واحدة بالمبلغ الذي تدخله.`)}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
        ) : targets.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4" data-testid="allocate-empty">
            {t("This customer has no issued invoice with an open balance. The amount stays on account.", "لا توجد لهذا العميل فاتورة صادرة برصيد مفتوح. يبقى المبلغ على الحساب.")}
          </p>
        ) : (
          <div className="overflow-x-auto min-w-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  <th className="text-start pb-2 pe-3 font-medium">{t("Invoice", "الفاتورة")}</th>
                  <th className="text-start pb-2 pe-3 font-medium hidden sm:table-cell">{t("Due", "الاستحقاق")}</th>
                  <th className="text-start pb-2 pe-3 font-medium">{t("Outstanding", "المستحق")}</th>
                  <th className="text-start pb-2 font-medium">{t("Allocate", "التخصيص")}</th>
                </tr>
              </thead>
              <tbody>
                {targets.map((inv) => {
                  const os = outstandingOf(inv);
                  const v = Number(amounts[inv.id]);
                  const bad = v > os + 0.005;
                  if (already.has(inv.id)) {
                    return (
                      <tr key={inv.id} className="border-b border-border/50 opacity-70" data-testid={`allocate-row-${inv.invoiceNumber}`} data-already-allocated="true">
                        <td className="py-2 pe-3 font-mono text-xs">{inv.invoiceNumber}</td>
                        <td className="py-2 pe-3 text-muted-foreground hidden sm:table-cell"><DualDate date={inv.dueDate} inline /></td>
                        <td className="py-2 pe-3 font-mono">{fmtNum(os)}</td>
                        <td className="py-2 text-xs text-muted-foreground">{t("Already allocated from this source — correct that allocation first", "مخصص بالفعل من هذا المصدر — صحّح ذلك التخصيص أولًا")}</td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={inv.id} className="border-b border-border/50" data-testid={`allocate-row-${inv.invoiceNumber}`}>
                      <td className="py-2 pe-3 font-mono text-xs">{inv.invoiceNumber}</td>
                      <td className="py-2 pe-3 text-muted-foreground hidden sm:table-cell"><DualDate date={inv.dueDate} inline /></td>
                      <td className="py-2 pe-3 font-mono">{fmtNum(os)}</td>
                      <td className="py-2">
                        <div className="flex items-center gap-1">
                          <Input
                            type="number" min={0} step="0.01" inputMode="decimal"
                            aria-label={t(`Amount for ${inv.invoiceNumber}`, `المبلغ لـ ${inv.invoiceNumber}`)}
                            value={amounts[inv.id] ?? ""}
                            onChange={(e) => setAmounts((a) => ({ ...a, [inv.id]: e.target.value }))}
                            className={`h-8 w-28 text-sm font-mono ${bad ? "border-destructive" : ""}`}
                          />
                          <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={() => fill(inv)}>{t("Fill", "تعبئة")}</Button>
                        </div>
                        {bad && <p className="text-xs text-destructive mt-1">{t("More than this invoice still owes", "أكبر من المتبقي على هذه الفاتورة")}</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm border-t border-border pt-3">
          <span className="text-muted-foreground">
            {t("Allocating", "يُخصَّص")} <span className="font-mono text-foreground">{fmtNum(requested)}</span>
            {" · "}
            {t("left on account after", "المتبقي على الحساب بعده")} <span className={`font-mono ${remaining < -0.005 ? "text-destructive" : "text-foreground"}`} data-testid="allocate-remaining">{fmtNum(remaining)}</span>
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
            <Button onClick={() => mut.mutate()} disabled={!valid || mut.isPending} data-testid="allocate-submit">
              {mut.isPending ? t("Allocating…", "جارٍ التخصيص…") : source.kind === "payment" ? t("Allocate", "تخصيص") : t("Apply credit", "تطبيق الرصيد")}
            </Button>
          </div>
        </div>
        {remaining < -0.005 && <p className="text-xs text-destructive">{t("Allocations exceed what is available.", "التخصيصات تتجاوز المتاح.")}</p>}
      </DialogContent>
    </Dialog>
  );
}
