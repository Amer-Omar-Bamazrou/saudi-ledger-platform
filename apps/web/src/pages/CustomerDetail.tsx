import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, FileText, FileMinus, ClipboardList, Banknote, AlertCircle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { computeAging, toFetched, DETAIL_FETCH_LIMIT, type FetchedDocs } from "@/lib/partyDetail";
import type { Paged } from "@/lib/pagedList";

/**
 * One customer, everything about them.
 *
 * The question "show me this customer" was previously answered by four pages
 * and manual filtering, which is the same complaint as a document not being
 * reachable from its serial number — pointed at the PARTY rather than the
 * document.
 *
 * 🔴 Every figure here is either returned by the server over the whole set
 * (`GET /customers/:id` computes the balance in SQL) or computed over a fetched
 * page that states when it was cut. Nothing is silently page-scoped.
 */

interface CustomerDetail {
  id: number; name: string; nameAr: string | null; taxNumber: string | null; crNumber: string | null;
  phone: string | null; email: string | null; address: string | null; city: string | null;
  paymentTermsDays: string | null; creditLimit: number | null; isActive: boolean;
  totalBilled: number; totalPaid: number; balance: number; invoiceCount: number;
}

interface InvoiceRow {
  id: number; invoiceNumber: string; date: string; dueDate: string | null; status: string;
  total: number; paidAmount: number | null; paidAt: string | null; documentType: string | null;
  noteReason: string | null;
}

interface QuotationRow {
  id: number; quotationNumber: string; date: string; status: string; total: number;
}

const money = (n: number) => fmtNum(n ?? 0);

