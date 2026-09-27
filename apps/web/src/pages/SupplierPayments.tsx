/**
 * SUPPLIER PAYMENTS, ADVANCES AND DEPOSITS (Phase 11 Part 2 — B3/B4, 2026-09-22).
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §9–§11.
 *
 * 🔴 THE PAGE SAYS THE DIRECTION, because the direction is the accounting. A
 * customer advance is a LIABILITY; a supplier advance is an ASSET — they hold
 * our money and owe us goods. Every "on account" figure here is money the
 * supplier is holding, never a reduction of what we owe.
 *
 * 🔴 It also says what may settle a bill and what may not. Only an ADVANCE
 * can: a refundable security deposit is not consideration for a supply, and an
 * unidentified payment has no stated purpose. The server refuses both BY NAME,
 * and the refusal is shown rather than hidden behind a disabled control —
 * explain a refusal, do not hide the control.
 *
 * 🔴 Every figure on this page is the SERVER's. Nothing here adds up a
 * payment's remaining balance itself.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Banknote, Plus, Landmark } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { businessToday } from "@workspace/shared";
import {
  useListSupplierPayments, useGetSupplierPayment, getGetSupplierPaymentQueryKey,
  useListVendors, useListBills, getListBillsQueryKey,
  createSupplierPayment, allocateSupplierPayment, classifySupplierPayment,
  refundSupplierPayment, reverseSupplierAllocation,
  type SupplierPaymentDetail, type Vendor, type Bill, type ListBillsParams,
  type SupplierPaymentClassification,
} from "@workspace/api-client-react";
import { useBankOptions } from "@/components/payments/shared";

/**
 * Every response shape on this page is the GENERATED one — none is declared
 * here (the hand-written-interface ratchet; a `type` alias would satisfy its
 * detector and fix nothing). `/bank-accounts` is the one endpoint not yet in
 * the contract; its picker is the shared `useBankOptions`, which is also the
 * one that offers ACTIVE banks only.
 */
type BankOption = ReturnType<typeof useBankOptions>["active"][number];

/** What a bill still owes, from the SERVER (billPosition) — never total − paid here. */
const owes = (b: Bill) => Number(b.outstanding ?? 0);

const Money = ({ v }: { v: number }) => <span className="font-mono" dir="ltr">{fmtNum(v)}</span>;

/**
 * 🔴 The four classifications, in the user's words. These are not styling
 * choices: each names a DIFFERENT account, and the difference is what leaves
 * it — an advance by being applied, a deposit by being returned, an
 * unidentified payment by being identified.
 */
const CLASSIFICATIONS = [
  { value: "advance", en: "Advance (may settle bills)", ar: "دفعة مقدمة (يمكن تسوية الفواتير بها)" },
  { value: "security_deposit", en: "Refundable security deposit", ar: "تأمين مسترد" },
  { value: "erroneous", en: "Paid in error", ar: "مدفوع بالخطأ" },
  { value: "unknown", en: "Not yet identified", ar: "غير محدد بعد" },
] as const;

const classLabel = (v: string, t: (en: string, ar: string) => string) => {
  const c = CLASSIFICATIONS.find((x) => x.value === v);
  return c ? t(c.en, c.ar) : v;
};

