/**
 * Phase 16B — the Zakat workspace (decision pack §3; owner decisions Q1–Q8).
 *
 * The scope gate first (M17.1, owner Q2): three states, not two — "not
 * declared" is deliberately NOT folded into "out of scope": a company that has
 * told us nothing is ASKED, never assumed to qualify and never refused on an
 * assumption. The rule lives server-side (`zakatScopeFor`) and the computation
 * enforces it; this page reads the declaration through the generated client
 * (no hand-written contract — the ratchet entry this file held is gone).
 *
 * Then the computations: a Zakat Base Working Paper per fiscal year (Q1), read
 * from the ledger and the person's account classification, versioned and
 * approved; the platform does NOT file with ZATCA. What the 1445H Regulations
 * leave open is listed in words, with the default this build takes (§11).
 */
import { Link } from "wouter";
import { useGetCurrentCompany, useListFiscalYears } from "@workspace/api-client-react";
import { fmtDate } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Landmark, HelpCircle, Ban, ListChecks } from "lucide-react";
import { ComputationList } from "@/components/tax/ComputationList";

export default function ZakatReport() {
  const { t } = useLanguage();
  const company = useGetCurrentCompany();
  const fiscal = useListFiscalYears();
  const ownership = company.data?.ownershipType ?? null;

  return (
    <div className="space-y-6" data-testid="zakat-page">
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2"><Landmark className="w-6 h-6 text-muted-foreground" />{t("Zakat", "الزكاة")}</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
          {t("The Zakat Base Working Paper for each fiscal year, computed from the ledger and your account classification under the 1445H Implementing Regulations for Zakat Collection (MoF Decision 1007, as amended by 1248). Approving a year posts Zakat as an expense on its own income-statement line (SOCPA Zakat Standard). The platform does not file with ZATCA.",
            "ورقة عمل الوعاء الزكوي لكل سنة مالية، محسوبة من الدفاتر ومن تصنيفك للحسابات وفق اللائحة التنفيذية لجباية الزكاة 1445هـ (قرار وزير المالية 1007 وتعديلاته بالقرار 1248). اعتماد السنة يرحّل الزكاة مصروفًا في بند مستقل في قائمة الدخل (معيار الزكاة الصادر عن الهيئة السعودية للمراجعين والمحاسبين). لا تقدّم المنصة الإقرار إلى الهيئة.")}
        </p>
      </div>

      {company.isLoading ? <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p> : (
        <div className="grid gap-3 md:grid-cols-2">
          <Card className="border-border" data-testid="zakat-scope">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Who owns the company", "ملكية الشركة")}</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {ownership == null ? (
                <div className="flex gap-2" data-testid="zakat-scope-not-declared">
                  <HelpCircle className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <p>{t("The ownership is not declared. Zakat applies differently depending on it, so nothing is assumed: declare it in Company Settings.", "لم يُصرَّح بالملكية. تختلف معالجة الزكاة بحسبها، فلا يُفترض شيء: صرِّح بها في إعدادات الشركة.")}</p>
                </div>
              ) : ownership === "SAUDI_GCC" ? (
                <p data-testid="zakat-scope-eligible">{t("100 % Saudi/GCC-owned — Zakat applies to the whole company.", "مملوكة بالكامل لسعوديين/خليجيين — تنطبق الزكاة على الشركة كلها.")}</p>
              ) : (
                <div className="flex gap-2" data-testid="zakat-scope-out">
                  <Ban className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <p>{ownership === "FOREIGN"
                    ? t("Declared foreign-owned: the company pays income tax, not Zakat.", "مُصرَّح بأنها مملوكة لأجانب: تدفع الشركة ضريبة الدخل لا الزكاة.")
                    : t("Declared mixed-owned: Zakat is due on the Saudi/GCC share and income tax on the rest (Art. 6(1)). How the minimum and maximum base apply to a split is not settled (open question Z-5), so the Zakat working paper covers a fully Saudi/GCC-owned company only (owner decision Q2).", "مُصرَّح بأنها مختلطة الملكية: تجب الزكاة على حصة السعوديين/الخليجيين وضريبة الدخل على الباقي (المادة 6(1)). لم يُحسم تطبيق الحد الأدنى والأعلى للوعاء على التقسيم (سؤال مفتوح Z-5)، لذا تغطي ورقة عمل الزكاة الشركة المملوكة بالكامل لسعوديين/خليجيين فقط (قرار المالك Q2).")}
                    {" "}<Link href="/tax/income-tax" className="underline">{t("Income tax", "ضريبة الدخل")}</Link></p>
                </div>
              )}
              <Link href="/company"><Button size="sm" variant="outline" className="h-7">{t("Company Settings", "إعدادات الشركة")}</Button></Link>
            </CardContent>
          </Card>
          <Card className="border-border" data-testid="zakat-fiscal">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("The Zakat year", "سنة الزكاة")}</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {!fiscal.data ? <p className="text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
                : !fiscal.data.declared ? <p data-testid="zakat-fiscal-undeclared">{t("The fiscal year is not declared — it is never assumed to be the calendar year. Declare it in Company Settings.", "السنة المالية غير مُعلنة — ولا تُفترض أبدًا أنها السنة الميلادية. أعلنها من إعدادات الشركة.")}</p>
                : (
                  <>
                    <p>{fiscal.data.current ? <>{t("Current fiscal year", "السنة المالية الحالية")} <span className="font-mono" dir="ltr">{fiscal.data.current.label}</span>: {fmtDate(fiscal.data.current.startDate)} – {fmtDate(fiscal.data.current.endDate)}</> : null}</p>
                    <p className="text-xs text-muted-foreground">{company.data?.fiscalCalendar === "hijri"
                      ? t("A Hijri year: Zakat is 2.5 % of the base (Art. 15(1)).", "سنة هجرية: الزكاة 2.5% من الوعاء (المادة 15(1)).")
                      : t("A Gregorian year: Zakat is 2.5 % ÷ 354 × the days of the year (Art. 15(2); the divisor follows owner decision Q3 while question Z-1 is open).", "سنة ميلادية: الزكاة 2.5% ÷ 354 × أيام السنة (المادة 15(2)؛ المقسوم وفق قرار المالك Q3 ما دام السؤال Z-1 مفتوحًا).")}</p>
                  </>
                )}
            </CardContent>
          </Card>
        </div>
      )}

      <Card className="border-border" data-testid="zakat-classification-link">
        <CardContent className="pt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm max-w-2xl">
            <p className="font-medium flex items-center gap-2"><ListChecks className="w-4 h-4 text-muted-foreground" />{t("Account classification", "تصنيف الحسابات")}</p>
            <p className="text-muted-foreground mt-1">{t("Every asset and liability account with a balance at the year-end carries one class, each tied to its article. A suggestion is pre-selected where the account's role decides it; nothing is classified without a person. An unclassified account with a balance blocks the computation, by name.", "يحمل كل حساب أصل أو التزام له رصيد في نهاية السنة تصنيفًا واحدًا مرتبطًا بمادته. يُقترح التصنيف مسبقًا حيث يحدده دور الحساب؛ ولا يُصنَّف شيء دون شخص. الحساب غير المصنف الذي له رصيد يوقف الاحتساب، باسمه.")}</p>
          </div>
          <Link href="/zakat/classification"><Button size="sm" variant="outline" data-testid="zakat-open-classification">{t("Classify accounts", "تصنيف الحسابات")}</Button></Link>
        </CardContent>
      </Card>

      {ownership === "SAUDI_GCC" || ownership == null ? <ComputationList kind="zakat" /> : null}

      <Card className="border-border" data-testid="zakat-open-questions">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground">{t("What the Regulations leave open — and what this working paper does meanwhile", "ما تتركه اللائحة مفتوحًا — وما تفعله ورقة العمل في الأثناء")}</CardTitle>
          <CardDescription className="text-xs">{t("Each is a question for your Zakat adviser; every term is shown on the working paper so it can be checked.", "كل منها سؤال لمستشارك الزكوي؛ وكل بند معروض في ورقة العمل ليمكن التحقق منه.")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="text-sm space-y-1.5 list-disc ps-5">
            <li>{t("Z-1 — a Gregorian year's divisor (a fixed 354, or that Hijri year's 354/355) and any rounding: ÷ 354, rounded once on the final amount.", "Z-1 — مقسوم السنة الميلادية (354 ثابتًا أو 354/355 للسنة الهجرية المقابلة) وأي تقريب: ÷ 354 مع تقريب واحد للمبلغ النهائي.")}</li>
            <li>{t("Z-2 — whether contra-asset allowances (expected credit loss, obsolescence, impairment) are provisions under Art. 24: you classify the account.", "Z-2 — هل مخصصات مقابلة الأصول (الخسائر الائتمانية المتوقعة، التقادم، الهبوط) مخصصات وفق المادة 24: أنت تصنّف الحساب.")}</li>
            <li>{t("Z-3 — the year's own Zakat charge is left out of equity and book profit when computing that year's base.", "Z-3 — تُستبعد زكاة السنة نفسها من حقوق الملكية والربح الدفتري عند احتساب وعاء تلك السنة.")}</li>
            <li>{t("Z-4 / Z-6 — the minimum (Art. 27) and maximum (Art. 28) base and the current-liability additions (Arts 25, 29(2)) are applied clause by clause, as shown.", "Z-4 / Z-6 — يُطبَّق الحد الأدنى (المادة 27) والأعلى (المادة 28) للوعاء وإضافات الالتزامات المتداولة (المادتان 25 و29(2)) بندًا بندًا كما هو معروض.")}</li>
            <li>{t("Z-5 / Z-8 — mixed ownership and the estimated (arbitrary) basis are not computed.", "Z-5 / Z-8 — لا تُحتسب الملكية المختلطة ولا الأساس التقديري.")}</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
