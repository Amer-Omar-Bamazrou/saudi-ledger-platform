import { useState } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useDeployment } from "@/hooks/useDeployment";
import { Badge } from "@/components/ui/badge";
import { OrgSwitcher } from "@/components/OrgSwitcher";
import {
  LayoutDashboard, ListOrdered, ListChecks, BrainCog, UploadCloud,
  Receipt, Landmark, Tags, Users, Building2, FileText, FileInput,
  BookOpen, Scale, TrendingUp, BarChart3, Waves, UserCheck, Banknote,
  Package, ShoppingBag, CreditCard, Target, AlertCircle, ChevronDown,
  ChevronRight, LogOut, KeyRound, UserCog, ClipboardList, FileMinus,
  ShoppingCart, PieChart, Languages, ShieldCheck, Repeat, CalendarClock, ScrollText,
  SearchCheck,
} from "lucide-react";

type NavItem = {
  href?: string;
  label: string;
  labelAr: string;
  icon: React.ElementType;
  children?: NavItem[];
  /** Hide from non-admins — HONESTY about the 403 the API would return
      (`requirePermission` is the boundary), never the boundary itself. */
  adminOnly?: boolean;
};

const navGroupsData: { label: string; labelAr: string; items: NavItem[] }[] = [
  {
    label: "Overview", labelAr: "نظرة عامة",
    items: [
      { href: "/",              label: "Dashboard",     labelAr: "لوحة التحكم",  icon: LayoutDashboard },
      { href: "/transactions",  label: "Transactions",  labelAr: "المعاملات",     icon: ListOrdered },
      { href: "/review",        label: "Review",        labelAr: "المراجعة",      icon: ListChecks },
      { href: "/bank-accounts", label: "Bank Accounts", labelAr: "الحسابات البنكية", icon: CreditCard },
    ],
  },
  {
    label: "Sales", labelAr: "المبيعات",
    items: [
      { href: "/customers",         label: "Customers",         labelAr: "العملاء",           icon: Users },
      { href: "/quotations",        label: "Quotations",        labelAr: "عروض الأسعار",       icon: ClipboardList },
      { href: "/invoices",          label: "Invoices",          labelAr: "الفواتير",           icon: FileText },
      { href: "/credit-notes",      label: "Credit Notes",      labelAr: "إشعارات الدائن",     icon: FileMinus },
    ],
  },
  {
    label: "Purchases", labelAr: "المشتريات",
    items: [
      { href: "/vendors",         label: "Vendors",         labelAr: "الموردون",            icon: Building2 },
      { href: "/purchase-orders", label: "Purchase Orders", labelAr: "أوامر الشراء",         icon: ShoppingCart },
      { href: "/bills",           label: "Bills",           labelAr: "فواتير الموردين",      icon: FileInput },
    ],
  },
  {
    label: "General Ledger", labelAr: "دفتر الأستاذ",
    items: [
      { href: "/journal-entries", label: "Journal Entries", labelAr: "قيود اليومية",       icon: BookOpen },
      { href: "/approvals",       label: "Approvals",       labelAr: "الموافقات",           icon: ClipboardList },
      { href: "/trial-balance",   label: "Trial Balance",   labelAr: "ميزان المراجعة",      icon: Scale },
    ],
  },
  {
    // Hub decision Q3: the Finance Hub SITS BESIDE Reports rather than
    // replacing it — replacing is a large reorganisation with no user feedback
    // yet. It leads the section because it states conditions, where everything
    // below it is a document you go and read.
    label: "Reports", labelAr: "التقارير",
    items: [
      { href: "/finance-hub",       label: "Finance Hub",      labelAr: "لوحة المالية",            icon: ShieldCheck },
      // AI-3a — deterministic observations; "Findings", never "audit" (design-ai-layer §9).
      { href: "/findings",          label: "Findings",         labelAr: "الملاحظات",                icon: SearchCheck },
      { href: "/analytics",         label: "Analytics",        labelAr: "التحليلات",                 icon: TrendingUp },
      { href: "/reports",           label: "Reports Hub",      labelAr: "مركز التقارير",           icon: BarChart3 },
      { href: "/income-statement",  label: "Income Statement", labelAr: "قائمة الدخل",              icon: TrendingUp },
      { href: "/balance-sheet",     label: "Balance Sheet",    labelAr: "الميزانية العمومية",        icon: BarChart3 },
      { href: "/cash-flow",         label: "Cash Flow",        labelAr: "التدفق النقدي",             icon: Waves },
      { href: "/trial-balance",     label: "Trial Balance",    labelAr: "ميزان المراجعة",            icon: Scale },
      // M18.5 (Q6): the VAT return MOVED to the Finance Hub's Tax & Compliance
      // block. Reached from there, and still directly at /vat.
      // M17.0 — not "Zakat Report": the page states the working paper is not
      // built yet. The entry stays so users who relied on the old (fabricated)
      // figure find the notice rather than a missing page.
      { href: "/zakat",             label: "Zakat",            labelAr: "الزكاة",                    icon: Landmark },
    ],
  },
  {
    label: "HR & Payroll", labelAr: "الموارد البشرية",
    items: [
      { href: "/employees", label: "Employees", labelAr: "الموظفون", icon: UserCheck },
      { href: "/payroll",   label: "Payroll",   labelAr: "الرواتب",  icon: Banknote },
    ],
  },
  {
    label: "Assets & Inventory", labelAr: "الأصول والمخزون",
    items: [
      { href: "/assets",   label: "Fixed Assets",        labelAr: "الأصول الثابتة",     icon: Package },
      { href: "/products", label: "Products & Services", labelAr: "المنتجات والخدمات",  icon: ShoppingBag },
    ],
  },
  {
    label: "AI Tools", labelAr: "أدوات الذكاء الاصطناعي",
    items: [
      { href: "/categorize", label: "Categorization Engine", labelAr: "محرك التصنيف", icon: BrainCog },
      { href: "/upload",     label: "Upload Data",            labelAr: "رفع البيانات",  icon: UploadCloud },
    ],
  },
  {
    label: "Planning", labelAr: "التخطيط",
    items: [
      { href: "/budgets", label: "Budgets", labelAr: "الميزانيات", icon: Target },
    ],
  },
  {
    label: "Settings", labelAr: "الإعدادات",
    items: [
      { href: "/categories",       label: "Chart of Accounts", labelAr: "دليل الحسابات",    icon: Tags },
      // Hub decision: Automation is settings, not a destination — rules live
      // here, the "↻ Make recurring" entry point lives on the Invoices page.
      { href: "/recurring",        label: "Automation Rules",  labelAr: "قواعد الأتمتة",    icon: Repeat },
      { href: "/company",          label: "Company Settings",  labelAr: "إعدادات الشركة",   icon: Building2 },
      { href: "/closed-months",    label: "Closed Months",     labelAr: "الأشهر المُقفلة",  icon: CalendarClock },
      // Admin-only in the API (audit_logs read = admin); the adminOnly flag
      // hides it from roles that would only meet a 403.
      { href: "/audit-trail",      label: "Audit Trail",       labelAr: "سجل التدقيق",      icon: ScrollText, adminOnly: true },
      { href: "/zatca",            label: "ZATCA e-invoicing", labelAr: "الفوترة الإلكترونية", icon: ShieldCheck },
      { href: "/users",            label: "User Management",   labelAr: "إدارة المستخدمين", icon: UserCog },
      { href: "/change-password",  label: "Change Password",   labelAr: "تغيير كلمة المرور", icon: KeyRound },
    ],
  },
];

