import { Link } from "wouter";
import { useLanguage } from "@/contexts/LanguageContext";
import { ChevronRight } from "lucide-react";
import { PageHeader, Panel } from "@/components/kit";

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
  /** One line on what the report answers — shown under its name in the index. */
  description: string;
  descriptionAr: string;
  isNew?: boolean;
}

interface ReportCategory {
  label: string;
  labelAr: string;
  description: string;
  descriptionAr: string;
  reports: ReportItem[];
}

const CATEGORIES: ReportCategory[] = [
  {
    label: "Financial Reports",
    labelAr: "التقارير المالية",
    description: "The statements, and the ledgers behind them.",
    descriptionAr: "القوائم المالية والدفاتر التي تستند إليها.",
    reports: [
      { label: "Income Statement",                 labelAr: "قائمة الدخل",                  href: "/income-statement",
        description: "Revenue and expenses for a period, and the net result.", descriptionAr: "الإيرادات والمصروفات لفترة، وصافي النتيجة." },
      { label: "Balance Sheet",                    labelAr: "الميزانية العمومية",           href: "/balance-sheet",
        description: "Assets, liabilities and equity at a date.", descriptionAr: "الأصول والخصوم وحقوق الملكية في تاريخ محدد." },
      { label: "Cash Flow",                        labelAr: "التدفق النقدي",                href: "/cash-flow",
        description: "Cash in and out, by operating, investing and financing activity.", descriptionAr: "النقد الداخل والخارج حسب الأنشطة التشغيلية والاستثمارية والتمويلية." },
      { label: "Trial Balance",                    labelAr: "ميزان المراجعة",               href: "/trial-balance",
        description: "Debit and credit totals for every account, and whether they agree.", descriptionAr: "مجاميع المدين والدائن لكل حساب، ومدى تطابقها." },
      { label: "Journal Report",                   labelAr: "تقرير اليومية",                href: "/reports/journal-report",
        description: "Posted journal entries, each with its debit and credit lines.", descriptionAr: "قيود اليومية المرحّلة، كل قيد بسطوره المدينة والدائنة." },
      { label: "General Ledger",                   labelAr: "دفتر الأستاذ العام",           href: "/reports/general-ledger",
        description: "Journal lines in date order with a running balance.", descriptionAr: "سطور القيود بترتيب التاريخ مع الرصيد الجاري." },
      { label: "Account Statement",                labelAr: "كشف الحساب",                   href: "/reports/account-statement",
        description: "Opening balance, movements and closing balance for one account.", descriptionAr: "الرصيد الافتتاحي والحركات والرصيد الختامي لحساب واحد." },
      { label: "Account Summary",                  labelAr: "ملخص الحساب",                  href: "/reports/account-summary",
        description: "Opening, period movement and closing balance for every account.", descriptionAr: "الرصيد الافتتاحي وحركة الفترة والرصيد الختامي لكل حساب." },
      { label: "Customer Ledger Report",           labelAr: "تقرير حساب العميل",            href: "/reports/customer-ledger", isNew: true,
        description: "Invoices, payments and the balance owed, per customer.", descriptionAr: "الفواتير والمدفوعات والرصيد المستحق لكل عميل." },
      { label: "Change in Owner Equity Statement", labelAr: "قائمة التغير في حقوق الملكية", href: "/reports/owner-equity",    isNew: true,
        description: "Opening equity to closing equity, through income, contributions and drawings.", descriptionAr: "من حقوق الملكية الافتتاحية إلى الختامية عبر الدخل والمساهمات والمسحوبات." },
    ],
  },
  {
    label: "Operation Reports",
    labelAr: "تقارير العمليات",
    description: "What is owed, and how long it has been owed.",
    descriptionAr: "ما هو مستحق، ومنذ متى.",
    reports: [
      { label: "Aging Reports", labelAr: "تقارير الأعمار", href: "/reports/aging", isNew: true,
        description: "Receivables and payables grouped by days overdue.", descriptionAr: "الذمم المدينة والدائنة مجمّعة حسب أيام التأخر." },
    ],
  },
  {
    label: "Tax Reports",
    labelAr: "التقارير الضريبية",
    description: "The ledger's view of VAT. The VAT return itself is in the Finance Hub.",
    descriptionAr: "ضريبة القيمة المضافة من منظور الدفتر. الإقرار الضريبي نفسه في المركز المالي.",
    reports: [
      // M18.5 (Q6) — the VAT return moved to the Finance Hub. "Tax Journal
      // Entries" stays: it is an accountant's report, and Q4 puts anything
      // needing accounting vocabulary in Reports rather than the hub.
      { label: "Tax Journal Entries", labelAr: "قيود اليومية الضريبية", href: "/reports/tax-journal-entries", isNew: true,
        description: "Journal entries that touch VAT or tax accounts.", descriptionAr: "قيود اليومية التي تمس حسابات الضريبة." },
    ],
  },
  {
    label: "Other Reports",
    labelAr: "تقارير أخرى",
    description: "Everything else the ledger can tell you.",
    descriptionAr: "كل ما يمكن أن يخبرك به الدفتر أيضًا.",
    reports: [
      { label: "Activity Report", labelAr: "تقرير النشاط", href: "/reports/activity",
        description: "Every journal entry in a period — posted, draft and reversed.", descriptionAr: "كل قيود اليومية في فترة — المرحّلة والمسودات والمعكوسة." },
    ],
  },
];

// "Sales Reports", "Employee Reports" and "Fixed Asset Reports" are gone: every
// entry in all three was a placeholder, so the categories emptied completely.
// An empty category card is the same promise in a thinner disguise.

function NewBadge() {
  const { t } = useLanguage();
  return (
    <span className="ms-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-attention-surface/15 text-attention border border-attention-surface/20 leading-none">
      {t("New", "جديد")}
    </span>
  );
}

function ReportLink({ item }: { item: ReportItem }) {
  const { t } = useLanguage();
  return (
    <li>
      <Link
        href={item.href}
        className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-muted/40"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center text-sm font-medium text-foreground group-hover:text-primary">
            {t(item.label, item.labelAr)}
            {item.isNew && <NewBadge />}
          </div>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{t(item.description, item.descriptionAr)}</p>
        </div>
        <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground/60 group-hover:text-primary transition-colors rtl:-scale-x-100" />
      </Link>
    </li>
  );
}

function CategoryPanel({ cat }: { cat: ReportCategory }) {
  const { t } = useLanguage();
  return (
    <Panel flush title={t(cat.label, cat.labelAr)} description={t(cat.description, cat.descriptionAr)}>
      <ul className="divide-y divide-border/70">
        {cat.reports.map((r) => (
          <ReportLink key={r.label} item={r} />
        ))}
      </ul>
    </Panel>
  );
}

export default function ReportsHub() {
  const { t } = useLanguage();
  const total = CATEGORIES.flatMap((c) => c.reports).length;
  const [primary, ...rest] = CATEGORIES;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/*
        One count, and it counts real things. The old header split it into
        "available / premium / total" — two thirds of which described reports
        that did not exist and a tier that could not be bought.
      */}
      <PageHeader
        title={t("Reports", "التقارير")}
        description={<>{total} {t("reports", "تقارير")}</>}
      />

      {/* The financial reports are most of the catalogue, so they take the main
          column; the short groups stack beside them. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <CategoryPanel cat={primary} />
        <div className="space-y-6">
          {rest.map((cat) => (
            <CategoryPanel key={cat.label} cat={cat} />
          ))}
        </div>
      </div>
    </div>
  );
}
