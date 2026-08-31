/**
 * INTEGRATIONS — the slot, not the hub.
 *
 * ── 🔴 WHAT THIS PAGE IS, AND WHAT IT DELIBERATELY IS NOT ──────────────────
 * `frontend-spec-reconciliation.md` §5.3 cut the integrations hub outright:
 * *"the extensibility need is an `EInvoiceProvider`-shaped code seam, not a
 * screen."* The owner reversed that on 2026-08-31 as part of the navigation
 * decision — but the reversal does not make §5.3 wrong, and this page is built
 * to keep both true at once.
 *
 * §5.3 was right that the SEAM is code. A screen cannot make the platform
 * extensible, and a dashboard of toggles over integrations that do not exist
 * would be a facade of the worst kind: every control real, every effect absent.
 *
 * What §5.3 missed is that a legible PLACE is worth something on its own. A
 * user who wants their bank connected needs somewhere to look, and finding an
 * honest "not yet, here is what is in the way, here is how to ask" is a better
 * answer than finding nothing and concluding the product cannot do it. So this
 * is a slot: it says what an integration is here, lists the three in scope with
 * their real blockers, and says how to ask for one that is not listed.
 *
 * 🔴 The three in scope are the whole scope (owner, 2026-08-31). PayTabs,
 * HyperPay, Shopify, WooCommerce, POS, ERP, Lean, Tarabut and integration logs
 * were all dropped — they return when someone asks, with a design and an
 * estimate, not as greyed-out rows implying a plan that does not exist.
 */
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plug, Clock, ArrowRight } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { BLOCKERS, COMING_SOON, comingSoonHref } from "@/lib/comingSoon";

/** The three in scope. Read from the registry so the blockers cannot diverge. */
const IN_SCOPE = ["myfatoorah", "sifi", "email-providers"] as const;

export default function Integrations() {
  const { t, lang } = useLanguage();
  const ar = lang === "ar";
  const entries = IN_SCOPE.map(slug => COMING_SOON.find(e => e.slug === slug)).filter(
    (e): e is NonNullable<typeof e> => Boolean(e),
  );

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Plug className="w-5 h-5" />
          {t("Integrations", "التكاملات")}
        </h1>
        <p className="text-muted-foreground text-sm mt-2 max-w-2xl">
          {t(
            "An integration connects this platform to something outside it — a bank, a payment provider, an email service. Each one is a piece of code plus, usually, an agreement with the other side.",
            "التكامل يربط هذه المنصة بجهة خارجية — بنك أو مزوّد دفع أو خدمة بريد. وكل تكامل شيفرة برمجية، ويقترن عادةً باتفاقية مع الطرف الآخر.",
          )}
        </p>
      </div>

      <div className="space-y-3">
        {entries.map(entry => {
          const blocker = BLOCKERS[entry.blocker];
          return (
            <Card key={entry.slug} className="border-border">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <CardTitle className="text-base">{ar ? entry.titleAr : entry.title}</CardTitle>
                  <Badge className="bg-attention-surface/20 text-attention border-attention-surface/30 gap-1">
                    <Clock className="w-3 h-3" />
                    {t("Not connected", "غير مربوط")}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-muted-foreground">{ar ? entry.summaryAr : entry.summary}</p>
                <p className="text-xs">
                  <span className="text-muted-foreground">{t("Waiting on: ", "بانتظار: ")}</span>
                  <span className="font-medium text-foreground">{ar ? blocker.nameAr : blocker.name}</span>
                </p>
                <Link href={comingSoonHref(entry.slug)} className="inline-flex items-center gap-1 text-xs text-info hover:underline">
                  {t("What this is waiting on, in full", "تفاصيل ما ينتظره هذا")}
                  <ArrowRight className="w-3 h-3" />
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/*
        🔴 THE SLOT ITSELF. An empty state that teaches rather than apologises:
        what an integration costs to add, and what asking for one involves.
      */}
      <Card className="border-dashed border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("Need something else connected?", "تحتاج ربط شيء آخر؟")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            {t(
              "Nothing else is planned right now, and that is deliberate — a list of integrations nobody is building would imply a roadmap that does not exist.",
              "لا يوجد شيء آخر مخطَّط حاليًا، وهذا مقصود — فقائمة تكاملات لا يبنيها أحد توحي بخطة غير موجودة.",
            )}
          </p>
          <p>
            {t(
              "Ask, and it gets a design and an estimate before anyone writes code. Most of the work in an integration is the agreement and the edge cases, not the connection itself.",
              "اطلبه، وسيحصل على تصميم وتقدير قبل كتابة أي شيفرة. فمعظم العمل في التكامل يكمن في الاتفاقية والحالات الاستثنائية، لا في الربط ذاته.",
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
