import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Landmark, TriangleAlert, Construction, HelpCircle, Ban } from "lucide-react";

/**
 * The Zakat surface (M17.0 + M17.1).
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
 * M17.1 adds the scope gate (owner decision Q2). Three states, not two —
 * "not declared" is deliberately NOT folded into "out of scope": a company
 * that has told us nothing must be ASKED, never assumed to qualify and never
 * refused on an assumption. The rule itself lives server-side in
 * `apps/api/src/lib/zakatScope.ts` so M17.4's endpoint enforces the same thing
 * rather than a second copy of it.
 */
interface Company {
  name: string;
  ownershipType: "SAUDI_GCC" | "FOREIGN" | "MIXED" | null;
}

export default function ZakatReport() {
  const { t } = useLanguage();
  const { data: company, isLoading } = useQuery<Company>({
    queryKey: ["company"],
    queryFn: () => apiFetch("/companies/current"),
  });

  const header = (
    <div>
      <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
        <Landmark className="w-8 h-8 text-muted-foreground" />
        {t("Zakat", "الزكاة")}
        <Badge variant="outline" className="text-xs font-normal uppercase tracking-wider">
          {t("Not implemented", "غير مُنفَّذ")}
        </Badge>
      </h1>
    </div>
  );

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto">
        {header}
        <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
      </div>
    );
  }

  // ── Not declared → ASK. Never assume, in either direction. ────────────────
  if (company && company.ownershipType == null) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto">
        {header}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HelpCircle className="w-5 h-5 text-muted-foreground" />
              {t("Tell us who owns the company", "أخبِرنا بهيكل ملكية المنشأة")}
            </CardTitle>
            <CardDescription>
              {t(
                "Zakat applies differently depending on ownership, so we do not guess. Set your ownership structure in Company Settings and this page will tell you whether the Zakat module applies to you.",
                "تختلف معالجة الزكاة باختلاف هيكل الملكية، ولذلك لا نفترض. حدِّد هيكل الملكية في إعدادات الشركة وستوضح لك هذه الصفحة ما إذا كانت وحدة الزكاة تنطبق عليك.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/company">
              <Button>{t("Open Company Settings", "فتح إعدادات الشركة")}</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Foreign / mixed → out of scope, and say why. ──────────────────────────
  if (company && company.ownershipType !== "SAUDI_GCC") {
    return (
      <div className="space-y-6 max-w-4xl mx-auto">
        {header}
        <Alert>
          <Ban className="h-4 w-4" />
          <AlertTitle>
            {t("The Zakat module does not apply to this company", "وحدة الزكاة لا تنطبق على هذه المنشأة")}
          </AlertTitle>
          <AlertDescription className="space-y-2 mt-2">
            <p>
              {company.ownershipType === "FOREIGN"
                ? t(
                    "This company is recorded as foreign-owned.",
                    "هذه المنشأة مسجَّلة كمملوكة لأجانب.",
                  )
                : t(
                    "This company is recorded as having mixed Saudi/GCC and foreign ownership.",
                    "هذه المنشأة مسجَّلة كذات ملكية مختلطة سعودية/خليجية وأجنبية.",
                  )}{" "}
              {t(
                "Entities with foreign or mixed ownership are assessed differently — the liability is apportioned between Zakat and income tax — and the platform does not attempt that calculation.",
                "تخضع المنشآت ذات الملكية الأجنبية أو المختلطة لمعالجة مختلفة — إذ يُقسَّم الالتزام بين الزكاة وضريبة الدخل — ولا تقوم المنصة بهذا الاحتساب.",
              )}
            </p>
            <p className="font-medium">
              {t(
                "Please consult your tax advisor for this company's Zakat and income tax position.",
                "يُرجى الرجوع إلى مستشارك الضريبي بشأن وضع الزكاة وضريبة الدخل لهذه المنشأة.",
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(
                "If this is wrong, correct the ownership structure in Company Settings.",
                "إذا كان هذا غير صحيح، فصحِّح هيكل الملكية في إعدادات الشركة.",
              )}{" "}
              <Link href="/company" className="underline">
                {t("Open settings", "فتح الإعدادات")}
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // ── In scope → the module, which is not built yet. ────────────────────────
  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {header}
      <p className="text-muted-foreground -mt-4">
        {t("The Zakat working paper is not built yet.", "لم يتم بعد إنشاء ورقة عمل وعاء الزكاة.")}
      </p>

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
                  "Both Hijri and Gregorian fiscal years are supported, with the rate adjusted for Gregorian filers. Set yours in Company Settings.",
                  "دعم السنة المالية الهجرية والميلادية معًا، مع تعديل النسبة لمن يتبع السنة الميلادية. حدِّد سنتك في إعدادات الشركة.",
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
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
