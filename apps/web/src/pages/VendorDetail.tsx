import { useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, FileInput, ShoppingCart, Banknote, AlertCircle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { residencyLabel, whtTypeLabel, WHT_TYPES } from "@/lib/taxLabels";
import { useUpdateVendor, type VendorInputFields } from "@workspace/api-client-react";
import { computeAging, toFetched, DETAIL_FETCH_LIMIT, type FetchedDocs } from "@/lib/partyDetail";
import type { Paged } from "@/lib/pagedList";

/**
 * One vendor, everything about them — the mirror of CustomerDetail.
 *
 * 🔴 THE STATEMENT BUTTON IS HERE NOW (B5, 2026-09-22). This comment used to
 * say there was deliberately no button, because no vendor ledger existed and
 * linking to nothing is the facade shape this codebase has removed twice. The
 * asymmetry is closed: `/supplier-statements/:vendorId` is real, it carries a
 * running balance per event, and it reports whether it agrees with the
 * position. An absence note outlives the absence unless somebody deletes it.
 */

import type { Bill, PurchaseOrder, VendorDetail as VendorDetailView } from "@workspace/api-client-react";



const money = (n: number) => fmtNum(n ?? 0);

function StatTile({ label, value, tone }: { label: string; value: string; tone?: "warn" | "good" }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs uppercase text-muted-foreground mb-1">{label}</p>
        <p className={`text-xl sm:text-2xl font-mono font-semibold ${tone === "warn" ? "text-attention" : tone === "good" ? "text-positive" : "text-foreground"}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function TruncationNotice({ shown, total }: { shown: number; total: number }) {
  const { t } = useLanguage();
  return (
    <div className="flex items-start gap-2 rounded-md border border-attention-surface/30 bg-attention-surface/10 p-3 text-xs text-amber-200">
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span>
        {t(
          `Showing ${shown} of ${total} documents. The aging and payment figures on this page cover only the documents shown.`,
          `يتم عرض ${shown} من ${total} مستند. تغطي أرقام الأعمار والمدفوعات في هذه الصفحة المستندات المعروضة فقط.`,
        )}
      </span>
    </div>
  );
}

/**
 * Phase 16 — the supplier's withholding-tax facts (pack §2.3): its residency,
 * its declared default payment nature, its registration number abroad
 * (Art. 68(B)(3)) and its country. Each is SET BY A PERSON here; nothing infers
 * one. Saved through the generated `updateVendor`; a blank optional field is
 * sent as null, never "".
 */
function WhtDetailsCard({ vendor }: { vendor: VendorDetailView }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ residency: "unknown" as NonNullable<VendorInputFields["residency"]>, whtDefaultPaymentType: "", foreignTaxId: "", country: "" });
  const orNull = (s: string) => (s.trim() === "" ? null : s);
  const save = useUpdateVendor({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["vendor", vendor.id] });
        qc.invalidateQueries({ queryKey: ["vendors"] });
        // generated-client keys: the vendor reads, and the WHT workspace (its exceptions follow residency)
        qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && ((q.queryKey[0] as string).startsWith("/api/vendors") || (q.queryKey[0] as string).startsWith("/api/tax")) });
        setOpen(false);
        toast({ title: t("Withholding-tax details saved", "تم حفظ بيانات ضريبة الاستقطاع") });
      },
    },
  });
  const startEdit = () => {
    setForm({ residency: vendor.residency, whtDefaultPaymentType: vendor.whtDefaultPaymentType ?? "", foreignTaxId: vendor.foreignTaxId ?? "", country: vendor.country ?? "" });
    setOpen(true);
  };
  return (
    <Card data-testid="vendor-wht-details">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{t("Withholding tax", "ضريبة الاستقطاع")}</CardTitle>
        <Button variant="outline" size="sm" onClick={startEdit} data-testid="vendor-wht-edit">{t("Edit", "تعديل")}</Button>
      </CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-2 text-sm">
        <p><span className="text-muted-foreground">{t("Residency", "الإقامة")}: </span><span data-testid="vendor-wht-residency">{residencyLabel(vendor.residency, t)}</span></p>
        <p><span className="text-muted-foreground">{t("Default payment nature", "الطبيعة الافتراضية للدفعة")}: </span><span data-testid="vendor-wht-default-value">{vendor.whtDefaultPaymentType ? whtTypeLabel(vendor.whtDefaultPaymentType, t) : t("None — declared on each payment", "لا شيء — تُصرَّح في كل دفعة")}</span></p>
        <p><span className="text-muted-foreground">{t("Registration number in its country", "رقم التسجيل في بلده")}: </span><span className="font-mono" dir="ltr" data-testid="vendor-foreign-tax-id-value">{vendor.foreignTaxId || "—"}</span></p>
        <p><span className="text-muted-foreground">{t("Country", "الدولة")}: </span><span dir="ltr" data-testid="vendor-country-value">{vendor.country || "—"}</span></p>
        {vendor.residency === "unknown" && (
          <p className="sm:col-span-2 text-xs text-muted-foreground">
            {t("Residency not declared: payments to this supplier withhold nothing and are listed as withholding-tax exceptions until it is declared.",
               "الإقامة غير مُصرَّح بها: لا يُستقطع شيء من المدفوعات لهذا المورد، وتُدرج ضمن استثناءات ضريبة الاستقطاع إلى أن يُصرَّح بها.")}
          </p>
        )}
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{t("Withholding-tax details", "بيانات ضريبة الاستقطاع")}</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2">
            <div>
              <Label className="text-xs text-muted-foreground">{t("Residency (for withholding tax)", "الإقامة (لأغراض ضريبة الاستقطاع)")}</Label>
              <Select value={form.residency} onValueChange={(v) => setForm((p) => ({ ...p, residency: v as typeof p.residency }))}>
                <SelectTrigger className="mt-1 h-8 text-sm" data-testid="vendor-residency-select"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unknown">{t("Not declared", "غير مُصرَّح")}</SelectItem>
                  <SelectItem value="resident">{t("Resident in Saudi Arabia", "مقيم في السعودية")}</SelectItem>
                  <SelectItem value="non_resident">{t("Non-resident", "غير مقيم")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">
                {t("A payment to a NON-RESIDENT supplier has tax withheld from it (Income Tax Law Art. 68). Declaring a supplier non-resident later lists its earlier payments with no withholding as \"possibly missed withholding\" on the Withholding tax page.",
                   "تُستقطع الضريبة من أي دفعة لمورد غير مقيم (نظام ضريبة الدخل المادة 68). والتصريح لاحقًا بأن المورد غير مقيم يُدرج مدفوعاته السابقة غير المستقطعة بوصفها «استقطاعًا ربما فات» في صفحة ضريبة الاستقطاع.")}
              </p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("Default nature of its payments (withholding tax)", "الطبيعة الافتراضية لمدفوعاته (ضريبة الاستقطاع)")}</Label>
              <Select value={form.whtDefaultPaymentType || "none"} onValueChange={(v) => setForm((p) => ({ ...p, whtDefaultPaymentType: v === "none" ? "" : v }))}>
                <SelectTrigger className="mt-1 h-8 text-sm" data-testid="vendor-wht-default"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" className="text-xs">{t("None — declared on each payment", "لا شيء — تُصرَّح في كل دفعة")}</SelectItem>
                  {WHT_TYPES.map((code) => <SelectItem key={code} value={code} className="text-xs">{whtTypeLabel(code, t)}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">
                {t("Used only for a non-resident supplier: preselected in the pay dialog and changeable on each payment. Without it, each payment states its nature — it is never assumed.",
                   "تُستخدم لمورد غير مقيم فقط: تُختار مسبقًا في نافذة الدفع ويمكن تغييرها في كل دفعة. ومن دونها تذكر كل دفعة طبيعتها — فلا تُفترض أبدًا.")}
              </p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("Registration number in its country", "رقم التسجيل في بلده")}</Label>
              <Input value={form.foreignTaxId} onChange={(e) => setForm((p) => ({ ...p, foreignTaxId: e.target.value }))} className="mt-1 h-8 text-sm font-mono" dir="ltr" data-testid="vendor-foreign-tax-id" />
              <p className="text-[11px] text-muted-foreground mt-1">
                {t("Reported on the annual withholding-tax return (Income Tax Law Art. 68(B)(3)).", "يُذكر في الإقرار السنوي لضريبة الاستقطاع (نظام ضريبة الدخل المادة 68(ب)(3)).")}
              </p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("Country", "الدولة")}</Label>
              <Input value={form.country} onChange={(e) => setForm((p) => ({ ...p, country: e.target.value }))} className="mt-1 h-8 text-sm" dir="ltr" data-testid="vendor-country" />
            </div>
          </div>
          <Button className="w-full mt-4" disabled={save.isPending} data-testid="vendor-wht-save"
            onClick={() => save.mutate({
              id: vendor.id,
              data: { residency: form.residency, whtDefaultPaymentType: orNull(form.whtDefaultPaymentType), foreignTaxId: orNull(form.foreignTaxId), country: orNull(form.country) },
            })}>
            {save.isPending ? t("Saving…", "جارٍ الحفظ…") : t("Save", "حفظ")}
          </Button>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function VendorDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { t } = useLanguage();

  const { data: vendor, isLoading, error } = useQuery<VendorDetailView>({
    queryKey: ["vendor", id],
    queryFn: () => apiFetch(`/vendors/${id}`),
    enabled: Number.isFinite(id),
  });

  const { data: billData } = useQuery<FetchedDocs<Bill>>({
    queryKey: ["vendor-bills", id],
    queryFn: async () =>
      toFetched(await apiFetch<Paged<Bill>>(`/bills?vendor_id=${id}&limit=${DETAIL_FETCH_LIMIT}`)),
    enabled: Number.isFinite(id),
  });

  const { data: poData } = useQuery<FetchedDocs<PurchaseOrder>>({
    queryKey: ["vendor-pos", id],
    queryFn: async () =>
      toFetched(await apiFetch<Paged<PurchaseOrder>>(`/purchase-orders?vendor_id=${id}&limit=${DETAIL_FETCH_LIMIT}`)),
    enabled: Number.isFinite(id),
  });

  if (isLoading) return <p className="text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (error || !vendor) {
    return (
      <div className="space-y-4">
        <Link href="/vendors"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4 me-2" />{t("Back to vendors", "العودة إلى الموردين")}</Button></Link>
        <p className="text-destructive">{t("Vendor not found.", "لم يتم العثور على المورد.")}</p>
      </div>
    );
  }

  const bills = billData?.items ?? [];
  const payments = bills.filter((b) => Number(b.paidAmount ?? 0) > 0);
  const aging = computeAging(bills);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/vendors">
          <Button variant="ghost" size="sm" className="mb-2 -ms-2">
            <ArrowLeft className="w-4 h-4 me-2" />{t("Back to vendors", "العودة إلى الموردين")}
          </Button>
        </Link>
        <h1 className="text-2xl font-semibold text-foreground">{vendor.name}</h1>
        {vendor.nameAr && <p className="text-muted-foreground" dir="rtl">{vendor.nameAr}</p>}
        <div className="flex gap-2 mt-2 flex-wrap">
          {!vendor.isActive && <Badge variant="destructive" className="text-xs">{t("Inactive", "غير نشط")}</Badge>}
          {vendor.taxNumber && <Badge variant="outline" className="text-xs font-mono">{t("VAT", "ض.ق.م")} {vendor.taxNumber}</Badge>}
          {vendor.crNumber && <Badge variant="outline" className="text-xs font-mono">{t("CR", "س.ت")} {vendor.crNumber}</Badge>}
          {vendor.paymentTermsDays && <Badge variant="outline" className="text-xs font-mono">{vendor.paymentTermsDays}d</Badge>}
          {/*
            B8: residency is shown only when somebody has SAID it. `unknown` is
            the default and is not a fact about the supplier, so a badge
            asserting "resident" by silence would be the wrong default in the
            direction that withholds nothing.
          */}
          {vendor.residency === "non_resident" && (
            <Badge variant="outline" className="text-xs" data-testid="vendor-residency">{t("Non-resident", "غير مقيم")}</Badge>
          )}
          {vendor.residency === "resident" && (
            <Badge variant="outline" className="text-xs" data-testid="vendor-residency">{t("Resident", "مقيم")}</Badge>
          )}
        </div>
        <div className="mt-3">
          <Link href={`/supplier-statements/${vendor.id}`}>
            <Button variant="outline" size="sm" data-testid="vendor-statement-link">
              <Banknote className="w-4 h-4 me-2" />{t("Statement", "كشف الحساب")}
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={t("Billed", "المفوتر")} value={money(vendor.totalBilled)} />
        <StatTile label={t("Paid", "المدفوع")} value={money(vendor.totalPaid)} tone="good" />
        <StatTile label={t("Outstanding", "المستحق")} value={money(vendor.balance)} tone={vendor.balance > 0 ? "warn" : "good"} />
        <StatTile label={t("Bills", "الفواتير")} value={String(vendor.billCount)} />
      </div>

      {(vendor.phone || vendor.email || vendor.address || vendor.city || vendor.iban) && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t("Contact", "بيانات الاتصال")}</CardTitle></CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2 text-sm">
            {vendor.phone && <p><span className="text-muted-foreground">{t("Phone", "الهاتف")}: </span>{vendor.phone}</p>}
            {vendor.email && <p><span className="text-muted-foreground">{t("Email", "البريد الإلكتروني")}: </span>{vendor.email}</p>}
            {vendor.address && <p><span className="text-muted-foreground">{t("Address", "العنوان")}: </span>{vendor.address}</p>}
            {vendor.city && <p><span className="text-muted-foreground">{t("City", "المدينة")}: </span>{vendor.city}</p>}
            {vendor.iban && <p className="font-mono text-xs"><span className="text-muted-foreground font-sans">{t("IBAN", "الآيبان")}: </span>{vendor.iban}</p>}
          </CardContent>
        </Card>
      )}

      <WhtDetailsCard vendor={vendor} />

      <Card>
        <CardHeader><CardTitle className="text-base">{t("Aging", "أعمار الذمم")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {billData?.truncated && <TruncationNotice shown={bills.length} total={billData.total} />}
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-5 text-sm">
            {[
              { l: t("Current", "جارٍ"), v: aging.current },
              { l: t("1–30 days", "١–٣٠ يوم"), v: aging.d1to30 },
              { l: t("31–60 days", "٣١–٦٠ يوم"), v: aging.d31to60 },
              { l: t("61–90 days", "٦١–٩٠ يوم"), v: aging.d61to90 },
              { l: t("90+ days", "أكثر من ٩٠ يوم"), v: aging.d90plus },
            ].map((b) => (
              <div key={b.l} className="rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground mb-1">{b.l}</p>
                <p className="font-mono font-medium">{money(b.v)}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><FileInput className="w-4 h-4" />{t("Bills", "فواتير الموردين")} ({bills.length})</CardTitle></CardHeader>
        <CardContent>
          {bills.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">{t("No bills yet.", "لا توجد فواتير بعد.")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    {[t("Number", "الرقم"), t("Reference", "المرجع"), t("Date", "التاريخ"), t("Due", "الاستحقاق"), t("Status", "الحالة"), t("Total", "الإجمالي"), t("Outstanding", "المستحق")].map((h) => (
                      <th key={h} className="text-start pb-2 pe-4 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bills.map((b) => {
                    // What the document still owes — the SERVER's figure (billPosition:
                    // net of advances, payments and credit notes applied through the
                    // AP subledger; 0 for a credit note). Never total − paid here.
                    const outstanding = Number(b.outstanding ?? 0);
                    return (
                      <tr key={b.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                        <td className="py-3 pe-4 font-mono text-xs">{b.billNumber}</td>
                        <td className="py-3 pe-4 font-mono text-xs text-muted-foreground">{b.vendorReference || "—"}</td>
                        <td className="py-3 pe-4 text-muted-foreground">{b.date}</td>
                        <td className="py-3 pe-4 text-muted-foreground">{b.dueDate || "—"}</td>
                        <td className="py-3 pe-4"><Badge variant="outline" className="text-xs">{b.status}</Badge></td>
                        <td className="py-3 pe-4 font-mono">{money(b.total)}</td>
                        <td className="py-3 pe-4 font-mono">
                          <span className={outstanding > 0 ? "text-attention" : "text-positive"}>{money(outstanding)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Banknote className="w-4 h-4" />{t("Payments", "المدفوعات")} ({payments.length})</CardTitle></CardHeader>
        <CardContent>
          {payments.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">{t("No payments recorded.", "لا توجد مدفوعات مسجلة.")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    {[t("Against", "مقابل"), t("Paid on", "تاريخ الدفع"), t("Amount", "المبلغ")].map((h) => (
                      <th key={h} className="text-start pb-2 pe-4 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} className="border-b border-border/50">
                      <td className="py-3 pe-4 font-mono text-xs">{p.billNumber}</td>
                      <td className="py-3 pe-4 text-muted-foreground">{p.paidAt ? p.paidAt.slice(0, 10) : "—"}</td>
                      <td className="py-3 pe-4 font-mono text-positive">{money(Number(p.paidAmount ?? 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><ShoppingCart className="w-4 h-4" />{t("Purchase Orders", "أوامر الشراء")} ({poData?.items.length ?? 0})</CardTitle></CardHeader>
        <CardContent>
          {(poData?.items.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground py-4">{t("No purchase orders.", "لا توجد أوامر شراء.")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    {[t("Number", "الرقم"), t("Date", "التاريخ"), t("Status", "الحالة"), t("Total", "الإجمالي")].map((h) => (
                      <th key={h} className="text-start pb-2 pe-4 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {poData!.items.map((p) => (
                    <tr key={p.id} className="border-b border-border/50">
                      <td className="py-3 pe-4 font-mono text-xs">{p.orderNumber}</td>
                      <td className="py-3 pe-4 text-muted-foreground">{p.date}</td>
                      <td className="py-3 pe-4"><Badge variant="outline" className="text-xs">{p.status}</Badge></td>
                      <td className="py-3 pe-4 font-mono">{money(p.total)}</td>
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
