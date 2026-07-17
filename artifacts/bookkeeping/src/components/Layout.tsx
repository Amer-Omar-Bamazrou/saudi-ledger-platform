import { useState } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard, ListOrdered, BrainCog, UploadCloud,
  Receipt, Landmark, Tags, Users, Building2, FileText, FileInput,
  BookOpen, Scale, TrendingUp, BarChart3, Waves, UserCheck, Banknote,
  Package, ShoppingBag, CreditCard, Target, AlertCircle, ChevronDown, ChevronRight,
} from "lucide-react";

type NavItem = {
  href?: string;
  label: string;
  icon: React.ElementType;
  children?: NavItem[];
};

const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/transactions", label: "Transactions", icon: ListOrdered },
      { href: "/bank-accounts", label: "Bank Accounts", icon: CreditCard },
    ],
  },
  {
    label: "Receivables (AR)",
    items: [
      { href: "/customers", label: "Customers", icon: Users },
      { href: "/invoices", label: "Invoices", icon: FileText },
      { href: "/ar-aging", label: "AR Aging", icon: AlertCircle },
    ],
  },
  {
    label: "Payables (AP)",
    items: [
      { href: "/vendors", label: "Vendors", icon: Building2 },
      { href: "/bills", label: "Bills", icon: FileInput },
    ],
  },
  {
    label: "General Ledger",
    items: [
      { href: "/journal-entries", label: "Journal Entries", icon: BookOpen },
      { href: "/trial-balance", label: "Trial Balance", icon: Scale },
    ],
  },
  {
    label: "Reports",
    items: [
      { href: "/income-statement", label: "Income Statement", icon: TrendingUp },
      { href: "/balance-sheet", label: "Balance Sheet", icon: BarChart3 },
      { href: "/cash-flow", label: "Cash Flow", icon: Waves },
      { href: "/vat", label: "VAT Report", icon: Receipt },
      { href: "/zakat", label: "Zakat Report", icon: Landmark },
    ],
  },
  {
    label: "HR & Payroll",
    items: [
      { href: "/employees", label: "Employees", icon: UserCheck },
      { href: "/payroll", label: "Payroll", icon: Banknote },
    ],
  },
  {
    label: "Assets & Inventory",
    items: [
      { href: "/assets", label: "Fixed Assets", icon: Package },
      { href: "/products", label: "Products & Services", icon: ShoppingBag },
    ],
  },
  {
    label: "AI Tools",
    items: [
      { href: "/categorize", label: "Categorization Engine", icon: BrainCog },
      { href: "/upload", label: "Upload Data", icon: UploadCloud },
    ],
  },
  {
    label: "Planning",
    items: [
      { href: "/budgets", label: "Budgets", icon: Target },
    ],
  },
  {
    label: "Settings",
    items: [
      { href: "/categories", label: "Chart of Accounts", icon: Tags },
    ],
  },
];

function NavGroup({ group, location }: { group: typeof navGroups[0]; location: string }) {
  const hasActive = group.items.some(i => i.href === location);
  const [open, setOpen] = useState(hasActive || ["Overview", "Receivables (AR)", "Payables (AP)"].includes(group.label));

  return (
    <div>
      <button
        onClick={() => setOpen(p => !p)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      >
        {group.label}
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {open && (
        <div className="space-y-0.5 mt-0.5 mb-2">
          {group.items.map(link => {
            const Icon = link.icon;
            const isActive = location === link.href;
            return (
              <Link
                key={link.href}
                href={link.href!}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
                )}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{link.label}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      {/* Sidebar */}
      <aside className="w-60 border-r border-border bg-sidebar shrink-0 flex flex-col">
        <div className="h-14 flex items-center px-4 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-primary flex items-center justify-center shrink-0">
              <div className="w-3 h-3 bg-background rounded-sm" />
            </div>
            <div>
              <span className="font-bold text-base text-primary tracking-tight">KSA Ledger</span>
              <div className="text-xs text-muted-foreground -mt-0.5">ERP · Accounting</div>
            </div>
          </div>
        </div>
        <nav className="flex-1 py-3 px-2 space-y-0 overflow-y-auto">
          {navGroups.map(g => (
            <NavGroup key={g.label} group={g} location={location} />
          ))}
        </nav>
        <div className="p-3 border-t border-border text-xs text-muted-foreground font-mono">
          System: <span className="text-emerald-400">Online</span>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex-1 overflow-auto p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
