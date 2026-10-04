/**
 * Phase 16E — the tax obligations calendar (decision pack §6, §8.4): what the
 * company owes the State, from the ledger, with the regulation's due date.
 * Treasury reads the same list as EXPECTED outflows (one source, two pages).
 *
 * Every amount is the server's (the WHT ledger, the GL payables, the VAT
 * return); every date is a statutory rule applied to a declared fact. Where a
 * date cannot be established the row says so — never a guessed day. The
 * server's notes are English; the page words them by the row's SOURCE.
 */
import { Link } from "wouter";
import { useGetTaxObligations, type TaxObligation } from "@workspace/api-client-react";
import { fmtDate, fmtNum } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import { obligationKindLabel } from "@/lib/taxLabels";

type T = (en: string, ar: string) => string;

const hrefOf = (o: TaxObligation) =>
  o.kind === "wht" ? "/tax/withholding" : o.kind === "zakat" ? "/zakat" : o.kind === "income_tax" ? "/tax/income-tax" : "/vat";

function ruleOf(o: TaxObligation, t: T) {
  if (o.kind === "wht") return o.dueDate
    ? t("Due the 10th of the month after the payments (IR Art. 63(9)(a)).", "تستحق في العاشر من الشهر التالي للدفعات (المادة 63(9)(أ) من اللائحة).")
    : t("The migrated opening WHT payable: its months are the previous system's, so its due date is not known here.", "رصيد الاستقطاع الافتتاحي المرحَّل: أشهره من النظام السابق، فتاريخ استحقاقه غير معروف هنا.");
  if (o.kind === "zakat" || o.kind === "income_tax") return o.dueDate
    ? t("Due 120 days after the fiscal year-end of the latest approved computation; a balance from earlier years is shown with it.", "تستحق بعد 120 يومًا من نهاية السنة المالية لأحدث احتساب معتمد؛ ويُعرض معها رصيد السنوات السابقة.")
    : t("No approved computation dates this balance.", "لا يوجد احتساب معتمد يؤرّخ هذا الرصيد.");
  if (o.dueDate == null) return t("The company's VAT tax period (monthly or quarterly) is not declared, so VAT is not projected. Declare it in Company Settings.", "لم يُصرَّح بفترة ضريبة القيمة المضافة للشركة (شهرية أو ربع سنوية)، فلا تُسقَط. صرِّح بها في إعدادات الشركة.");
  return o.reference.includes("(to date)")
    ? t("The current period TO DATE — it grows until the period ends. Due by the last day of the month after the period.", "الفترة الحالية حتى تاريخه — تنمو حتى تنتهي الفترة. تستحق بنهاية الشهر التالي للفترة.")
    : t("Net VAT per the return for the last completed period, less VAT payments booked since it ended (presumed for it). Due by the last day of the following month.", "صافي الضريبة حسب الإقرار لآخر فترة مكتملة، مطروحًا منه ما دُفع للضريبة منذ نهايتها (يُفترض أنه لها). تستحق بنهاية الشهر التالي.");
}

export default function TaxObligations() {
  const { t } = useLanguage();
  const q = useGetTaxObligations();
  const rows = q.data?.obligations ?? [];
  return (
    <div className="space-y-6" data-testid="tax-obligations-page">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("Tax obligations", "الالتزامات الضريبية")}</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">{t("What the company owes ZATCA today — withholding tax, Zakat, income tax and VAT — from the books, each with its statutory due date. Treasury reads this same list as expected payments.", "ما تدين به الشركة للهيئة اليوم — ضريبة الاستقطاع والزكاة وضريبة الدخل وضريبة القيمة المضافة — من الدفاتر، ولكل منها تاريخ استحقاقه النظامي. وتقرأ الخزينة هذه القائمة نفسها مدفوعاتٍ متوقعة.")}</p>
      </div>
      <Card className="border-border"><CardContent className="pt-4">
        {q.isLoading ? <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
          : rows.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="tax-obligations-empty">{t("Nothing is owed: no unremitted withholding, no Zakat or income-tax payable, and no VAT due.", "لا شيء مستحق: لا استقطاع غير مُسدَّد، ولا زكاة أو ضريبة دخل مستحقة، ولا ضريبة قيمة مضافة مستحقة.")}</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="tax-obligations-table">
                <thead><tr className="border-b border-border text-xs text-muted-foreground">
                  {[t("Tax", "الضريبة"), t("For", "عن"), t("Amount", "المبلغ"), t("Due", "الاستحقاق"), t("How it is dated", "أساس التاريخ")].map((h) => <th key={h} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>)}
                </tr></thead>
                <tbody>{rows.map((o, i) => (
                  <tr key={`${o.kind}-${o.reference}-${i}`} className="border-b border-border/50 align-top" data-testid={`tax-obligation-${o.kind}-${i}`}>
                    <td className="py-2 pe-3 whitespace-nowrap"><Link href={hrefOf(o)} className="underline">{obligationKindLabel(o.kind, t)}</Link></td>
                    <td className="py-2 pe-3 font-mono text-xs"><span dir="ltr">{o.reference.replace(" (to date)", "")}</span>{o.reference.endsWith("(to date)") ? <span className="block font-sans">{t("to date — still growing", "حتى تاريخه — ما زال ينمو")}</span> : null}</td>
                    <td className="py-2 pe-3 text-end font-mono" dir="ltr">{o.dueDate == null && o.amount === 0 ? "—" : fmtNum(o.amount)}</td>
                    <td className="py-2 pe-3 whitespace-nowrap">{o.dueDate ? <>{fmtDate(o.dueDate)}{o.overdue ? <span className="block text-xs">{t("past its due date", "تجاوز تاريخ استحقاقه")}</span> : null}</> : t("not dated", "غير مؤرَّخ")}</td>
                    <td className="py-2 pe-3 text-xs text-muted-foreground max-w-md">{ruleOf(o, t)}</td>
                  </tr>
                ))}</tbody>
                <tfoot><tr><td className="pt-2 pe-3 font-medium" colSpan={2}>{t("Total", "الإجمالي")}</td><td className="pt-2 pe-3 text-end font-mono font-semibold" dir="ltr" data-testid="tax-obligations-total">{fmtNum(q.data?.total ?? 0)}</td><td colSpan={2} /></tr></tfoot>
              </table>
            </div>
          )}
        <p className="text-xs text-muted-foreground mt-3">{t("Penalties and fines are not estimated here except the withholding-tax delay fine shown on its month (an estimate, never posted).", "لا تُقدَّر الغرامات هنا سوى غرامة تأخير الاستقطاع المعروضة في شهرها (تقدير لا يُرحَّل).")}</p>
      </CardContent></Card>
    </div>
  );
}
