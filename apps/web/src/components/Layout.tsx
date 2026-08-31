import { useState } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useDeployment } from "@/hooks/useDeployment";
import { Badge } from "@/components/ui/badge";
import { OrgSwitcher } from "@/components/OrgSwitcher";
import { NAV_TREE, type NavEntry, type NavSection } from "@/nav/tree";
import { ChevronDown, ChevronRight, LogOut, Languages, Clock } from "lucide-react";

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

const ROLE_COLOR: Record<string, string> = {
  admin:      "bg-attention-surface/20 text-attention border-attention-surface/30",
  accountant: "bg-info-surface/20 text-info border-info-surface/30",
  viewer:     "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};

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
function NavLink({
  entry,
  location,
  search,
  lang,
  depth,
}: {
  entry: NavEntry;
  location: string;
  search: string;
  lang: "en" | "ar";
  depth: number;
}) {
  const Icon = entry.icon;
  const [path, query] = entry.href.split("?");
  const isActive =
    location === path && (query ? search === `?${query}` : !search.includes("status="));

  return (
    <Link
      href={entry.href}
      data-nav-marker={entry.marker}
      className={cn(
        "flex items-center gap-2.5 rounded-md text-sm transition-colors",
        depth === 0 ? "px-3 py-2 font-medium gap-3" : "ps-9 pe-3 py-1.5 text-[13px]",
        isActive
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary/60",
      )}
    >
      {Icon && <Icon className="w-4 h-4 shrink-0" />}
      <span className="truncate">{lang === "ar" ? entry.labelAr : entry.label}</span>
      {/*
        🔴 A quiet marker, not a warning. A Coming Soon entry is a real link to
        a real page that explains itself; dressing it as broken would teach the
        user to distrust the sidebar instead of teaching them what is missing.
      */}
      {entry.marker === "coming-soon" && (
        <Clock className="w-3 h-3 shrink-0 ms-auto opacity-40" aria-hidden />
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

  return (
    <div>
      <div className="flex items-center">
        <div className="flex-1 min-w-0">
          <NavLink entry={entry} location={location} search={search} lang={lang} depth={0} />
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={lang === "ar" ? `توسيع ${entry.labelAr}` : `Expand ${entry.label}`}
          className="p-1.5 me-1 rounded text-muted-foreground/60 hover:text-foreground hover:bg-secondary/60"
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
      </div>
      {open && (
        <div className="space-y-0.5 mt-0.5">
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
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      >
        {lang === "ar" ? section.labelAr : section.label}
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {open && (
        <div className="space-y-0.5 mt-0.5 mb-2">
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

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      {/* Sidebar */}
      <aside className="w-60 border-e border-border bg-sidebar shrink-0 flex flex-col">
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
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-negative transition-colors"
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
