import { Link } from "wouter";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DollarSign, FileText, TrendingUp, PieChart, Users, BarChart3,
  Archive, Lock, Sparkles, ChevronRight,
} from "lucide-react";

interface ReportItem {
  label: string;
  labelAr: string;
  href?: string;
  locked?: boolean;
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
      { label: "Income Statement",                    labelAr: "قائمة الدخل",                         href: "/income-statement" },
      { label: "Balance Sheet",                       labelAr: "الميزانية العمومية",                  href: "/balance-sheet" },
      { label: "Journal Report",                      labelAr: "تقرير اليومية",                       href: "/reports/journal-report" },
      { label: "Trial Balance",                       labelAr: "ميزان المراجعة",                      href: "/trial-balance" },
      { label: "Account Statement",                   labelAr: "كشف الحساب",                          href: "/reports/account-statement" },
      { label: "Account Summary",                     labelAr: "ملخص الحساب",                         href: "/reports/account-summary" },
      { label: "Cashflow Report",                     labelAr: "تقرير التدفق النقدي",                  locked: true },
      { label: "General Ledger",                      labelAr: "دفتر الأستاذ العام",                  href: "/reports/general-ledger" },
      { label: "Income Statement Actual Vs Budget",   labelAr: "قائمة الدخل الفعلي مقابل الميزانية",  locked: true },
      { label: "Customer Ledger Report",              labelAr: "تقرير حساب العميل",                   href: "/reports/customer-ledger", isNew: true },
      { label: "Change in Owner Equity Statement",    labelAr: "قائمة التغير في حقوق الملكية",        href: "/reports/owner-equity",    isNew: true },
    ],
  },
  {
    label: "Operation Reports",
    labelAr: "تقارير العمليات",
    icon: FileText,
    reports: [
      { label: "Sales and Purchase Summary",      labelAr: "ملخص المبيعات والمشتريات",    locked: true },
      { label: "A/R by Customer",                 labelAr: "الذمم المدينة حسب العميل",     locked: true },
      { label: "A/P by Vendor",                   labelAr: "الذمم الدائنة حسب المورد",     locked: true },
      { label: "Aged Open Quotation",             labelAr: "عروض الأسعار المفتوحة المتأخرة", locked: true },
      { label: "Aged Open Invoices",              labelAr: "الفواتير المفتوحة المتأخرة",   locked: true },
      { label: "Aged Open Purchase Orders",       labelAr: "أوامر الشراء المفتوحة المتأخرة", locked: true },
      { label: "Aged Open Bills",                 labelAr: "الفواتير المستحقة المتأخرة",   locked: true },
      { label: "Product Locations Summary",       labelAr: "ملخص مواقع المنتجات",          locked: true },
      { label: "Aging Reports",                   labelAr: "تقارير الأعمار",               href: "/reports/aging",           isNew: true },
      { label: "Invoice Details & Margin Report", labelAr: "تفاصيل الفاتورة وتقرير الهامش", locked: true,                      isNew: true },
    ],
  },
  {
    label: "Sales Reports",
    labelAr: "تقارير المبيعات",
    icon: TrendingUp,
    reports: [
      { label: "Product Sales Trend Line",        labelAr: "اتجاه مبيعات المنتجات",       locked: true },
      { label: "Product Purchases Trend Line",    labelAr: "اتجاه مشتريات المنتجات",      locked: true },
      { label: "New Customers Trend Line",        labelAr: "اتجاه العملاء الجدد",          locked: true },
      { label: "Number of Invoices Trend Line",   labelAr: "اتجاه عدد الفواتير",           locked: true },
      { label: "Product Sales Pie Chart",         labelAr: "مخطط دائري لمبيعات المنتجات", locked: true },
      { label: "Product Cost & Margin Report",    labelAr: "تقرير تكلفة وهامش المنتجات",  locked: true, isNew: true },
    ],
  },
  {
    label: "Tax Reports",
    labelAr: "التقارير الضريبية",
    icon: PieChart,
    reports: [
      { label: "Tax Return Form",                 labelAr: "نموذج الإقرار الضريبي",        href: "/vat" },
      { label: "Invoice Taxes Report",            labelAr: "تقرير ضرائب الفواتير",         locked: true },
      { label: "Bill Taxes Report",               labelAr: "تقرير ضرائب الفواتير الواردة", locked: true },
      { label: "Credit Note Taxes Report",        labelAr: "تقرير ضرائب إشعارات الدائن",   locked: true },
      { label: "Debit Note Taxes Report",         labelAr: "تقرير ضرائب إشعارات المدين",   locked: true },
      { label: "Tax Journal Entries",             labelAr: "قيود اليومية الضريبية",        href: "/reports/tax-journal-entries", isNew: true },
    ],
  },
  {
    label: "Employee Reports",
    labelAr: "تقارير الموظفين",
    icon: Users,
    reports: [
      { label: "Employees Salary Report",         labelAr: "تقرير رواتب الموظفين",         locked: true },
      { label: "Employee Account Statement",      labelAr: "كشف حساب الموظف",              locked: true },
    ],
  },
  {
    label: "Fixed Asset Reports",
    labelAr: "تقارير الأصول الثابتة",
    icon: BarChart3,
    reports: [
      { label: "Fixed Asset Registry Report",     labelAr: "تقرير سجل الأصول الثابتة",    locked: true },
    ],
  },
  {
    label: "Other Reports",
    labelAr: "تقارير أخرى",
    icon: Archive,
    reports: [
      { label: "Activity Report",                 labelAr: "تقرير النشاط",                  href: "/reports/activity" },
      { label: "Analysis by Dimensions Report",   labelAr: "تقرير التحليل حسب الأبعاد",    locked: true },
      { label: "Deferral Transactions Report",    labelAr: "تقرير معاملات الترحيل المؤجل", locked: true, isNew: true },
    ],
  },
];

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
  if (item.locked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2 py-1.5 px-2 rounded-md cursor-not-allowed group">
            <Lock className="w-3 h-3 text-muted-foreground/40 shrink-0" />
            <span className="text-sm text-muted-foreground/50 select-none leading-snug">
              {t(item.label, item.labelAr)}
            </span>
            {item.isNew && <NewBadge />}
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          {t("Upgrade to unlock this report", "قم بالترقية لفتح هذا التقرير")}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Link href={item.href!}>
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
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-blue-400" />
        </div>
        <h2 className="font-bold text-foreground text-sm tracking-tight leading-tight">{t(cat.label, cat.labelAr)}</h2>
      </div>

      {/* Divider */}
      <div className="h-px bg-border" />

      {/* Report links */}
      <div className="flex flex-col gap-0.5">
        {cat.reports.map(r => (
          <ReportLink key={r.label} item={r} />
        ))}
      </div>
    </div>
  );
}

export default function ReportsHub() {
  const { t } = useLanguage();
  const total    = CATEGORIES.flatMap(c => c.reports).length;
  const unlocked = CATEGORIES.flatMap(c => c.reports).filter(r => !r.locked).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("Reports", "التقارير")}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {unlocked} {t("available", "متاح")} · {total - unlocked} {t("premium", "مميز")} · {total} {t("total", "الإجمالي")}
        </p>
      </div>

      {/* Upgrade banner */}
      <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-amber-500/20 bg-amber-500/5">
        <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
        <p className="text-sm text-amber-400">
          <span className="font-semibold">{t("Unlock premium reports", "افتح التقارير المميزة")}</span>
          <span className="text-amber-400/70"> — {t("upgrade your plan to access all", "قم بترقية خطتك للوصول إلى جميع")} {total - unlocked} {t("locked reports.", "التقارير المقفلة.")}</span>
        </p>
      </div>

      {/* Category grid — 3 columns desktop, 2 tablet, 1 mobile */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {CATEGORIES.map(cat => (
          <CategoryCard key={cat.label} cat={cat} />
        ))}
      </div>
    </div>
  );
}
