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
import { Fragment, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { Link } from "wouter";
import { useGetVatReturn, useGetVatSummary, useGetDepositReview } from "@workspace/api-client-react";
import { useClassificationLabels } from "@/components/payments/shared";
import { fmtNum } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
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

  const needsReview = !!reviewSummary && reviewSummary.needsReviewCount > 0;

  return (
    <div className="space-y-6 max-w-6xl">
      <PageHeader
        title={t("ZATCA VAT Return", "إقرار ضريبة القيمة المضافة - زاتكا")}
        description={t(
          "Filed from your invoices and bills — the legal documents. Bank activity is reconciled below.",
          "يُعد من فواتيرك ومشترياتك — المستندات النظامية. وتُطابَق الحركة البنكية أدناه.",
        )}
        actions={
          <div className="flex gap-3 items-end">
            <div className="space-y-1">
              <Label className="text-[13px] text-muted-foreground">{t("Period from", "الفترة من")}</Label>
              <Input type="month" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} className="w-40" />
            </div>
            <div className="space-y-1">
              <Label className="text-[13px] text-muted-foreground">{t("Period to", "الفترة إلى")}</Label>
              <Input type="month" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} className="w-40" />
            </div>
          </div>
        }
      >
        <div className="mt-3">
          <PeriodShortcuts granularity="month" from={periodFrom} to={periodTo} onSelect={(r)=>{setPeriodFrom(r.from);setPeriodTo(r.to);}} />
        </div>
      </PageHeader>

      <StatStrip cols={3}>
        <Stat
          label={t("Total Output VAT (Box 8)", "إجمالي ضريبة المخرجات (خانة 8)")}
          value={isLoading ? <Skeleton className="h-6 w-28" /> : formatCurrency(sales?.box8_totalOutputVat || 0)}
          hint={t("From issued invoices, credit notes deducted", "من الفواتير الصادرة، بعد خصم الإشعارات الدائنة")}
        />
        <Stat
          label={t("Recoverable Input VAT (Box 13)", "ضريبة المدخلات القابلة للاسترداد (خانة 13)")}
          value={isLoading ? <Skeleton className="h-6 w-28" /> : formatCurrency(purchases?.box13_recoverableInputVat || 0)}
          hint={t("From approved bills", "من فواتير المشتريات المعتمدة")}
        />
        <Stat
          label={t("Net VAT Due", "صافي الضريبة المستحقة")}
          value={isLoading ? <Skeleton className="h-6 w-28" /> : formatCurrency(Math.abs(netDue))}
          tone={isLoading ? "default" : netDue < 0 ? "positive" : "negative"}
          hint={netDue < 0 ? t("Refund due", "مستحق الاسترداد") : t("Payment due", "مستحق السداد")}
        />
      </StatStrip>

      <Panel
        flush
        title={t("Return Boxes", "خانات الإقرار")}
        description={t(
          "The box structure of the ZATCA VAT return, computed from your documents.",
          "بنية خانات إقرار ضريبة القيمة المضافة، محتسبة من مستنداتك.",
        )}
        actions={
          <span className="text-[13px] text-muted-foreground tabular-nums">
            {t("Invoices", "الفواتير")}: {vatReturn?.invoiceCount ?? 0} · {t("Bills", "المشتريات")}: {vatReturn?.billCount ?? 0}
          </span>
        }
      >
        {isLoading ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-3 text-start w-16">{t("Box", "خانة")}</th>
                  <th className="px-3 text-start">{t("Description", "الوصف")}</th>
                  <th className="px-3 text-end">{t("Amount (SAR)", "المبلغ (ر.س)")}</th>
                </tr>
              </thead>
              <tbody>
                {boxRows.map((row) => (
                  <Fragment key={row.box}>
                    {(row.box === "1" || row.box === "9") && (
                      <tr className="border-b border-border/70 bg-muted/30">
                        <td colSpan={3} className="py-2 px-3 text-[13px] font-semibold text-foreground">
                          {row.box === "1" ? t("Sales", "المبيعات") : t("Purchases", "المشتريات")}
                        </td>
                      </tr>
                    )}
                    <tr className={`border-b border-border/70 transition-colors ${row.emphasis ? "font-semibold bg-muted/40" : "hover:bg-muted/40"}`}>
                      <td className="py-2.5 px-3 tabular-nums text-muted-foreground">{row.box}</td>
                      <td className="py-2.5 px-3 text-foreground">{t(row.label, row.labelAr)}</td>
                      <td className="py-2.5 px-3 text-end whitespace-nowrap tabular-nums">{formatCurrency(row.value || 0)}</td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td className="py-3 px-3"></td>
                  <td className="py-3 px-3">{t("Net VAT due (box 8 − box 15)", "صافي الضريبة المستحقة (خانة 8 − خانة 15)")}</td>
                  <td className={`py-3 px-3 text-end whitespace-nowrap tabular-nums ${netDue < 0 ? "text-positive" : "text-negative"}`}>{formatCurrency(netDue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        flush
        data-testid="deposit-review-card"
        className={needsReview ? "border-attention/40" : ""}
        title={
          <span className="flex items-start gap-2">
            <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${needsReview ? "text-attention" : "text-muted-foreground"}`} />
            {t("Customer deposits held — may carry VAT the boxes do not show", "عرابين العملاء المحتفظ بها — قد تحمل ضريبة لا تظهرها الخانات")}
          </span>
        }
        description={
          <span className="block max-w-[80ch]">
            {t(
              "Money received before a supply is a VAT tax point at receipt, and an advance tax invoice (type 386) is due by the 15th of the following month. The return above reads documents only, so an advance that has not been invoiced is missing from it. Classify each deposit, then issue the advance tax invoice from the receipt on the customer's page; once issued it files here, and the final invoice applies it.",
              "المبلغ المستلم قبل التوريد نقطة استحقاق ضريبية عند الاستلام، وتستحق فاتورة ضريبية عن الدفعة المقدمة بحلول اليوم الخامس عشر من الشهر التالي. يقرأ الإقرار أعلاه المستندات فقط، فالدفعة المقدمة التي لم تصدر فاتورتها غائبة عنه. صنّف كل عربون، ثم أصدر الفاتورة الضريبية للدفعة المقدمة (نوع 386) من الإيصال في صفحة العميل؛ وبعد إصدارها تُدرج هنا، وتُطبّقها الفاتورة النهائية.",
            )}
          </span>
        }
        actions={
          reviewSummary && (
            <Badge variant="outline" className={`text-[13px] py-1 px-2.5 font-medium tabular-nums ${needsReview ? "border-attention/40 text-attention" : "text-positive"}`} data-testid="deposit-review-summary">
              {t("Needs review", "تحتاج إلى مراجعة")}: {reviewSummary.needsReviewCount} · {formatCurrency(reviewSummary.needsReviewAmount)}
              {reviewSummary.overdueCount > 0 ? ` · ${t("overdue", "متأخرة")}: ${reviewSummary.overdueCount}` : ""}
            </Badge>
          )
        }
      >
        {reviewLoading ? (
          <div className="p-5"><Skeleton className="h-16 w-full" /></div>
        ) : !review || review.items.length === 0 ? (
          <p className="text-sm text-muted-foreground px-5 py-6" data-testid="deposit-review-empty">
            {t(`No customer deposits held as of ${review?.asOf ?? ""}.`, `لا توجد عرابين عملاء محتفظ بها حتى ${review?.asOf ?? ""}.`)}
          </p>
        ) : (
          <>
            <p className="text-[13px] text-muted-foreground px-5 py-3 border-b border-border">
              {t(`Receipts up to ${review.asOf} whose money is still on account today. ${review.needsReviewCount} of ${review.items.length} need a decision or an advance tax invoice.`,
                 `الإيصالات حتى ${review.asOf} التي لا يزال مبلغها على الحساب اليوم. ${review.needsReviewCount} من ${review.items.length} تحتاج إلى قرار أو فاتورة ضريبية عن دفعة مقدمة.`)}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="deposit-review-table">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-3 text-start hidden sm:table-cell">{t("Receipt", "الإيصال")}</th>
                    <th className="px-3 text-start">{t("Customer", "العميل")}</th>
                    <th className="px-3 text-start hidden sm:table-cell">{t("Received", "الاستلام")}</th>
                    <th className="px-3 text-end">{t("On account", "على الحساب")}</th>
                    <th className="px-3 text-start hidden md:table-cell">{t("Classified as", "مصنف كـ")}</th>
                    <th className="px-3 text-start">{t("Status", "الحالة")}</th>
                  </tr>
                </thead>
                <tbody>
                  {review.items.map((i) => (
                    <tr key={i.paymentId} className={`border-b border-border/70 transition-colors ${i.needsReview ? "bg-attention-surface/10" : "hover:bg-muted/40"}`} data-testid={`deposit-review-${i.paymentId}`} data-review-state={i.reviewState} data-needs-review={i.needsReview ? "1" : "0"}>
                      <td className="py-3 px-3 whitespace-nowrap font-medium text-primary hidden sm:table-cell">RCPT-{i.paymentId}</td>
                      <td className="py-3 px-3">
                        <Link href={`/customers/${i.customerId}`} className="text-foreground hover:text-primary hover:underline">{n(i.customerName, i.customerNameAr)}</Link>
                        <span className="block text-xs text-muted-foreground sm:hidden">RCPT-{i.paymentId}</span>
                      </td>
                      <td className="py-3 px-3 text-muted-foreground hidden sm:table-cell whitespace-nowrap"><DualDate date={i.paidAt} inline /></td>
                      <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(i.unappliedAmount)}</td>
                      <td className="py-3 px-3 hidden md:table-cell text-[13px]">{i.source === "opening" ? t("Migrated deposit", "عربون مُرحَّل") : classLabel[i.classification]}{i.vatCategory ? ` · ${i.vatCategory}` : ""}</td>
                      <td className="py-3 px-3 min-w-[6.5rem]">
                        <span className={`text-[13px] ${i.needsReview ? "text-attention font-medium" : "text-muted-foreground"}`}>{stateLabel[i.reviewState]}</span>
                        {i.deadline && (
                          <p className={`text-xs mt-0.5 ${i.overdue ? "text-negative" : "text-muted-foreground"}`} data-testid={`deposit-review-deadline-${i.paymentId}`}>
                            {i.overdue ? t("Advance tax invoice was due by", "كانت الفاتورة الضريبية للدفعة المقدمة مستحقة بحلول") : t("Advance tax invoice due by", "الفاتورة الضريبية للدفعة المقدمة مستحقة بحلول")} <span dir="ltr" className="tabular-nums whitespace-nowrap">{i.deadline}</span>
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
      </Panel>

      <Panel
        flush
        className="overflow-hidden"
        title={
          <span className="flex items-center gap-2">
            <Scale className="w-4 h-4 text-muted-foreground" />
            {t("Reconciliation — documents vs bank activity", "المطابقة — المستندات مقابل الحركة البنكية")}
          </span>
        }
        description={t(
          "A gap here is cash activity with no invoice or bill behind it. Review it before filing — it is either an undocumented sale or purchase, or a bank line that should not carry VAT.",
          "الفجوة هنا حركة نقدية بلا فاتورة تدعمها. راجعها قبل تقديم الإقرار — فهي إما بيع أو شراء غير موثق، وإما حركة بنكية لا ينبغي أن تحمل ضريبة.",
        )}
      >
        {bankLoading || isLoading ? (
          <div className="p-5"><Skeleton className="h-24 w-full" /></div>
        ) : (
          <StatStrip cols={3} className="mb-0 rounded-none border-0">
            <Stat
              label={t("Net VAT per your documents", "صافي الضريبة حسب مستنداتك")}
              value={formatCurrency(netDue)}
              hint={t("This is the filing figure", "هذا هو رقم الإقرار")}
            />
            <Stat
              label={t("Net VAT per bank activity", "صافي الضريبة حسب الحركة البنكية")}
              value={formatCurrency(bankNet)}
              hint={t("Estimated from imported transactions", "مقدّر من المعاملات المستوردة")}
            />
            <Stat
              label={t("Gap", "الفجوة")}
              value={formatCurrency(gap)}
              tone={Math.abs(gap) < 0.01 ? "positive" : "attention"}
              hint={
                Math.abs(gap) < 0.01
                  ? t("Documents and bank activity agree", "المستندات والحركة البنكية متطابقتان")
                  : t("Undocumented activity — review before filing", "نشاط غير موثق — راجعه قبل التقديم")
              }
            />
          </StatStrip>
        )}
        {/* C9 — Art. 50-blocked input VAT (entertainment, catering). A real
            cost the business paid; NEVER part of the recoverable estimate.
            Shown rather than silently excluded — a figure that moves says
            where the money went. */}
        {!bankLoading && (bankVat?.vatBlocked ?? 0) > 0.004 && (
          <p className="text-[13px] text-muted-foreground border-t border-border px-5 py-3">
            {t(
              `${formatCurrency(bankVat!.vatBlocked)} of VAT paid on meals and entertainment is excluded from the recoverable figure — KSA VAT rules do not allow deducting it (Implementing Regulations, Art. 50). It is a cost, not a claim.`,
              `استُبعد ${formatCurrency(bankVat!.vatBlocked)} من الضريبة المدفوعة على الوجبات والضيافة من الرقم القابل للاسترداد — لا تسمح أنظمة ضريبة القيمة المضافة السعودية بخصمها (اللائحة التنفيذية، المادة 50). فهي تكلفة، لا مطالبة.`,
            )}
          </p>
        )}
      </Panel>

      <Panel
        flush
        title={t("Bank-activity VAT lines", "بنود الضريبة من الحركة البنكية")}
        description={t(
          "Transactions carrying a VAT estimate. These reconcile against the return; they never file it.",
          "المعاملات التي تحمل تقديراً للضريبة. تُستخدم للمطابقة مع الإقرار، ولا يُعد الإقرار منها.",
        )}
      >
        {bankLoading ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : bankVat?.transactions?.length === 0 ? (
          <EmptyState icon={Receipt} title={t("No VAT-carrying transactions in this period.", "لا توجد معاملات تحمل ضريبة في هذه الفترة.")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-3 text-start">{t("Date", "التاريخ")}</th>
                  <th className="px-3 text-start">{t("Description", "الوصف")}</th>
                  <th className="px-3 text-start">{t("Type", "النوع")}</th>
                  <th className="px-3 text-end">{t("Gross Amount", "المبلغ الإجمالي")}</th>
                  <th className="px-3 text-end">{t("VAT Amount", "مبلغ الضريبة")}</th>
                </tr>
              </thead>
              <tbody>
                {bankVat?.transactions?.map((tx) => (
                  <tr key={tx.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors">
                    <td className="py-3 px-3 text-muted-foreground whitespace-nowrap"><DualDate date={tx.date} /></td>
                    <td className="py-3 px-3 text-foreground">{tx.description}</td>
                    <td className="py-3 px-3">
                      <Badge
                        variant="outline"
                        className={tx.type === "credit" ? "border-primary/30 text-primary" : "border-negative/30 text-negative"}
                      >
                        {tx.type === "credit" ? t("Output", "مخرجات") : t("Input", "مدخلات")}
                      </Badge>
                    </td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{formatCurrency(tx.amount)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums font-medium">{formatCurrency(tx.vatAmount)}</td>
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
