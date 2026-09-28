/**
 * 🔴 PHASE 13C — EXPENSES: purchases PAID WHEN RECORDED.
 *
 *   BILL     the supplier's document creates a PAYABLE, paid later
 *            (Purchases → Bills, then Pay).
 *   EXPENSE  the purchase was ALREADY PAID when it is recorded — from a named
 *            bank on a stated date — so no payable is left outstanding.
 *
 * There is no expense engine. "Record expense" creates a bill that states the
 * bank and the paid date (POST /bills); posting it (the ordinary approval)
 * posts the bill AND pays it through the bill-payment path in one step. This
 * page READS those bills — status, payment, bank, evidence — so it cannot
 * disagree with the ledger. Employee reimbursement is not here: there is no
 * employee payable model yet.
 */
import { useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch, fmtNum } from "@/lib/api";
import { fetchPickerOptions } from "@/lib/pagedList";
import { PickerLimitNotice } from "@/components/PickerLimitNotice";
import { listExpenses, previewBillVatEvidence, type Bill, type CreateBillInput, type Expense, type ListExpensesParams, type Vendor, type VatEvidencePreviewInput } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { useExpenseAccounts } from "@/lib/accounts";
import { DualDate } from "@/components/DualDate";
import { VatEvidencePanel } from "@/components/VatEvidencePanel";
import { DuplicateWarning } from "@/components/DuplicateWarning";
import { statusLabel as billStatusLabel } from "@/lib/statusLabel";
import { SUPPLIER_DOCUMENT_KINDS, inputVatLabel, kindLabel, statusLabel as evidenceStatusLabel, type SupplierDocumentKind } from "@/lib/vatEvidence";
import { businessToday } from "@workspace/shared";
import { Plus, Receipt } from "lucide-react";

const PAGE = 50;

const empty = () => ({
  vendorId: "", vendorReference: "", date: businessToday(), subtotal: "", vatAmount: "", total: "",
  supplierDocumentKind: "" as SupplierDocumentKind | "", debitAccountId: null as number | null,
  bankId: "", paidAt: "", notes: "",
});

