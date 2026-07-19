import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DollarSign, FileText, TrendingUp, PieChart, Users, BarChart3,
  Archive, Lock, Sparkles, ChevronRight,
} from "lucide-react";

interface ReportItem {
  label: string;
  href?: string;
  locked?: boolean;
  isNew?: boolean;
}

interface ReportCategory {
  label: string;
  icon: React.ElementType;
  reports: ReportItem[];
}

const CATEGORIES: ReportCategory[] = [
  {
    label: "Financial Reports",
    icon: DollarSign,
    reports: [
      { label: "Income Statement",                    href: "/income-statement" },
      { label: "Balance Sheet",                       href: "/balance-sheet" },
      { label: "Journal Report",                      href: "/reports/journal-report" },
      { label: "Trial Balance",                       href: "/trial-balance" },
      { label: "Account Statement",                   href: "/reports/account-statement" },
      { label: "Account Summary",                     href: "/reports/account-summary" },
      { label: "Cashflow Report",                     locked: true },
      { label: "General Ledger",                      href: "/reports/general-ledger" },
      { label: "Income Statement Actual Vs Budget",   locked: true },
      { label: "Customer Ledger Report",              href: "/reports/customer-ledger", isNew: true },
      { label: "Change in Owner Equity Statement",    href: "/reports/owner-equity",    isNew: true },
    ],
  },
  {
    label: "Operation Reports",
    icon: FileText,
    reports: [
      { label: "Sales and Purchase Summary",      locked: true },
      { label: "A/R by Customer",                 locked: true },
      { label: "A/P by Vendor",                   locked: true },
      { label: "Aged Open Quotation",             locked: true },
      { label: "Aged Open Invoices",              locked: true },
      { label: "Aged Open Purchase Orders",       locked: true },
      { label: "Aged Open Bills",                 locked: true },
      { label: "Product Locations Summary",       locked: true },
      { label: "Aging Reports",                   href: "/reports/aging",           isNew: true },
      { label: "Invoice Details & Margin Report", locked: true,                      isNew: true },
    ],
  },
  {
    label: "Sales Reports",
    icon: TrendingUp,
    reports: [
      { label: "Product Sales Trend Line",        locked: true },
      { label: "Product Purchases Trend Line",    locked: true },
      { label: "New Customers Trend Line",        locked: true },
      { label: "Number of Invoices Trend Line",   locked: true },
      { label: "Product Sales Pie Chart",         locked: true },
      { label: "Product Cost & Margin Report",    locked: true, isNew: true },
    ],
  },
  {
    label: "Tax Reports",
    icon: PieChart,
    reports: [
      { label: "Tax Return Form",                 href: "/vat" },
      { label: "Invoice Taxes Report",            locked: true },
      { label: "Bill Taxes Report",               locked: true },
      { label: "Credit Note Taxes Report",        locked: true },
      { label: "Debit Note Taxes Report",         locked: true },
      { label: "Tax Journal Entries",             href: "/reports/tax-journal-entries", isNew: true },
    ],
  },
  {
    label: "Employee Reports",
    icon: Users,
    reports: [
      { label: "Employees Salary Report",         locked: true },
      { label: "Employee Account Statement",      locked: true },
    ],
  },
  {
    label: "Fixed Asset Reports",
    icon: BarChart3,
    reports: [
      { label: "Fixed Asset Registry Report",     locked: true },
    ],
  },
  {
    label: "Other Reports",
    icon: Archive,
    reports: [
      { label: "Activity Report",                 href: "/reports/activity" },
      { label: "Analysis by Dimensions Report",   locked: true },
      { label: "Deferral Transactions Report",    locked: true, isNew: true },
    ],
  },
];

function NewBadge() {
  return (
    <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/20 leading-none">
      New
    </span>
  );
}

function ReportLink({ item }: { item: ReportItem }) {
  if (item.locked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2 py-1.5 px-2 rounded-md cursor-not-allowed group">
            <Lock className="w-3 h-3 text-muted-foreground/40 shrink-0" />
            <span className="text-sm text-muted-foreground/50 select-none leading-snug">
              {item.label}
            </span>
            {item.isNew && <NewBadge />}
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          Upgrade to unlock this report
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Link href={item.href!}>
      <div className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-secondary/60 transition-colors group cursor-pointer">
        <ChevronRight className="w-3 h-3 text-muted-foreground/40 group-hover:text-primary transition-colors shrink-0" />
        <span className="text-sm text-foreground leading-snug">{item.label}</span>
        {item.isNew && <NewBadge />}
      </div>
    </Link>
  );
}

function CategoryCard({ cat }: { cat: ReportCategory }) {
  const Icon = cat.icon;
  return (
    <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-blue-400" />
        </div>
        <h2 className="font-bold text-foreground text-sm tracking-tight leading-tight">{cat.label}</h2>
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
  const total    = CATEGORIES.flatMap(c => c.reports).length;
  const unlocked = CATEGORIES.flatMap(c => c.reports).filter(r => !r.locked).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Reports</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {unlocked} available · {total - unlocked} premium · {total} total
        </p>
      </div>

      {/* Upgrade banner */}
      <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-amber-500/20 bg-amber-500/5">
        <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
        <p className="text-sm text-amber-400">
          <span className="font-semibold">Unlock premium reports</span>
          <span className="text-amber-400/70"> — upgrade your plan to access all {total - unlocked} locked reports.</span>
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
