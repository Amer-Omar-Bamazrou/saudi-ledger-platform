import { useState } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { Badge } from "@/components/ui/badge";
import {
  LayoutDashboard, ListOrdered, BrainCog, UploadCloud,
  Receipt, Landmark, Tags, Users, Building2, FileText, FileInput,
  BookOpen, Scale, TrendingUp, BarChart3, Waves, UserCheck, Banknote,
  Package, ShoppingBag, CreditCard, Target, AlertCircle, ChevronDown,
  ChevronRight, LogOut, KeyRound, UserCog,
} from "lucide-react";

type NavItem = { href?: string; label: string; icon: React.ElementType; children?: NavItem[] };

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
      { href: "/users", label: "User Management", icon: UserCog },
      { href: "/change-password", label: "Change Password", icon: KeyRound },
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

const ROLE_COLOR: Record<string, string> = {
  admin: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  accountant: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  viewer: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      {/* Sidebar */}
      <aside className="w-60 border-r border-border bg-sidebar shrink-0 flex flex-col">
        {/* Brand */}
        <div className="h-14 flex items-center px-4 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-primary flex items-center justify-center shrink-0">
              <span className="text-xs font-bold text-background">ك</span>
            </div>
            <div>
              <span className="font-bold text-base text-primary tracking-tight">KSA Ledger</span>
              <div className="text-xs text-muted-foreground -mt-0.5">ERP · Accounting</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 px-2 overflow-y-auto">
          {navGroups.map(g => (
            <NavGroup key={g.label} group={g} location={location} />
          ))}
        </nav>

        {/* User footer */}
        {user && (
          <div className="border-t border-border p-3 space-y-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                <span className="text-xs font-bold text-primary">{user.name.charAt(0).toUpperCase()}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-foreground truncate">{user.name}</p>
                <p className="text-xs text-muted-foreground truncate">{user.email}</p>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded border", ROLE_COLOR[user.role] ?? ROLE_COLOR.viewer)}>
                {user.role.toUpperCase()}
              </span>
              <button
                onClick={logout}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-red-400 transition-colors"
                title="Sign out"
              >
                <LogOut className="w-3 h-3" />
                Sign out
              </button>
            </div>
          </div>
        )}
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex-1 overflow-auto p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
