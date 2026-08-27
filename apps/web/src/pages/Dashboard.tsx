import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import {
  TrendingUp, ShieldCheck, ListChecks, FileText, FileInput, BarChart3, ChevronRight, SearchCheck,
} from "lucide-react";

/**
 * The landing page (M19.4 — owner decision A11).
 *
 * 🔴 THIS USED TO BE THE "FINANCIAL COCKPIT", and it was the third surface
 * answering a question two destinations already own. Three surfaces answering
 * adjacent questions is how the hub/Analytics split fails, so the Cockpit was
 * not moved — it was TAKEN APART, each piece going to whichever destination
 * already owned that question:
 *
 *   Income / expenses / net position  → Analytics (how is the business doing)
 *   Net VAT                           → the Finance Hub's Tax & Compliance
 *                                       block, which already reports it (M18.5)
 *   Transaction + uncategorised counts → the hub's "are your books current"
 *                                       block, which already reports them
 *   Recent transactions               → /transactions, which is that page
 *
 * Three pieces were DELETED rather than rehomed, because they were wrong:
 *
 *   - a card titled "Cash Flow Overview" that charted income, expenses and net
 *     VAT as three bars. It was not cash flow by any reading — /cash-flow is,
 *     and Analytics now charts the real thing;
 *   - "VAT Rate 15%" presented under "System Status", which is a hardcoded
 *     constant wearing the costume of a live reading;
 *   - hardcoded chart colours (#2D3748, #A0AEC0, #1A202C) that assumed a dark
 *     theme and ignored the token system entirely.
 *
 * What remains is a router: where to go, not another set of figures. It states
 * no numbers on purpose — a landing that computes is a fourth surface.
 */

interface Destination {
  href: string;
  icon: React.ElementType;
  en: string;
  ar: string;
  enDesc: string;
  arDesc: string;
}

const PRIMARY: Destination[] = [
  {
    href: "/analytics",
    icon: TrendingUp,
    en: "Analytics",
    ar: "التحليلات",
    enDesc: "How the business is doing over time, and where the change came from.",
    arDesc: "كيف يسير أداء المنشأة عبر الزمن، ومن أين جاء التغيّر.",
  },
  {
    href: "/finance-hub",
    icon: ShieldCheck,
    en: "Finance Hub",
    ar: "لوحة المالية",
    enDesc: "Whether your books are right, current and closed — and whether you can pay what you owe.",
    arDesc: "ما إذا كانت دفاترك صحيحة ومحدَّثة ومقفلة — وما إذا كان بإمكانك سداد ما عليك.",
  },
];

const WORK: Destination[] = [
  {
    href: "/review",
    icon: ListChecks,
    en: "Review",
    ar: "المراجعة",
    enDesc: "Imported transactions waiting for a decision.",
    arDesc: "معاملات مستوردة بانتظار قرار.",
  },
  {
    href: "/invoices",
    icon: FileText,
    en: "Invoices",
    ar: "الفواتير",
    enDesc: "Bill your customers.",
    arDesc: "إصدار فواتير العملاء.",
  },
  {
    href: "/bills",
    icon: FileInput,
    en: "Bills",
    ar: "فواتير الموردين",
    enDesc: "What your suppliers have charged you.",
    arDesc: "ما طالبك به موردوك.",
  },
  {
    href: "/reports",
    icon: BarChart3,
    en: "Reports",
    ar: "التقارير",
    enDesc: "The statements, in full.",
    arDesc: "القوائم المالية كاملة.",
  },
];

function DestinationCard({ d, prominent }: { d: Destination; prominent?: boolean }) {
  const { t } = useLanguage();
  const Icon = d.icon;
  return (
    <Link href={d.href}>
      <Card className="hover:border-primary/40 transition-colors cursor-pointer h-full">
        <CardContent className={prominent ? "p-5" : "p-4"}>
          <div className="flex items-start gap-3">
            <Icon className={`${prominent ? "w-5 h-5" : "w-4 h-4"} text-muted-foreground shrink-0 mt-0.5`} />
            <div className="min-w-0">
              <p className={`font-semibold ${prominent ? "text-base" : "text-sm"} flex items-center gap-1`}>
                {t(d.en, d.ar)}
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/50" />
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{t(d.enDesc, d.arDesc)}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * AI-5's escalation terminus: the persistent marker. 🔴 Owner decisions
 * (2026-08-24): the escalation lands HERE — on the page the tenant actually
 * opens — never in a second email ("email escalating into more email is a
 * longer parking space"). It persists until someone opens the findings;
 * OPENING IS THE DISMISSAL (the M16 one-act principle) — no close button
 * exists, because dismissing without viewing is the exact behavior this
 * exists to prevent. Approver-level roles only: they own the review.
 *
 * The honest limit: this is the LOUDEST the product gets. A tenant who never
 * opens the app is never reached past the one email — recorded, not solved.
 */
function UnreadFindingsMarker() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const isApprover = user?.organizationRole === "admin" || user?.organizationRole === "accountant";
  const { data } = useQuery<{ escalated: boolean; lastScheduledRun: { ranAt: string; openAfter: number } | null }>({
    queryKey: ["findings-status"],
    queryFn: () => apiFetch("/findings/status"),
    enabled: isApprover,
  });
  if (!isApprover || !data?.escalated || !data.lastScheduledRun) return null;
  return (
    <Link href="/findings">
      <Card className="border-foreground/30 cursor-pointer">
        <CardContent className="p-4 flex items-start gap-3">
          <SearchCheck className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold">
              {t(
                `Scheduled findings from ${data.lastScheduledRun.ranAt.slice(0, 10)} have not been opened — ${data.lastScheduledRun.openAfter} open`,
                `ملاحظات الفحص المجدول بتاريخ ${data.lastScheduledRun.ranAt.slice(0, 10)} لم تُفتح بعد — ${data.lastScheduledRun.openAfter} مفتوحة`,
              )}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {t(
                "This notice stays until someone reviews them. Opening the Findings page is what clears it.",
                "يبقى هذا التنبيه حتى تتم مراجعتها. فتح صفحة الملاحظات هو ما يزيله.",
              )}
            </p>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground/50 ms-auto mt-1" />
        </CardContent>
      </Card>
    </Link>
  );
}

export default function Dashboard() {
  const { t } = useLanguage();
  return (
    <div className="space-y-8 max-w-4xl">
      <UnreadFindingsMarker />
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("Where would you like to go?", "إلى أين تريد الذهاب؟")}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {t(
            "The two places that answer a question, and the places where the work happens.",
            "المكانان اللذان يجيبان عن سؤال، والأماكن التي يجري فيها العمل.",
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {PRIMARY.map((d) => (
          <DestinationCard key={d.href} d={d} prominent />
        ))}
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3">
          {t("Where the work happens", "حيث يجري العمل")}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {WORK.map((d) => (
            <DestinationCard key={d.href} d={d} />
          ))}
        </div>
      </div>
    </div>
  );
}
