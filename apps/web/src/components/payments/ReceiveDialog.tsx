/**
 * Record a customer receipt ON ACCOUNT — money that arrived before, or
 * without, an invoice to settle. It posts Dr bank / Cr Customer deposits and
 * is allocated later by an explicit act (the Allocate dialog). Paying a
 * specific invoice stays where it was: Invoices → Mark Paid.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { fetchPickerOptions } from "@/lib/pagedList";
import { PickerLimitNotice } from "@/components/PickerLimitNotice";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { businessToday } from "@workspace/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BankPicker, invalidatePaymentQueries, newIdempotencyKey } from "./shared";

import type { Customer, ReceivePaymentInput } from "@workspace/api-client-react";

const json = (b: ReceivePaymentInput) => JSON.stringify(b);

export function ReceiveDialog({ open, onClose, customer }: { open: boolean; onClose: () => void; customer?: { id: number; name: string } }) {
  const { t, n } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [customerId, setCustomerId] = useState(customer ? String(customer.id) : "");
  const [amount, setAmount] = useState("");
  const [bank, setBank] = useState("");
  const [date, setDate] = useState(businessToday());
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [key] = useState(() => newIdempotencyKey("rcpt"));

  const { data: customers } = useQuery({
    queryKey: ["customers", "picker"],
    queryFn: () => fetchPickerOptions<Customer>("/customers?is_active=true"),
    enabled: open && !customer,
  });

  const amt = Number(amount);
  const valid = amt > 0 && !!bank && !!customerId;

  const mut = useMutation({
    mutationFn: () =>
      apiFetch("/payments", {
        method: "POST",
        body: json({ customerId: Number(customerId), amount: amt, bankAccountId: Number(bank), paidAt: date, method: method.trim() || null, reference: reference.trim() || null, idempotencyKey: key, allocations: [] }),
      }),
    onSuccess: () => {
      invalidatePaymentQueries(qc);
      toast({ title: t("Receipt recorded", "تم تسجيل الإيصال"), description: t(`${fmtNum(amt)} is on account until allocated.`, `${fmtNum(amt)} على الحساب حتى يُخصَّص.`) });
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid="receive-dialog">
        <DialogHeader>
          <DialogTitle>{t("Record a receipt on account", "تسجيل إيصال على الحساب")}</DialogTitle>
          <DialogDescription>
            {t("Money received from a customer that is not yet allocated to an invoice. It is held as a customer deposit until you allocate it.",
               "مبلغ مستلم من عميل لم يُخصَّص بعد لفاتورة. يُحتفظ به كعربون للعميل حتى تخصصه.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <p className="text-xs text-muted-foreground mb-1">{t("Customer *", "العميل *")}</p>
            {customer ? (
              <p className="text-sm font-medium">{customer.name}</p>
            ) : (
              <>
                <Select value={customerId} onValueChange={setCustomerId}>
                  <SelectTrigger className="h-9 text-sm" data-testid="receive-customer"><SelectValue placeholder={t("Choose the customer", "اختر العميل")} /></SelectTrigger>
                  <SelectContent>{(customers?.items ?? []).map((c) => <SelectItem key={c.id} value={String(c.id)}>{n(c.name, c.nameAr)}</SelectItem>)}</SelectContent>
                </Select>
                {customers && <PickerLimitNotice shown={customers.items.length} total={customers.total} />}
              </>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1">{t("Amount (SAR) *", "المبلغ (ر.س) *")}</p>
              <Input type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-9 text-sm font-mono" data-testid="receive-amount" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">{t("Received on", "تاريخ الاستلام")}</p>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 text-sm" />
            </div>
          </div>
          <BankPicker value={bank} onChange={setBank} testId="receive-bank-account" label={t("Received into bank account *", "استُلم في الحساب البنكي *")} />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1">{t("Method", "الطريقة")}</p>
              <Input value={method} onChange={(e) => setMethod(e.target.value)} className="h-9 text-sm" placeholder={t("transfer, cash…", "تحويل، نقد…")} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">{t("Reference", "المرجع")}</p>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} className="h-9 text-sm font-mono" data-testid="receive-reference" placeholder={t("as on the bank statement", "كما في كشف البنك")} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
            <Button onClick={() => mut.mutate()} disabled={!valid || mut.isPending} data-testid="receive-submit">
              {mut.isPending ? t("Recording…", "جارٍ التسجيل…") : t("Record receipt", "تسجيل الإيصال")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
