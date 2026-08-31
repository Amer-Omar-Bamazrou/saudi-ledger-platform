/**
 * The COMING SOON page — one component, driven entirely by `lib/comingSoon.ts`.
 *
 * ── 🔴 WHY ONE PAGE AND NOT FORTY ──────────────────────────────────────────
 * About a third of the approved navigation tree is Coming Soon. Forty
 * hand-written placeholders would drift within a month: some would name their
 * blocker, some would say "coming soon", and the ones written last would copy
 * whichever neighbour the author happened to open. The rule ("every page names
 * what it is waiting on, specifically") only survives if it is a REQUIRED FIELD
 * rather than an instruction — so the content is data, the type demands the
 * blocker and the work order, and this file is the renderer.
 *
 * ── 🔴 THIS IS NOT A DEAD END, AND IT MUST NOT LOOK LIKE ONE ───────────────
 * A placeholder is what a user meets when they trusted the navigation. It owes
 * them three things: an honest statement that the thing does not exist, the
 * REASON in terms they can act on, and — where a capability is already live
 * under a different surface — a way through to it. A page that says only
 * "coming soon" teaches the user to distrust every other entry in the sidebar.
 */
import { useRoute, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Clock, ArrowLeft, CircleCheck, UserRoundCheck } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { BLOCKERS, comingSoonEntry } from "@/lib/comingSoon";

export default function ComingSoon() {
  const [, params] = useRoute("/coming-soon/:slug");
  const { t, lang } = useLanguage();
  const ar = lang === "ar";
  const entry = params?.slug ? comingSoonEntry(params.slug) : undefined;

  /**
   * 🔴 An unknown slug is a NAVIGATION defect, and it says so rather than
   * rendering a generic placeholder. A placeholder that absorbs any slug would
   * make a broken nav entry indistinguishable from a working one — and the
   * whole point of this pass was to remove entries that quietly pointed at
   * nothing. `e2e/nav-tree.spec.ts` asserts this branch is unreachable from the
   * navigation; if a user ever sees it, the tree and the registry have drifted.
   */
  if (!entry) {
    return (
      <div className="p-6">
        <Card className="border-negative-surface/40">
          <CardHeader>
            <CardTitle className="text-base text-negative">
              {t("This page does not exist", "هذه الصفحة غير موجودة")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              {t(
                "A navigation entry pointed here, and nothing is registered for it. That is a defect in the navigation, not something you did.",
                "أشار أحد عناصر التنقل إلى هنا، ولا يوجد تسجيل مقابل له. هذا خلل في التنقل، وليس خطأً منك.",
              )}
            </p>
            <Link href="/">
              <Button variant="outline" size="sm" className="gap-2">
                <ArrowLeft className="w-4 h-4" />
                {t("Back to the dashboard", "العودة إلى لوحة التحكم")}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const blocker = BLOCKERS[entry.blocker];
  const isOwnerAction = "ownerAction" in blocker && blocker.ownerAction === true;

  return (
    <div className="p-6 max-w-3xl space-y-6" data-testid="coming-soon" data-slug={entry.slug} data-blocker={entry.blocker}>
      <div>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold text-foreground">{ar ? entry.titleAr : entry.title}</h1>
          <Badge className="bg-attention-surface/20 text-attention border-attention-surface/30 gap-1">
            <Clock className="w-3 h-3" />
            {/*
              🔴 "Not available yet", never "not built yet". For several of
              these the code IS built — AI-6a is finished and dark by
              construction, debit notes post correctly, transfers post to the
              GL — and "not built" would be a false statement on those pages,
              in the one place a reader has come specifically to find out what
              is true. Unavailable is the fact common to all of them.
            */}
            {t("Not available yet", "غير متاح بعد")}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-2">{ar ? entry.summaryAr : entry.summary}</p>
      </div>

      {/*
        🔴 THE CAPABILITY NOTE COMES FIRST WHEN THERE IS ONE.
        Some of these are a missing SCREEN over a working capability — debit
        notes post correctly, transfers post to the GL, the AI answers are
        built and dark. Reading "coming soon" over a live capability would send
        someone off to rebuild machinery that already works, which is the
        claimed-but-unreachable disease running in reverse.
      */}
      {entry.capabilityLive && (
        <Card className="border-positive-surface/40 bg-positive-surface/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-positive">
              <CircleCheck className="w-4 h-4" />
              {t("What already works", "ما يعمل بالفعل")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-foreground/90">
            {ar ? entry.capabilityLiveAr : entry.capabilityLive}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            {isOwnerAction && <UserRoundCheck className="w-4 h-4 text-attention" />}
            {t("What this is waiting on", "ما الذي ينتظره هذا")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="font-semibold text-foreground" data-testid="coming-soon-blocker">
            {ar ? blocker.nameAr : blocker.name}
          </p>
          <p className="text-muted-foreground">{ar ? blocker.clearedByAr : blocker.clearedBy}</p>
          {isOwnerAction && (
            <p className="text-xs text-attention border-s-2 border-attention-surface/40 ps-3">
              {t(
                "This is an owner action. No amount of development work moves it.",
                "هذه من مهام المالك. لا يحرّكها أي قدر من أعمال التطوير.",
              )}
            </p>
          )}
        </CardContent>
      </Card>

      {/*
        🔴 THE WORK ORDER — the corollary that makes the placeholder useful the
        day the blocker clears. "Waiting on a contract" is a queue item the
        moment the contract is signed, but only if the page says what to do
        next in enough detail to act on.
      */}
      <Card className="border-info-surface/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-info">
            {t("The day that clears, this is the work", "يوم يزول ذلك، هذا هو العمل المطلوب")}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-foreground/90" data-testid="coming-soon-work-order">
          {ar ? entry.whenClearedAr : entry.whenCleared}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        {t(
          "This page is deliberate. Every unbuilt feature in the navigation says what it is waiting on, so that nobody spends effort on something that cannot ship — and so that nothing in the sidebar is a dead click.",
          "هذه الصفحة مقصودة. كل ميزة غير مبنية في التنقل تُفصح عمّا تنتظره، حتى لا يُبذل جهد في ما لا يمكن إطلاقه، وحتى لا يكون في القائمة الجانبية نقرة ميتة.",
        )}
      </p>
    </div>
  );
}
