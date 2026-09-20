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
 *
 * AP-1 (2026-09-20): the deposits held at the end of the window are listed
 * beside the return. A taxable advance is a VAT tax point at RECEIPT (GCC VAT
 * Agreement Art. 23(1)) and needs an advance tax invoice by the 15th of the
 * next month (IR Art. 53(1)); the boxes read documents only, so an
 * un-invoiced advance is absent from them — this panel is where it becomes
 * visible. The server decides every state; the page renders its list.
 */
import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { Link } from "wouter";
import { useGetVatReturn, useGetVatSummary, useGetDepositReview } from "@workspace/api-client-react";
import { useClassificationLabels } from "@/components/payments/shared";
import { fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { Receipt, Scale, AlertTriangle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DualDate } from "@/components/DualDate";

export default function VatReport() {
  const { t, n } = useLanguage();
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

  // AP-1: the deposit review list for the same window end (the return carries the summary; this is the list).
  const { data: review, isLoading: reviewLoading } = useGetDepositReview({ period_to: periodTo || undefined });
  const { label: classLabel, state: stateLabel } = useClassificationLabels();
  const reviewSummary = vatReturn?.depositReview;

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
            <Receipt className="w-8 h-8 text-positive-surface" />
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
              <p className="text-2xl sm:text-3xl font-mono font-bold text-foreground">{formatCurrency(sales?.box8_totalOutputVat || 0)}</p>
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
              <p className="text-2xl sm:text-3xl font-mono font-bold text-foreground">{formatCurrency(purchases?.box13_recoverableInputVat || 0)}</p>
            )}
            <p className="text-xs text-muted-foreground">{t("From approved bills", "من فواتير المشتريات المعتمدة")}</p>
          </CardContent>
        </Card>

        <Card className="border-positive-surface/30 bg-positive-surface/5">
          <CardContent className="p-6 space-y-2">
            <p className="text-sm font-medium text-positive-surface/80 uppercase tracking-wider">
              {t("Net VAT Due", "صافي الضريبة المستحقة")}
            </p>
            {isLoading ? (
              <Skeleton className="h-10 w-32 bg-positive-surface/20" />
            ) : (
              <p className={`text-4xl font-mono font-bold ${netDue < 0 ? "text-positive" : "text-destructive"}`}>
                {formatCurrency(Math.abs(netDue))}
              </p>
            )}
            <p className="text-xs font-bold text-foreground/70">
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
              <table className="w-full text-sm text-start">
                <thead className="text-xs text-muted-foreground uppercase bg-secondary/50 border-b">
                  <tr>
                    <th className="px-6 py-3 font-semibold w-16">{t("Box", "خانة")}</th>
                    <th className="px-6 py-3 font-semibold">{t("Description", "الوصف")}</th>
                    <th className="px-6 py-3 font-semibold text-end">{t("Amount (SAR)", "المبلغ (ر.س)")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {boxRows.map((row) => (
                    <tr key={row.box} className={row.emphasis ? "bg-secondary/30 font-semibold" : "hover:bg-secondary/30 transition-colors"}>
                      <td className="px-6 py-3 font-mono text-muted-foreground">{row.box}</td>
                      <td className="px-6 py-3 text-foreground">{t(row.label, row.labelAr)}</td>
                      <td className={`px-6 py-3 text-end font-mono ${row.emphasis ? "text-positive" : ""}`}>
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

      <Card data-testid="deposit-review-card" className={reviewSummary && reviewSummary.needsReviewCount > 0 ? "border-attention-surface/40" : ""}>
        <CardHeader>
          <div className="flex justify-between items-start gap-3 flex-wrap">
            <div>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className={`w-5 h-5 ${reviewSummary && reviewSummary.needsReviewCount > 0 ? "text-attention" : "text-muted-foreground"}`} />
                {t("Customer deposits held — may carry VAT the boxes do not show", "عرابين العملاء المحتفظ بها — قد تحمل ضريبة لا تظهرها الخانات")}
              </CardTitle>
              <CardDescription>
                {t(
                  "Money received before a supply is a VAT tax point at receipt, and an advance tax invoice is due by the 15th of the following month. The return above reads documents only, so an advance that has not been invoiced is missing from it. Classify each deposit; the platform cannot issue the advance tax invoice yet.",
                  "المبلغ المستلم قبل التوريد نقطة استحقاق ضريبية عند الاستلام، وتستحق فاتورة ضريبية عن الدفعة المقدمة بحلول اليوم الخامس عشر من الشهر التالي. يقرأ الإقرار أعلاه المستندات فقط، فالدفعة المقدمة التي لم تصدر فاتورتها غائبة عنه. صنّف كل عربون؛ ولا تستطيع المنصة إصدار الفاتورة الضريبية للدفعة المقدمة بعد.",
                )}
              </CardDescription>
            </div>
            {reviewSummary && (
              <Badge variant="outline" className={`text-sm py-1 px-3 ${reviewSummary.needsReviewCount > 0 ? "border-attention/40 text-attention" : "text-positive"}`} data-testid="deposit-review-summary">
                {t("Needs review", "تحتاج إلى مراجعة")}: {reviewSummary.needsReviewCount} · {formatCurrency(reviewSummary.needsReviewAmount)}
                {reviewSummary.overdueCount > 0 ? ` · ${t("overdue", "متأخرة")}: ${reviewSummary.overdueCount}` : ""}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {reviewLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : !review || review.items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4" data-testid="deposit-review-empty">
              {t(`No customer deposits held as of ${review?.asOf ?? ""}.`, `لا توجد عرابين عملاء محتفظ بها حتى ${review?.asOf ?? ""}.`)}
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground mb-3">
                {t(`Receipts up to ${review.asOf} whose money is still on account today. ${review.needsReviewCount} of ${review.items.length} need a decision or an advance tax invoice.`,
                   `الإيصالات حتى ${review.asOf} التي لا يزال مبلغها على الحساب اليوم. ${review.needsReviewCount} من ${review.items.length} تحتاج إلى قرار أو فاتورة ضريبية عن دفعة مقدمة.`)}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-start" data-testid="deposit-review-table">
                  <thead className="text-xs text-muted-foreground uppercase bg-secondary/50 border-b">
                    <tr>
                      <th className="px-2 sm:px-3 py-2 font-semibold hidden sm:table-cell">{t("Receipt", "الإيصال")}</th>
                      <th className="px-2 sm:px-3 py-2 font-semibold">{t("Customer", "العميل")}</th>
                      <th className="px-2 sm:px-3 py-2 font-semibold hidden sm:table-cell">{t("Received", "الاستلام")}</th>
                      <th className="px-2 sm:px-3 py-2 font-semibold text-end">{t("On account", "على الحساب")}</th>
                      <th className="px-2 sm:px-3 py-2 font-semibold hidden md:table-cell">{t("Classified as", "مصنف كـ")}</th>
                      <th className="px-2 sm:px-3 py-2 font-semibold">{t("Status", "الحالة")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {review.items.map((i) => (
                      <tr key={i.paymentId} className={i.needsReview ? "bg-attention-surface/5" : ""} data-testid={`deposit-review-${i.paymentId}`} data-review-state={i.reviewState} data-needs-review={i.needsReview ? "1" : "0"}>
                        <td className="px-2 sm:px-3 py-2 font-mono text-xs whitespace-nowrap hidden sm:table-cell">RCPT-{i.paymentId}</td>
                        <td className="px-2 sm:px-3 py-2">
                          <Link href={`/customers/${i.customerId}`} className="text-primary hover:underline">{n(i.customerName, i.customerNameAr)}</Link>
                          <span className="block font-mono text-xs text-muted-foreground sm:hidden">RCPT-{i.paymentId}</span>
                        </td>
                        <td className="px-2 sm:px-3 py-2 text-muted-foreground hidden sm:table-cell whitespace-nowrap"><DualDate date={i.paidAt} inline /></td>
                        <td className="px-2 sm:px-3 py-2 text-end font-mono">{fmtNum(i.unappliedAmount)}</td>
                        <td className="px-2 sm:px-3 py-2 hidden md:table-cell text-xs">{i.source === "opening" ? t("Migrated deposit", "عربون مُرحَّل") : classLabel[i.classification]}{i.vatCategory ? ` · ${i.vatCategory}` : ""}</td>
                        <td className="px-2 sm:px-3 py-2 min-w-[6.5rem]">
                          <span className={`text-xs ${i.needsReview ? "text-attention font-medium" : "text-muted-foreground"}`}>{stateLabel[i.reviewState]}</span>
                          {i.deadline && (
                            <p className={`text-xs ${i.overdue ? "text-destructive" : "text-muted-foreground"}`} data-testid={`deposit-review-deadline-${i.paymentId}`}>
                              {i.overdue ? t("Advance tax invoice was due by", "كانت الفاتورة الضريبية للدفعة المقدمة مستحقة بحلول") : t("Advance tax invoice due by", "الفاتورة الضريبية للدفعة المقدمة مستحقة بحلول")} <span dir="ltr" className="font-mono">{i.deadline}</span>
                            </p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Scale className="w-5 h-5 text-attention-surface" />
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
                <p className="text-xl sm:text-2xl font-mono font-bold text-foreground">{formatCurrency(netDue)}</p>
                <p className="text-xs text-muted-foreground">{t("This is the filing figure", "هذا هو رقم الإقرار")}</p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t("Net VAT per bank activity", "صافي الضريبة حسب الحركة البنكية")}</p>
                <p className="text-xl sm:text-2xl font-mono font-bold text-foreground">{formatCurrency(bankNet)}</p>
                <p className="text-xs text-muted-foreground">
                  {t("Estimated from imported transactions", "مقدّر من المعاملات المستوردة")}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">{t("Gap", "الفجوة")}</p>
                <p className={`text-xl sm:text-2xl font-mono font-bold ${Math.abs(gap) < 0.01 ? "text-positive" : "text-attention"}`}>
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
          {/* C9 — Art. 50-blocked input VAT (entertainment, catering). A real
              cost the business paid; NEVER part of the recoverable estimate.
              Shown rather than silently excluded — a figure that moves says
              where the money went. */}
          {!bankLoading && (bankVat?.vatBlocked ?? 0) > 0.004 && (
            <p className="text-xs text-muted-foreground mt-4 border-t border-border pt-3">
              {t(
                `${formatCurrency(bankVat!.vatBlocked)} of VAT paid on meals and entertainment is excluded from the recoverable figure — KSA VAT rules do not allow deducting it (Implementing Regulations, Art. 50). It is a cost, not a claim.`,
                `استُبعد ${formatCurrency(bankVat!.vatBlocked)} من الضريبة المدفوعة على الوجبات والضيافة من الرقم القابل للاسترداد — لا تسمح أنظمة ضريبة القيمة المضافة السعودية بخصمها (اللائحة التنفيذية، المادة 50). فهي تكلفة، لا مطالبة.`,
              )}
            </p>
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
              <table className="w-full text-sm text-start">
                <thead className="text-xs text-muted-foreground uppercase bg-secondary/50 border-b">
                  <tr>
                    <th className="px-6 py-4 font-semibold">{t("Date", "التاريخ")}</th>
                    <th className="px-6 py-4 font-semibold">{t("Description", "الوصف")}</th>
                    <th className="px-6 py-4 font-semibold">{t("Type", "النوع")}</th>
                    <th className="px-6 py-4 font-semibold text-end">{t("Gross Amount", "المبلغ الإجمالي")}</th>
                    <th className="px-6 py-4 font-semibold text-end text-positive">{t("VAT Amount", "مبلغ الضريبة")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {bankVat?.transactions?.map((tx) => (
                    <tr key={tx.id} className="hover:bg-secondary/30 transition-colors">
                      <td className="px-6 py-4 font-mono text-muted-foreground whitespace-nowrap"><DualDate date={tx.date} /></td>
                      <td className="px-6 py-4 text-foreground font-medium">{tx.description}</td>
                      <td className="px-6 py-4">
                        <Badge
                          variant="outline"
                          className={tx.type === "credit" ? "border-primary/30 text-primary" : "border-destructive/30 text-destructive"}
                        >
                          {tx.type === "credit" ? t("Output", "مخرجات") : t("Input", "مدخلات")}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 text-end font-mono">{formatCurrency(tx.amount)}</td>
                      <td className="px-6 py-4 text-end font-mono font-bold text-positive">{formatCurrency(tx.vatAmount)}</td>
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
