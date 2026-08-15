import { Link } from "wouter";
import { useLanguage } from "@/contexts/LanguageContext";
import { DollarSign, FileText, PieChart, Archive, ChevronRight } from "lucide-react";

/**
 * The reports catalogue (M18.0 — owner decision Q9).
 *
 * 🔴 WHAT THIS PAGE USED TO BE, so nobody restores it:
 *
 * A catalogue of 39 reports of which 13 existed. The other 26 were
 * `locked: true` — rendered greyed out, with a padlock, a tooltip reading
 * "Upgrade to unlock this report", a header counter reading
 * "13 available · 26 premium · 39 total", and a banner offering to
 * "upgrade your plan to access all 26 locked reports".
 *
 * There is no plan. There is no billing system, no subscription model, no
 * pricing decision, and no paid tier anywhere in this product. So the page was
 * not merely promising reports that did not exist — it was making a COMMERCIAL
 * claim that was false in both halves: a tier the tenant cannot buy, gating
 * reports nobody has written.
 *
 * One of the "premium" entries was worse still: "Cashflow Report" was padlocked
 * while `/cash-flow` has been a built, routed, navigable page the whole time.
 * The catalogue was charging for something already shipped. It is restored
 * below with its real link rather than deleted.
 *
 * Every entry here now resolves to a route that exists. If you add one, add the
 * page in the same change — an entry whose href 404s is the same defect wearing
 * a different costume.
 */
interface ReportItem {
  label: string;
  labelAr: string;
  href: string;
  isNew?: boolean;
}

interface ReportCategory {
  label: string;
  labelAr: string;
  icon: React.ElementType;
  reports: ReportItem[];
}

const CATEGORIES: ReportCategory[] = [
  {
    label: "Financial Reports",
    labelAr: "التقارير المالية",
    icon: DollarSign,
    reports: [
      { label: "Income Statement",                 labelAr: "قائمة الدخل",                  href: "/income-statement" },
      { label: "Balance Sheet",                    labelAr: "الميزانية العمومية",           href: "/balance-sheet" },
      { label: "Cash Flow",                        labelAr: "التدفق النقدي",                href: "/cash-flow" },
      { label: "Trial Balance",                    labelAr: "ميزان المراجعة",               href: "/trial-balance" },
      { label: "Journal Report",                   labelAr: "تقرير اليومية",                href: "/reports/journal-report" },
      { label: "General Ledger",                   labelAr: "دفتر الأستاذ العام",           href: "/reports/general-ledger" },
      { label: "Account Statement",                labelAr: "كشف الحساب",                   href: "/reports/account-statement" },
      { label: "Account Summary",                  labelAr: "ملخص الحساب",                  href: "/reports/account-summary" },
      { label: "Customer Ledger Report",           labelAr: "تقرير حساب العميل",            href: "/reports/customer-ledger", isNew: true },
      { label: "Change in Owner Equity Statement", labelAr: "قائمة التغير في حقوق الملكية", href: "/reports/owner-equity",    isNew: true },
    ],
  },
  {
    label: "Operation Reports",
    labelAr: "تقارير العمليات",
    icon: FileText,
    reports: [
      { label: "Aging Reports", labelAr: "تقارير الأعمار", href: "/reports/aging", isNew: true },
    ],
  },
  {
    label: "Tax Reports",
    labelAr: "التقارير الضريبية",
    icon: PieChart,
    reports: [
      { label: "Tax Return Form",     labelAr: "نموذج الإقرار الضريبي", href: "/vat" },
      { label: "Tax Journal Entries", labelAr: "قيود اليومية الضريبية", href: "/reports/tax-journal-entries", isNew: true },
    ],
  },
  {
    label: "Other Reports",
    labelAr: "تقارير أخرى",
    icon: Archive,
    reports: [
      { label: "Activity Report", labelAr: "تقرير النشاط", href: "/reports/activity" },
    ],
  },
];

// "Sales Reports", "Employee Reports" and "Fixed Asset Reports" are gone: every
// entry in all three was a placeholder, so the categories emptied completely.
// An empty category card is the same promise in a thinner disguise.

function NewBadge() {
  const { t } = useLanguage();
  return (
    <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/20 leading-none">
      {t("New", "جديد")}
    </span>
  );
}

function ReportLink({ item }: { item: ReportItem }) {
  const { t } = useLanguage();
  return (
    <Link href={item.href}>
      <div className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-secondary/60 transition-colors group cursor-pointer">
        <ChevronRight className="w-3 h-3 text-muted-foreground/40 group-hover:text-primary transition-colors shrink-0" />
        <span className="text-sm text-foreground leading-snug">{t(item.label, item.labelAr)}</span>
        {item.isNew && <NewBadge />}
      </div>
    </Link>
  );
}

function CategoryCard({ cat }: { cat: ReportCategory }) {
  const { t } = useLanguage();
  const Icon = cat.icon;
  return (
    <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-blue-400" />
        </div>
        <h2 className="font-bold text-foreground text-sm tracking-tight leading-tight">{t(cat.label, cat.labelAr)}</h2>
      </div>

      <div className="h-px bg-border" />

      <div className="flex flex-col gap-0.5">
        {cat.reports.map((r) => (
          <ReportLink key={r.label} item={r} />
        ))}
      </div>
    </div>
  );
}

export default function ReportsHub() {
  const { t } = useLanguage();
  const total = CATEGORIES.flatMap((c) => c.reports).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("Reports", "التقارير")}</h1>
        {/*
          One count, and it counts real things. The old header split it into
          "available / premium / total" — two thirds of which described reports
          that did not exist and a tier that could not be bought.
        */}
        <p className="text-muted-foreground text-sm mt-1">
          {total} {t("reports", "تقارير")}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {CATEGORIES.map((cat) => (
          <CategoryCard key={cat.label} cat={cat} />
        ))}
      </div>
    </div>
  );
}