export default function Expenses() {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState<"" | "unposted" | "posted">("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty());
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { accounts: expenseAccounts, defaultId: defaultExpenseId } = useExpenseAccounts();

  const params: ListExpensesParams = { limit: PAGE, offset: page * PAGE, ...(status ? { status } : {}) };
  const { data, isLoading } = useQuery({ queryKey: ["expenses", params], queryFn: () => listExpenses(params) });
  const items = data?.items ?? [];
  const total = data?.page.total ?? 0;

  const { data: vendorsPage } = useQuery<{ items: Vendor[]; total: number }>({
    queryKey: ["vendors", "picker"],
    queryFn: () => fetchPickerOptions<Vendor>("/vendors"),
  });
  const vendors = vendorsPage?.items ?? [];
  const { data: bankAccounts = [] } = useQuery<Array<{ id: number; name: string; bankName: string; isDefault: boolean; isActive: boolean }>>({
    queryKey: ["bank-accounts"],
    queryFn: () => apiFetch("/bank-accounts"),
  });
  const activeBanks = bankAccounts.filter((b) => b.isActive);
  const defaultBankId = activeBanks.find((b) => b.isDefault)?.id;
  const bank = Number(form.bankId || defaultBankId || 0);

  const preview: VatEvidencePreviewInput = {
    supplierDocumentKind: form.supplierDocumentKind || null,
    vendorId: form.vendorId ? Number(form.vendorId) : null,
    vendorReference: form.vendorReference || null,
    date: form.date || null,
    subtotal: Number(form.subtotal) || 0,
    vatAmount: Number(form.vatAmount) || 0,
    total: Number(form.total) || 0,
    expenseAccountId: form.debitAccountId ?? defaultExpenseId ?? null,
  };
  const { data: verdict } = useQuery({
    queryKey: ["evidence-preview", "expense", preview],
    queryFn: () => previewBillVatEvidence(preview),
    enabled: open && Number(form.total) > 0,
  });

  /**
   * Record, then post: the draft is created, and posting it posts AND pays it.
   * Accountant X1/X5: insufficient evidence no longer keeps it a draft — it is
   * paid, and its VAT is held (or, if blocked, is part of the cost).
   */
  const record = useMutation({
    mutationFn: async () => {
      let captureId: string | undefined;
      if (file) {
        const fd = new FormData();
        fd.append("document", file, file.name);
        fd.append("source", "manual");
        captureId = ((await apiFetch("/capture", { method: "POST", body: fd })) as { captureId: string }).captureId;
      }
      const body: CreateBillInput = {
        date: form.date,
        vendorId: Number(form.vendorId),
        vendorReference: form.vendorReference || undefined,
        supplierDocumentKind: form.supplierDocumentKind || undefined,
        subtotal: Number(form.subtotal) || 0,
        vatAmount: Number(form.vatAmount) || 0,
        total: Number(form.total) || 0,
        expenseAccountId: form.debitAccountId ?? defaultExpenseId ?? undefined,
        notes: form.notes || undefined,
        recordedAsExpense: true,
        expensePaidFromBankAccountId: bank,
        expensePaidAt: form.paidAt || form.date,
        ...(captureId ? { captureId } : {}),
        items: [],
      };
      const bill = (await apiFetch("/bills", { method: "POST", body: JSON.stringify(body) })) as { id: number; billNumber: string };
      try {
        const out = await apiFetch<Bill>(`/bills/${bill.id}/post`, { method: "POST", body: JSON.stringify({}) });
        return { bill, posted: true, vatState: out.inputVat?.state ?? null };
      } catch (e) {
        // The recorder may not approve: the expense is SAVED as a draft for approval.
        if (e instanceof ApiError && e.status === 403) return { bill, posted: false, vatState: null };
        throw e;
      }
    },
    onSuccess: ({ bill, posted, vatState }) => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["bills"] });
      qc.invalidateQueries({ queryKey: ["vat-evidence"] });
      qc.invalidateQueries({ queryKey: ["bank-accounts"] });
      setOpen(false); setForm(empty()); setFile(null);
      toast(!posted
        ? { title: t(`${bill.billNumber} saved as a draft for approval`, `حُفظ ${bill.billNumber} كمسودة بانتظار الاعتماد`), description: t("Nothing is posted or paid until it is approved.", "لا يُرحّل ولا يُدفع شيء حتى يُعتمد.") }
        : vatState === "awaiting_evidence"
          ? { title: t(`Expense ${bill.billNumber} posted and paid — VAT held for evidence`, `رُحّل المصروف ${bill.billNumber} ودُفع — الضريبة محتجزة بانتظار الإثبات`), description: t("Its VAT is in \"Input VAT awaiting evidence\", not claimed. Supply the evidence under VAT evidence and it is claimed in that period.", "ضريبته في حساب «ضريبة مدخلات بانتظار الإثبات» دون خصم. استكمل الإثبات في قائمة إثبات الضريبة فتُخصم في تلك الفترة.") }
          : vatState === "not_deductible"
            ? { title: t(`Expense ${bill.billNumber} posted and paid — VAT in cost`, `رُحّل المصروف ${bill.billNumber} ودُفع — الضريبة ضمن التكلفة`), description: t("Its VAT is not deductible (Art. 50) and is part of the expense's cost.", "ضريبته غير قابلة للخصم (المادة 50) وهي ضمن تكلفة المصروف.") }
            : { title: t(`Expense ${bill.billNumber} recorded, posted and paid`, `سُجّل المصروف ${bill.billNumber} ورُحّل ودُفع`) });
    },
    onError: (e: Error) => toast({ title: t("Could not record the expense", "تعذّر تسجيل المصروف"), description: e.message, variant: "destructive" } as never),
  });

  const postOne = useMutation({
    mutationFn: (id: number) => apiFetch(`/bills/${id}/post`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["bills"] });
      qc.invalidateQueries({ queryKey: ["bank-accounts"] });
      toast({ title: t("Expense posted and paid", "رُحّل المصروف ودُفع") });
    },
    onError: (e: Error) => toast({ title: t("Could not post", "تعذّر الترحيل"), description: e.message, variant: "destructive" } as never),
  });

  const payLabel = (s: string) => {
    switch (s) {
      case "paid": return t("Paid", "مدفوع");
      case "part_paid": return t("Part paid", "مدفوع جزئيًا");
      case "unpaid": return t("Not paid", "غير مدفوع");
      default: return t("Not posted", "غير مُرحّل");
    }
  };
  const canSave = !!form.vendorId && Number(form.total) > 0 && !!bank && !record.isPending;

  return (
    <div className="space-y-6" data-testid="page-expenses">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2"><Receipt className="w-6 h-6 text-primary" /> {t("Expenses", "المصروفات")}</h1>
          <p className="text-muted-foreground text-sm mt-1 max-w-3xl">
            {t("An EXPENSE is a purchase already paid when you record it: posting it pays it from the bank you name, so nothing is left owing. A BILL is a supplier's invoice you pay later — it stays in Accounts Payable until paid.",
               "المصروف مشتريات دُفعت عند تسجيلها: ترحيلها يدفعها من الحساب البنكي الذي تحدده، فلا يبقى شيء مستحق. أما الفاتورة فهي فاتورة مورد تدفعها لاحقًا، وتبقى في الذمم الدائنة حتى تُدفع.")}
            {" "}<Link href="/bills" className="underline">{t("Bills", "فواتير الموردين")}</Link>
          </p>
        </div>
        <Button className="gap-2" onClick={() => setOpen(true)} data-testid="record-expense"><Plus className="w-4 h-4" /> {t("Record expense", "تسجيل مصروف")}</Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          [t("Posted expenses", "المصروفات المُرحّلة"), data ? fmtNum(data.totals.postedAmount) : "—", "exp-posted"],
          [t("VAT on posted expenses", "ضريبة المصروفات المُرحّلة"), data ? fmtNum(data.totals.postedVat) : "—", "exp-vat"],
          [t("Not yet posted", "لم تُرحّل بعد"), data ? String(data.totals.unposted) : "—", "exp-unposted"],
        ].map(([l, v, id]) => (
          <Card key={id} className="border-border bg-card">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
            <CardContent><div className="text-xl sm:text-2xl font-bold font-mono" data-testid={id} dir="ltr">{v}</div></CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="flex gap-2 flex-wrap">
            {([["", t("All", "الكل")], ["unposted", t("Not posted", "غير مُرحّلة")], ["posted", t("Posted", "مُرحّلة")]] as const).map(([v, l]) => (
              <Button key={v || "all"} size="sm" variant={status === v ? "default" : "ghost"} className="h-7 text-xs" onClick={() => { setStatus(v); setPage(0); }}>{l}</Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-10 text-center" data-testid="expenses-empty">{t("No expenses recorded.", "لا توجد مصروفات مسجلة.")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs">
                    {[t("Number", "الرقم"), t("Supplier", "المورد"), t("Date", "التاريخ"), t("Account", "الحساب"), t("Total", "الإجمالي"), t("VAT", "الضريبة"),
                      t("VAT evidence", "إثبات الضريبة"), t("Status", "الحالة"), t("Payment", "الدفع"), t("Document", "المستند"), ""].map((h, i) => (
                      <th key={i} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((e: Expense) => {
                    const unposted = e.status === "draft" || e.status === "submitted";
                    // Held = VAT not claimed for want of evidence: posted with its VAT in the holding account, or a draft awaiting evidence.
                    const held = e.inputVat?.state === "awaiting_evidence" || (unposted && e.vatEvidence?.status === "awaiting_evidence");
                    const doc = e.evidenceDocument as { captureId?: string } | null | undefined;
                    return (
                      <tr key={e.id} className="border-b border-border/50 align-top" data-testid={`expense-row-${e.id}`}>
                        <td className="py-2 pe-3 font-mono text-xs"><Link href={`/bills?edit=${e.id}`} className="text-primary" dir="ltr">{e.billNumber}</Link>
                          {e.vendorReference && <div className="text-[10px] text-muted-foreground" dir="ltr">{e.vendorReference}</div>}</td>
                        <td className="py-2 pe-3">{e.vendorName ?? "—"}</td>
                        <td className="py-2 pe-3 text-xs"><DualDate date={e.date} /></td>
                        <td className="py-2 pe-3 text-xs">{e.expenseAccountName ?? "—"}</td>
                        <td className="py-2 pe-3 font-mono" dir="ltr">{fmtNum(e.total)}</td>
                        <td className="py-2 pe-3 font-mono text-muted-foreground" dir="ltr">{fmtNum(e.vatAmount)}</td>
                        <td className="py-2 pe-3 text-xs">
                          {held
                            ? <Link href={`/vat-evidence?q=${encodeURIComponent(e.billNumber)}`} className="text-attention underline" data-testid={`expense-held-${e.id}`}>{inputVatLabel(e.inputVat?.state, t) ?? evidenceStatusLabel(e.vatEvidence?.status, t)}</Link>
                            : <span data-testid={`expense-vat-${e.id}`}>{inputVatLabel(e.inputVat?.state, t) ?? evidenceStatusLabel(e.vatEvidence?.status, t)}</span>}
                        </td>
                        <td className="py-2 pe-3 text-xs">{billStatusLabel(e.status, lang)}</td>
                        <td className="py-2 pe-3 text-xs" data-testid={`expense-payment-${e.id}`}>
                          {payLabel(e.paymentStatus)}
                          <div className="text-[10px] text-muted-foreground">{e.paidFromBankName ?? ""} {e.expensePaidAt ? <span dir="ltr">· {e.expensePaidAt}</span> : null}</div>
                        </td>
                        <td className="py-2 pe-3 text-xs">
                          {doc?.captureId
                            ? <a href={`/api/capture/${doc.captureId}/image`} target="_blank" rel="noreferrer" className="text-primary underline">{t("View", "عرض")}</a>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2">
                          {unposted && (
                            <Button size="sm" variant="ghost" className="h-7 text-xs text-info" disabled={postOne.isPending} onClick={() => postOne.mutate(e.id)} data-testid={`expense-post-${e.id}`}>
                              {t("Post & pay", "ترحيل ودفع")}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {total > 0 && (
            <div className="flex items-center justify-between pt-3 text-sm text-muted-foreground">
              <span>{t(`Showing ${page * PAGE + 1}–${Math.min(page * PAGE + items.length, total)} of ${total}`, `عرض ${page * PAGE + 1}–${Math.min(page * PAGE + items.length, total)} من ${total}`)}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>{t("Previous", "السابق")}</Button>
                <Button variant="outline" size="sm" disabled={(page + 1) * PAGE >= total} onClick={() => setPage((p) => p + 1)}>{t("Next", "التالي")}</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setForm(empty()); setFile(null); } }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{t("Record an expense", "تسجيل مصروف")}</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2" data-testid="expense-form">
            <p className="text-xs text-muted-foreground">{t("Already paid. Posting it pays it from the bank below — nothing is left owing to the supplier.", "مدفوع بالفعل. ترحيله يدفعه من الحساب البنكي أدناه — فلا يبقى مستحق للمورد.")}</p>
            <div>
              <Label className="text-xs text-muted-foreground">{t("Supplier *", "المورد *")}</Label>
              <Select value={form.vendorId} onValueChange={(v) => setForm((p) => ({ ...p, vendorId: v }))}>
                <SelectTrigger className="mt-1 h-8 text-sm" data-testid="expense-vendor"><SelectValue placeholder={t("Select supplier…", "اختر المورد…")} /></SelectTrigger>
                <SelectContent>{vendors.map((v) => <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}<PickerLimitNotice shown={vendors.length} total={vendorsPage?.total ?? vendors.length} /></SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("Supplier document you hold", "مستند المورد الذي بحوزتك")}</Label>
              <Select value={form.supplierDocumentKind || "unset"} onValueChange={(v) => setForm((p) => ({ ...p, supplierDocumentKind: v === "unset" ? "" : (v as SupplierDocumentKind) }))}>
                <SelectTrigger className="mt-1 h-8 text-sm" data-testid="expense-document-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unset" className="text-xs">{t("— Choose —", "— اختر —")}</SelectItem>
                  {SUPPLIER_DOCUMENT_KINDS.map((k) => <SelectItem key={k} value={k} className="text-xs">{kindLabel(k, t)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">{t("Supplier invoice #", "رقم فاتورة المورد")}</Label>
                <Input value={form.vendorReference} onChange={(e) => setForm((p) => ({ ...p, vendorReference: e.target.value }))} className="mt-1 h-8 text-sm" data-testid="expense-reference" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t("Invoice date *", "تاريخ الفاتورة *")}</Label>
                <Input type="date" value={form.date} onChange={(e) => setForm((p) => ({ ...p, date: e.target.value }))} className="mt-1 h-8 text-sm" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {([["subtotal", t("Subtotal", "المجموع قبل الضريبة")], ["vatAmount", t("VAT", "الضريبة")], ["total", t("Total *", "الإجمالي *")]] as const).map(([k, l]) => (
                <div key={k}>
                  <Label className="text-xs text-muted-foreground">{l}</Label>
                  <Input type="number" step="0.01" value={form[k]} onChange={(e) => setForm((p) => ({ ...p, [k]: e.target.value }))} className="mt-1 h-8 text-sm font-mono" data-testid={`expense-${k}`} />
                </div>
              ))}
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("Expense account", "حساب المصروف")}</Label>
              <Select value={String(form.debitAccountId ?? defaultExpenseId ?? "")} onValueChange={(v) => setForm((p) => ({ ...p, debitAccountId: Number(v) }))}>
                <SelectTrigger className="mt-1 h-8 text-sm" data-testid="expense-account"><SelectValue /></SelectTrigger>
                <SelectContent>{expenseAccounts.map((a) => <SelectItem key={a.id} value={String(a.id)} className="text-xs">{a.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">{t("Paid from bank account *", "دُفع من الحساب البنكي *")}</Label>
                <Select value={form.bankId || (defaultBankId != null ? String(defaultBankId) : "")} onValueChange={(v) => setForm((p) => ({ ...p, bankId: v }))}>
                  <SelectTrigger className="mt-1 h-8 text-sm" data-testid="expense-bank"><SelectValue placeholder={t("Choose the bank account", "اختر الحساب البنكي")} /></SelectTrigger>
                  <SelectContent>{activeBanks.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name} — {b.bankName}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t("Date paid *", "تاريخ الدفع *")}</Label>
                <Input type="date" value={form.paidAt || form.date} onChange={(e) => setForm((p) => ({ ...p, paidAt: e.target.value }))} className="mt-1 h-8 text-sm" data-testid="expense-paid-at" />
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("Receipt or invoice (optional)", "الإيصال أو الفاتورة (اختياري)")}</Label>
              <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} data-testid="expense-file" />
              <div className="flex items-center gap-2 mt-1">
                <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={() => fileRef.current?.click()}>{t("Choose a file", "اختيار ملف")}</Button>
                <span className="text-xs text-muted-foreground truncate">{file?.name ?? t("No file", "لا يوجد ملف")}</span>
              </div>
            </div>
            <VatEvidencePanel verdict={verdict} context="preview" />
            <DuplicateWarning vendorId={form.vendorId ? Number(form.vendorId) : null} vendorReference={form.vendorReference} date={form.date} total={Number(form.total) || null} />
          </div>
          <Button className="w-full mt-4" disabled={!canSave} onClick={() => record.mutate()} data-testid="expense-save">
            {record.isPending ? t("Saving…", "جارٍ الحفظ…") : t("Record expense", "تسجيل المصروف")}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
