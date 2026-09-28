import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useDeployment } from "@/hooks/useDeployment";
import { OrgSwitcher } from "@/components/OrgSwitcher";
import { NAV_TREE, type NavEntry, type NavSection } from "@/nav/tree";
import { ChevronDown, LogOut, Languages, Clock, Menu, X, Moon, Sun } from "lucide-react";

/**
 * 🔴 THE NAVIGATION IS NO LONGER DEFINED HERE. It lives in `@/nav/tree`, as
 * data, because P5's checks must cover EVERY entry rather than a sample — and
 * a tree written as JSX in this file cannot be enumerated by anything except a
 * scraper, which would test the scraper.
 *
 * This file is now the RENDERER only. Three things follow from that:
 *
 *   1. Children ARE rendered now. The previous note here said the opposite —
 *      "typed and filtered but NEVER rendered; do not nest, a child added here
 *      vanishes silently" — which was true and is the reason the approved
 *      §4 hierarchy could not have been expressed in the old shape at all.
 *   2. Section membership, labels and markers are decisions recorded in
 *      `nav-tree-reconciliation.md`. Change them there, not here.
 *   3. A COMING SOON entry is an ordinary link to a real placeholder page. It
 *      is deliberately NOT greyed out or disabled: a control that looks broken
 *      teaches nothing, while a page that names its blocker teaches why the
 *      feature is not there.
 */

/**
 * Routes the demo refuses at the server, so their nav entries go too.
 * `/zatca` — onboarding would take real taxpayer credentials (D5).
 * Document capture has no nav entry of its own; its button lives on Bills.
 */
const DEMO_HIDDEN = new Set(["/zatca"]);

const ROLE_AR: Record<string, string> = {
  admin: "مدير", accountant: "محاسب", viewer: "مشاهد",
};

/**
 * One nav entry. A leaf, or a parent that discloses its children.
 *
 * 🔴 The active test compares PATHNAMES, not hrefs. A filter entry's href
 * carries a query string (`/invoices?status=sent`) and wouter's `useLocation`
 * returns the path alone, so comparing the two directly would leave every
 * filter entry permanently inactive — a whole class of nav item that silently
 * never highlights. The query is compared separately, against the real
 * `window.location.search`, so "Issued" lights up on `/invoices?status=sent`
 * and does not on `/invoices?status=paid`.
 */
function isEntryActive(entry: NavEntry, location: string, search: string): boolean {
  const [path, query] = entry.href.split("?");
  return location === path && (query ? search === `?${query}` : !search.includes("status="));
}

function NavLink({
  entry,
  location,
  search,
  lang,
  depth,
  suppressActive = false,
}: {
  entry: NavEntry;
  location: string;
  search: string;
  lang: "en" | "ar";
  depth: number;
  /** A parent whose CHILD is the current page: the child owns the tab. */
  suppressActive?: boolean;
}) {
  const Icon = entry.icon;
  const isActive = !suppressActive && isEntryActive(entry, location, search);

  return (
    <Link
      href={entry.href}
      data-nav-marker={entry.marker}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        // Every entry is a TAB: flush to the spine's inner edge and rounded on
        // the start side only. The active one takes the page's own colour, so
        // it reads as the page reaching into the sidebar (see `.nav-tab` in
        // index.css for the two concave corners that complete the join).
        "nav-tab relative flex items-center rounded-s-md transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-inset",
        depth === 0 ? "h-9 ps-3 pe-3 gap-3 text-[14px]" : "h-8 ps-10 pe-3 gap-2.5 text-[13px]",
        isActive
          ? "nav-tab-active bg-sidebar-primary text-sidebar-primary-foreground font-semibold"
          : "text-sidebar-foreground/80 hover:text-sidebar-foreground hover:bg-sidebar-accent",
      )}
    >
      {Icon && <Icon className="w-4 h-4 shrink-0" strokeWidth={isActive ? 2.25 : 1.75} />}
      <span className="truncate">{lang === "ar" ? entry.labelAr : entry.label}</span>
      {/*
        🔴 A quiet marker, not a warning. A Coming Soon entry is a real link to
        a real page that explains itself; dressing it as broken would teach the
        user to distrust the sidebar instead of teaching them what is missing.
      */}
      {entry.marker === "coming-soon" && (
        <Clock className="w-3 h-3 shrink-0 ms-auto opacity-50" aria-hidden />
      )}
    </Link>
  );
}

