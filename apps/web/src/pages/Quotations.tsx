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
import { fetchPickerOptions } from "@/lib/pagedList";
import { PickerLimitNotice } from "@/components/PickerLimitNotice";
import { ListPagination } from "@/components/ListPagination";
import { PAGE_SIZE, type Paged } from "@/lib/pagedList";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, FileText, Clock, CheckCircle, XCircle, Trash2, AlertTriangle, ArrowRightLeft } from "lucide-react";
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
  submitted: "bg-attention-surface/20 text-attention",
  approved: "bg-info-surface/20 text-info",
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
  /**
   * 🔴 AUD-4 — editing, which the product could not do at all.
   *
   * `PATCH /quotations/:id` existed, was tested, and had NO caller anywhere in
   * apps/web — so a typo was correctable only by deleting and retyping, and all
   * of M21.2's edit machinery (lines reconciled BY ID so a converted line keeps
   * its identity, plus both freeze-rule guards) was unreachable. The route
   * guard passed throughout, because it matches the path PREFIX and never the
   * verb.
   *
   * The same dialog serves both modes: `editing` null = create.
   */
  const [editing, setEditing] = useState<{ id: number; number: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [form, setForm] = useState({
    date: new Date().toISOString().split("T")[0],
    validUntil: "",
    customerId: "",
    notes: "",
  });
  const [lines, setLines] = useState<QuotationItem[]>([emptyLine()]);

  const [page, setPage] = useState(0);
  const { data: quotationsPage, isLoading } = useQuery<Paged<Quotation>>({
    queryKey: ["quotations", statusFilter, page],
    queryFn: () =>
      apiFetch(
        `/quotations?${statusFilter !== "all" ? `status=${statusFilter}&` : ""}` +
          `limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      ),
  });
  const quotations = quotationsPage?.items ?? [];
  const { data: customersPage } = useQuery<{ items: Customer[]; total: number }>({
    queryKey: ["customers", "picker"],
    queryFn: () => fetchPickerOptions<Customer>("/customers"),
  });
  const customers = customersPage?.items ?? [];

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

  /**
   * 🔴 AUD-6 — the half of the workflow that had no surface.
   *
   * `send-back` and `reject` existed on the API, were covered by the approval
   * engine's tests, and NOTHING in the product could call them: a submitted
   * quotation could only ever go forward. P4
   * (`state-machine-reachability.test.ts`) is the guard that now reports it,
   * and these two controls are what turn it green.
   */
  const [sendBack, setSendBack] = useState<{ id: number; number: string } | null>(null);
  const [sendBackNote, setSendBackNote] = useState("");
  const [reject, setReject] = useState<{ id: number; number: string } | null>(null);

  const updateMut = useMutation({
    mutationFn: () =>
      apiFetch(`/quotations/${editing!.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          date: form.date,
          validUntil: form.validUntil || undefined,
          customerId: form.customerId ? Number(form.customerId) : undefined,
          notes: form.notes || undefined,
          // Lines carry their ID where they have one: the server reconciles by
          // id, so an edited line keeps the identity any conversion points at.
          items: lines.map((l) => ({
            ...(l.id != null ? { id: l.id } : {}),
            description: l.description,
            quantity: Number(l.quantity),
            unitPrice: Number(l.unitPrice),
            vatRate: Number(l.vatRate),
          })),
        }),
      }),
    onSuccess: () => {
      setOpen(false);
      setEditing(null);
      refresh();
      toast({ title: t("Changes saved", "تم حفظ التعديلات") });
    },
    onError: fail,
  });

  /** Open the shared dialog in EDIT mode, prefilled from the full record. */
  const openEdit = async (row: { id: number; quotationNumber: string }) => {
    try {
      const detail: any = await apiFetch(`/quotations/${row.id}`);
      setForm({
        date: detail.date ?? "",
        validUntil: detail.validUntil ?? "",
        customerId: String(detail.customerId ?? ""),
        notes: detail.notes ?? "",
      });
      setLines(
        (detail.items ?? []).map((i: any) => ({
          id: i.id,
          description: i.description,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          vatRate: i.vatRate,
        })),
      );
      setEditing({ id: row.id, number: row.quotationNumber });
      setOpen(true);
    } catch (e) {
      fail(e);
    }
  };

  const actionMut = useMutation({
    mutationFn: ({ id, action, note }: { id: number; action: string; note?: string }) =>
      apiFetch(`/quotations/${id}/${action}`, {
        method: "POST",
        body: JSON.stringify(note != null ? { note } : {}),
      }),
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

  // ── Conversion (M21.2) ───────────────────────────────────────────────────
  const [converting, setConverting] = useState<Quotation | null>(null);
  const [convertQty, setConvertQty] = useState<Record<number, string>>({});
  const [convertDate, setConvertDate] = useState(new Date().toISOString().split("T")[0]);

  // The dialog needs the LINES, which the list response does not carry.
  const { data: convertDetail } = useQuery<Quotation>({
    queryKey: ["quotation", converting?.id],
    queryFn: () => apiFetch(`/quotations/${converting!.id}`),
    enabled: !!converting,
  });

  const { data: conversionHistory = [] } = useQuery<
    { id: number; convertedOn: string; invoiceId: number; invoiceNumber: string | null; invoiceTotal: number | null }[]
  >({
    queryKey: ["quotation-conversions", converting?.id],
    queryFn: () => apiFetch(`/quotations/${converting!.id}/conversions`),
    enabled: !!converting,
  });

  const openConvert = (q: Quotation) => {
    setConverting(q);
    setConvertQty({});
    setConvertDate(new Date().toISOString().split("T")[0]);
  };

  const convertMut = useMutation({
    mutationFn: () => {
      const items = convertDetail?.items ?? [];
      // An empty/untouched form means "everything outstanding" — the server
      // treats a missing `lines` as exactly that, so we send nothing rather
      // than reconstructing the remainder here and risking a different answer.
      const touched = items.filter((i) => convertQty[i.id!] !== undefined && convertQty[i.id!] !== "");
      const body: Record<string, unknown> = { date: convertDate };
      if (touched.length > 0) {
        body.lines = touched
          .map((i) => ({ quotationItemId: i.id, quantity: Number(convertQty[i.id!]) }))
          .filter((l) => l.quantity > 0);
      }
      return apiFetch(`/quotations/${converting!.id}/convert`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (res: { invoice: { invoiceNumber: string; status: string } }) => {
      setConverting(null);
      refresh();
      qc.invalidateQueries({ queryKey: ["invoices"] });
      toast({
        title: t("Draft invoice created", "تم إنشاء مسودة الفاتورة"),
        description: `${res.invoice.invoiceNumber} — ${t("awaiting approval", "بانتظار الاعتماد")}`,
      });
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
          <Dialog
            open={open}
            onOpenChange={(o) => {
              setOpen(o);
              // Leaving the dialog leaves EDIT mode, or the next "New" would
              // silently save over the record just edited.
              if (!o) {
                setEditing(null);
                setLines([emptyLine()]);
                setForm({ date: new Date().toISOString().split("T")[0], validUntil: "", customerId: "", notes: "" });
              }
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="w-4 h-4 me-1" />{t("New quotation", "عرض سعر جديد")}</Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader><DialogTitle>{editing ? t("Edit quotation", "تعديل عرض السعر") + ` — ${editing.number}` : t("New quotation", "عرض سعر جديد")}</DialogTitle></DialogHeader>
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Customer", "العميل")}</Label>
                    <Select value={form.customerId} onValueChange={(v) => setForm((p) => ({ ...p, customerId: v }))}>
                      <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder={t("Select…", "اختر…")} /></SelectTrigger>
                      <SelectContent>
                        {customers.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                      <PickerLimitNotice shown={customers.length} total={customersPage?.total ?? customers.length} /></SelectContent>
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
                    <Plus className="w-3.5 h-3.5 me-1" />{t("Add line", "إضافة بند")}
                  </Button>
                </div>

                <div className="flex items-center justify-between border-t border-border pt-3">
                  <span className="text-sm text-muted-foreground">{t("Total (incl. VAT)", "الإجمالي شامل الضريبة")}</span>
                  <span className="font-mono text-lg">{fmtNum(previewTotal)}</span>
                </div>

                <Button
                  className="w-full"
                  onClick={() => (editing ? updateMut.mutate() : createMut.mutate())}
                  disabled={createMut.isPending || updateMut.isPending}
                >
                  {createMut.isPending || updateMut.isPending
                    ? t("Saving…", "جارٍ الحفظ…")
                    : editing
                      ? t("Save changes", "حفظ التعديلات")
                      : t("Create quotation", "إنشاء عرض السعر")}
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
                  <tr className="text-start text-xs text-muted-foreground border-b border-border">
                    <th className="pb-2 pe-4">{t("Number", "الرقم")}</th>
                    <th className="pb-2 pe-4">{t("Customer", "العميل")}</th>
                    <th className="pb-2 pe-4">{t("Date", "التاريخ")}</th>
                    <th className="pb-2 pe-4">{t("Valid until", "صالح حتى")}</th>
                    <th className="pb-2 pe-4 text-end">{t("Total", "الإجمالي")}</th>
                    <th className="pb-2 pe-4">{t("Status", "الحالة")}</th>
                    <th className="pb-2 pe-4">{t("Progress", "التقدم")}</th>
                    <th className="pb-2 text-end">{t("Actions", "إجراءات")}</th>
                  </tr>
                </thead>
                <tbody>
                  {quotations.map((q) => (
                    <tr key={q.id} className="border-b border-border/50">
                      <td className="py-3 pe-4 font-mono text-xs text-primary">{q.quotationNumber}</td>
                      <td className="py-3 pe-4">{q.customerName ?? "—"}</td>
                      <td className="py-3 pe-4 text-muted-foreground text-xs"><DualDate date={q.date} /></td>
                      <td className="py-3 pe-4 text-muted-foreground text-xs">
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
                      <td className="py-3 pe-4 text-end font-mono">{fmtNum(q.total)}</td>
                      <td className="py-3 pe-4">
                        <Badge className={`text-xs gap-1 ${STATUS_STYLES[q.status] ?? ""}`}>
                          {STATUS_ICONS[q.status]}{q.status}
                        </Badge>
                        {q.outcome && (
                          <Badge className="text-xs ms-1 bg-secondary text-muted-foreground">{q.outcome}</Badge>
                        )}
                      </td>
                      <td className="py-3 pe-4 text-xs text-muted-foreground">
                        {t(...(CONVERSION_LABEL[q.conversionState] ?? ["—", "—"]))}
                      </td>
                      <td className="py-3 text-end space-x-1 whitespace-nowrap">
                        {/* AUD-4: editing, finally reachable. Offered while the
                            record can still change: a draft freely, and an
                            approved one for its untouched lines — the server's
                            freeze rules are the authority and refuse the rest. */}
                        {!q.outcome && q.conversionState !== "converted" && (
                          <Button size="sm" variant="ghost" onClick={() => openEdit(q)}>
                            {t("Edit", "تعديل")}
                          </Button>
                        )}
                        {q.status === "draft" && (
                          <Button size="sm" variant="outline" onClick={() => actionMut.mutate({ id: q.id, action: "submit" })}>
                            {t("Submit", "إرسال")}
                          </Button>
                        )}
                        {/* 🔴 NOT hidden by role. A control removed teaches nothing and leaves
                            the person wondering where it went; the server refuses with a
                            reason that names the next step ("this needs an accountant to
                            approve it"), which teaches the workflow. Reversing AUD-7's
                            first fix deliberately — hiding was the wrong half of D4. */}
                        {q.status === "submitted" && (
                          <>
                            <Button size="sm" onClick={() => actionMut.mutate({ id: q.id, action: "approve" })}>
                              {t("Approve", "اعتماد")}
                            </Button>
                            {/* AUD-6: the two ways a review can end in something
                                other than approval. Both existed on the API and
                                had no control anywhere in the product. */}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => { setSendBackNote(""); setSendBack({ id: q.id, number: q.quotationNumber }); }}
                            >
                              {t("Send back", "إعادة للتعديل")}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setReject({ id: q.id, number: q.quotationNumber })}
                            >
                              {t("Reject", "رفض")}
                            </Button>
                          </>
                        )}
                        {q.status === "approved" && !q.outcome && q.conversionState !== "converted" && (
                          <Button size="sm" onClick={() => openConvert(q)}>
                            <ArrowRightLeft className="w-3.5 h-3.5 me-1" />{t("Convert", "تحويل")}
                          </Button>
                        )}
                        {q.status === "approved" && !q.outcome && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => actionMut.mutate({ id: q.id, action: "decline" })}>
                              <XCircle className="w-3.5 h-3.5 me-1" />{t("Declined", "مرفوض")}
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
                  <ListPagination
            page={quotationsPage?.page}
            shown={quotations.length}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </CardContent>
      </Card>

      {/* ── Convert to invoice (M21.2) ─────────────────────────────────────── */}
      <Dialog open={!!converting} onOpenChange={(o) => !o && setConverting(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t("Convert to invoice", "التحويل إلى فاتورة")} — {converting?.quotationNumber}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              {t(
                "Quantities default to everything still outstanding. Reduce a quantity to invoice part of the line; the rest stays on the quotation. Prices are the ones you quoted.",
                "الكميات الافتراضية هي كل ما تبقى. قلّل الكمية لفوترة جزء من البند؛ ويبقى الباقي في عرض السعر. الأسعار هي التي عرضتها.",
              )}
            </p>

            {/*
              🔴 The irreversibility is stated BEFORE the act, not discovered
              after it (owner instruction, 2026-08-20). The conversion record
              is append-only by design, so there is no undo; a wrong quantity
              is corrected the way the ledger corrects things. Saying so here
              is what makes that design defensible rather than a trap.

              Neutral styling on purpose: this is a fact about what the button
              does, not a warning that something is wrong. The status palette
              is reserved for real states (CLAUDE.md §4).
            */}
            <div className="rounded-md border border-border bg-secondary/40 p-3 space-y-1">
              <p className="text-xs font-medium flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" />
                {t("A conversion cannot be reversed", "لا يمكن التراجع عن التحويل")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(
                  "This records permanently that the customer accepted these quantities. If you get it wrong, the correction is a credit note against the invoice — there is no undo.",
                  "يسجّل هذا بشكل دائم أن العميل قبل هذه الكميات. وإذا حدث خطأ، فالتصحيح يكون بإشعار دائن مقابل الفاتورة — ولا يوجد تراجع.",
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(
                  "The invoice is created as a DRAFT — nothing reaches the ledger until someone approves it.",
                  "تُنشأ الفاتورة كمسودة — ولا شيء يصل إلى الدفاتر حتى يعتمدها أحد.",
                )}
              </p>
            </div>

            {converting?.expired && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                {t(
                  "This quotation's validity date has passed. You can still convert it — that is your commercial decision.",
                  "انتهى تاريخ صلاحية هذا العرض. لا يزال بإمكانك تحويله — وهذا قرارك التجاري.",
                )}
              </p>
            )}

            <div className="space-y-2">
              {(convertDetail?.items ?? []).map((i) => {
                const remaining = i.remainingQuantity ?? 0;
                return (
                  <div key={i.id} className="grid grid-cols-12 gap-2 items-center text-sm">
                    <span className="col-span-5 truncate">{i.description}</span>
                    <span className="col-span-3 text-xs text-muted-foreground">
                      {t("Remaining", "المتبقي")}: <span className="font-mono">{remaining}</span>
                    </span>
                    <Input
                      className="col-span-2 h-8 text-sm font-mono"
                      type="number"
                      step="0.001"
                      min="0"
                      max={remaining}
                      disabled={remaining <= 0}
                      placeholder={String(remaining)}
                      value={convertQty[i.id!] ?? ""}
                      onChange={(e) => setConvertQty((p) => ({ ...p, [i.id!]: e.target.value }))}
                    />
                    <span className="col-span-2 text-end font-mono text-xs text-muted-foreground">
                      {fmtNum(i.unitPrice as number)}
                    </span>
                  </div>
                );
              })}
            </div>

            <div>
              <Label className="text-xs text-muted-foreground">{t("Invoice date", "تاريخ الفاتورة")}</Label>
              <Input type="date" value={convertDate} onChange={(e) => setConvertDate(e.target.value)} className="mt-1 h-8 text-sm w-48" />
            </div>

            {conversionHistory.length > 0 && (
              <div className="border-t border-border pt-3">
                <p className="text-xs text-muted-foreground mb-2">
                  {t("Already invoiced from this quotation", "سبق فوترته من هذا العرض")}
                </p>
                <ul className="space-y-1">
                  {conversionHistory.map((h) => (
                    <li key={h.id} className="flex items-center justify-between text-xs">
                      <span className="font-mono text-primary">{h.invoiceNumber ?? `#${h.invoiceId}`}</span>
                      <DualDate date={h.convertedOn} />
                      <span className="font-mono">{h.invoiceTotal != null ? fmtNum(h.invoiceTotal) : "—"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Button className="w-full" onClick={() => convertMut.mutate()} disabled={convertMut.isPending}>
              {convertMut.isPending
                ? t("Converting…", "جارٍ التحويل…")
                : t("Create draft invoice", "إنشاء مسودة فاتورة")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── AUD-6: send back for correction ─────────────────────────────── */}
      <Dialog open={!!sendBack} onOpenChange={(o) => !o && setSendBack(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t(`Send ${sendBack?.number ?? ""} back for correction?`, `إعادة ${sendBack?.number ?? ""} للتعديل؟`)}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>{t("It returns to the editor as a draft. Nothing is issued and nothing is lost.", "سيعود عرض السعر إلى المحرِّر بحالة مسودة قابلة للتعديل.")}</p>
            <div>
              <Label>{t("Reason (optional — the editor sees it)", "السبب (اختياري — يظهر للمحرِّر)")}</Label>
              <Input value={sendBackNote} onChange={(ev) => setSendBackNote(ev.target.value)} className="mt-1" />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setSendBack(null)}>
                {t("Cancel", "إلغاء")}
              </Button>
              <Button
                size="sm"
                disabled={actionMut.isPending}
                onClick={() => {
                  if (sendBack) actionMut.mutate({ id: sendBack.id, action: "send-back", note: sendBackNote });
                  setSendBack(null);
                }}
              >
                {t("Send back", "إعادة للتعديل")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── AUD-6: reject. 🔴 A HARD DELETE — the act is named before it runs,
          per the destructive-scope rule: no archive, no undo (approval spec §4). */}
      <Dialog open={!!reject} onOpenChange={(o) => !o && setReject(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t(`Reject ${reject?.number ?? ""}?`, `رفض ${reject?.number ?? ""}؟`)}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="font-medium">
              {t(
                "Rejecting DELETES the record permanently — there is no archive and no undo. To return it for correction instead, use Send back.",
                "الرفض يحذف السجل نهائيًا — لا توجد نسخة محفوظة ولا تراجع. لإعادته للتعديل بدلًا من ذلك، استخدم \"إعادة للتعديل\"."
              )}
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setReject(null)}>
                {t("Cancel", "إلغاء")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={actionMut.isPending}
                onClick={() => {
                  if (reject) actionMut.mutate({ id: reject.id, action: "reject" });
                  setReject(null);
                }}
              >
                {t("Reject and delete", "رفض وحذف")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