/**
 * Routes the demo refuses at the server, so their nav entries go too.
 * `/zatca` — onboarding would take real taxpayer credentials (D5).
 * Document capture has no nav entry of its own; its button lives on Bills.
 */
const DEMO_HIDDEN = new Set(["/zatca"]);

const ROLE_COLOR: Record<string, string> = {
  admin:      "bg-amber-500/20 text-amber-400 border-amber-500/30",
  accountant: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  viewer:     "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};

const ROLE_AR: Record<string, string> = {
  admin: "مدير", accountant: "محاسب", viewer: "مشاهد",
};

function NavGroup({
  group,
  location,
  lang,
}: {
  group: typeof navGroupsData[0];
  location: string;
  lang: "en" | "ar";
}) {
  const hasActive = group.items.some(i => i.href === location);
  const [open, setOpen] = useState(
    hasActive || ["Overview", "Sales", "Purchases", "Financial Reports"].includes(group.label)
  );

  return (
    <div>
      <button
        onClick={() => setOpen(p => !p)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      >
        {lang === "ar" ? group.labelAr : group.label}
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
                <span className="truncate">
                  {lang === "ar" ? link.labelAr : link.label}
                </span>
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
  const { user, logout } = useAuth();
  const { lang, setLang, t } = useLanguage();
  const { demoMode } = useDeployment();

  /**
   * On the demo, drop the nav entries whose routes the server refuses (D3/D5).
   * The refusal is the real control — this only keeps the sidebar honest, so a
   * deliberately narrowed demo does not read as a product full of dead links.
   */
  const visible = (i: NavItem) =>
    (!demoMode || !i.href || !DEMO_HIDDEN.has(i.href)) &&
    (!i.adminOnly || user?.organizationRole === "admin");
  // 🔴 Filtered UNCONDITIONALLY, not only on the demo. The first wiring of
  // `adminOnly` applied `visible` inside the demo branch alone, which made
  // the flag a no-op for every real tenant — a consumer that consumed nothing
  // in the path that matters. DEMO_HIDDEN is scoped to demoMode inside
  // `visible` itself, so unifying the branches changes nothing for it.
  const navGroups = navGroupsData
    .map((g) => ({
      ...g,
      // Nested items too: a hidden route inside a collapsible group is
      // still a dead link.
      items: g.items
        .filter(visible)
        .map((i) => (i.children ? { ...i, children: i.children.filter(visible) } : i)),
    }))
    .filter((g) => g.items.length > 0);

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
              <div className="text-xs text-muted-foreground -mt-0.5">
                {t("ERP · Accounting", "نظام ERP · محاسبة")}
              </div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 px-2 overflow-y-auto">
          {navGroups.map(g => (
            <NavGroup key={g.label} group={g} location={location} lang={lang} />
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
            <OrgSwitcher />
            <div className="flex items-center justify-between">
              <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded border", ROLE_COLOR[user.role] ?? ROLE_COLOR.viewer)}>
                {lang === "ar" ? (ROLE_AR[user.role] ?? user.role) : user.role.toUpperCase()}
              </span>
              <div className="flex items-center gap-2">
                {/* Language toggle EN ⇌ ع */}
                <button
                  onClick={() => setLang(lang === "en" ? "ar" : "en")}
                  className={cn(
                    "flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border transition-colors",
                    lang === "ar"
                      ? "border-primary/50 text-primary bg-primary/10"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground"
                  )}
                  title={lang === "en" ? "Switch to Arabic" : "التبديل إلى الإنجليزية"}
                >
                  <Languages className="w-3 h-3" />
                  {lang === "en" ? "ع" : "EN"}
                </button>
                <button
                  onClick={logout}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-red-400 transition-colors"
                  title={t("Sign out", "تسجيل الخروج")}
                >
                  <LogOut className="w-3 h-3" />
                  {t("Sign out", "تسجيل الخروج")}
                </button>
              </div>
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