function StatTile({ label, value, tone }: { label: string; value: string; tone?: "warn" | "good" }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs uppercase text-muted-foreground mb-1">{label}</p>
        <p className={`text-2xl font-mono font-semibold ${tone === "warn" ? "text-attention" : tone === "good" ? "text-positive" : "text-foreground"}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

/** A stated cap, not a silent one — see partyDetail.ts. */
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

function DocTable({ rows, kind }: { rows: InvoiceRow[]; kind: "invoice" | "credit" }) {
  const { t } = useLanguage();
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">{t("Nothing here yet.", "لا يوجد شيء هنا بعد.")}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground text-xs uppercase">
            {[
              t("Number", "الرقم"),
              t("Date", "التاريخ"),
              t("Due", "الاستحقاق"),
              t("Status", "الحالة"),
              t("Total", "الإجمالي"),
              kind === "invoice" ? t("Outstanding", "المستحق") : t("Reason", "السبب"),
            ].map((h) => (
              <th key={h} className="text-start pb-2 pe-4 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const outstanding = Number(r.total ?? 0) - Number(r.paidAmount ?? 0);
            return (
              <tr key={r.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                <td className="py-3 pe-4 font-mono text-xs">{r.invoiceNumber}</td>
                <td className="py-3 pe-4 text-muted-foreground">{r.date}</td>
                <td className="py-3 pe-4 text-muted-foreground">{r.dueDate || "—"}</td>
                <td className="py-3 pe-4"><Badge variant="outline" className="text-xs">{r.status}</Badge></td>
                <td className="py-3 pe-4 font-mono">{money(r.total)}</td>
                <td className="py-3 pe-4 font-mono">
                  {kind === "invoice"
                    ? <span className={outstanding > 0 ? "text-attention" : "text-positive"}>{money(outstanding)}</span>
                    : <span className="text-muted-foreground font-sans text-xs">{r.noteReason || "—"}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function CustomerDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { t } = useLanguage();

  const { data: customer, isLoading, error } = useQuery<CustomerDetail>({
    queryKey: ["customer", id],
    queryFn: () => apiFetch(`/customers/${id}`),
    enabled: Number.isFinite(id),
  });

  const { data: invoiceData } = useQuery<FetchedDocs<InvoiceRow>>({
    queryKey: ["customer-invoices", id],
    queryFn: async () =>
      toFetched(await apiFetch<Paged<InvoiceRow>>(`/invoices?customer_id=${id}&limit=${DETAIL_FETCH_LIMIT}`)),
    enabled: Number.isFinite(id),
  });

  const { data: quotationData } = useQuery<FetchedDocs<QuotationRow>>({
    queryKey: ["customer-quotations", id],
    queryFn: async () =>
      toFetched(await apiFetch<Paged<QuotationRow>>(`/quotations?customer_id=${id}&limit=${DETAIL_FETCH_LIMIT}`)),
    enabled: Number.isFinite(id),
  });

  if (isLoading) return <p className="text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (error || !customer) {
    return (
      <div className="space-y-4">
        <Link href="/customers"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4 me-2" />{t("Back to customers", "العودة إلى العملاء")}</Button></Link>
        <p className="text-destructive">{t("Customer not found.", "لم يتم العثور على العميل.")}</p>
      </div>
    );
  }

  const all = invoiceData?.items ?? [];
  // Credit notes reduce the balance and are NOT receivables — they are listed
  // separately and excluded from aging, which sums what is still owed.
  const invoices = all.filter((d) => d.documentType !== "credit_note");
  const creditNotes = all.filter((d) => d.documentType === "credit_note");
  const payments = all.filter((d) => Number(d.paidAmount ?? 0) > 0);
  const aging = computeAging(invoices);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/customers">
          <Button variant="ghost" size="sm" className="mb-2 -ms-2">
            <ArrowLeft className="w-4 h-4 me-2" />{t("Back to customers", "العودة إلى العملاء")}
          </Button>
        </Link>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">{customer.name}</h1>
            {customer.nameAr && <p className="text-muted-foreground" dir="rtl">{customer.nameAr}</p>}
            <div className="flex gap-2 mt-2 flex-wrap">
              {!customer.isActive && <Badge variant="destructive" className="text-xs">{t("Inactive", "غير نشط")}</Badge>}
              {customer.taxNumber && <Badge variant="outline" className="text-xs font-mono">{t("VAT", "ض.ق.م")} {customer.taxNumber}</Badge>}
              {customer.crNumber && <Badge variant="outline" className="text-xs font-mono">{t("CR", "س.ت")} {customer.crNumber}</Badge>}
              {customer.paymentTermsDays && <Badge variant="outline" className="text-xs font-mono">{customer.paymentTermsDays}d</Badge>}
            </div>
          </div>
          <Link href={`/reports/customer-ledger?customer_id=${customer.id}`}>
            <Button variant="outline" size="sm">{t("Open statement", "فتح كشف الحساب")}</Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={t("Billed", "المفوتر")} value={money(customer.totalBilled)} />
        <StatTile label={t("Paid", "المدفوع")} value={money(customer.totalPaid)} tone="good" />
        <StatTile label={t("Outstanding", "المستحق")} value={money(customer.balance)} tone={customer.balance > 0 ? "warn" : "good"} />
        <StatTile label={t("Invoices", "الفواتير")} value={String(customer.invoiceCount)} />
      </div>

      {(customer.phone || customer.email || customer.address || customer.city) && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t("Contact", "بيانات الاتصال")}</CardTitle></CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2 text-sm">
            {customer.phone && <p><span className="text-muted-foreground">{t("Phone", "الهاتف")}: </span>{customer.phone}</p>}
            {customer.email && <p><span className="text-muted-foreground">{t("Email", "البريد الإلكتروني")}: </span>{customer.email}</p>}
            {customer.address && <p><span className="text-muted-foreground">{t("Address", "العنوان")}: </span>{customer.address}</p>}
            {customer.city && <p><span className="text-muted-foreground">{t("City", "المدينة")}: </span>{customer.city}</p>}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">{t("Aging", "أعمار الذمم")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {invoiceData?.truncated && <TruncationNotice shown={all.length} total={invoiceData.total} />}
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
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><FileText className="w-4 h-4" />{t("Invoices", "الفواتير")} ({invoices.length})</CardTitle></CardHeader>
        <CardContent><DocTable rows={invoices} kind="invoice" /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><FileMinus className="w-4 h-4" />{t("Credit Notes", "إشعارات الدائن")} ({creditNotes.length})</CardTitle></CardHeader>
        <CardContent><DocTable rows={creditNotes} kind="credit" /></CardContent>
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
                      <td className="py-3 pe-4 font-mono text-xs">{p.invoiceNumber}</td>
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
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><ClipboardList className="w-4 h-4" />{t("Quotations", "عروض الأسعار")} ({quotationData?.items.length ?? 0})</CardTitle></CardHeader>
        <CardContent>
          {(quotationData?.items.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground py-4">{t("No quotations.", "لا توجد عروض أسعار.")}</p>
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
                  {quotationData!.items.map((q) => (
                    <tr key={q.id} className="border-b border-border/50">
                      <td className="py-3 pe-4 font-mono text-xs">{q.quotationNumber}</td>
                      <td className="py-3 pe-4 text-muted-foreground">{q.date}</td>
                      <td className="py-3 pe-4"><Badge variant="outline" className="text-xs">{q.status}</Badge></td>
                      <td className="py-3 pe-4 font-mono">{money(q.total)}</td>
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
