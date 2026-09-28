import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel, EmptyState, Field } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileInput, ShoppingCart, Banknote, AlertCircle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { statusLabel } from "@/lib/statusLabel";
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

const numTh = (num: boolean) => `${num ? "text-end" : "text-start"} px-3`;
const ROW = "border-b border-border/70 hover:bg-muted/40 transition-colors";

function TruncationNotice({ shown, total }: { shown: number; total: number }) {
  const { t } = useLanguage();
  return (
    <div className="flex items-start gap-2 rounded-md border border-attention-surface/30 bg-attention-surface/10 p-3 text-xs text-attention">
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

export default function VendorDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { t, lang } = useLanguage();

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
        <Link href="/vendors" className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"><span aria-hidden className="rtl:-scale-x-100 inline-block">←</span>{t("Back to vendors", "العودة إلى الموردين")}</Link>
        <p className="text-destructive">{t("Vendor not found.", "لم يتم العثور على المورد.")}</p>
      </div>
    );
  }

  const bills = billData?.items ?? [];
  const payments = bills.filter((b) => Number(b.paidAmount ?? 0) > 0);
  const aging = computeAging(bills);

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/vendors", label: t("Back to vendors", "العودة إلى الموردين") }}
        title={vendor.name}
        description={vendor.nameAr ? <span dir="rtl">{vendor.nameAr}</span> : undefined}
        actions={
          <Link href={`/supplier-statements/${vendor.id}`}>
            <Button variant="outline" size="sm" data-testid="vendor-statement-link">
              <Banknote className="w-4 h-4 me-2" />{t("Statement", "كشف الحساب")}
            </Button>
          </Link>
        }
      >
        <div className="flex gap-2 mt-3 flex-wrap">
          {!vendor.isActive && <Badge variant="destructive" className="text-xs">{t("Inactive", "غير نشط")}</Badge>}
          {vendor.taxNumber && <Badge variant="outline" className="text-xs tabular-nums">{t("VAT", "ض.ق.م")} {vendor.taxNumber}</Badge>}
          {vendor.crNumber && <Badge variant="outline" className="text-xs tabular-nums">{t("CR", "س.ت")} {vendor.crNumber}</Badge>}
          {vendor.paymentTermsDays && <Badge variant="outline" className="text-xs tabular-nums">{vendor.paymentTermsDays}d</Badge>}
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
      </PageHeader>

      <StatStrip cols={4}>
        <Stat label={t("Billed", "المفوتر")} value={money(vendor.totalBilled)} />
        <Stat label={t("Paid", "المدفوع")} value={money(vendor.totalPaid)} tone="positive" />
        <Stat label={t("Outstanding", "المستحق")} value={money(vendor.balance)} tone={vendor.balance > 0 ? "attention" : "positive"} />
        <Stat label={t("Bills", "الفواتير")} value={String(vendor.billCount)} />
      </StatStrip>

      {(vendor.phone || vendor.email || vendor.address || vendor.city || vendor.iban) && (
        <Panel title={t("Contact", "بيانات الاتصال")}>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {vendor.phone && <Field label={t("Phone", "الهاتف")}><span dir="ltr">{vendor.phone}</span></Field>}
            {vendor.email && <Field label={t("Email", "البريد الإلكتروني")}>{vendor.email}</Field>}
            {vendor.address && <Field label={t("Address", "العنوان")}>{vendor.address}</Field>}
            {vendor.city && <Field label={t("City", "المدينة")}>{vendor.city}</Field>}
            {vendor.iban && <Field label={t("IBAN", "الآيبان")}><span className="tabular-nums break-all" dir="ltr">{vendor.iban}</span></Field>}
          </dl>
        </Panel>
      )}

      <Panel title={t("Aging", "أعمار الذمم")} bodyClassName="space-y-3">
        {billData?.truncated && <TruncationNotice shown={bills.length} total={billData.total} />}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-px overflow-hidden rounded-md border border-border bg-border text-sm">
          {[
            { l: t("Current", "جارٍ"), v: aging.current },
            { l: t("1–30 days", "١–٣٠ يوم"), v: aging.d1to30 },
            { l: t("31–60 days", "٣١–٦٠ يوم"), v: aging.d31to60 },
            { l: t("61–90 days", "٦١–٩٠ يوم"), v: aging.d61to90 },
            { l: t("90+ days", "أكثر من ٩٠ يوم"), v: aging.d90plus },
          ].map((b) => (
            <div key={b.l} className="bg-card px-4 py-3">
              <p className="text-[12px] text-muted-foreground mb-1">{b.l}</p>
              <p className="font-medium tabular-nums">{money(b.v)}</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel flush title={<span className="flex items-center gap-2"><FileInput className="w-4 h-4 text-muted-foreground" />{t("Bills", "فواتير الموردين")} ({bills.length})</span>}>
        {bills.length === 0 ? (
          <EmptyState icon={FileInput} title={t("No bills yet.", "لا توجد فواتير بعد.")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {([[t("Number", "الرقم"), false], [t("Reference", "المرجع"), false], [t("Date", "التاريخ"), false], [t("Due", "الاستحقاق"), false], [t("Status", "الحالة"), false], [t("Total", "الإجمالي"), true], [t("Outstanding", "المستحق"), true]] as const).map(([h, num]) => (
                    <th key={h} className={numTh(num)}>{h}</th>
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
                    <tr key={b.id} className={ROW}>
                      <td className="py-3 px-3 font-medium text-primary whitespace-nowrap">{b.billNumber}</td>
                      <td className="py-3 px-3 text-muted-foreground whitespace-nowrap">{b.vendorReference || "—"}</td>
                      <td className="py-3 px-3 text-muted-foreground whitespace-nowrap">{b.date}</td>
                      <td className="py-3 px-3 text-muted-foreground whitespace-nowrap">{b.dueDate || "—"}</td>
                      <td className="py-3 px-3"><Badge variant="outline" className="text-xs capitalize">{statusLabel(b.status, lang)}</Badge></td>
                      <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{money(b.total)}</td>
                      <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">
                        <span className={outstanding > 0 ? "text-attention" : "text-positive"}>{money(outstanding)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel flush title={<span className="flex items-center gap-2"><Banknote className="w-4 h-4 text-muted-foreground" />{t("Payments", "المدفوعات")} ({payments.length})</span>}>
        {payments.length === 0 ? (
          <EmptyState icon={Banknote} title={t("No payments recorded.", "لا توجد مدفوعات مسجلة.")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {([[t("Against", "مقابل"), false], [t("Paid on", "تاريخ الدفع"), false], [t("Amount", "المبلغ"), true]] as const).map(([h, num]) => (
                    <th key={h} className={numTh(num)}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className={ROW}>
                    <td className="py-3 px-3 font-medium text-primary whitespace-nowrap">{p.billNumber}</td>
                    <td className="py-3 px-3 text-muted-foreground whitespace-nowrap">{p.paidAt ? p.paidAt.slice(0, 10) : "—"}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-positive">{money(Number(p.paidAmount ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel flush title={<span className="flex items-center gap-2"><ShoppingCart className="w-4 h-4 text-muted-foreground" />{t("Purchase Orders", "أوامر الشراء")} ({poData?.items.length ?? 0})</span>}>
        {(poData?.items.length ?? 0) === 0 ? (
          <EmptyState icon={ShoppingCart} title={t("No purchase orders.", "لا توجد أوامر شراء.")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {([[t("Number", "الرقم"), false], [t("Date", "التاريخ"), false], [t("Status", "الحالة"), false], [t("Total", "الإجمالي"), true]] as const).map(([h, num]) => (
                    <th key={h} className={numTh(num)}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {poData!.items.map((p) => (
                  <tr key={p.id} className={ROW}>
                    <td className="py-3 px-3 font-medium text-primary whitespace-nowrap">{p.orderNumber}</td>
                    <td className="py-3 px-3 text-muted-foreground whitespace-nowrap">{p.date}</td>
                    <td className="py-3 px-3"><Badge variant="outline" className="text-xs capitalize">{statusLabel(p.status, lang)}</Badge></td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{money(p.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
