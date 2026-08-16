import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, FileInput, ScanLine } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ReceiptScanner } from "@/components/ReceiptScanner";
import type { ParsedReceipt } from "@/lib/receiptParser";
import { storeScanData } from "@/lib/scanReviewStore";
import { useDeployment } from "@/hooks/useDeployment";
import type { QrCaptureResult } from "@/lib/qrCapture";
import { EXPENSE_ACCOUNTS, DEFAULT_EXPENSE_ACCOUNT } from "@/lib/accounts";
import { useLanguage } from "@/contexts/LanguageContext";

interface Bill {
  id: number; billNumber: string; vendorReference: string; date: string;
  dueDate: string; vendorId: number; vendorName: string; status: string;
  subtotal: number; vatAmount: number; total: number; paidAmount: number;
}
interface Vendor { id: number; name: string; }

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  received: "bg-blue-500/20 text-blue-400",
  approved: "bg-amber-500/20 text-amber-400",
  paid: "bg-emerald-500/20 text-emerald-400",
  overdue: "bg-red-500/20 text-red-400",
};

const makeEmpty = () => ({
  billNumber: `BILL-${Date.now().toString().slice(-6)}`,
  vendorReference: "",
  date: new Date().toISOString().split("T")[0],
  dueDate: "",
  vendorId: "",
  status: "received",
  subtotal: "",
  vatAmount: "",
  total: "",
  notes: "",
  debitAccount: DEFAULT_EXPENSE_ACCOUNT as string,
});

