/**
 * THE PAGE KIT — the 2026-09 design pass's shared page anatomy.
 *
 * Every page in the app is built from the same five parts, so the product
 * reads as ONE ledger rather than seventy separately-styled screens:
 *
 *   <PageHeader>   title, one line of context, the page's primary actions
 *   <StatStrip>    the page's headline figures, as ONE ruled strip — not a
 *                  row of floating cards
 *   <Panel>        a titled section; `flush` for tables, which run edge to edge
 *   <FilterTabs>   status filters as an underlined tab bar
 *   <EmptyState>   what an empty list says, and the next step
 *
 * 🔴 PRESENTATION ONLY. Nothing here fetches, computes, or decides. A page
 * keeps its own data, handlers and data-testids and passes them through; the
 * kit only decides how they look. Every component forwards `data-*` props.
 *
 * 🔴 Tones follow CLAUDE.md §4: `positive`/`negative`/`attention` describe a
 * STATE that is the case (money in, money out, overdue). A heuristic
 * threshold — a ratio, a variance — gets `default` and words, never a tone.
 */
import * as React from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

type DataAttrs = { [k: `data-${string}`]: string | number | boolean | undefined };

/* ── PageHeader ────────────────────────────────────────────────────────── */

export function PageHeader({
  title,
  description,
  actions,
  back,
  children,
  className,
  ...rest
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary actions, end-aligned. */
  actions?: React.ReactNode;
  /** A link back to the parent list, rendered above the title. */
  back?: { href: string; label: React.ReactNode };
  /** Extra content under the description (notices, scope lines). */
  children?: React.ReactNode;
  className?: string;
} & DataAttrs) {
  return (
    <header className={cn("mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)} {...rest}>
      <div className="min-w-0">
        {back && (
          <Link
            href={back.href}
            className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <span aria-hidden className="rtl:-scale-x-100 inline-block">←</span>
            {back.label}
          </Link>
        )}
        <h1 className="text-[26px] leading-tight font-semibold text-foreground">{title}</h1>
        {description && <p className="mt-1.5 text-sm text-muted-foreground max-w-[70ch]">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}

/* ── StatStrip / Stat ──────────────────────────────────────────────────── */

export type Tone = "default" | "positive" | "negative" | "attention" | "info" | "primary";

const TONE_TEXT: Record<Tone, string> = {
  default: "text-foreground",
  primary: "text-primary",
  positive: "text-positive",
  negative: "text-negative",
  attention: "text-attention",
  info: "text-info",
};

/**
 * One bordered strip, divided by hairlines. The `gap-px` over a border-coloured
 * background draws the dividers in every layout (2-up on a phone, N-up on a
 * desk) without per-breakpoint border rules, and mirrors in RTL for free.
 */
export function StatStrip({
  children,
  className,
  cols,
  ...rest
}: { children: React.ReactNode; className?: string; cols?: 2 | 3 | 4 | 5 } & DataAttrs) {
  const n = cols ?? Math.min(Math.max(React.Children.toArray(children).filter(Boolean).length, 2), 5);
  const lg = { 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 5: "lg:grid-cols-5" }[n];
  return (
    <div
      className={cn(
        "mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border",
        // An odd count on the 2-up phone grid would leave an empty grey cell:
        // the last stat spans the row instead.
        "[&>*:last-child:nth-child(odd)]:col-span-2 lg:[&>*:last-child:nth-child(odd)]:col-span-1",
        lg,
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
  href,
  className,
  ...rest
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
  href?: string;
  className?: string;
} & DataAttrs) {
  const body = (
    <>
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className={cn("mt-1.5 text-[22px] sm:text-[24px] leading-none font-semibold tabular-nums tracking-tight", TONE_TEXT[tone])}>
        {value}
      </div>
      {hint && <div className="mt-2 text-[12px] text-muted-foreground">{hint}</div>}
    </>
  );
  const cls = cn("bg-card px-5 py-4 min-w-0", className);
  return href ? (
    <Link href={href} className={cn(cls, "block transition-colors hover:bg-muted/60")} {...rest}>
      {body}
    </Link>
  ) : (
    <div className={cls} {...rest}>
      {body}
    </div>
  );
}

/* ── Panel ─────────────────────────────────────────────────────────────── */

export function Panel({
  title,
  description,
  actions,
  flush = false,
  footer,
  children,
  className,
  bodyClassName,
  ...rest
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Tables and lists: no body padding, and the first/last cells line up with the header text. */
  flush?: boolean;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
} & DataAttrs) {
  return (
    <section className={cn("rounded-lg border border-border bg-card text-card-foreground", className)} {...rest}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>}
            {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div
        className={cn(
          flush
            ? "[&_th:first-child]:ps-5 [&_td:first-child]:ps-5 [&_th:last-child]:pe-5 [&_td:last-child]:pe-5"
            : "p-5",
          bodyClassName,
        )}
      >
        {children}
      </div>
      {footer && <div className="border-t border-border px-5 py-3">{footer}</div>}
    </section>
  );
}

/* ── FilterTabs ────────────────────────────────────────────────────────── */

export interface FilterTabOption {
  value: string;
  label: React.ReactNode;
  count?: number | null;
}

/**
 * Status filters as an underlined tab bar. Rendered as BUTTONS with
 * `aria-pressed` (not an ARIA tablist): each one re-queries a list, and the
 * e2e suite finds them as buttons by name.
 */
export function FilterTabs({
  options,
  value,
  onChange,
  className,
  end,
  ...rest
}: {
  options: FilterTabOption[];
  value: string;
  onChange: (v: string) => void;
  className?: string;
  /** Content at the end of the bar (search, a scope line). */
  end?: React.ReactNode;
} & DataAttrs) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-border px-5", className)} {...rest}>
      <div className="-mb-px flex flex-wrap gap-x-5">
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.value)}
              className={cn(
                "inline-flex items-center gap-1.5 border-b-2 py-3 text-[13px] font-medium transition-colors outline-none focus-visible:text-foreground",
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
              )}
            >
              {o.label}
              {o.count != null && (
                <span
                  className={cn(
                    "rounded px-1.5 text-[11px] tabular-nums",
                    active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                  )}
                >
                  {o.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {end && <div className="py-2">{end}</div>}
    </div>
  );
}

/* ── EmptyState ────────────────────────────────────────────────────────── */

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  ...rest
}: {
  icon?: React.ElementType;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
} & DataAttrs) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)} {...rest}>
      {Icon && (
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <Icon className="h-5 w-5" />
        </span>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* ── Small pieces ──────────────────────────────────────────────────────── */

/** A labelled value pair for detail pages ("Customer — Najd Contracting"). */
export function Field({ label, children, className }: { label: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm text-foreground">{children}</dd>
    </div>
  );
}

/** A section title inside a page, between panels. */
export function SectionTitle({ children, className, actions }: { children: React.ReactNode; className?: string; actions?: React.ReactNode }) {
  return (
    <div className={cn("mb-3 mt-8 flex items-end justify-between gap-3", className)}>
      <h2 className="text-base font-semibold text-foreground">{children}</h2>
      {actions}
    </div>
  );
}