export default function SupplierPayments() {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data, isLoading } = useListSupplierPayments();
  const { data: vendorsPage } = useListVendors({ limit: 200 });
  const { active: banks } = useBankOptions();
  const { data: detail } = useGetSupplierPayment(detailId ?? 0, {
    query: { enabled: detailId != null, queryKey: getGetSupplierPaymentQueryKey(detailId ?? 0) },
  });

  const vendors = vendorsPage?.items ?? [];
  const vendorName = (id: number) => {
    const v = vendors.find((x) => x.id === id);
    return v ? (lang === "ar" && v.nameAr ? v.nameAr : v.name) : `#${id}`;
  };

  // Everything a supplier payment can move: the payment list and detail, the
  // bills it settles, the supplier's statement and position, and the ageing.
  const invalidate = () => {
    for (const key of ["/api/supplier-payments", "/api/bills", "/api/supplier-statements", "/api/vendors", "/api/reports/ap-aging"]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
    void qc.invalidateQueries({ queryKey: ["ap-aging"] });
  };

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-full" data-testid="page-supplier-payments">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Banknote className="w-6 h-6" />{t("Supplier payments", "مدفوعات الموردين")}</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            {t("Money paid to a supplier that is not against a bill stays ON ACCOUNT — it is an ASSET, because the supplier holds it and owes us goods. Only an advance may later settle a bill: a refundable deposit is not consideration for a supply, and a payment nobody has identified has no stated purpose.",
               "الأموال المدفوعة لمورد دون أن تكون مقابل فاتورة تبقى على الحساب — وهي أصل، لأن المورد يحتفظ بها ويدين لنا ببضاعة. والدفعة المقدمة وحدها هي ما يمكن أن يسوّي فاتورة لاحقًا: فالتأمين المسترد ليس مقابلًا لتوريد، والمدفوعات غير المحددة لا غرض معلن لها.")}
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2" data-testid="new-supplier-payment"><Plus className="w-4 h-4" />{t("New payment", "دفعة جديدة")}</Button></DialogTrigger>
          <NewPaymentDialog
            vendors={vendors} banks={banks} t={t} lang={lang}
            onDone={() => { setOpen(false); invalidate(); }}
          />
        </Dialog>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Payments", "المدفوعات")}</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {isLoading ? <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
           : (data?.items ?? []).length === 0 ? <p className="text-sm text-muted-foreground" data-testid="no-supplier-payments">{t("No supplier payments yet.", "لا توجد مدفوعات للموردين بعد.")}</p>
           : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">
                {[t("Paid", "التاريخ"), t("Supplier", "المورد"), t("Reference", "المرجع"), t("Amount", "المبلغ"), t("On account", "على الحساب"), t("What it is", "طبيعتها"), ""].map((h, i) => (
                  <th key={i} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {(data?.items ?? []).map((p) => (
                  <tr key={p.id} className="border-b border-border/50" data-testid={`supplier-payment-row-${p.id}`}>
                    <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{p.paidAt}</td>
                    <td className="py-2 pe-3">{vendorName(p.vendorId)}</td>
                    <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{p.reference ?? "—"}</td>
                    <td className="py-2 pe-3"><Money v={p.amount} /></td>
                    <td className="py-2 pe-3" data-testid={`available-${p.id}`}><Money v={p.availableAmount} /></td>
                    <td className="py-2 pe-3">
                      <Badge variant="outline" className="text-[10px]" data-testid={`classification-${p.id}`}>{classLabel(p.classification, t)}</Badge>
                    </td>
                    <td className="py-2">
                      <Button size="sm" variant="ghost" onClick={() => setDetailId(p.id)} data-testid={`open-supplier-payment-${p.id}`}>{t("Open", "فتح")}</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={detailId != null} onOpenChange={(v) => !v && setDetailId(null)}>
        {detail && (
          <PaymentDetailDialog
            payment={detail} banks={banks} vendorName={vendorName} t={t}
            /*
             * 🔴 A successful act CLOSES the dialog and returns to the list,
             * where the refreshed row shows what changed (found by the browser
             * walk: it stayed open showing the figures it had before the act,
             * which reads as "nothing happened"). Its inputs are local state, so
             * leaving it open would also keep the amount the user just applied
             * sitting in the box, ready to be applied again.
             */
            onDone={() => { invalidate(); setDetailId(null); }}
            onToast={(title, description, bad) => toast({ title, description, variant: bad ? "destructive" : undefined })}
          />
        )}
      </Dialog>
    </div>
  );
}

// ── new payment ────────────────────────────────────────────────────────────

/**
 * The bills a payment can settle for ONE supplier: approved, not a credit
 * note, and still owing something by the server's figure. Fetched per
 * supplier (`vendorId` filter), so the list is that supplier's bills rather
 * than whatever fell inside a capped all-supplier page.
 */
function useOpenBills(vendorId: number | null) {
  // 🔴 Typed as the GENERATED params: the list's filter is `vendor_id`, and an
  // untyped `{ vendorId }` — what this was first written as — compiled, was
  // ignored by the server, and offered every supplier's bills in the picker.
  const params: ListBillsParams = { vendor_id: vendorId ?? 0, limit: 200 };
  const { data } = useListBills(params, { query: { enabled: vendorId != null, queryKey: getListBillsQueryKey(params) } });
  return (data?.items ?? []).filter((b) =>
    b.vendorId === vendorId && // and never trust the filter alone to decide whose bill it is
    !["draft", "submitted"].includes(b.status) && b.documentType !== "credit_note" && owes(b) >= 0.01);
}

function NewPaymentDialog({ vendors, banks, t, lang, onDone }: {
  vendors: Vendor[]; banks: BankOption[];
  t: (en: string, ar: string) => string; lang: string; onDone: () => void;
}) {
  const { toast } = useToast();
  const [vendorId, setVendorId] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [paidAt, setPaidAt] = useState(businessToday());
  const [reference, setReference] = useState("");
  const [classification, setClassification] = useState("unknown");
  const [allocations, setAllocations] = useState<Record<number, string>>({});

  const openBills = useOpenBills(vendorId ? Number(vendorId) : null);
  // One key per dialog: a double-click or a retried request is the SAME
  // payment, which the server returns rather than paying twice.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const create = useMutation({
    mutationFn: () => createSupplierPayment({
      vendorId: Number(vendorId),
      bankAccountId: Number(bankAccountId),
      amount: Number(amount),
      paidAt,
      reference: reference || undefined,
      classification: classification as SupplierPaymentClassification,
      idempotencyKey,
      allocations: Object.entries(allocations)
        .filter(([, v]) => Number(v) > 0)
        .map(([billId, v]) => ({ billId: Number(billId), amount: Number(v) })),
    }),
    onSuccess: () => { toast({ title: t("Payment recorded", "تم تسجيل الدفعة") }); onDone(); },
    onError: (e: Error) => toast({ title: t("Refused", "مرفوض"), description: e.message, variant: "destructive" }),
  });

  return (
    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="new-supplier-payment-dialog">
      <DialogHeader>
        <DialogTitle>{t("Pay a supplier", "دفع لمورد")}</DialogTitle>
        <DialogDescription>
          {/* 🔴 D-3: which bank the money left is REQUIRED and never inferred. */}
          {t("Name the bank the money left — it is never assumed. Anything you do not allocate to a bill stays on account as an asset.",
             "حدّد البنك الذي خرجت منه الأموال — ولا يُفترض أبدًا. وما لا تخصصه لفاتورة يبقى على الحساب كأصل.")}
        </DialogDescription>
      </DialogHeader>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>{t("Supplier", "المورد")}</Label>
          <Select value={vendorId} onValueChange={(v) => { setVendorId(v); setAllocations({}); }}>
            <SelectTrigger data-testid="sp-vendor"><SelectValue placeholder={t("Choose a supplier", "اختر موردًا")} /></SelectTrigger>
            <SelectContent>
              {vendors.map((v) => <SelectItem key={v.id} value={String(v.id)}>{lang === "ar" && v.nameAr ? v.nameAr : v.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("Paid from", "مدفوعة من")}</Label>
          <Select value={bankAccountId} onValueChange={setBankAccountId}>
            <SelectTrigger data-testid="sp-bank"><SelectValue placeholder={t("Choose a bank account", "اختر حسابًا بنكيًا")} /></SelectTrigger>
            <SelectContent>
              {banks.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}{b.bankName ? ` — ${b.bankName}` : ""}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("Amount", "المبلغ")}</Label>
          <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="sp-amount" dir="ltr" />
        </div>
        <div className="space-y-1">
          <Label>{t("Paid on", "تاريخ الدفع")}</Label>
          <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} data-testid="sp-paid-at" dir="ltr" />
        </div>
        <div className="space-y-1">
          <Label>{t("Reference", "المرجع")}</Label>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} data-testid="sp-reference" dir="ltr" />
        </div>
        <div className="space-y-1">
          <Label>{t("What is this money?", "ما طبيعة هذه الأموال؟")}</Label>
          <Select value={classification} onValueChange={setClassification}>
            <SelectTrigger data-testid="sp-classification"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CLASSIFICATIONS.map((c) => <SelectItem key={c.value} value={c.value}>{t(c.en, c.ar)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {vendorId && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("Apply to bills (optional)", "التخصيص على الفواتير (اختياري)")}</Label>
          {openBills.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="sp-no-bills">{t("This supplier has no approved bills still owing anything.", "لا توجد لهذا المورد فواتير معتمدة عليها مبالغ مستحقة.")}</p>
          ) : (
            <div className="space-y-2">
              {openBills.map((b) => (
                <div key={b.id} className="flex items-center gap-3">
                  <span className="font-mono text-xs w-32 shrink-0" dir="ltr">{b.billNumber}</span>
                  <span className="text-xs text-muted-foreground w-28 shrink-0" title={t("Still owed", "المتبقي")} data-testid={`sp-owes-${b.billNumber}`}><Money v={owes(b)} /></span>
                  <Input
                    type="number" step="0.01" placeholder="0.00" dir="ltr"
                    value={allocations[b.id] ?? ""}
                    onChange={(e) => setAllocations((a) => ({ ...a, [b.id]: e.target.value }))}
                    data-testid={`sp-allocate-${b.billNumber}`}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <DialogFooter>
        <Button onClick={() => create.mutate()} disabled={create.isPending} data-testid="sp-submit">
          {t("Record payment", "تسجيل الدفعة")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// ── one payment ────────────────────────────────────────────────────────────

function PaymentDetailDialog({ payment, banks, vendorName, t, onDone, onToast }: {
  payment: SupplierPaymentDetail; banks: BankOption[];
  vendorName: (id: number) => string;
  t: (en: string, ar: string) => string;
  onDone: () => void;
  onToast: (title: string, description?: string, bad?: boolean) => void;
}) {
  const [allocations, setAllocations] = useState<Record<number, string>>({});
  const [classification, setClassification] = useState<string>(payment.classification);
  const [refundAmount, setRefundAmount] = useState("");
  const [reason, setReason] = useState("");
  const [refundReason, setRefundReason] = useState("");
  /**
   * 🔴 D-3: the bank the refund came INTO is chosen, never inferred. The
   * first build sent `banks[0]` — the first bank in the list, invisibly — so
   * a refund could post into an account nobody chose. The one pre-selection
   * allowed is a bank the user explicitly marked default, and it is VISIBLE
   * in the picker (the same rule the Bills pay dialog follows).
   */
  const [refundBank, setRefundBank] = useState<string>(() => {
    const marked = banks.find((b) => b.isDefault);
    return marked ? String(marked.id) : "";
  });

  const openBills = useOpenBills(payment.vendorId);

  const post = useMutation({
    mutationFn: (act: () => Promise<unknown>) => act(),
    onSuccess: () => { onToast(t("Done", "تم")); onDone(); },
    // 🔴 The refusal is SHOWN. A server refusal nobody surfaces is
    // indistinguishable from a frozen screen, and this one teaches the
    // workflow: "reclassify it as an advance first".
    onError: (e: Error) => onToast(t("Refused", "مرفوض"), e.message, true),
  });

  return (
    <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="supplier-payment-detail">
      <DialogHeader>
        <DialogTitle>{t("Payment to", "دفعة إلى")} {vendorName(payment.vendorId)}</DialogTitle>
        <DialogDescription>
          <span data-testid="detail-amount"><Money v={payment.amount} /></span>
          {" · "}
          {t("on account", "على الحساب")}: <span data-testid="detail-available"><Money v={payment.availableAmount} /></span>
          {" · "}
          <span data-testid="detail-classification">{classLabel(payment.classification, t)}</span>
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5">
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t("What this money is", "طبيعة هذه الأموال")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("Changing this moves the balance between two asset accounts with one entry. If the account does not change, nothing is posted and the history says so.",
               "تغيير هذا ينقل الرصيد بين حسابي أصول بقيد واحد. وإذا لم يتغير الحساب فلا يُرحَّل شيء ويذكر السجل ذلك.")}
          </p>
          <div className="flex flex-wrap gap-2 items-end">
            <Select value={classification} onValueChange={setClassification}>
              <SelectTrigger className="w-64" data-testid="detail-classify-select"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CLASSIFICATIONS.map((c) => <SelectItem key={c.value} value={c.value}>{t(c.en, c.ar)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button
              size="sm" variant="secondary" data-testid="detail-classify"
              onClick={() => post.mutate(() => classifySupplierPayment(payment.id, { classification: classification as SupplierPaymentClassification }))}
            >{t("Save", "حفظ")}</Button>
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t("Apply to bills", "التخصيص على الفواتير")}</h3>
          {openBills.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("No approved bills for this supplier still owe anything.", "لا توجد لهذا المورد فواتير معتمدة عليها مبالغ مستحقة.")}</p>
          ) : (
            <>
              {openBills.map((b) => (
                <div key={b.id} className="flex items-center gap-3">
                  <span className="font-mono text-xs w-32 shrink-0" dir="ltr">{b.billNumber}</span>
                  <span className="text-xs text-muted-foreground w-28 shrink-0" title={t("Still owed", "المتبقي")}><Money v={owes(b)} /></span>
                  <Input
                    type="number" step="0.01" placeholder="0.00" dir="ltr"
                    value={allocations[b.id] ?? ""}
                    onChange={(e) => setAllocations((a) => ({ ...a, [b.id]: e.target.value }))}
                    data-testid={`detail-allocate-${b.billNumber}`}
                  />
                </div>
              ))}
              <Button
                size="sm" data-testid="detail-allocate-submit"
                onClick={() => post.mutate(() => allocateSupplierPayment(payment.id, {
                  allocations: Object.entries(allocations).filter(([, v]) => Number(v) > 0).map(([billId, v]) => ({ billId: Number(billId), amount: Number(v) })),
                }))}
              >{t("Apply", "تخصيص")}</Button>
            </>
          )}
        </section>

        {payment.allocations.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t("Applied to", "مخصصة على")}</h3>
            <table className="w-full text-sm">
              <tbody>
                {payment.allocations.map((a) => (
                  <tr key={a.id} className="border-b border-border/50" data-testid={`allocation-row-${a.id}`}>
                    <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{a.billNumber}</td>
                    <td className="py-2 pe-3"><Money v={a.amount} /></td>
                    <td className="py-2 pe-3">
                      {/* 🔴 A reversed allocation STAYS on the list. The row is the
                          record of what happened; the correction sits beside it. */}
                      {a.reversed
                        ? <Badge variant="outline" className="text-[10px]" data-testid={`allocation-reversed-${a.id}`}>{t("Reversed", "معكوسة")}</Badge>
                        : (
                          <Button
                            size="sm" variant="ghost" data-testid={`reverse-allocation-${a.id}`}
                            /* 🔴 The reason is the USER'S. The server requires one so the
                               record says why the supplier's balance moved; a default
                               typed in here would satisfy that check with a reason
                               nobody gave. Empty is sent as empty and refused, shown. */
                            onClick={() => post.mutate(() => reverseSupplierAllocation(a.id, { reason }))}
                          >{t("Undo", "تراجع")}</Button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Input
              placeholder={t("Why is it being undone?", "لماذا يجري التراجع؟")}
              value={reason} onChange={(e) => setReason(e.target.value)} data-testid="reverse-reason"
            />
          </section>
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-medium flex items-center gap-2"><Landmark className="w-4 h-4" />{t("Refund from the supplier", "استرداد من المورد")}</h3>
          <div className="flex flex-wrap gap-2 items-end">
            <Input
              type="number" step="0.01" className="w-40" dir="ltr"
              placeholder={t("Amount", "المبلغ")} value={refundAmount}
              onChange={(e) => setRefundAmount(e.target.value)} data-testid="refund-amount"
            />
            <Select value={refundBank} onValueChange={setRefundBank}>
              <SelectTrigger className="w-56" data-testid="refund-bank"><SelectValue placeholder={t("Received into…", "استُلمت في…")} /></SelectTrigger>
              <SelectContent>
                {banks.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}{b.bankName ? ` — ${b.bankName}` : ""}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input
              className="flex-1 min-w-48" placeholder={t("Why is the money coming back?", "لماذا تعود الأموال؟")}
              value={refundReason} onChange={(e) => setRefundReason(e.target.value)} data-testid="refund-reason"
            />
            <Button
              size="sm" variant="secondary" data-testid="refund-submit" disabled={!refundBank}
              onClick={() => post.mutate(() => refundSupplierPayment(payment.id, {
                amount: Number(refundAmount), reason: refundReason, bankAccountId: Number(refundBank),
              }))}
            >{t("Record refund", "تسجيل الاسترداد")}</Button>
          </div>
        </section>

        {payment.classificationHistory.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t("What we have called it", "ما أطلقناه عليها")}</h3>
            <ul className="text-xs text-muted-foreground space-y-1">
              {payment.classificationHistory.map((c) => (
                <li key={c.id} data-testid={`classification-history-${c.id}`}>
                  {classLabel(c.classification, t)}
                  {c.effectiveDate ? ` · ${c.effectiveDate}` : ""}
                  {c.note ? ` · ${c.note}` : ""}
                  {c.journalEntryId ? ` · ${t("posted", "مُرحَّل")} #${c.journalEntryId}` : ` · ${t("no entry — the account did not change", "بلا قيد — لم يتغير الحساب")}`}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </DialogContent>
  );
}
