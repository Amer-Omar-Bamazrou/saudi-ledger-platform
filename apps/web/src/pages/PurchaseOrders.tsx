/**
 * Purchase orders (M21.3).
 *
 * 🔴 This page REPLACES the last of the six façades the 2026-08-20 audit
 * found. Every control calls a real endpoint.
 *
 * 🔴 EVERY WORD ABOUT PROGRESS IS BILLING, NOT DELIVERY. The platform has no
 * goods-receipt concept, so a PO↔bill match is TWO-way and we cannot tell "the
 * supplier shipped half" from "the supplier billed half". The owner's
 * instruction was explicit that pretending otherwise would be a confident
 * wrong answer — so this page says "partially billed" and "un-billed", never
 * "received", "delivered" or "outstanding". A reviewer should scan for any
 * word implying we know what arrived; there must not be one.
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

interface PriceVariance {
  orderedUnitPrice: number;
  billedUnitPrice: number;
  quantity: number;
  billedOn: string;
  difference: number;
}

interface PoItem {
  id: number;
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate: number;
  billedQuantity?: number;
  unbilledQuantity?: number;
  priceVariances?: PriceVariance[];
}

interface PurchaseOrder {
  id: number;
  orderNumber: string;
  date: string;
  validUntil: string | null;
  vendorId: number | null;
  vendorName: string | null;
  status: string;
  outcome: string | null;
  billingState: "open" | "partially_billed" | "fully_billed";
  expired: boolean;
  subtotal: number;
  vatAmount: number;
  total: number;
  currency: string;
  reviewNote: string | null;
  items?: PoItem[];
}

interface Vendor { id: number; name: string }

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

const emptyLine = (): Partial<PoItem> => ({ description: "", quantity: 1, unitPrice: undefined, vatRate: 15 });

export default function PurchaseOrders() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  /**
   * 🔴 AUD-4 — editing, which the product could not do at all.
   *
   * `PATCH /purchase-orders/:id` existed, was tested, and had NO caller anywhere in
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
  const [form, setForm] = useState({ date: new Date().toISOString().split("T")[0], validUntil: "", vendorId: "", notes: "" });
  const [lines, setLines] = useState<Partial<PoItem>[]>([emptyLine()]);

  const [page, setPage] = useState(0);
  const { data: ordersPage, isLoading } = useQuery<Paged<PurchaseOrder>>({
    queryKey: ["purchase-orders", statusFilter, page],
    queryFn: () =>
      apiFetch(
        `/purchase-orders?${statusFilter !== "all" ? `status=${statusFilter}&` : ""}` +
          `limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      ),
  });
  const orders = ordersPage?.items ?? [];
  const { data: vendorsPage } = useQuery<{ items: Vendor[]; total: number }>({ queryKey: ["vendors", "picker"], queryFn: () => fetchPickerOptions<Vendor>("/vendors") });
  const vendors = vendorsPage?.items ?? [];

  const refresh = () => qc.invalidateQueries({ queryKey: ["purchase-orders"] });
  const fail = (e: unknown) =>
    toast({ title: t("Failed", "فشل"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });

  const createMut = useMutation({
    mutationFn: () =>
      apiFetch("/purchase-orders", {
        method: "POST",
        body: JSON.stringify({
          date: form.date,
          validUntil: form.validUntil || undefined,
          vendorId: form.vendorId ? Number(form.vendorId) : undefined,
          notes: form.notes || undefined,
          items: lines.map((l) => ({
            description: l.description,
            quantity: Number(l.quantity),
            unitPrice: Number(l.unitPrice),
            vatRate: Number(l.vatRate),
          })),
        }),
      }),
    onSuccess: (po: PurchaseOrder) => {
      setOpen(false);
      setLines([emptyLine()]);
      setForm({ date: new Date().toISOString().split("T")[0], validUntil: "", vendorId: "", notes: "" });
      refresh();
      toast({ title: t("Purchase order created", "تم إنشاء أمر الشراء"), description: po.orderNumber });
    },
    onError: fail,
  });

  /**
   * 🔴 AUD-6 — the half of the workflow that had no surface.
   *
   * `send-back` and `reject` existed on the API, were covered by the approval
   * engine's tests, and NOTHING in the product could call them: a submitted
   * purchase order could only ever go forward. P4
   * (`state-machine-reachability.test.ts`) is the guard that now reports it,
   * and these two controls are what turn it green.
   */
  const [sendBack, setSendBack] = useState<{ id: number; number: string } | null>(null);
  const [sendBackNote, setSendBackNote] = useState("");
  const [reject, setReject] = useState<{ id: number; number: string } | null>(null);

  const updateMut = useMutation({
    mutationFn: () =>
      apiFetch(`/purchase-orders/${editing!.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          date: form.date,
          validUntil: form.validUntil || undefined,
          vendorId: form.vendorId ? Number(form.vendorId) : undefined,
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
  const openEdit = async (row: { id: number; orderNumber: string }) => {
    try {
      const detail: any = await apiFetch(`/purchase-orders/${row.id}`);
      setForm({
        date: detail.date ?? "",
        validUntil: detail.validUntil ?? "",
        vendorId: String(detail.vendorId ?? ""),
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
      setEditing({ id: row.id, number: row.orderNumber });
      setOpen(true);
    } catch (e) {
      fail(e);
    }
  };

  const actionMut = useMutation({
    mutationFn: ({ id, action, note }: { id: number; action: string; note?: string }) =>
      apiFetch(`/purchase-orders/${id}/${action}`, {
        method: "POST",
        body: JSON.stringify(note != null ? { note } : {}),
      }),
    onSuccess: () => refresh(),
    onError: fail,
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/purchase-orders/${id}`, { method: "DELETE" }),
    onSuccess: () => { refresh(); toast({ title: t("Purchase order deleted", "تم حذف أمر الشراء") }); },
    onError: fail,
  });

  // ── Recording the supplier's bill ────────────────────────────────────────
  const [billing, setBilling] = useState<PurchaseOrder | null>(null);
  const [billQty, setBillQty] = useState<Record<number, string>>({});
  const [billPrice, setBillPrice] = useState<Record<number, string>>({});
  const [billDate, setBillDate] = useState(new Date().toISOString().split("T")[0]);
  const [vendorRef, setVendorRef] = useState("");
  const [allowOver, setAllowOver] = useState(false);

  const { data: billDetail } = useQuery<PurchaseOrder>({
    queryKey: ["purchase-order", billing?.id],
    queryFn: () => apiFetch(`/purchase-orders/${billing!.id}`),
    enabled: !!billing,
  });

  const { data: billHistory = [] } = useQuery<
    { id: number; billedOn: string; billId: number; billNumber: string | null; billTotal: number | null }[]
  >({
    queryKey: ["purchase-order-conversions", billing?.id],
    queryFn: () => apiFetch(`/purchase-orders/${billing!.id}/conversions`),
    enabled: !!billing,
  });

  const openBilling = (po: PurchaseOrder) => {
    setBilling(po);
    setBillQty({});
    setBillPrice({});
    setVendorRef("");
    setAllowOver(false);
    setBillDate(new Date().toISOString().split("T")[0]);
  };

  const convertMut = useMutation({
    mutationFn: () => {
      const items = billDetail?.items ?? [];
      const touched = items.filter((i) => (billQty[i.id] ?? "") !== "" || (billPrice[i.id] ?? "") !== "");
      const body: Record<string, unknown> = { date: billDate, allowOverBilling: allowOver };
      if (vendorRef.trim()) body.vendorReference = vendorRef.trim();
      if (touched.length > 0) {
        body.lines = touched
          .map((i) => ({
            purchaseOrderItemId: i.id,
            quantity: Number(billQty[i.id] ?? i.unbilledQuantity ?? 0),
            ...(billPrice[i.id] ? { unitPrice: Number(billPrice[i.id]) } : {}),
          }))
          .filter((l) => l.quantity > 0);
      }
      return apiFetch(`/purchase-orders/${billing!.id}/convert`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (res: { bill: { billNumber: string } }) => {
      setBilling(null);
      refresh();
      qc.invalidateQueries({ queryKey: ["bills"] });
      toast({
        title: t("Draft bill created", "تم إنشاء مسودة الفاتورة"),
        description: `${res.bill.billNumber} — ${t("awaiting approval", "بانتظار الاعتماد")}`,
      });
    },
    onError: fail,
  });

  const setLine = (i: number, patch: Partial<PoItem>) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const previewTotal = lines.reduce((sum, l) => {
    const base = round2(Number(l.quantity || 0) * Number(l.unitPrice || 0));
    return round2(sum + base + round2(base * (Number(l.vatRate || 0) / 100)));
  }, 0);

  // 🔴 Billing words only. No "received", no "delivered".
  const BILLING_LABEL: Record<string, [string, string]> = {
    open: ["Not billed", "لم تُفوتر"],
    partially_billed: ["Partly billed", "مفوترة جزئيًا"],
    fully_billed: ["Fully billed", "مفوترة بالكامل"],
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">{t("Purchase Orders", "أوامر الشراء")}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t(
              "An intention to buy. A purchase order affects no report and no ledger until the supplier's bill arrives.",
              "نية للشراء. لا يؤثر أمر الشراء على أي تقرير أو دفتر حتى تصل فاتورة المورد.",
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
                setForm({ date: new Date().toISOString().split("T")[0], validUntil: "", vendorId: "", notes: "" });
              }
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="w-4 h-4 me-1" />{t("New order", "أمر جديد")}</Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader><DialogTitle>{editing ? t("Edit purchase order", "تعديل أمر الشراء") + ` — ${editing.number}` : t("New purchase order", "أمر شراء جديد")}</DialogTitle></DialogHeader>
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Supplier", "المورد")}</Label>
                    <Select value={form.vendorId} onValueChange={(v) => setForm((p) => ({ ...p, vendorId: v }))}>
                      <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder={t("Select…", "اختر…")} /></SelectTrigger>
                      <SelectContent>
                        {vendors.map((v) => <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}
                      <PickerLimitNotice shown={vendors.length} total={vendorsPage?.total ?? vendors.length} /></SelectContent>
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
                      <Input className="col-span-5 h-8 text-sm" placeholder={t("Description", "الوصف")} value={l.description ?? ""} onChange={(e) => setLine(i, { description: e.target.value })} />
                      <Input className="col-span-2 h-8 text-sm font-mono" type="number" step="0.001" placeholder={t("Qty", "الكمية")} value={l.quantity ?? ""} onChange={(e) => setLine(i, { quantity: Number(e.target.value) })} />
                      <Input className="col-span-2 h-8 text-sm font-mono" type="number" step="0.01" placeholder={t("Price", "السعر")} value={l.unitPrice ?? ""} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) })} />
                      <Input className="col-span-2 h-8 text-sm font-mono" type="number" step="0.01" placeholder={t("VAT %", "ض.ق.م ٪")} value={l.vatRate ?? ""} onChange={(e) => setLine(i, { vatRate: Number(e.target.value) })} />
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
                      : t("Create purchase order", "إنشاء أمر الشراء")}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">{t("Purchase Orders", "أوامر الشراء")}</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-6 text-center">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : orders.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">{t("No purchase orders yet.", "لا توجد أوامر شراء بعد.")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-start text-xs text-muted-foreground border-b border-border">
                    <th className="pb-2 pe-4">{t("Number", "الرقم")}</th>
                    <th className="pb-2 pe-4">{t("Supplier", "المورد")}</th>
                    <th className="pb-2 pe-4">{t("Date", "التاريخ")}</th>
                    <th className="pb-2 pe-4 text-end">{t("Total", "الإجمالي")}</th>
                    <th className="pb-2 pe-4">{t("Status", "الحالة")}</th>
                    <th className="pb-2 pe-4">{t("Billing", "الفوترة")}</th>
                    <th className="pb-2 text-end">{t("Actions", "إجراءات")}</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((po) => (
                    <tr key={po.id} className="border-b border-border/50">
                      <td className="py-3 pe-4 font-mono text-xs text-primary">{po.orderNumber}</td>
                      <td className="py-3 pe-4">{po.vendorName ?? "—"}</td>
                      <td className="py-3 pe-4 text-muted-foreground text-xs">
                        <DualDate date={po.date} />
                        {po.expired && (
                          <span className="ms-1 inline-flex items-center gap-1 text-muted-foreground">
                            <AlertTriangle className="w-3 h-3" />{t("lapsed", "منتهٍ")}
                          </span>
                        )}
                      </td>
                      <td className="py-3 pe-4 text-end font-mono">{fmtNum(po.total)}</td>
                      <td className="py-3 pe-4">
                        <Badge className={`text-xs gap-1 ${STATUS_STYLES[po.status] ?? ""}`}>
                          {STATUS_ICONS[po.status]}{po.status}
                        </Badge>
                        {po.outcome && <Badge className="text-xs ms-1 bg-secondary text-muted-foreground">{po.outcome}</Badge>}
                      </td>
                      <td className="py-3 pe-4 text-xs text-muted-foreground">
                        {t(...(BILLING_LABEL[po.billingState] ?? ["—", "—"]))}
                      </td>
                      <td className="py-3 text-end space-x-1 whitespace-nowrap">
                        {/* AUD-4: editing, finally reachable. Offered while the
                            record can still change: a draft freely, and an
                            approved one for its untouched lines — the server's
                            freeze rules are the authority and refuse the rest. */}
                        {!po.outcome && po.billingState !== "fully_billed" && (
                          <Button size="sm" variant="ghost" onClick={() => openEdit(po)}>
                            {t("Edit", "تعديل")}
                          </Button>
                        )}
                        {po.status === "draft" && (
                          <Button size="sm" variant="outline" onClick={() => actionMut.mutate({ id: po.id, action: "submit" })}>
                            {t("Submit", "إرسال")}
                          </Button>
                        )}
                        {/* 🔴 NOT hidden by role. A control removed teaches nothing and leaves
                            the person wondering where it went; the server refuses with a
                            reason that names the next step ("this needs an accountant to
                            approve it"), which teaches the workflow. Reversing AUD-7's
                            first fix deliberately — hiding was the wrong half of D4. */}
                        {po.status === "submitted" && (
                          <>
                            <Button size="sm" onClick={() => actionMut.mutate({ id: po.id, action: "approve" })}>
                              {t("Approve", "اعتماد")}
                            </Button>
                            {/* AUD-6: the two ways a review can end in something
                                other than approval. Both existed on the API and
                                had no control anywhere in the product. */}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => { setSendBackNote(""); setSendBack({ id: po.id, number: po.orderNumber }); }}
                            >
                              {t("Send back", "إعادة للتعديل")}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setReject({ id: po.id, number: po.orderNumber })}
                            >
                              {t("Reject", "رفض")}
                            </Button>
                          </>
                        )}
                        {po.status === "approved" && !po.outcome && po.billingState !== "fully_billed" && (
                          <Button size="sm" onClick={() => openBilling(po)}>
                            <ArrowRightLeft className="w-3.5 h-3.5 me-1" />{t("Record bill", "تسجيل فاتورة")}
                          </Button>
                        )}
                        {po.status === "approved" && !po.outcome && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => actionMut.mutate({ id: po.id, action: "cancel" })}>
                              <XCircle className="w-3.5 h-3.5 me-1" />{t("Cancel", "إلغاء")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => actionMut.mutate({ id: po.id, action: "close" })}>
                              {t("Close", "إغلاق")}
                            </Button>
                          </>
                        )}
                        {po.outcome && (
                          <Button size="sm" variant="ghost" onClick={() => actionMut.mutate({ id: po.id, action: "reopen" })}>
                            {t("Reopen", "إعادة فتح")}
                          </Button>
                        )}
                        {po.status === "draft" && (
                          <Button size="sm" variant="ghost" onClick={() => deleteMut.mutate(po.id)}>
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
            page={ordersPage?.page}
            shown={orders.length}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </CardContent>
      </Card>

      {/* ── Record the supplier's bill ──────────────────────────────────────── */}
      <Dialog open={!!billing} onOpenChange={(o) => !o && setBilling(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("Record the supplier's bill", "تسجيل فاتورة المورد")} — {billing?.orderNumber}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              {t(
                "Enter what the supplier actually billed. Quantities default to everything not yet billed, and the price defaults to what you ordered — change it if the supplier charged something else.",
                "أدخل ما فوتره المورد فعليًا. الكميات الافتراضية هي كل ما لم يُفوتر بعد، والسعر الافتراضي هو ما طلبته — غيّره إذا كان المورد قد حاسب بمبلغ آخر.",
              )}
            </p>

            {/* 🔴 The two-way limitation, stated plainly on the screen. */}
            <div className="rounded-md border border-border bg-secondary/40 p-3 space-y-1">
              <p className="text-xs font-medium flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" />
                {t("This tracks BILLING, not delivery", "هذا يتتبع الفوترة، لا التسليم")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(
                  "The platform records what the supplier has billed against this order. It does not know what was delivered — a part-billed order may or may not have been part-delivered.",
                  "تسجّل المنصة ما فوتره المورد مقابل هذا الأمر. وهي لا تعرف ما تم تسليمه — فالأمر المفوتر جزئيًا قد يكون سُلّم جزئيًا أو لا.",
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(
                  "The bill is created as a DRAFT and cannot be un-recorded — nothing reaches the ledger until someone approves it.",
                  "تُنشأ الفاتورة كمسودة ولا يمكن التراجع عن تسجيلها — ولا شيء يصل إلى الدفاتر حتى يعتمدها أحد.",
                )}
              </p>
            </div>

            <div className="space-y-2">
              <div className="grid grid-cols-12 gap-2 text-xs text-muted-foreground">
                <span className="col-span-4">{t("Line", "البند")}</span>
                <span className="col-span-2">{t("Un-billed", "غير مفوتر")}</span>
                <span className="col-span-2">{t("Qty billed", "الكمية المفوترة")}</span>
                <span className="col-span-2">{t("Ordered", "المطلوب")}</span>
                <span className="col-span-2">{t("Billed price", "السعر المفوتر")}</span>
              </div>
              {(billDetail?.items ?? []).map((i) => (
                <div key={i.id} className="grid grid-cols-12 gap-2 items-center text-sm">
                  <span className="col-span-4 truncate">{i.description}</span>
                  <span className="col-span-2 font-mono text-xs text-muted-foreground">{i.unbilledQuantity ?? 0}</span>
                  <Input
                    className="col-span-2 h-8 text-sm font-mono"
                    type="number" step="0.001" min="0"
                    placeholder={String(i.unbilledQuantity ?? 0)}
                    value={billQty[i.id] ?? ""}
                    onChange={(e) => setBillQty((p) => ({ ...p, [i.id]: e.target.value }))}
                  />
                  <span className="col-span-2 font-mono text-xs text-muted-foreground">{fmtNum(i.unitPrice)}</span>
                  <Input
                    className="col-span-2 h-8 text-sm font-mono"
                    type="number" step="0.01" min="0"
                    placeholder={String(i.unitPrice)}
                    value={billPrice[i.id] ?? ""}
                    onChange={(e) => setBillPrice((p) => ({ ...p, [i.id]: e.target.value }))}
                  />
                </div>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">{t("Bill date", "تاريخ الفاتورة")}</Label>
                <Input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} className="mt-1 h-8 text-sm" />
              </div>
              <div className="col-span-2">
                <Label className="text-xs text-muted-foreground">{t("Supplier's bill number", "رقم فاتورة المورد")}</Label>
                <Input value={vendorRef} onChange={(e) => setVendorRef(e.target.value)} placeholder={t("optional", "اختياري")} className="mt-1 h-8 text-sm" />
              </div>
            </div>

            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input type="checkbox" className="mt-0.5" checked={allowOver} onChange={(e) => setAllowOver(e.target.checked)} />
              <span>
                {t(
                  "The supplier billed more than this order allows for — record it anyway. Use this when the supplier is right; otherwise check the bill against the order first.",
                  "فوتر المورد أكثر مما يسمح به هذا الأمر — سجّلها على أي حال. استخدم هذا عندما يكون المورد محقًا؛ وإلا فراجع الفاتورة مقابل الأمر أولًا.",
                )}
              </span>
            </label>

            {billHistory.length > 0 && (
              <div className="border-t border-border pt-3">
                <p className="text-xs text-muted-foreground mb-2">{t("Already billed against this order", "سبق فوترته مقابل هذا الأمر")}</p>
                <ul className="space-y-1">
                  {billHistory.map((h) => (
                    <li key={h.id} className="flex items-center justify-between text-xs">
                      <span className="font-mono text-primary">{h.billNumber ?? `#${h.billId}`}</span>
                      <DualDate date={h.billedOn} />
                      <span className="font-mono">{h.billTotal != null ? fmtNum(h.billTotal) : "—"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Button className="w-full" onClick={() => convertMut.mutate()} disabled={convertMut.isPending}>
              {convertMut.isPending ? t("Recording…", "جارٍ التسجيل…") : t("Create draft bill", "إنشاء مسودة فاتورة")}
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
            <p>{t("It returns to the editor as a draft. Nothing is issued and nothing is lost.", "سيعود أمر الشراء إلى المحرِّر بحالة مسودة قابلة للتعديل.")}</p>
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
