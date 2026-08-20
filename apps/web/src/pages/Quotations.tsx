/**
 * Quotations (M21.1).
 *
 * 🔴 This page REPLACES a façade. The previous version rendered a form whose
 * Save button showed a success toast and persisted nothing, against an API
 * route that was never mounted — one of six such pages the 2026-08-20 audit
 * found. Every control here calls a real endpoint; there is no optimistic
 * toast that outruns the server.
 *
 * Two axes are displayed SEPARATELY and deliberately (design §4): the approval
 * status (draft / submitted / approved) and the conversion state (open /
 * partially converted / converted). They are different facts, and a single
 * badge claiming to be both would be the thing the design set out to avoid.
 * Conversion lands in M21.2; until then every live quotation reads `open`.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, FileText, Clock, CheckCircle, XCircle, Trash2, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { DualDate } from "@/components/DualDate";

interface QuotationItem {
  id?: number;
  description: string;
  quantity: number | string;
  unitPrice: number | string;
  vatRate: number | string;
  total?: number;
  remainingQuantity?: number;
}

interface Quotation {
  id: number;
  quotationNumber: string;
  date: string;
  validUntil: string | null;
  customerId: number | null;
  customerName: string | null;
  status: string;
  outcome: string | null;
  conversionState: "open" | "partially_converted" | "converted";
  expired: boolean;
  subtotal: number;
  vatAmount: number;
  total: number;
  currency: string;
  reviewNote: string | null;
  items?: QuotationItem[];
}

interface Customer { id: number; name: string }

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  submitted: "bg-amber-500/20 text-amber-400",
  approved: "bg-blue-500/20 text-blue-400",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  draft: <FileText className="w-3 h-3" />,
  submitted: <Clock className="w-3 h-3" />,
  approved: <CheckCircle className="w-3 h-3" />,
};

const emptyLine = (): QuotationItem => ({ description: "", quantity: 1, unitPrice: "", vatRate: 15 });

export default function Quotations() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [form, setForm] = useState({
    date: new Date().toISOString().split("T")[0],
    validUntil: "",
    customerId: "",
    notes: "",
  });
  const [lines, setLines] = useState<QuotationItem[]>([emptyLine()]);

  const { data: quotations = [], isLoading } = useQuery<Quotation[]>({
    queryKey: ["quotations", statusFilter],
    queryFn: () => apiFetch(`/quotations${statusFilter !== "all" ? `?status=${statusFilter}` : ""}`),
  });
  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: () => apiFetch("/customers"),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["quotations"] });

  // 🔴 Errors surface as themselves. The façade this replaces reported success
  // unconditionally; a mutation that fails must say so, in the server's words.
  const fail = (e: unknown) =>
    toast({
      title: t("Failed", "فشل"),
      description: e instanceof Error ? e.message : String(e),
      variant: "destructive",
    });

  const createMut = useMutation({
    mutationFn: () =>
      apiFetch("/quotations", {
        method: "POST",
        body: JSON.stringify({
          date: form.date,
          validUntil: form.validUntil || undefined,
          customerId: form.customerId ? Number(form.customerId) : undefined,
          notes: form.notes || undefined,
          items: lines.map((l) => ({
            description: l.description,
            quantity: Number(l.quantity),
            unitPrice: Number(l.unitPrice),
            vatRate: Number(l.vatRate),
          })),
        }),
      }),
    onSuccess: (q: Quotation) => {
      setOpen(false);
      setLines([emptyLine()]);
      setForm({ date: new Date().toISOString().split("T")[0], validUntil: "", customerId: "", notes: "" });
      refresh();
      toast({ title: t("Quotation created", "تم إنشاء عرض السعر"), description: q.quotationNumber });
    },
    onError: fail,
  });

  const actionMut = useMutation({
    mutationFn: ({ id, action }: { id: number; action: string }) =>
      apiFetch(`/quotations/${id}/${action}`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => refresh(),
    onError: fail,
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/quotations/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      refresh();
      toast({ title: t("Quotation deleted", "تم حذف عرض السعر") });
    },
    onError: fail,
  });

  const setLine = (i: number, patch: Partial<QuotationItem>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  // Mirrors the server's round-then-sum arithmetic so the preview cannot claim
  // a total the server will not produce.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const previewTotal = lines.reduce((sum, l) => {
    const base = round2(Number(l.quantity || 0) * Number(l.unitPrice || 0));
    return round2(sum + base + round2(base * (Number(l.vatRate || 0) / 100)));
  }, 0);

  const CONVERSION_LABEL: Record<string, [string, string]> = {
    open: ["Open", "مفتوح"],
    partially_converted: ["Partly invoiced", "مفوتر جزئيًا"],
    converted: ["Invoiced", "مفوتر"],
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">{t("Quotations", "عروض الأسعار")}</h1>
          {/* An offer, not a transaction — said plainly, because the whole
              design rests on it and a user should not wonder. */}
          <p className="text-sm text-muted-foreground mt-1">
            {t(
              "An offer to a customer. A quotation affects no report and no ledger until it becomes an invoice.",
              "عرض مقدَّم للعميل. لا يؤثر عرض السعر على أي تقرير أو دفتر حتى يتحول إلى فاتورة.",
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-40 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("All statuses", "كل الحالات")}</SelectItem>
              <SelectItem value="draft">{t("Draft", "مسودة")}</SelectItem>
              <SelectItem value="submitted">{t("Submitted", "مُرسل للاعتماد")}</SelectItem>
              <SelectItem value="approved">{t("Approved", "معتمد")}</SelectItem>
            </SelectContent>
          </Select>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="w-4 h-4 mr-1" />{t("New quotation", "عرض سعر جديد")}</Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader><DialogTitle>{t("New quotation", "عرض سعر جديد")}</DialogTitle></DialogHeader>
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Customer", "العميل")}</Label>
                    <Select value={form.customerId} onValueChange={(v) => setForm((p) => ({ ...p, customerId: v }))}>
                      <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder={t("Select…", "اختر…")} /></SelectTrigger>
                      <SelectContent>
                        {customers.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Date", "التاريخ")}</Label>
                    <Input type="date" value={form.date} onChange={(e) => setForm((p) => ({ ...p, date: e.target.value }))} className="mt-1 h-8 text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Valid until", "صالح حتى")}</Label>
                    <Input type="date" value={form.validUntil} onChange={(e) => setForm((p) => ({ ...p, validUntil: e.target.value }))} className="mt-1 h-8 text-sm" />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">{t("Lines", "البنود")}</Label>
                  {lines.map((l, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center">
                      <Input className="col-span-5 h-8 text-sm" placeholder={t("Description", "الوصف")} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                      <Input className="col-span-2 h-8 text-sm font-mono" type="number" step="0.001" placeholder={t("Qty", "الكمية")} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                      <Input className="col-span-2 h-8 text-sm font-mono" type="number" step="0.01" placeholder={t("Price", "السعر")} value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
                      <Input className="col-span-2 h-8 text-sm font-mono" type="number" step="0.01" placeholder={t("VAT %", "ض.ق.م ٪")} value={l.vatRate} onChange={(e) => setLine(i, { vatRate: e.target.value })} />
                      <Button variant="ghost" size="icon" className="col-span-1 h-8 w-8" onClick={() => setLines((p) => (p.length > 1 ? p.filter((_, idx) => idx !== i) : p))}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" onClick={() => setLines((p) => [...p, emptyLine()])}>
                    <Plus className="w-3.5 h-3.5 mr-1" />{t("Add line", "إضافة بند")}
                  </Button>
                </div>

                <div className="flex items-center justify-between border-t border-border pt-3">
                  <span className="text-sm text-muted-foreground">{t("Total (incl. VAT)", "الإجمالي شامل الضريبة")}</span>
                  <span className="font-mono text-lg">{fmtNum(previewTotal)}</span>
                </div>

                <Button className="w-full" onClick={() => createMut.mutate()} disabled={createMut.isPending}>
                  {createMut.isPending ? t("Saving…", "جارٍ الحفظ…") : t("Create quotation", "إنشاء عرض السعر")}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">{t("Quotations", "عروض الأسعار")}</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-6 text-center">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : quotations.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">{t("No quotations yet.", "لا توجد عروض أسعار بعد.")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="pb-2 pr-4">{t("Number", "الرقم")}</th>
                    <th className="pb-2 pr-4">{t("Customer", "العميل")}</th>
                    <th className="pb-2 pr-4">{t("Date", "التاريخ")}</th>
                    <th className="pb-2 pr-4">{t("Valid until", "صالح حتى")}</th>
                    <th className="pb-2 pr-4 text-right">{t("Total", "الإجمالي")}</th>
                    <th className="pb-2 pr-4">{t("Status", "الحالة")}</th>
                    <th className="pb-2 pr-4">{t("Progress", "التقدم")}</th>
                    <th className="pb-2 text-right">{t("Actions", "إجراءات")}</th>
                  </tr>
                </thead>
                <tbody>
                  {quotations.map((q) => (
                    <tr key={q.id} className="border-b border-border/50">
                      <td className="py-3 pr-4 font-mono text-xs text-primary">{q.quotationNumber}</td>
                      <td className="py-3 pr-4">{q.customerName ?? "—"}</td>
                      <td className="py-3 pr-4 text-muted-foreground text-xs"><DualDate date={q.date} /></td>
                      <td className="py-3 pr-4 text-muted-foreground text-xs">
                        {q.validUntil ? (
                          <span className="inline-flex items-center gap-1">
                            <DualDate date={q.validUntil} />
                            {/* Expiry is a FACT the user weighs, never a block:
                                a customer accepting a lapsed quote is their
                                commercial call. Neutral styling on purpose —
                                the status palette is for real states. */}
                            {q.expired && (
                              <span className="inline-flex items-center gap-1 text-muted-foreground" title={t("This quotation's validity date has passed. You can still convert it.", "انتهى تاريخ صلاحية هذا العرض. لا يزال بإمكانك تحويله.")}>
                                <AlertTriangle className="w-3 h-3" />
                                {t("lapsed", "منتهٍ")}
                              </span>
                            )}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="py-3 pr-4 text-right font-mono">{fmtNum(q.total)}</td>
                      <td className="py-3 pr-4">
                        <Badge className={`text-xs gap-1 ${STATUS_STYLES[q.status] ?? ""}`}>
                          {STATUS_ICONS[q.status]}{q.status}
                        </Badge>
                        {q.outcome && (
                          <Badge className="text-xs ml-1 bg-secondary text-muted-foreground">{q.outcome}</Badge>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-xs text-muted-foreground">
                        {t(...(CONVERSION_LABEL[q.conversionState] ?? ["—", "—"]))}
                      </td>
                      <td className="py-3 text-right space-x-1 whitespace-nowrap">
                        {q.status === "draft" && (
                          <Button size="sm" variant="outline" onClick={() => actionMut.mutate({ id: q.id, action: "submit" })}>
                            {t("Submit", "إرسال")}
                          </Button>
                        )}
                        {q.status === "submitted" && (
                          <Button size="sm" onClick={() => actionMut.mutate({ id: q.id, action: "approve" })}>
                            {t("Approve", "اعتماد")}
                          </Button>
                        )}
                        {q.status === "approved" && !q.outcome && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => actionMut.mutate({ id: q.id, action: "decline" })}>
                              <XCircle className="w-3.5 h-3.5 mr-1" />{t("Declined", "مرفوض")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => actionMut.mutate({ id: q.id, action: "close" })}>
                              {t("Close", "إغلاق")}
                            </Button>
                          </>
                        )}
                        {q.outcome && (
                          <Button size="sm" variant="ghost" onClick={() => actionMut.mutate({ id: q.id, action: "reopen" })}>
                            {t("Reopen", "إعادة فتح")}
                          </Button>
                        )}
                        {q.status === "draft" && (
                          <Button size="sm" variant="ghost" onClick={() => deleteMut.mutate(q.id)}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
