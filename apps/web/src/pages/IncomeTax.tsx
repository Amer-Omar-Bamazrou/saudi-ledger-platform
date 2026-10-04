/**
 * Phase 16C — income tax, where it applies (decision pack §4).
 *
 * A resident capital company is taxed on the shares owned by non-Saudis (GCC
 * treated as Saudi; Income Tax Law Arts 2(a), 6(a)) at 20 % (Art. 7). The
 * computation reads the Phase 14 income statement for the fiscal year, swaps
 * book depreciation for the Art. 17 pool the fixed-asset register computes,
 * applies the user's declared adjustments (each with its article), the losses
 * carried forward (≤ 25 %, Art. 21) and the declared non-Saudi share.
 * 🔴 Current tax only — deferred tax (IAS 12) is NOT computed, and the page
 * says so; oil, hydrocarbon and natural-gas rates are not supported.
 */
import { Link } from "wouter";
import { useGetCurrentCompany } from "@workspace/api-client-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Scale } from "lucide-react";
import { ComputationList } from "@/components/tax/ComputationList";

export default function IncomeTax() {
  const { t } = useLanguage();
  const company = useGetCurrentCompany();
  const ownership = company.data?.ownershipType ?? null;
  const pct = company.data?.foreignOwnershipPct ?? null;

  return (
    <div className="space-y-6" data-testid="income-tax-page">
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2"><Scale className="w-6 h-6 text-muted-foreground" />{t("Income tax", "ضريبة الدخل")}</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
          {t("Corporate income tax on the non-Saudi share of a resident company's taxable income (Income Tax Law Arts 2(a), 6(a)), at 20 % (Art. 7). Book depreciation is replaced by the Art. 17 pool; losses carried forward offset at most 25 % of the year's income (Art. 21). Approving a year posts the tax as an expense on its own income-statement line. The platform does not file with ZATCA.",
            "ضريبة الدخل على حصة غير السعوديين من الدخل الخاضع للضريبة للشركة المقيمة (نظام ضريبة الدخل المادتان 2(أ) و6(أ))، بنسبة 20% (المادة 7). يحل وعاء المادة 17 محل الإهلاك الدفتري؛ وتُخصم الخسائر المرحلة في حدود 25% من دخل السنة (المادة 21). اعتماد السنة يرحّل الضريبة مصروفًا في بند مستقل في قائمة الدخل. لا تقدّم المنصة الإقرار إلى الهيئة.")}
        </p>
      </div>

      <Card className="border-border" data-testid="income-tax-scope">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Does income tax apply?", "هل تنطبق ضريبة الدخل؟")}</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {company.isLoading ? <p className="text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
            : ownership == null ? <p data-testid="income-tax-scope-not-declared">{t("The ownership is not declared, so nothing is assumed. Declare it in Company Settings.", "لم يُصرَّح بالملكية، فلا يُفترض شيء. صرِّح بها في إعدادات الشركة.")}</p>
            : ownership === "SAUDI_GCC" ? <p data-testid="income-tax-scope-not-applicable">{t("This company is 100 % Saudi/GCC-owned: it pays Zakat, not income tax.", "هذه الشركة مملوكة بالكامل لسعوديين/خليجيين: تدفع الزكاة لا ضريبة الدخل.")} <Link href="/zakat" className="underline">{t("Zakat", "الزكاة")}</Link></p>
            : ownership === "FOREIGN" ? <p data-testid="income-tax-scope-foreign">{t("Declared foreign-owned: income tax applies to 100 % of the taxable income.", "مُصرَّح بأنها مملوكة لأجانب: تنطبق ضريبة الدخل على 100% من الدخل الخاضع للضريبة.")}</p>
            : <p data-testid="income-tax-scope-mixed">{pct == null
              ? t("Declared mixed-owned, with no non-Saudi share declared — the computation stops until the share is declared in Company Settings (Art. 6(a)).", "مُصرَّح بأنها مختلطة الملكية دون تصريح بحصة غير السعوديين — يتوقف الاحتساب حتى يُصرَّح بالحصة في إعدادات الشركة (المادة 6(أ)).")
              : <>{t("Declared mixed-owned: income tax applies to the non-Saudi share of", "مُصرَّح بأنها مختلطة الملكية: تنطبق ضريبة الدخل على حصة غير السعوديين البالغة")} <span className="font-mono" dir="ltr">{pct}%</span>{t("; Zakat applies to the rest but is not computed here for a mixed company (open question Z-5).", "؛ وتنطبق الزكاة على الباقي لكنها لا تُحتسب هنا للشركة المختلطة (سؤال مفتوح Z-5).")}</>}</p>}
          <div className="flex flex-wrap gap-2">
            <Link href="/company"><Button size="sm" variant="outline" className="h-7">{t("Company Settings", "إعدادات الشركة")}</Button></Link>
            <Link href="/assets/income-tax-pool"><Button size="sm" variant="outline" className="h-7">{t("Art. 17 depreciation pool", "وعاء الإهلاك وفق المادة 17")}</Button></Link>
          </div>
        </CardContent>
      </Card>

      {ownership === "FOREIGN" || ownership === "MIXED"
        ? <ComputationList kind="income_tax" />
        : <ComputationList kind="income_tax" canStart={false} notStartedWhy={t("Income tax does not apply to this company as its ownership is declared today, so a new computation is not started here. A computation that already exists stays listed — it may cover a year when the ownership was different — and can be opened, reviewed or, if never approved, deleted.", "لا تنطبق ضريبة الدخل على هذه الشركة وفق ملكيتها المصرَّح بها اليوم، فلا يُبدأ هنا احتساب جديد. ويبقى الاحتساب القائم مدرجًا — فقد يغطي سنة كانت الملكية فيها مختلفة — ويمكن فتحه ومراجعته أو حذفه إن لم يُعتمد.")} />}

      <Card className="border-border" data-testid="income-tax-limits">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Not computed here", "ما لا يُحتسب هنا")}</CardTitle></CardHeader>
        <CardContent>
          <ul className="text-sm space-y-1.5 list-disc ps-5">
            <li>{t("Deferred tax (IAS 12 / IFRS for SMEs section 29) — only current tax is posted; statements of an income-tax payer are not complete in that respect.", "الضريبة المؤجلة (معيار المحاسبة الدولي 12 / القسم 29) — تُرحَّل الضريبة الجارية فقط؛ وقوائم دافع ضريبة الدخل غير مكتملة من هذه الناحية.")}</li>
            <li>{t("Oil, hydrocarbon and natural-gas activities (85 % and special rates).", "أنشطة النفط والمواد الهيدروكربونية والغاز الطبيعي (85% والنسب الخاصة).")}</li>
            <li>{t("Advance payments (Art. 70).", "الدفعات المقدمة (المادة 70).")}</li>
            <li>{t("A mixed-owned company with losses carried forward: whether the 25 % cap applies before or after the non-Saudi share is not settled (open question I-1), so it is refused rather than assumed.", "الشركة المختلطة الملكية ذات الخسائر المرحلة: لم يُحسم تطبيق سقف 25% قبل حصة غير السعوديين أو بعدها (سؤال مفتوح I-1)، لذا يُرفض بدل أن يُفترض.")}</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
