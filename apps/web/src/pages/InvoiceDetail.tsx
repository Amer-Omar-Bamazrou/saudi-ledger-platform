/**
 * 🔴 The read-only invoice screen (Phase 18 final round, walk finding 18; register §11.141), opened by tapping a row:
 * status, number, dates, customer, seller, lines, totals, the QR code and a PDF button. Nothing here can be edited, and
 * every act stays on the list. An issued invoice's seller is the identity stamped at issue, from the API; the page never
 * reads the live company for it.
 */
import type { ReactNode } from "react";
import { Link, useParams } from "wouter";
import { ArrowRight, FileDown } from "lucide-react";
import {
  getGetInvoiceIssueViewQueryKey,
  getGetInvoiceQueryKey,
  useGetInvoice,
  useGetInvoiceIssueView,
} from "@workspace/api-client-react";
import { DualDate } from "@/components/DualDate";
import { useLanguage } from "@/contexts/LanguageContext";
import { fmtNum } from "@/lib/api";
import { statusLabel } from "@/lib/statusLabel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function InvoiceDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const valid = Number.isInteger(id) && id > 0;
  const { t, lang, n } = useLanguage();
  const invoice = useGetInvoice(id, { query: { enabled: valid, retry: false, queryKey: getGetInvoiceQueryKey(id) } });
  const view = useGetInvoiceIssueView(id, { query: { enabled: valid, retry: false, queryKey: getGetInvoiceIssueViewQueryKey(id) } });

  const back = (
    <Link href="/invoices" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
      <ArrowRight className="h-4 w-4 ltr:rotate-180" />
      {t("All invoices", "كل الفواتير")}
    </Link>
  );

  if (!valid || invoice.isError) {
    return (
      <div className="space-y-4 max-w-3xl mx-auto" data-testid="invoice-detail-missing">
        {back}
        <p className="text-sm text-muted-foreground">{t("This invoice was not found.", "لم يُعثر على هذه الفاتورة.")}</p>
      </div>
    );
  }
  const inv = invoice.data;
  if (!inv) return <div className="text-sm text-muted-foreground p-4">{t("Loading...", "جارٍ التحميل...")}</div>;
  const seller = view.data;
  const issued = inv.status !== "draft" && inv.status !== "submitted";
  const hasDocument = issued && !inv.isOpening;
  const row = (label: string, value: ReactNode) => (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </>
  );

  return (
    <div className="space-y-4 max-w-3xl mx-auto" data-testid="invoice-detail">
      {back}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold font-mono break-all">{inv.invoiceNumber}</h1>
        <Badge variant="outline" data-testid="invoice-detail-status">{statusLabel(inv.status, lang)}</Badge>
      </div>

      <Card>
        <CardContent className="pt-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {row(t("Date", "التاريخ"), <DualDate date={inv.date} />)}
            {row(t("Due date", "تاريخ الاستحقاق"), <DualDate date={inv.dueDate} />)}
            {row(t("Customer", "العميل"), n(inv.customerName ?? "", inv.customerNameAr) || "—")}
          </dl>
        </CardContent>
      </Card>

      <Card data-testid="invoice-detail-seller">
        <CardHeader className="pb-2"><CardTitle className="text-sm">{t("Seller", "البائع")}</CardTitle></CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {row(t("Name", "الاسم"), [seller?.sellerName, seller?.sellerNameAr].filter(Boolean).join(" · ") || "—")}
            {row(t("VAT number", "الرقم الضريبي"), <span className="font-mono">{seller?.sellerVatNumber ?? "—"}</span>)}
            {seller?.sellerCrNumber ? row(t("CR number", "رقم السجل التجاري"), <span className="font-mono">{seller.sellerCrNumber}</span>) : null}
            {seller?.sellerAddress ? row(t("Address", "العنوان"), seller.sellerAddress) : null}
          </dl>
          {seller && !seller.sellerStamped && (
            <p className="text-xs text-muted-foreground mt-2">
              {t("The company's current details. They are fixed on the invoice when it is issued.", "بيانات الشركة الحالية، وتُثبَّت على الفاتورة عند إصدارها.")}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">{t("Lines", "البنود")}</CardTitle></CardHeader>
        <CardContent>
          <ul className="divide-y divide-border text-sm" data-testid="invoice-detail-lines">
            {(inv.items ?? []).map((line) => (
              <li key={line.id} className="py-2 space-y-1">
                <div className="font-medium break-words">{lang === "ar" ? (line.descriptionAr || line.description) : line.description}</div>
                <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
                  <span>{t("Qty", "الكمية")}: <span className="font-mono">{line.quantity}</span></span>
                  <span>{t("Unit price", "سعر الوحدة")}: <span className="font-mono">{fmtNum(line.unitPrice)}</span></span>
                  <span>{t("VAT", "الضريبة")}: <span className="font-mono">{line.vatRate ?? 0}%</span></span>
                  <span>{t("Total", "الإجمالي")}: <span className="font-mono">{fmtNum(line.total)}</span></span>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm" data-testid="invoice-detail-totals">
            {row(t("Amount", "المبلغ"), <span className="font-mono">{fmtNum(inv.subtotal)}</span>)}
            {row(t("VAT", "ضريبة القيمة المضافة"), <span className="font-mono">{fmtNum(inv.vatAmount)}</span>)}
            {row(t("Total", "الإجمالي"), <span className="font-mono font-semibold">{fmtNum(inv.total)}</span>)}
          </dl>
        </CardContent>
      </Card>

      {hasDocument ? (
        <Card>
          <CardContent className="pt-4 flex flex-col items-center gap-3">
            {seller?.qrImage && (
              <img src={seller.qrImage} alt={t("The invoice's ZATCA QR code", "رمز QR للفاتورة")} width={180} height={180} data-testid="invoice-detail-qr" />
            )}
            <a
              href={`/api/invoices/${inv.id}/document?lang=ar`}
              download
              data-testid="invoice-detail-pdf"
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              <FileDown className="h-4 w-4" />
              {t("Download the tax invoice (PDF)", "تنزيل الفاتورة الضريبية (PDF)")}
            </a>
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="invoice-detail-not-issued">
          {inv.isOpening
            ? t("A balance migrated from the previous system: it has no QR code or PDF here.", "رصيد مُرحَّل من النظام السابق: ليس له رمز QR أو ملف PDF هنا.")
            : t("Not issued yet: it has no QR code or PDF until it is approved.", "لم تصدر بعد: لا رمز QR ولا ملف PDF حتى تُعتمد.")}
        </p>
      )}
    </div>
  );
}