function NavItemNode({
  entry,
  location,
  search,
  lang,
}: {
  entry: NavEntry;
  location: string;
  search: string;
  lang: "en" | "ar";
}) {
  const children = entry.children ?? [];
  const containsActive = children.some((c) => c.href.split("?")[0] === location);
  const [open, setOpen] = useState(containsActive);

  if (children.length === 0) {
    return <NavLink entry={entry} location={location} search={search} lang={lang} depth={0} />;
  }

  // When a child is the current page (e.g. "All invoices" under "Invoices",
  // which share an href), the CHILD draws the tab and the parent is only
  // emphasised — two stacked tabs would read as two pages.
  const childActive = open && children.some((c) => isEntryActive(c, location, search));
  const selfActive = !childActive && isEntryActive(entry, location, search);

  return (
    <div>
      {/* The disclosure sits INSIDE the tab's footprint (absolutely placed at
          its end) so the tab can stay flush to the spine's edge. */}
      <div className={cn("relative [&>a]:pe-9", childActive && "[&>a]:text-sidebar-foreground [&>a]:font-semibold")}>
        <NavLink entry={entry} location={location} search={search} lang={lang} depth={0} suppressActive={childActive} />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={lang === "ar" ? `توسيع ${entry.labelAr}` : `Expand ${entry.label}`}
          className={cn(
            "absolute end-2 top-1/2 -translate-y-1/2 p-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            selfActive
              ? "text-sidebar-primary-foreground/70 hover:bg-foreground/5"
              : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-black/10",
          )}
        >
          <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", !open && "-rotate-90 rtl:rotate-90")} />
        </button>
      </div>
      {open && (
        <div className="space-y-px mt-px">
          {children.map((child) => (
            <NavLink
              key={`${child.href}-${child.label}`}
              entry={child}
              location={location}
              search={search}
              lang={lang}
              depth={1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NavGroup({
  section,
  location,
  search,
  lang,
  defaultOpen,
}: {
  section: NavSection;
  location: string;
  search: string;
  lang: "en" | "ar";
  defaultOpen: boolean;
}) {
  /**
   * 🔴 Open if it CONTAINS the current page, compared on pathnames and
   * including children. The previous version matched a section label against a
   * hardcoded list that had been renamed out from under it, so the check
   * silently never fired — an obsolete assertion living in the UI rather than
   * in a test. Deriving it from the tree means a renamed section cannot break
   * it.
   */
  const contains = section.items.some(
    (i) =>
      i.href.split("?")[0] === location ||
      (i.children ?? []).some((c) => c.href.split("?")[0] === location),
  );
  const [open, setOpen] = useState(contains || defaultOpen);

  return (
    <div>
      <button
        onClick={() => setOpen((p) => !p)}
        // Announced, not merely drawn: the chevron is the only cue a sighted
        // user gets, and a screen reader gets nothing from it. It also gives
        // `rtl-direction.spec.ts` a deterministic way to open every section
        // instead of guessing which ones happen to be expanded.
        aria-expanded={open}
        data-nav-section={section.label}
        className="w-full flex items-center justify-between ps-3 pe-4 pt-4 pb-1.5 text-[12px] font-medium text-sidebar-foreground/60 hover:text-sidebar-foreground/90 transition-colors outline-none focus-visible:text-sidebar-foreground"
      >
        {lang === "ar" ? section.labelAr : section.label}
        <ChevronDown className={cn("w-3 h-3 transition-transform", !open && "-rotate-90 rtl:rotate-90")} />
      </button>
      {open && (
        <div className="space-y-px">
          {section.items.map((item) => (
            <NavItemNode
              key={`${item.href}-${item.label}`}
              entry={item}
              location={location}
              search={search}
              lang={lang}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const { lang, setLang, t } = useLanguage();
  const { theme, toggle: toggleTheme } = useTheme();
  const { demoMode } = useDeployment();

  /**
   * On the demo, drop the nav entries whose routes the server refuses (D3/D5).
   * The refusal is the real control — this only keeps the sidebar honest, so a
   * deliberately narrowed demo does not read as a product full of dead links.
   */
  const visible = (i: NavEntry) =>
    (!demoMode || !DEMO_HIDDEN.has(i.href.split("?")[0])) &&
    (!i.adminOnly || user?.organizationRole === "admin");
  // 🔴 Filtered UNCONDITIONALLY, not only on the demo. The first wiring of
  // `adminOnly` applied `visible` inside the demo branch alone, which made
  // the flag a no-op for every real tenant — a consumer that consumed nothing
  // in the path that matters. DEMO_HIDDEN is scoped to demoMode inside
  // `visible` itself, so unifying the branches changes nothing for it.
  //
  // 🔴 A parent whose children are ALL hidden is dropped with them. Left in,
  // it would be a disclosure triangle that opens on nothing — the empty-state
  // cousin of a dead link, and just as much a lie about what is there.
  const navSections: NavSection[] = NAV_TREE.map((section) => ({
    ...section,
    items: section.items
      .filter(visible)
      .map((i) => (i.children ? { ...i, children: i.children.filter(visible) } : i))
      .filter((i) => !i.children || i.children.length > 0),
  })).filter((s) => s.items.length > 0);

  /**
   * The query string, read from the browser rather than from wouter — its
   * `useLocation` returns the pathname alone, and the filter entries in the
   * navigation are distinguished only by their query.
   */
  const search = typeof window === "undefined" ? "" : window.location.search;

  /**
   * 🔴 L2 — THE RESPONSIVE SHELL (launch blocker, first core-path walk):
   * `Layout.tsx` had ZERO breakpoints, so on a phone the app was a
   * horizontal-scroll desktop page for a mobile-first customer.
   *
   * ONE sidebar, TWO containers — the same `sidebarInner` renders in the
   * desktop `<aside>` (≥ md) and in an OWNED mobile drawer (< md). Owned, not
   * the vendored `ui/sidebar.tsx`/`ui/sheet.tsx`: those are deliberately
   * unowned (design-pass-inherited-decisions), their RTL behaviour lives in an
   * override layer keyed on utilities, and a 40-line drawer built on LOGICAL
   * properties (`inset-inline-start`, `border-e`) mirrors under `dir` with no
   * override needed. The nav being data (`@/nav/tree`) is what makes the same
   * tree render in both containers with no duplication — the exact dividend
   * §5's L2 entry predicted.
   *
   * The drawer closes on navigation (location effect), on the backdrop, and on
   * Escape. It renders nothing at ≥ md — an overlay that merely hides would
   * still trap focus.
   */
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    setDrawerOpen(false); // navigating IS the dismissal on a phone
  }, [location]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawerOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const brand = (
    <div className="flex items-center gap-2.5">
      <div className="w-8 h-8 rounded-md bg-sidebar-foreground flex items-center justify-center shrink-0">
        <span className="font-display text-[17px] font-bold leading-none text-sidebar -mt-0.5">ك</span>
      </div>
      <div className="leading-tight">
        <div className="font-display font-semibold text-[15px] text-sidebar-foreground">
          {t("KSA Ledger", "دفتر المملكة")}
        </div>
        <div className="text-[11px] text-sidebar-foreground/65">
          {t("Accounting and compliance", "المحاسبة والامتثال")}
        </div>
      </div>
    </div>
  );

  const sidebarInner = (
    <>
      {/* Brand (desktop header; the drawer carries its own with a close control) */}
      <div className="h-16 hidden md:flex items-center px-5 shrink-0">
        {brand}
      </div>

        {/* Nav — padded on the START side only: every tab runs to the edge. */}
        <nav className="sidebar-scroll flex-1 pb-4 ps-3 overflow-y-auto overflow-x-hidden">
          {navSections.map((s, idx) => (
            <NavGroup
              key={s.label}
              section={s}
              location={location}
              search={search}
              lang={lang}
              // The first three sections open by default. Twelve collapsed
              // sections is a wall; twelve expanded ones is a scroll.
              defaultOpen={idx < 3}
            />
          ))}
        </nav>

        {/* User footer */}
        {user && (
          <div className="border-t border-sidebar-border bg-black/10 px-4 py-3 space-y-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-full bg-sidebar-foreground/15 flex items-center justify-center shrink-0">
                <span className="text-xs font-semibold text-sidebar-foreground">{user.name.charAt(0).toUpperCase()}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-sidebar-foreground truncate">{user.name}</p>
                <p className="text-[11px] text-sidebar-foreground/65 truncate">{user.email}</p>
              </div>
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-sidebar-foreground/15 text-sidebar-foreground shrink-0">
                {lang === "ar" ? (ROLE_AR[user.role] ?? user.role) : user.role.charAt(0).toUpperCase() + user.role.slice(1)}
              </span>
            </div>
            <OrgSwitcher />
            <div className="flex items-center gap-1">
              {/* Language toggle EN ⇌ ع — the accessible name is the glyph
                  alone; rtl-direction.spec.ts finds it by exactly that. */}
              <button
                onClick={() => setLang(lang === "en" ? "ar" : "en")}
                className="flex items-center gap-1.5 h-7 px-2 rounded text-[12px] font-semibold text-sidebar-foreground/85 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                title={lang === "en" ? "Switch to Arabic" : "التبديل إلى الإنجليزية"}
              >
                <Languages className="w-3.5 h-3.5" />
                {lang === "en" ? "ع" : "EN"}
              </button>
              <button
                onClick={toggleTheme}
                aria-label={theme === "dark" ? t("Switch to light mode", "التبديل إلى الوضع الفاتح") : t("Switch to dark mode", "التبديل إلى الوضع الداكن")}
                title={theme === "dark" ? t("Light mode", "الوضع الفاتح") : t("Dark mode", "الوضع الداكن")}
                className="flex items-center justify-center h-7 w-7 rounded text-sidebar-foreground/85 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              >
                {theme === "dark" ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={logout}
                className="ms-auto flex items-center gap-1.5 h-7 px-2 rounded text-[12px] text-sidebar-foreground/85 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                title={t("Sign out", "تسجيل الخروج")}
              >
                <LogOut className="w-3.5 h-3.5 rtl:-scale-x-100" />
                {t("Sign out", "تسجيل الخروج")}
              </button>
            </div>
          </div>
        )}
    </>
  );

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      {/* Desktop sidebar — hidden below md; the drawer takes over there. */}
      <aside className="w-64 bg-sidebar text-sidebar-foreground shrink-0 hidden md:flex flex-col sticky top-0 h-screen">
        {sidebarInner}
      </aside>

      {/* Mobile drawer — rendered only while open, only below md. */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/40"
            data-testid="nav-drawer-backdrop"
            onClick={() => setDrawerOpen(false)}
          />
          <aside
            data-testid="nav-drawer"
            className="absolute inset-y-0 start-0 h-full w-72 max-w-[85vw] bg-sidebar text-sidebar-foreground flex flex-col shadow-xl"
          >
            <div className="h-14 flex items-center justify-between px-4 shrink-0">
              {brand}
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label={t("Close menu", "إغلاق القائمة")}
                className="p-2 rounded text-sidebar-foreground/80 hover:text-sidebar-foreground hover:bg-sidebar-accent"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {sidebarInner}
          </aside>
        </div>
      )}

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar — the only place the hamburger exists. */}
        <header className="h-14 md:hidden flex items-center gap-2 px-3 bg-sidebar text-sidebar-foreground shrink-0">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={t("Open menu", "فتح القائمة")}
            data-testid="nav-hamburger"
            className="p-2 -ms-1 rounded text-sidebar-foreground/85 hover:text-sidebar-foreground hover:bg-sidebar-accent"
          >
            <Menu className="w-5 h-5" />
          </button>
          {brand}
        </header>
        {/* 🔴 min-w-0 + overflow-x-hidden: the PAGE never scrolls sideways;
            wide content (tables) scrolls inside its own container — the B-6
            rule applied to layout. Mobile e2e asserts this per route. */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 md:px-10 md:py-9">
          {children}
        </div>
      </main>
    </div>
  );
}
