/**
 * THE NAVIGATION TREE — the approved §4 hierarchy, as data.
 *
 * Source of truth for the content: `docs/product/nav-tree-reconciliation.md`,
 * approved by the owner on 2026-08-31 with all four open questions answered.
 *
 * ── 🔴 WHY THE TREE IS DATA ────────────────────────────────────────────────
 * The owner's condition on this build was that P5's checks cover EVERY entry,
 * not a sample someone chose. A tree written as JSX cannot be enumerated: a
 * test would have to render the sidebar and scrape it, which tests the scraper.
 * As data, `e2e/nav-tree.spec.ts` walks every node and asserts the promise each
 * one makes — a BUILT entry renders, a FILTER entry's destination reflects the
 * filter, a COMING SOON entry names its blocker. Three markers, three
 * mechanical checks, no sampling.
 *
 * ── 🔴 THE THREE MARKERS, AND WHAT EACH PROMISES ───────────────────────────
 *   built        A real page exists. The href is its route.
 *   filter       NOT a destination — a filter on a list that exists. Deep-links
 *                with the filter applied, and the destination MUST reflect it
 *                (heading, selected control, row count). Carries `filter` so a
 *                test can check the destination rather than the link.
 *   coming-soon  A real feature that does not exist. Resolves to a placeholder
 *                naming its blocker. Never a dead click, a blank screen, or a
 *                404.
 *
 * DROPPED entries are simply absent — thirteen of them, each pointing at
 * something that cannot be renamed into anything real, each argued in the
 * reconciliation document. 🔴 Do not add one back without checking that a
 * writer produces the state it filters on: a chip returning a permanently
 * empty set is the defect this whole pass removed.
 *
 * ── 🔴 ABOUT A THIRD OF THIS TREE IS COMING SOON ───────────────────────────
 * That is the honest shape of the owner's decision, taken with the proportion
 * in front of him: the navigation shows roughly as many unbuilt features as
 * built ones, so the product's scope is legible from the sidebar. The
 * placeholder convention — every one naming its blocker specifically — is what
 * keeps that from being a facade.
 */
import {
  LayoutDashboard, ShieldCheck, ClipboardList, Tags, BookOpen, Scale,
  CalendarClock, Users, FileText, FileMinus, FilePlus2, Clock, BarChart3,
  Building2, ShoppingCart, FileInput, CreditCard, ListChecks, BrainCog,
  UploadCloud, ArrowLeftRight, Landmark, Receipt, TrendingUp, Waves,
  PieChart, SearchCheck, Repeat, ScanLine, Sparkles, Plug, UserCog,
  KeyRound, ScrollText, Wallet, SlidersHorizontal, UserRound, Eye,
  ListOrdered, Package, Banknote, UserCheck, Target, ShoppingBag,
} from "lucide-react";
import { comingSoonHref } from "@/lib/comingSoon";
import {
  INVOICE_FILTERS, BILL_FILTERS, JOURNAL_ENTRY_FILTERS,
  QUOTATION_FILTERS, PURCHASE_ORDER_FILTERS, type FilterOption,
} from "@/lib/listFilters";

export type NavMarker = "built" | "filter" | "coming-soon";

export interface NavEntry {
  label: string;
  labelAr: string;
  marker: NavMarker;
  /** The URL this entry navigates to. Always resolvable — never a dead click. */
  href: string;
  icon?: React.ElementType;
  /** Hidden from non-admins: honesty about the 403, never the boundary itself. */
  adminOnly?: boolean;
  /**
   * Present on `filter` entries only: the destination page and the status it
   * applies. What makes the deep-link check mechanical rather than a sample.
   */
  filter?: { path: string; status: string };
  children?: NavEntry[];
}

export interface NavSection {
  label: string;
  labelAr: string;
  icon: React.ElementType;
  items: NavEntry[];
}

/** A filter entry built from the shared vocabulary, so labels cannot diverge. */
function filterEntry(path: string, options: readonly FilterOption[], status: string): NavEntry {
  const option = options.find(o => o.value === status);
  if (!option) throw new Error(`nav: no filter option '${status}' for ${path}`);
  return {
    label: option.label,
    labelAr: option.labelAr,
    marker: "filter",
    href: `${path}?status=${status}`,
    filter: { path, status },
  };
}

