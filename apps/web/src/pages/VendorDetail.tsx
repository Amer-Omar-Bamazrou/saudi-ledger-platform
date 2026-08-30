import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, FileInput, ShoppingCart, Banknote, AlertCircle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { computeAging, toFetched, DETAIL_FETCH_LIMIT, type FetchedDocs } from "@/lib/partyDetail";
import type { Paged } from "@/lib/pagedList";

/**
 * One vendor, everything about them — the mirror of CustomerDetail.
 *
 * 🔴 NO STATEMENT BUTTON, deliberately. `/reports/customer-ledger` exists;
 * there is no vendor ledger endpoint. Linking one anyway is precisely the
 * facade shape this codebase has removed twice — a control that looks like a
 * capability and reaches nothing. When a vendor ledger is built, the button
 * belongs here.
 */

interface VendorDetail {
  id: number; name: string; nameAr: string | null; taxNumber: string | null; crNumber: string | null;
  phone: string | null; email: string | null; address: string | null; city: string | null;
  iban: string | null; paymentTermsDays: string | null; isActive: boolean;
  totalBilled: number; totalPaid: number; balance: number; billCount: number;
}

interface BillRow {
  id: number; billNumber: string; vendorReference: string | null; date: string; dueDate: string | null;
  status: string; total: number; paidAmount: number | null; paidAt: string | null;
}

interface PoRow {
  id: number; orderNumber: string; date: string; status: string; total: number; billingState: string | null;
}

const money = (n: number) => fmtNum(n ?? 0);

function StatTile({ label, value, tone }: { label: string; value: string; tone?: "warn" | "good" }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs uppercase text-muted-foreground mb-1">{label}</p>
        <p className={`text-2xl font-mono font-semibold ${tone === "warn" ? "text-amber-400" : tone === "good" ? "text-emerald-400" : "text-foreground"}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function TruncationNotice({ shown, total }: { shown: number; total: number }) {
  const { t } = useLanguage();
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
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
  const { t } = useLanguage();

  const { data: vendor, isLoading, error } = useQuery<VendorDetail>({
    queryKey: ["vendor", id],
    queryFn: () => apiFetch(`/vendors/${id}`),
    enabled: Number.isFinite(id),
  });

  const { data: billData } = useQuery<FetchedDocs<BillRow>>({
    queryKey: ["vendor-bills", id],
    queryFn: async () =>
      toFetched(await apiFetch<Paged<BillRow>>(`/bills?vendor_id=${id}&limit=${DETAIL_FETCH_LIMIT}`)),
    enabled: Number.isFinite(id),
  });

  const { data: poData } = useQuery<FetchedDocs<PoRow>>({
    queryKey: ["vendor-pos", id],
    queryFn: async () =>
      toFetched(await apiFetch<Paged<PoRow>>(`/purchase-orders?vendor_id=${id}&limit=${DETAIL_FETCH_LIMIT}`)),
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
                    const outstanding = Number(b.total ?? 0) - Number(b.paidAmount ?? 0);
                    return (
                      <tr key={b.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                        <td className="py-3 pe-4 font-mono text-xs">{b.billNumber}</td>
                        <td className="py-3 pe-4 font-mono text-xs text-muted-foreground">{b.vendorReference || "—"}</td>
                        <td className="py-3 pe-4 text-muted-foreground">{b.date}</td>
                        <td className="py-3 pe-4 text-muted-foreground">{b.dueDate || "—"}</td>
                        <td className="py-3 pe-4"><Badge variant="outline" className="text-xs">{b.status}</Badge></td>
                        <td className="py-3 pe-4 font-mono">{money(b.total)}</td>
                        <td className="py-3 pe-4 font-mono">
                          <span className={outstanding > 0 ? "text-amber-400" : "text-emerald-400"}>{money(outstanding)}</span>
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
                      <td className="py-3 pe-4 font-mono text-emerald-400">{money(Number(p.paidAmount ?? 0))}</td>
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
