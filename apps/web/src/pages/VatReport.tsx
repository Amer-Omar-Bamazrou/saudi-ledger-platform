/**
 * M16.1 (design Q0): the VAT page files from DOCUMENTS, reconciles from CASH.
 *
 * Until M16.1 this page — literally titled "ZATCA VAT Return" — was fed by
 * `/summary/vat`, the transaction-derived guess, while the real box-structured
 * return (`/reports/vat-return`, invoices + bills, S/Z/E/O-aware, credit-note
 * direction applied) was routed and consumed by nothing. A user would have
 * filed from the weaker of two sources.
 *
 * The transaction figure is deliberately NOT hidden: it renders beside the
 * filing figure as a reconciliation. A gap between them is undocumented cash
 * activity — exactly what an SME should see before filing.
 */
import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { useGetVatReturn, useGetVatSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { Receipt, Scale } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function VatReport() {
  const { t } = useLanguage();
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");

  const { data: vatReturn, isLoading } = useGetVatReturn({
    period_from: periodFrom || undefined,
    period_to: periodTo || undefined,
  });

  // The reconciliation side: the same window, as full dates.
  const { data: bankVat, isLoading: bankLoading } = useGetVatSummary({
    date_from: periodFrom ? `${periodFrom}-01` : undefined,
    date_to: periodTo ? `${periodTo}-31` : undefined,
  });

  const sales = vatReturn?.salesSection;
  const purchases = vatReturn?.purchasesSection;
  const netDue = vatReturn?.netVatDue ?? 0;
  const bankNet = bankVat?.netVatPosition ?? 0;
  const gap = Math.round((netDue - bankNet) * 100) / 100;

  const boxRows: Array<{ box: string; label: string; labelAr: string; value: number | undefined; emphasis?: boolean }> = [
    { box: "1", label: "Standard-rated domestic sales", labelAr: "المبيعات المحلية الخاضعة للنسبة الأساسية", value: sales?.box1_standardRatedDomesticSales },
    { box: "2", label: "Zero-rated domestic sales", labelAr: "المبيعات المحلية الخاضعة لنسبة الصفر", value: sales?.box2_zeroRatedDomesticSales },
    { box: "3", label: "Exempt sales", labelAr: "المبيعات المعفاة", value: sales?.box3_exemptSales },
    { box: "4", label: "Export sales", labelAr: "الصادرات", value: sales?.box4_exportSales },
    { box: "5", label: "Total sales", labelAr: "إجمالي المبيعات", value: sales?.box5_totalSales },
    { box: "6", label: "VAT on standard-rated sales", labelAr: "الضريبة على المبيعات الخاضعة للنسبة الأساسية", value: sales?.box6_vatOnStandardRatedSales },
    { box: "7", label: "VAT adjustments (sales)", labelAr: "تعديلات الضريبة (المبيعات)", value: sales?.box7_vatAdjustments },
    { box: "8", label: "Total output VAT", labelAr: "إجمالي ضريبة المخرجات", value: sales?.box8_totalOutputVat, emphasis: true },
    { box: "9", label: "Standard-rated purchases", labelAr: "المشتريات الخاضعة للنسبة الأساسية", value: purchases?.box9_standardRatedPurchases },
    { box: "10", label: "Zero-rated purchases", labelAr: "المشتريات الخاضعة لنسبة الصفر", value: purchases?.box10_zeroRatedPurchases },
    { box: "11", label: "Exempt purchases", labelAr: "المشتريات المعفاة", value: purchases?.box11_exemptPurchases },
    { box: "12", label: "Total purchases", labelAr: "إجمالي المشتريات", value: purchases?.box12_totalPurchases },
    { box: "13", label: "Recoverable input VAT", labelAr: "ضريبة المدخلات القابلة للاسترداد", value: purchases?.box13_recoverableInputVat },
    { box: "14", label: "Input VAT adjustments", labelAr: "تعديلات ضريبة المدخلات", value: purchases?.box14_inputVatAdjustments },
    { box: "15", label: "Total input VAT", labelAr: "إجمالي ضريبة المدخلات", value: purchases?.box15_totalInputVat, emphasis: true },
  ];

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Receipt className="w-8 h-8 text-emerald-500" />
            {t("ZATCA VAT Return", "إقرار ضريبة القيمة المضافة - زاتكا")}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t(
              "Filed from your invoices and bills — the legal documents. Bank activity is reconciled below.",
              "يُعد من فواتيرك ومشترياتك — المستندات النظامية. وتُطابَق الحركة البنكية أدناه.",
            )}
          </p>
        </div>

        <div className="space-y-2 bg-card p-3 rounded-lg border shadow-sm">
          <div className="flex gap-4 items-end">
            <div className="space-y-1">
              <Label className="text-xs">{t("Period from", "الفترة من")}</Label>
              <Input type="month" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} className="h-8" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("Period to", "الفترة إلى")}</Label>
              <Input type="month" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} className="h-8" />
            </div>
          </div>
          <PeriodShortcuts granularity="month" from={periodFrom} to={periodTo} onSelect={(r)=>{setPeriodFrom(r.from);setPeriodTo(r.to);}} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-card">
          <CardContent className="p-6 space-y-2">
            <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              {t("Total Output VAT (Box 8)", "إجمالي ضريبة المخرجات (خانة 8)")}
            </p>
            {isLoading ? (
              <Skeleton className="h-10 w-32" />
            ) : (
              <p className="text-3xl font-mono font-bold text-white">{formatCurrency(sales?.box8_totalOutputVat || 0)}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("From issued invoices, credit notes deducted", "من الفواتير الصادرة، بعد خصم الإشعارات الدائنة")}
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardContent className="p-6 space-y-2">
            <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              {t("Recoverable Input VAT (Box 13)", "ضريبة المدخلات القابلة للاسترداد (خانة 13)")}
            </p>
            {isLoading ? (
              <Skeleton className="h-10 w-32" />
            ) : (
              <p className="text-3xl font-mono font-bold text-white">{formatCurrency(purchases?.box13_recoverableInputVat || 0)}</p>
            )}
            <p className="text-xs text-muted-foreground">{t("From approved bills", "من فواتير المشتريات المعتمدة")}</p>
          </CardContent>
        </Card>

        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardContent className="p-6 space-y-2">
            <p className="text-sm font-medium text-emerald-500/80 uppercase tracking-wider">
              {t("Net VAT Due", "صافي الضريبة المستحقة")}
            </p>
            {isLoading ? (
              <Skeleton className="h-10 w-32 bg-emerald-500/20" />
            ) : (
              <p className={`text-4xl font-mono font-bold ${netDue < 0 ? "text-emerald-400" : "text-destructive"}`}>
                {formatCurrency(Math.abs(netDue))}
              </p>
            )}
            <p className="text-xs font-bold text-white/70">
              {netDue < 0 ? t("REFUND DUE", "مستحق الاسترداد") : t("PAYMENT DUE", "مستحق السداد")}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <div>
              <CardTitle>{t("Return Boxes", "خانات الإقرار")}</CardTitle>
              <CardDescription>
                {t(
                  "The box structure of the ZATCA VAT return, computed from your documents.",
                  "بنية خانات إقرار ضريبة القيمة المضافة، محتسبة من مستنداتك.",
                )}
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-sm py-1 px-3">
              {t("Invoices", "الفواتير")}: {vatReturn?.invoiceCount ?? 0} · {t("Bills", "المشتريات")}: {vatReturn?.billCount ?? 0}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-muted-foreground uppercase bg-secondary/50 border-b">
                  <tr>
                    <th className="px-6 py-3 font-semibold w-16">{t("Box", "خانة")}</th>
                    <th className="px-6 py-3 font-semibold">{t("Description", "الوصف")}</th>
                    <th className="px-6 py-3 font-semibold text-right">{t("Amount (SAR)", "المبلغ (ر.س)")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {boxRows.map((row) => (
                    <tr key={row.box} className={row.emphasis ? "bg-secondary/30 font-semibold" : "hover:bg-secondary/30 transition-colors"}>
                      <td className="px-6 py-3 font-mono text-muted-foreground">{row.box}</td>
                      <td className="px-6 py-3 text-white">{t(row.label, row.labelAr)}</td>
                      <td className={`px-6 py-3 text-right font-mono ${row.emphasis ? "text-emerald-400" : ""}`}>
                        {formatCurrency(row.value || 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Scale className="w-5 h-5 text-amber-500" />
            {t("Reconciliation — documents vs bank activity", "المطابقة — المستندات مقابل الحركة البنكية")}
          </CardTitle>
          <CardDescription>
            {t(
              "A gap here is cash activity with no invoice or bill behind it. Review it before filing — it is either an undocumented sale or purchase, or a bank line that should not carry VAT.",
              "الفجوة هنا حركة نقدية بلا فاتورة تدعمها. راجعها قبل تقديم الإقرار — فهي إما بيع أو شراء غير موثق، وإما حركة بنكية لا ينبغي أن تحمل ضريبة.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {bankLoading || isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t("Net VAT per your documents", "صافي الضريبة حسب مستنداتك")}</p>
                <p className="text-2xl font-mono font-bold text-white">{formatCurrency(netDue)}</p>
                <p className="text-xs text-muted-foreground">{t("This is the filing figure", "هذا هو رقم الإقرار")}</p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t("Net VAT per bank activity", "صافي الضريبة حسب الحركة البنكية")}</p>
                <p className="text-2xl font-mono font-bold text-white">{formatCurrency(bankNet)}</p>
                <p className="text-xs text-muted-foreground">
                  {t("Estimated from imported transactions", "مقدّر من المعاملات المستوردة")}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t("Gap", "الفجوة")}</p>
                <p className={`text-2xl font-mono font-bold ${Math.abs(gap) < 0.01 ? "text-emerald-400" : "text-amber-400"}`}>
                  {formatCurrency(gap)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {Math.abs(gap) < 0.01
                    ? t("Documents and bank activity agree", "المستندات والحركة البنكية متطابقتان")
                    : t("Undocumented activity — review before filing", "نشاط غير موثق — راجعه قبل التقديم")}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Bank-activity VAT lines", "بنود الضريبة من الحركة البنكية")}</CardTitle>
          <CardDescription>
            {t(
              "Transactions carrying a VAT estimate. These reconcile against the return; they never file it.",
              "المعاملات التي تحمل تقديراً للضريبة. تُستخدم للمطابقة مع الإقرار، ولا يُعد الإقرار منها.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {bankLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-muted-foreground uppercase bg-secondary/50 border-b">
                  <tr>
                    <th className="px-6 py-4 font-semibold">{t("Date", "التاريخ")}</th>
                    <th className="px-6 py-4 font-semibold">{t("Description", "الوصف")}</th>
                    <th className="px-6 py-4 font-semibold">{t("Type", "النوع")}</th>
                    <th className="px-6 py-4 font-semibold text-right">{t("Gross Amount", "المبلغ الإجمالي")}</th>
                    <th className="px-6 py-4 font-semibold text-right text-emerald-400">{t("VAT Amount", "مبلغ الضريبة")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {bankVat?.transactions?.map((tx) => (
                    <tr key={tx.id} className="hover:bg-secondary/30 transition-colors">
                      <td className="px-6 py-4 font-mono text-muted-foreground whitespace-nowrap">{tx.date}</td>
                      <td className="px-6 py-4 text-white font-medium">{tx.description}</td>
                      <td className="px-6 py-4">
                        <Badge
                          variant="outline"
                          className={tx.type === "credit" ? "border-primary/30 text-primary" : "border-destructive/30 text-destructive"}
                        >
                          {tx.type === "credit" ? t("Output", "مخرجات") : t("Input", "مدخلات")}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 text-right font-mono">{formatCurrency(tx.amount)}</td>
                      <td className="px-6 py-4 text-right font-mono font-bold text-emerald-400">{formatCurrency(tx.vatAmount)}</td>
                    </tr>
                  ))}
                  {bankVat?.transactions?.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                        {t("No VAT-carrying transactions in this period.", "لا توجد معاملات تحمل ضريبة في هذه الفترة.")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