function soon(slug: string, label: string, labelAr: string, icon?: React.ElementType): NavEntry {
  return { label, labelAr, marker: "coming-soon", href: comingSoonHref(slug), icon };
}

function built(href: string, label: string, labelAr: string, icon?: React.ElementType, adminOnly?: boolean): NavEntry {
  return { label, labelAr, marker: "built", href, icon, adminOnly };
}

export const NAV_TREE: readonly NavSection[] = [
  // ── 1. DASHBOARD ─────────────────────────────────────────────────────────
  {
    label: "Dashboard", labelAr: "لوحة التحكم", icon: LayoutDashboard,
    items: [
      built("/", "Overview", "نظرة عامة", LayoutDashboard),
      // "Financial Health" in the spec — the same thing under the product's
      // own name, rather than a second entry to one page.
      built("/finance-hub", "Financial Health", "الصحة المالية", ShieldCheck),
      // "My Tasks" in the spec: the approvals worklist IS my tasks.
      built("/approvals", "My Tasks", "مهامي", ClipboardList),
    ],
  },

  // ── 2. FINANCE ───────────────────────────────────────────────────────────
  {
    label: "Finance", labelAr: "المالية", icon: BookOpen,
    items: [
      {
        ...built("/categories", "Chart of Accounts", "دليل الحسابات", Tags),
        children: [
          soon("coa-tree-view", "Tree View", "العرض الشجري"),
          built("/categories", "List View", "العرض القائمي"),
          soon("coa-import", "Import Accounts", "استيراد الحسابات"),
        ],
      },
      {
        ...built("/journal-entries", "Journal Entries", "قيود اليومية", BookOpen),
        children: [
          built("/journal-entries", "All Entries", "كل القيود"),
          filterEntry("/journal-entries", JOURNAL_ENTRY_FILTERS, "draft"),
          filterEntry("/journal-entries", JOURNAL_ENTRY_FILTERS, "posted"),
          filterEntry("/journal-entries", JOURNAL_ENTRY_FILTERS, "reversed"),
          built("/recurring", "Recurring Templates", "القوالب المتكررة"),
          soon("recurring-journal-entries", "Recurring Journal Entries", "قيود اليومية المتكررة"),
        ],
      },
      built("/reports/general-ledger", "General Ledger", "دفتر الأستاذ العام", ListOrdered),
      built("/trial-balance", "Trial Balance", "ميزان المراجعة", Scale),
      built("/closed-months", "Period Management", "إدارة الفترات", CalendarClock),
      soon("cost-centers", "Cost Centres & Projects", "مراكز التكلفة والمشاريع", Target),
    ],
  },

  // ── 3. SALES ─────────────────────────────────────────────────────────────
  {
    label: "Sales", labelAr: "المبيعات", icon: FileText,
    items: [
      {
        ...built("/invoices", "Invoices", "الفواتير", FileText),
        children: [
          built("/invoices", "All Invoices", "كل الفواتير"),
          filterEntry("/invoices", INVOICE_FILTERS, "draft"),
          filterEntry("/invoices", INVOICE_FILTERS, "submitted"),
          filterEntry("/invoices", INVOICE_FILTERS, "sent"),
          filterEntry("/invoices", INVOICE_FILTERS, "paid"),
          filterEntry("/invoices", INVOICE_FILTERS, "overdue"),
          soon("invoice-templates", "Invoice Templates", "قوالب الفواتير"),
        ],
      },
      built("/credit-notes", "Credit Notes", "إشعارات الدائن", FileMinus),
      soon("debit-notes", "Debit Notes", "إشعارات المدين", FilePlus2),
      {
        ...built("/quotations", "Quotations", "عروض الأسعار", ClipboardList),
        children: [
          built("/quotations", "All Quotations", "كل العروض"),
          filterEntry("/quotations", QUOTATION_FILTERS, "draft"),
          filterEntry("/quotations", QUOTATION_FILTERS, "submitted"),
          filterEntry("/quotations", QUOTATION_FILTERS, "approved"),
          filterEntry("/quotations", QUOTATION_FILTERS, "converted"),
          filterEntry("/quotations", QUOTATION_FILTERS, "expired"),
          soon("quotation-templates", "Quotation Templates", "قوالب عروض الأسعار"),
        ],
      },
      {
        ...built("/customers", "Customers", "العملاء", Users),
        children: [
          built("/customers", "All Customers", "كل العملاء"),
          built("/reports/customer-ledger", "Customer Statements", "كشوف حساب العملاء"),
          built("/ar-aging", "Customer Aging", "أعمار ذمم العملاء"),
          soon("customer-groups", "Customer Groups", "مجموعات العملاء"),
        ],
      },
      built("/ar-aging", "AR Aging", "أعمار الذمم المدينة", Clock),
      {
        label: "Sales Reports", labelAr: "تقارير المبيعات", marker: "built",
        href: "/reports/customer-ledger", icon: BarChart3,
        children: [
          built("/reports/customer-ledger", "Sales by Customer", "المبيعات حسب العميل"),
          soon("sales-by-product", "Sales by Product", "المبيعات حسب المنتج"),
          built("/analytics", "Sales Trends", "اتجاهات المبيعات"),
        ],
      },
    ],
  },

  // ── 4. PURCHASES ─────────────────────────────────────────────────────────
  {
    label: "Purchases", labelAr: "المشتريات", icon: ShoppingCart,
    items: [
      {
        ...built("/bills", "Bills", "فواتير الموردين", FileInput),
        children: [
          built("/bills", "All Bills", "كل الفواتير"),
          filterEntry("/bills", BILL_FILTERS, "draft"),
          filterEntry("/bills", BILL_FILTERS, "submitted"),
          filterEntry("/bills", BILL_FILTERS, "received"),
          filterEntry("/bills", BILL_FILTERS, "approved"),
          filterEntry("/bills", BILL_FILTERS, "paid"),
          filterEntry("/bills", BILL_FILTERS, "overdue"),
        ],
      },
      {
        ...built("/purchase-orders", "Purchase Orders", "أوامر الشراء", ShoppingCart),
        children: [
          built("/purchase-orders", "All Orders", "كل الأوامر"),
          filterEntry("/purchase-orders", PURCHASE_ORDER_FILTERS, "draft"),
          filterEntry("/purchase-orders", PURCHASE_ORDER_FILTERS, "submitted"),
          filterEntry("/purchase-orders", PURCHASE_ORDER_FILTERS, "approved"),
          filterEntry("/purchase-orders", PURCHASE_ORDER_FILTERS, "converted"),
          soon("po-templates", "PO Templates", "قوالب أوامر الشراء"),
        ],
      },
      {
        ...built("/vendors", "Vendors", "الموردون", Building2),
        children: [
          built("/vendors", "All Vendors", "كل الموردين"),
          soon("vendor-statements", "Vendor Statements", "كشوف حساب الموردين"),
          built("/ap-aging", "Vendor Aging", "أعمار ذمم الموردين"),
        ],
      },
      built("/ap-aging", "AP Aging", "أعمار الذمم الدائنة", Clock),
      {
        label: "Purchase Reports", labelAr: "تقارير المشتريات", marker: "built",
        href: "/analytics", icon: BarChart3,
        children: [
          soon("purchases-by-vendor", "Purchases by Vendor", "المشتريات حسب المورد"),
          soon("purchases-by-product", "Purchases by Product", "المشتريات حسب المنتج"),
          built("/analytics", "Purchase Trends", "اتجاهات المشتريات"),
        ],
      },
    ],
  },

  // ── 5. BANKING ───────────────────────────────────────────────────────────
  {
    label: "Banking", labelAr: "البنوك", icon: Landmark,
    items: [
      {
        ...built("/bank-accounts", "Bank Accounts", "الحسابات البنكية", CreditCard),
        children: [
          built("/bank-accounts", "All Accounts", "كل الحسابات"),
          soon("bank-account-detail", "Account Detail", "تفاصيل الحساب"),
        ],
      },
      {
        label: "Bank Statements", labelAr: "كشوف الحسابات", marker: "built",
        href: "/upload", icon: UploadCloud,
        children: [
          built("/upload", "Import Statement", "استيراد كشف"),
          built("/review", "Statement Review Queue", "قائمة مراجعة الكشوف"),
          built("/categorize", "Categorisation", "التصنيف"),
          soon("bank-statement-register", "All Statements", "كل الكشوف"),
        ],
      },
      built("/transactions", "Transactions", "المعاملات", ListOrdered),
      soon("transfers", "Transfers", "التحويلات", ArrowLeftRight),
      built("/review", "Reconciliation", "التسوية البنكية", ListChecks),
      soon("live-bank-feeds", "Live Bank Feeds", "الربط المباشر مع البنوك", Plug),
      {
        label: "Banking Reports", labelAr: "التقارير البنكية", marker: "built",
        href: "/cash-flow", icon: Waves,
        children: [
          built("/cash-flow", "Cash Flow", "التدفق النقدي"),
          built("/analytics", "Bank Balance History", "تاريخ الرصيد البنكي"),
          soon("transfer-reports", "Transfer Reports", "تقارير التحويلات"),
        ],
      },
    ],
  },

  // ── 6. TAX ───────────────────────────────────────────────────────────────
  {
    label: "Tax & Compliance", labelAr: "الضرائب والامتثال", icon: Receipt,
    items: [
      built("/vat", "VAT Return", "إقرار ضريبة القيمة المضافة", Receipt),
      built("/vat", "VAT Reconciliation", "تسوية ضريبة القيمة المضافة", Scale),
      {
        ...built("/zatca", "ZATCA E-Invoicing", "الفوترة الإلكترونية", ShieldCheck),
        children: [
          built("/zatca", "Onboarding & Compliance", "التسجيل والامتثال"),
          soon("zatca-production-submission", "Production Submission", "الإرسال الفعلي"),
        ],
      },
      {
        ...built("/zakat", "Zakat", "الزكاة", Landmark),
        children: [
          built("/zakat", "Fiscal Calendar", "التقويم المالي"),
          soon("zakat-calculation", "Zakat Calculation", "احتساب الزكاة"),
          soon("zakat-base", "Zakat Base", "وعاء الزكاة"),
          soon("zakat-reports", "Zakat Reports", "تقارير الزكاة"),
          soon("zakat-settings", "Zakat Settings", "إعدادات الزكاة"),
        ],
      },
      soon("withholding-tax", "Withholding Tax", "ضريبة الاستقطاع", Receipt),
    ],
  },

  // ── 7. REPORTS ───────────────────────────────────────────────────────────
  {
    label: "Reports", labelAr: "التقارير", icon: BarChart3,
    items: [
      built("/reports", "Reports Hub", "مركز التقارير", BarChart3),
      built("/income-statement", "Profit & Loss", "قائمة الدخل", TrendingUp),
      built("/balance-sheet", "Balance Sheet", "الميزانية العمومية", Scale),
      // 🔴 The DIRECT method, and only that. The indirect method is not built
      // and is not being built, so there is no toggle offering a choice of one.
      built("/cash-flow", "Cash Flow Statement (Direct)", "قائمة التدفقات النقدية (المباشرة)", Waves),
      built("/trial-balance", "Trial Balance", "ميزان المراجعة", Scale),
      {
        ...built("/reports/aging", "Aging Reports", "تقارير الأعمار", Clock),
        children: [
          built("/reports/aging", "AR / AP Aging", "أعمار الذمم المدينة والدائنة"),
          soon("aging-trends", "Aging Trends", "اتجاهات الأعمار"),
        ],
      },
      built("/analytics", "Analytics", "التحليلات", TrendingUp),
      {
        label: "Operational Reports", labelAr: "التقارير التشغيلية", marker: "built",
        href: "/reports/journal-report", icon: ScrollText,
        children: [
          built("/reports/journal-report", "Journal Report", "تقرير اليومية"),
          built("/reports/general-ledger", "General Ledger", "دفتر الأستاذ العام"),
          // 🔴 THESE FIVE WERE FOUND BY THE COVERAGE CHECK, NOT BY READING.
          // Every one is a real, working report page that the §4 spec never
          // listed — so reconciling the spec entry by entry could not surface
          // them, and replacing the old navigation with this tree would have
          // made all five unreachable in the same commit that made the
          // navigation "complete". The reconciliation asked whether every spec
          // entry points at something real; the inverse question — whether
          // every real page still appears — is a different one, and only
          // `nav-tree.spec.ts`'s route-coverage assertion asks it.
          built("/reports/account-statement", "Account Statement", "كشف حساب"),
          built("/reports/account-summary", "Account Summary", "ملخص الحسابات"),
          built("/reports/owner-equity", "Owner's Equity", "حقوق الملكية"),
          built("/reports/tax-journal-entries", "Tax Journal Entries", "قيود الضريبة"),
          built("/reports/activity", "Activity Report", "تقرير النشاط"),
          built("/audit-trail", "Audit Trail", "سجل التدقيق", undefined, true),
        ],
      },
      soon("custom-reports", "Custom Reports", "التقارير المخصّصة", SlidersHorizontal),
    ],
  },

  // ── 8. AI & AUTOMATION ───────────────────────────────────────────────────
  // 🔴 This section reverses `hub-structure-decision.md`, which gave AI and
  // automation no navigation entry at all. Reversed deliberately by the owner
  // on 2026-08-31 and recorded in that file, so nobody later reads the code
  // comments there as current.
  {
    label: "AI & Automation", labelAr: "الذكاء الاصطناعي والأتمتة", icon: Sparkles,
    items: [
      soon("ai-assistant", "AI Assistant", "المساعد الذكي", Sparkles),
      built("/findings", "Findings", "الملاحظات", SearchCheck),
      built("/scan-review", "Receipt Capture", "التقاط الإيصالات", ScanLine),
      built("/recurring", "Recurring Transactions", "المعاملات المتكررة", Repeat),
      soon("vision-model", "Vision Model", "نموذج الرؤية", Eye),
    ],
  },

  // ── 9. INTEGRATIONS ──────────────────────────────────────────────────────
  // Scoped to three things by the owner (2026-08-31). Everything else the spec
  // listed here — PayTabs, HyperPay, Shopify, WooCommerce, POS, ERP, Lean,
  // Tarabut, integration logs — is dropped until someone asks, with a design
  // and an estimate. Live Bank Feeds lives in BANKING only; the duplicate here
  // and the duplicate ZATCA entry are both gone.
  {
    label: "Integrations", labelAr: "التكاملات", icon: Plug,
    items: [
      built("/integrations", "All Integrations", "كل التكاملات", Plug),
      soon("myfatoorah", "MyFatoorah", "ماي فاتورة", Wallet),
      // 🔴 NOT under a "payment gateways" heading. SiFi is a SAMA-licensed EMI
      // doing spend management — outbound — and filing it beside MyFatoorah
      // would repeat the exact error the owner corrected on 2026-08-30.
      soon("sifi", "SiFi (spend management)", "سيفي (إدارة الإنفاق)", Banknote),
      soon("email-providers", "Email Delivery", "إرسال البريد الإلكتروني", Plug),
    ],
  },

  // ── 10. SETTINGS ─────────────────────────────────────────────────────────
  {
    label: "Settings", labelAr: "الإعدادات", icon: UserCog,
    items: [
      {
        ...built("/company", "Company Settings", "إعدادات الشركة", Building2),
        children: [
          built("/company", "Profile, Fiscal & Documents", "الملف والسنة المالية والمستندات"),
          soon("multi-currency", "Currency & Exchange Rates", "العملات وأسعار الصرف"),
        ],
      },
      built("/categories", "Chart of Accounts", "دليل الحسابات", Tags),
      soon("coa-settings", "Chart of Accounts Settings", "إعدادات دليل الحسابات"),
      built("/products", "Products & Services", "المنتجات والخدمات", ShoppingBag),
      built("/recurring", "Automation Rules", "قواعد الأتمتة", Repeat),
      {
        ...built("/users", "Users & Roles", "المستخدمون والصلاحيات", Users),
        children: [
          built("/users", "All Users & Permissions", "المستخدمون والصلاحيات"),
          soon("assignments", "Assignments", "المهام المسندة"),
        ],
      },
      {
        label: "Security", labelAr: "الأمان", marker: "built",
        href: "/change-password", icon: KeyRound,
        children: [
          built("/change-password", "Change Password", "تغيير كلمة المرور"),
          soon("password-reset", "Password Reset", "إعادة تعيين كلمة المرور"),
          soon("two-factor", "Two-Factor Authentication", "التحقق بخطوتين"),
          soon("session-management", "Session Management", "إدارة الجلسات"),
          soon("ip-restrictions", "IP Restrictions", "تقييد عناوين IP"),
          built("/audit-trail", "Login History", "سجل تسجيل الدخول", undefined, true),
        ],
      },
      built("/audit-trail", "Audit Trail", "سجل التدقيق", ScrollText, true),
      soon("data-export", "Data Export", "تصدير البيانات"),
      built("/verification", "Organisation Verification", "توثيق المنشأة", ShieldCheck),
      soon("billing-subscription", "Billing & Subscription", "الفوترة والاشتراك", Wallet),
      {
        label: "Preferences", labelAr: "التفضيلات", marker: "built",
        href: "/company", icon: SlidersHorizontal,
        children: [
          built("/company", "Language & Date Format", "اللغة وصيغة التاريخ"),
          soon("notification-preferences", "Notification Preferences", "تفضيلات الإشعارات"),
          soon("dashboard-layout", "Dashboard Layout", "تخطيط لوحة التحكم"),
          soon("keyboard-shortcuts", "Keyboard Shortcuts", "اختصارات لوحة المفاتيح"),
        ],
      },
      soon("system-administration", "System", "النظام", SlidersHorizontal),
    ],
  },

  // ── 11. SUBLEDGERS ───────────────────────────────────────────────────────
  // Not a spec section. These are real, built pages that the §4 tree never
  // listed — payroll, employees, fixed assets, budgets. 🔴 Left out, they
  // would have become unreachable the moment this tree replaced the old nav:
  // the reconciliation checked that every SPEC entry points at something real,
  // and the inverse question — does every real page still appear — is a
  // different one, which only the route-coverage assertion in
  // `nav-tree.spec.ts` answers.
  {
    label: "Subledgers", labelAr: "الدفاتر المساعدة", icon: Package,
    items: [
      built("/employees", "Employees", "الموظفون", UserCheck),
      built("/payroll", "Payroll", "الرواتب", Banknote),
      built("/payroll-report", "Payroll Report", "تقرير الرواتب", BarChart3),
      built("/assets", "Fixed Assets", "الأصول الثابتة", Package),
      built("/asset-schedule", "Asset Schedule", "جدول الأصول", PieChart),
      built("/budgets", "Budgets", "الميزانيات", Target),
      built("/invoice-summary", "Invoice Summary", "ملخص الفواتير", FileText),
    ],
  },

  // ── 12. PROFILE ──────────────────────────────────────────────────────────
  {
    label: "My Account", labelAr: "حسابي", icon: UserRound,
    items: [
      soon("my-profile", "My Profile", "ملفي الشخصي", UserRound),
      built("/approvals", "My Tasks", "مهامي", ClipboardList),
      built("/audit-trail", "My Activity", "نشاطي", ScrollText, true),
    ],
  },
];

/** Every entry in the tree, flattened — parents and children alike. */
export function allNavEntries(): NavEntry[] {
  const out: NavEntry[] = [];
  for (const section of NAV_TREE) {
    for (const item of section.items) {
      out.push(item);
      for (const child of item.children ?? []) out.push(child);
    }
  }
  return out;
}
