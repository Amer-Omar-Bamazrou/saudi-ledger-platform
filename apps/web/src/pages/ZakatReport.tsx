import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Landmark, TriangleAlert, Construction } from "lucide-react";

/**
 * M17.0 (owner decision Q7) — the Zakat surface states that it is not built.
 *
 * 🔴 What was here before, and why it had to go NOW rather than at M17.4:
 * a "Zakat Assessment" that summed transactions flagged `is_zakat_relevant`.
 * Exactly ONE categorization rule out of ~40 ever wrote that flag (Tadawul /
 * investment income), so the page read SAR 0.00 for almost every tenant — and
 * for a tenant who DID trade, it counted investment INCOME as a zakatable
 * ASSET and subtracted every debit from it. Then it compared the result to a
 * nisab threshold hardcoded from a 2024 gold price. Every number on the page
 * was presented as a calculation and none was one.
 *
 * An empty state is not a regression from that; it is the first accurate thing
 * this page has ever shown. A wrong tax figure that looks computed is worse
 * than no figure, because only one of the two gets filed.
 *
 * The replacement is specified in docs/product/design-zakat-module.md.
 */
export default function ZakatReport() {
  const { t } = useLanguage();

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
          <Landmark className="w-8 h-8 text-muted-foreground" />
          {t("Zakat", "الزكاة")}
          <Badge variant="outline" className="text-xs font-normal uppercase tracking-wider">
            {t("Not implemented", "غير مُنفَّذ")}
          </Badge>
        </h1>
        <p className="text-muted-foreground mt-1">
          {t(
            "The Zakat working paper is not built yet.",
            "لم يتم بعد إنشاء ورقة عمل وعاء الزكاة.",
          )}
        </p>
      </div>

      <Alert variant="destructive" className="border-destructive/40">
        <TriangleAlert className="h-4 w-4" />
        <AlertTitle>
          {t("Do not file a Zakat figure from this platform yet", "لا تعتمد على هذه المنصة في تقديم إقرار الزكاة بعد")}
        </AlertTitle>
        <AlertDescription className="space-y-2 mt-2">
          <p>
            {t(
              "This page previously displayed a Zakat amount and a nisab threshold. Those figures were not a real calculation — they were built from a transaction flag almost nothing in the product ever set, and compared against a gold price hardcoded in 2024. They have been removed.",
              "كانت هذه الصفحة تعرض سابقًا مبلغ زكاة وحد نصاب. لم تكن تلك الأرقام حسابًا حقيقيًا — بل كانت مبنية على مؤشر على المعاملات لا يكاد يُضبط في المنتج، ومقارنةً بسعر ذهب مُثبَّت في عام 2024. وقد تمت إزالتها.",
            )}
          </p>
          <p>
            {t(
              "Until the working paper ships, prepare your Zakat return with your accountant or tax advisor.",
              "إلى حين إطلاق ورقة العمل، يُرجى إعداد إقرار الزكاة مع محاسبك أو مستشارك الضريبي.",
            )}
          </p>
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Construction className="w-5 h-5 text-muted-foreground" />
            {t("What is being built", "ما الذي يجري بناؤه")}
          </CardTitle>
          <CardDescription>
            {t(
              "An auditable Zakat Base Working Paper you or your accountant use to complete the ZATCA filing. The platform does not submit to ZATCA on your behalf.",
              "ورقة عمل قابلة للمراجعة لوعاء الزكاة تستخدمها أنت أو محاسبك لاستكمال الإقرار لدى هيئة الزكاة والضريبة والجمارك. لا تقوم المنصة بالتقديم نيابةً عنك.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3 text-sm">
            <li className="flex gap-3">
              <span className="text-muted-foreground shrink-0">•</span>
              <span>
                {t(
                  "The base is derived from your general ledger — capital, retained earnings, provisions and long-term liabilities, less deductible long-term assets — and cross-checked against the income statement.",
                  "يُشتق الوعاء من دفتر الأستاذ العام — رأس المال والأرباح المبقاة والمخصصات والالتزامات طويلة الأجل، مطروحًا منها الأصول طويلة الأجل القابلة للحسم — مع مطابقته بقائمة الدخل.",
                )}
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-muted-foreground shrink-0">•</span>
              <span>
                {t(
                  "Both Hijri and Gregorian fiscal years are supported, with the rate adjusted for Gregorian filers.",
                  "دعم السنة المالية الهجرية والميلادية معًا، مع تعديل النسبة لمن يتبع السنة الميلادية.",
                )}
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-muted-foreground shrink-0">•</span>
              <span>
                {t(
                  "You or your accountant can adjust non-ledger items on the worksheet before locking it for the year.",
                  "يمكنك أنت أو محاسبك تعديل البنود غير المقيدة في الدفاتر داخل ورقة العمل قبل إقفالها للسنة.",
                )}
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-muted-foreground shrink-0">•</span>
              <span>
                {t(
                  "Version 1 covers entities that are 100% Saudi/GCC-owned. Companies with foreign or mixed ownership are assessed differently and are out of scope — consult your tax advisor.",
                  "الإصدار الأول يغطي المنشآت المملوكة بالكامل لسعوديين أو لمواطني دول الخليج. أما الشركات ذات الملكية الأجنبية أو المختلطة فتخضع لمعالجة مختلفة وهي خارج النطاق — يُرجى الرجوع إلى مستشارك الضريبي.",
                )}
              </span>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