// ── small JE preview used inside the manual-bill dialog ──────────────────────
function JePreview({ subtotal, vatAmount, total, debitAccount }: {
  subtotal: number; vatAmount: number; total: number; debitAccount: string;
}) {
  const { t } = useLanguage();
  const reconciled = Math.abs(subtotal + vatAmount - total) <= 0.02;
  return (
    <div className="rounded-lg border border-border overflow-hidden text-xs mt-1">
      <div className="bg-secondary/40 px-3 py-1.5 text-muted-foreground font-medium">
        {t("Proposed journal entry", "قيد اليومية المقترح")}
      </div>
      <table className="w-full">
        <thead>
          <tr className="border-b border-border/50">
            <th className="text-left px-3 py-1.5 text-muted-foreground font-normal">{t("Account", "الحساب")}</th>
            <th className="text-right px-3 py-1.5 text-muted-foreground font-normal">{t("Dr", "مدين")}</th>
            <th className="text-right px-3 py-1.5 text-muted-foreground font-normal">{t("Cr", "دائن")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/30">
          <tr>
            <td className="px-3 py-1.5 truncate max-w-[160px]">{debitAccount || "—"}</td>
            <td className="px-3 py-1.5 text-right font-mono tabular-nums">{subtotal > 0 ? fmtNum(subtotal) : "—"}</td>
            <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">—</td>
          </tr>
          <tr>
            <td className="px-3 py-1.5 text-muted-foreground">{t("Input VAT Receivable", "ضريبة القيمة المضافة المدخلة المستحقة")}</td>
            <td className="px-3 py-1.5 text-right font-mono tabular-nums">{vatAmount > 0 ? fmtNum(vatAmount) : "—"}</td>
            <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">—</td>
          </tr>
          <tr>
            <td className="px-3 py-1.5 text-muted-foreground">{t("Accounts Payable", "الذمم الدائنة")}</td>
            <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">—</td>
            <td className="px-3 py-1.5 text-right font-mono tabular-nums">{total > 0 ? fmtNum(total) : "—"}</td>
          </tr>
        </tbody>
      </table>
      {subtotal > 0 && total > 0 && !reconciled && (
        <div className="px-3 py-1.5 text-red-400 bg-red-500/5 border-t border-red-500/20 text-xs">
          ⚠ {t("Totals don't reconcile — server will reject this unless corrected.", "الإجماليات غير متطابقة — سيرفض الخادم هذا القيد ما لم يتم تصحيحه.")}
        </div>
      )}
    </div>
  );
}

export default function Bills() {
  const [, navigate] = useLocation();
  const [statusFilter, setStatusFilter] = useState("all");
  const [open, setOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const { demoMode } = useDeployment();
  const [payOpen, setPayOpen] = useState<number | null>(null);
  const [postReviewOpen, setPostReviewOpen] = useState<Bill | null>(null);
  const [postDebitAccount, setPostDebitAccount] = useState<string>(DEFAULT_EXPENSE_ACCOUNT);
  const [form, setForm] = useState(makeEmpty());
  const [payAmount, setPayAmount] = useState("");
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();

  const { data: bills = [], isLoading } = useQuery<Bill[]>({
    queryKey: ["bills", statusFilter],
    queryFn: () => apiFetch(`/bills${statusFilter !== "all" ? `?status=${statusFilter}` : ""}`),
  });

  const { data: vendors = [] } = useQuery<Vendor[]>({
    queryKey: ["vendors"],
    queryFn: () => apiFetch("/vendors"),
  });

  // Manual bill creation: create draft, then post GL through the shared endpoint.
  // debitAccount is passed explicitly — no hardcoded default anywhere in this path.
  const createMut = useMutation({
    mutationFn: async (body: typeof form) => {
      const bill: { id: number; billNumber: string } = await apiFetch("/bills", {
        method: "POST",
        body: JSON.stringify({
          ...body,
          vendorId:  Number(body.vendorId),
          subtotal:  body.subtotal  ? Number(body.subtotal)  : undefined,
          vatAmount: body.vatAmount ? Number(body.vatAmount) : undefined,
          total:     body.total     ? Number(body.total)     : undefined,
          items: [],
        }),
      });
      // Post GL through the single shared endpoint, passing the accountant's
      // chosen debit account — same call shape as ScanReview.
      if (Number(body.total) > 0) {
        await apiFetch(`/bills/${bill.id}/post`, {
          method: "POST",
          body: JSON.stringify({ debitAccount: body.debitAccount }),
        });
      }
      return bill;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bills"] });
      setOpen(false);
      setForm(makeEmpty());
      toast({ title: t("Bill created & posted", "تم إنشاء الفاتورة وترحيلها") });
    },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" } as any),
  });

  // Post an existing draft bill — opens a small account-selection dialog first
  // so the accountant can choose the debit account and see the JE preview,
  // matching the scanner review flow.
  const postMut = useMutation({
    mutationFn: ({ id, debitAccount }: { id: number; debitAccount: string }) =>
      apiFetch(`/bills/${id}/post`, {
        method: "POST",
        body: JSON.stringify({ debitAccount }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bills"] });
      setPostReviewOpen(null);
      toast({ title: t("Bill posted to ledger", "تم ترحيل الفاتورة إلى دفتر الأستاذ") });
    },
    onError: (e: Error) => toast({ title: t("Posting failed", "فشل الترحيل"), description: e.message, variant: "destructive" } as any),
  });

  const payMut = useMutation({
    mutationFn: ({ id, amount }: { id: number; amount: number }) =>
      apiFetch(`/bills/${id}/pay`, {
        method: "POST",
        body: JSON.stringify({ amount, paidAt: new Date().toISOString().split("T")[0] }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bills"] });
      setPayOpen(null);
      setPayAmount("");
      toast({ title: t("Payment recorded", "تم تسجيل الدفعة") });
    },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" } as any),
  });

  /**
   * Called when the ReceiptScanner returns parsed fields — stage the
   * photograph server-side (A1: the capture pipeline finally has its caller),
   * then go to the review page carrying the captureId.
   */
  const handleScanned = async (data: ParsedReceipt, qr: QrCaptureResult | undefined, file: File) => {
    const payload = {
      parsed: data,
      // Provenance travels with the extraction: a figure decoded from a ZATCA
      // QR is exact, one read by OCR is a guess, and the review page must be
      // able to tell the user which it is looking at.
      source: (qr ? "qr" : "ocr") as "qr" | "ocr",
      isPhase2: qr?.isPhase2,
      missing: qr?.missing,
      payloadBase64: qr?.payloadBase64,
    };
    try {
      const form = new FormData();
      form.append("document", file, file.name);
      form.append("source", payload.source);
      if (qr?.payloadBase64) form.append("qrPayload", qr.payloadBase64);
      form.append("extraction", JSON.stringify(data));
      const capture: { captureId: string; signatureStatus?: string; signatureFailed?: boolean } =
        await apiFetch("/capture", { method: "POST", body: form });
      storeScanData({ ...payload, captureId: capture.captureId, signatureStatus: capture.signatureStatus });
      navigate(`/scan-review?capture=${capture.captureId}`);
    } catch (e: any) {
      // Storage being down must not block billing — but say so plainly: the
      // bill posted from this scan will have NO stored source document.
      toast({
        title: t("Document could not be stored", "تعذّر حفظ المستند"),
        description: t(
          "You can still review and post the bill, but the photograph will not be retained as evidence.",
          "يمكنك مراجعة الفاتورة وترحيلها، لكن لن يتم الاحتفاظ بالصورة كمستند داعم.",
        ),
        variant: "destructive",
      } as any);
      storeScanData(payload);
      navigate("/scan-review");
    }
  };

  const totalOutstanding = bills
    .filter(b => b.status !== "paid")
    .reduce((s, b) => s + (b.total - b.paidAmount), 0);

  // Derived JE preview values for the manual bill form
  const previewSubtotal  = Number(form.subtotal)  || 0;
  const previewVat       = Number(form.vatAmount)  || 0;
  const previewTotal     = Number(form.total)      || 0;

  return (
    <div className="space-y-6">
      {/* ── header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Bills", "فواتير الموردين")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Vendor bills · Accounts Payable", "فواتير الموردين · الذمم الدائنة")}</p>
        </div>
        <div className="flex gap-2">
          {/*
            Scan Receipt — hidden on the demo, where POST /capture is refused
            at the route (D3). Capture is the one act a demo could make
            IRREVERSIBLE: a promoted photograph lands in an archive with no
            delete by design, and PDPL is still unanswered (queue C8). The
            button goes with the capability, not instead of it.
          */}
          {!demoMode && (
            <Button variant="outline" className="gap-2" onClick={() => setScanOpen(true)}>
              <ScanLine className="w-4 h-4" /> {t("Scan Receipt", "مسح الإيصال")}
            </Button>
          )}

          {/* New Bill dialog */}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2"><Plus className="w-4 h-4" /> {t("New Bill", "فاتورة جديدة")}</Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader><DialogTitle>{t("New Bill", "فاتورة جديدة")}</DialogTitle></DialogHeader>
              <div className="space-y-3 mt-2">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Bill Number", "رقم الفاتورة")}</Label>
                    <Input value={form.billNumber}
                      onChange={e => setForm(p => ({ ...p, billNumber: e.target.value }))}
                      className="mt-1 h-8 text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Vendor Ref / Invoice #", "مرجع المورد / رقم الفاتورة")}</Label>
                    <Input value={form.vendorReference}
                      onChange={e => setForm(p => ({ ...p, vendorReference: e.target.value }))}
                      className="mt-1 h-8 text-sm" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Date", "التاريخ")}</Label>
                    <Input type="date" value={form.date}
                      onChange={e => setForm(p => ({ ...p, date: e.target.value }))}
                      className="mt-1 h-8 text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Due Date", "تاريخ الاستحقاق")}</Label>
                    <Input type="date" value={form.dueDate}
                      onChange={e => setForm(p => ({ ...p, dueDate: e.target.value }))}
                      className="mt-1 h-8 text-sm" />
                  </div>
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground">{t("Vendor", "المورد")}</Label>
                  <Select value={form.vendorId} onValueChange={v => setForm(p => ({ ...p, vendorId: v }))}>
                    <SelectTrigger className="mt-1 h-8 text-sm">
                      <SelectValue placeholder={t("Select vendor…", "اختر المورد…")} />
                    </SelectTrigger>
                    <SelectContent>
                      {vendors.map(v => <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Subtotal (SAR)", "المجموع قبل الضريبة (ر.س)")}</Label>
                    <Input type="number" step="0.01" value={form.subtotal}
                      onChange={e => setForm(p => ({ ...p, subtotal: e.target.value }))}
                      placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("VAT (SAR)", "ضريبة القيمة المضافة (ر.س)")}</Label>
                    <Input type="number" step="0.01" value={form.vatAmount}
                      onChange={e => setForm(p => ({ ...p, vatAmount: e.target.value }))}
                      placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Total (SAR)", "الإجمالي (ر.س)")}</Label>
                    <Input type="number" step="0.01" value={form.total}
                      onChange={e => setForm(p => ({ ...p, total: e.target.value }))}
                      placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                  </div>
                </div>

                {/* Fix 2: debit account dropdown — same 14 accounts as scanner flow */}
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Expense / Debit Account", "حساب المصروف / المدين")}</Label>
                  <Select value={form.debitAccount}
                    onValueChange={v => setForm(p => ({ ...p, debitAccount: v }))}>
                    <SelectTrigger className="mt-1 h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EXPENSE_ACCOUNTS.map(a => (
                        <SelectItem key={a} value={a} className="text-xs">{a}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground">{t("Notes", "ملاحظات")}</Label>
                  <Input value={form.notes}
                    onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                    className="mt-1 h-8 text-sm" />
                </div>

                {/* Fix 2: live JE preview — same structure as ScanReview */}
                {(previewSubtotal > 0 || previewVat > 0 || previewTotal > 0) && (
                  <JePreview
                    subtotal={previewSubtotal}
                    vatAmount={previewVat}
                    total={previewTotal}
                    debitAccount={form.debitAccount}
                  />
                )}
              </div>

              <Button
                className="w-full mt-4"
                onClick={() => createMut.mutate(form)}
                disabled={!form.vendorId || createMut.isPending}
              >
                {createMut.isPending ? t("Posting…", "جارٍ الترحيل…") : t("Post Bill", "ترحيل الفاتورة")}
              </Button>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* ── KPI cards ───────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-4">
        {[
          [t("Total Bills", "إجمالي الفواتير"), bills.length, "text-primary"],
          [t("Outstanding AP", "الذمم الدائنة المستحقة"), fmtNum(totalOutstanding), "text-red-400"],
          [t("Paid", "مدفوع"), fmtNum(bills.filter(b => b.status === "paid").reduce((s, b) => s + b.total, 0)), "text-emerald-400"],
          [t("Overdue", "متأخر"), bills.filter(b => b.status === "overdue").length, "text-red-400"],
        ].map(([l, v, c]) => (
          <Card key={String(l)} className="border-border bg-card">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
            <CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent>
          </Card>
        ))}
      </div>

      {/* ── bills table ─────────────────────────────────────────────────────── */}
      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="flex gap-2 flex-wrap">
            {["all", "draft", "received", "approved", "paid", "overdue"].map(s => (
              <Button key={s} variant={statusFilter === s ? "default" : "ghost"} size="sm"
                className="h-7 text-xs capitalize" onClick={() => setStatusFilter(s)}>
                {s}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-muted-foreground text-sm p-4">{t("Loading…", "جارٍ التحميل…")}</div>
          ) : bills.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <FileInput className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No bills found.", "لا توجد فواتير.")}</p>
              <p className="text-xs mt-1 opacity-60">{t("Create one manually or scan a receipt.", "أنشئ فاتورة يدوياً أو امسح إيصالاً.")}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[
                    t("Bill #", "رقم الفاتورة"),
                    t("Vendor", "المورد"),
                    t("Date", "التاريخ"),
                    t("Due Date", "تاريخ الاستحقاق"),
                    t("Subtotal", "المجموع قبل الضريبة"),
                    t("VAT", "ضريبة القيمة المضافة"),
                    t("Total", "الإجمالي"),
                    t("Status", "الحالة"),
                    "",
                  ].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bills.map(b => (
                  <tr key={b.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                    <td className="py-3 pr-4 font-mono text-xs text-primary">{b.billNumber}</td>
                    <td className="py-3 pr-4 font-medium">{b.vendorName ?? "—"}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{fmtDate(b.date)}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{b.dueDate ? fmtDate(b.dueDate) : "—"}</td>
                    <td className="py-3 pr-4 font-mono">{fmtNum(b.subtotal)}</td>
                    <td className="py-3 pr-4 font-mono text-muted-foreground">{fmtNum(b.vatAmount)}</td>
                    <td className="py-3 pr-4 font-mono font-semibold">{fmtNum(b.total)}</td>
                    <td className="py-3 pr-4">
                      <Badge className={`text-xs ${STATUS_STYLES[b.status] ?? ""}`}>{b.status}</Badge>
                    </td>
                    <td className="py-3 flex gap-1">
                      {b.status === "draft" && (
                        <Button variant="ghost" size="sm" className="text-xs h-7 text-blue-400"
                          onClick={() => { setPostReviewOpen(b); setPostDebitAccount(DEFAULT_EXPENSE_ACCOUNT); }}>
                          {t("Post", "ترحيل")}
                        </Button>
                      )}
                      {b.status !== "paid" && b.status !== "draft" && (
                        <Button variant="ghost" size="sm" className="text-xs h-7 text-emerald-400"
                          onClick={() => { setPayOpen(b.id); setPayAmount(String(b.total - b.paidAmount)); }}>
                          {t("Pay", "دفع")}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* ── "Post draft bill" dialog — account selection + JE preview ───────── */}
      <Dialog open={postReviewOpen !== null} onOpenChange={v => !v && setPostReviewOpen(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t("Post Bill to Ledger", "ترحيل الفاتورة إلى دفتر الأستاذ")}</DialogTitle></DialogHeader>
          {postReviewOpen && (
            <div className="mt-2 space-y-3">
              <p className="text-sm text-muted-foreground">
                {t("Bill", "فاتورة")} <span className="font-mono text-foreground">{postReviewOpen.billNumber}</span>
                {" "}· {postReviewOpen.vendorName ?? t("Unknown vendor", "مورد غير معروف")}
              </p>
              <div>
                <Label className="text-xs text-muted-foreground">{t("Expense / Debit Account", "حساب المصروف / المدين")}</Label>
                <Select value={postDebitAccount} onValueChange={setPostDebitAccount}>
                  <SelectTrigger className="mt-1 h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPENSE_ACCOUNTS.map(a => (
                      <SelectItem key={a} value={a} className="text-xs">{a}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <JePreview
                subtotal={postReviewOpen.subtotal}
                vatAmount={postReviewOpen.vatAmount}
                total={postReviewOpen.total}
                debitAccount={postDebitAccount}
              />
              <Button
                className="w-full"
                disabled={postMut.isPending}
                onClick={() => postMut.mutate({ id: postReviewOpen.id, debitAccount: postDebitAccount })}
              >
                {postMut.isPending ? t("Posting…", "جارٍ الترحيل…") : t("Confirm & Post", "تأكيد والترحيل")}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── payment dialog ──────────────────────────────────────────────────── */}
      <Dialog open={payOpen !== null} onOpenChange={() => setPayOpen(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t("Record Payment", "تسجيل دفعة")}</DialogTitle></DialogHeader>
          <div className="mt-2">
            <Label className="text-xs text-muted-foreground">{t("Amount Paid (SAR)", "المبلغ المدفوع (ر.س)")}</Label>
            <Input type="number" value={payAmount}
              onChange={e => setPayAmount(e.target.value)} className="mt-1 h-8 text-sm" />
          </div>
          <Button
            className="w-full mt-4 bg-emerald-600 hover:bg-emerald-700"
            onClick={() => payOpen && payMut.mutate({ id: payOpen, amount: Number(payAmount) })}
            disabled={!payAmount || payMut.isPending}
          >
            {payMut.isPending ? t("Recording…", "جارٍ التسجيل…") : t("Record Payment", "تسجيل الدفعة")}
          </Button>
        </DialogContent>
      </Dialog>

      {/* ── receipt scanner ─────────────────────────────────────────────────── */}
      <ReceiptScanner
        open={scanOpen}
        onOpenChange={setScanOpen}
        onExtracted={handleScanned}
      />
    </div>
  );
}
