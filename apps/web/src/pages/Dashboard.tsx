import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  useGetCashPosition, useGetBooksStatus, useGetTaxCompliance, useGetCashReconciliation,
} from "@workspace/api-client-react";
import type { ArAgingReport, ApAgingReport, ListInvoices200, ApprovalPendingRow } from "@workspace/api-client-react";
import { businessToday } from "@workspace/shared";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { formatHijri } from "@/lib/hijriDate";
import { statusLabel } from "@/lib/statusLabel";
import { Button } from "@/components/ui/button";
import { Stat, StatStrip, Panel, EmptyState } from "@/components/kit";
import {
  SearchCheck, ChevronRight, Plus, ListChecks, ClipboardCheck, AlertTriangle, FileText, TrendingUp, ShieldCheck,
} from "lucide-react";

/**
 * The landing page.
 *
 * 🔴 HISTORY (so the change reads as a decision, not a drift). M19.4 / owner
 * decision A11 made this a ROUTER that stated no figures, because the old
 * "Financial Cockpit" duplicated Analytics and the Finance Hub and carried
 * three wrong pieces (a "Cash Flow Overview" that was not cash flow, a
 * hardcoded "VAT Rate 15%" presented as a reading, and dark-only colours).
 *
 * 2026-09-28 — the owner reversed the "no figures" half of A11 in the design
 * pass: the landing shows data again. What carries over from A11 is the
 * DISCIPLINE, which is why this page computes nothing of its own:
 *
 *   - every figure is read from the endpoint that already OWNS it
 *     (/cash-position, /reports/ar-aging, /reports/ap-aging, the Finance
 *     Hub's tax block, /analytics/cash) and links to that page;
 *   - each is labelled with the question it answers ("cash in your banks",
 *     "owed to you") — never "revenue", never a verdict;
 *   - the chart is the ledger's net cash MOVEMENT per month, drawn with the
 *     Analytics page's validated up/down pair — not the status palette;
 *   - a figure that did not load renders "—", never 0.
 */

/** Diverging poles for change (the Analytics page's validated pair). NOT the status palette. */
const UP = "#2a78d6";
const DOWN = "#e34948";

function sixMonthWindow(): { from: string; to: string } {
  const [y, m] = businessToday().split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1 - 5, 1));
  return {
    from: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
    to: `${y}-${String(m).padStart(2, "0")}`,
  };
}

const money = (v: number | null | undefined) => (v == null ? "—" : fmtNum(v));

/** Compact axis labels: 12.5K, 1.2M. Latin digits, like the rest of the app. */
function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(Math.round(v));
}

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground border-border",
  submitted: "bg-attention-surface/15 text-attention border-transparent",
  sent: "bg-info-surface/15 text-info border-transparent",
  paid: "bg-positive-surface/15 text-positive border-transparent",
  overdue: "bg-negative-surface/15 text-negative border-transparent",
  cancelled: "bg-muted text-muted-foreground border-border",
};

const BUCKETS: Array<{ key: keyof ArAgingReport["buckets"]; en: string; ar: string; cls: string }> = [
  { key: "current", en: "Not yet due", ar: "غير مستحقة بعد", cls: "bg-positive-surface" },
  { key: "days_1_30", en: "1–30 days", ar: "1–30 يومًا", cls: "bg-attention-surface" },
  { key: "days_31_60", en: "31–60 days", ar: "31–60 يومًا", cls: "bg-severe" },
  { key: "days_61_90", en: "61–90 days", ar: "61–90 يومًا", cls: "bg-negative-surface" },
  { key: "over_90", en: "Over 90 days", ar: "أكثر من 90 يومًا", cls: "bg-critical" },
];

/* ── Header ─────────────────────────────────────────────────────────────── */

function Today() {
  const { lang } = useLanguage();
  const iso = businessToday();
  const [y, m, d] = iso.split("-").map(Number);
  const gregorian = new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
  const hijri = formatHijri(iso, lang);
  return (
    <div className="text-sm leading-tight sm:text-end">
      <div className="font-medium text-foreground">{gregorian}</div>
      {hijri && <div className="mt-0.5 text-[13px] text-muted-foreground">{hijri}</div>}
    </div>
  );
}

/* ── Findings marker (AI-5's escalation terminus — unchanged behaviour) ── */

/**
 * 🔴 Owner decisions (2026-08-24): the escalation lands HERE — on the page the
 * tenant actually opens. It persists until someone opens the findings;
 * OPENING IS THE DISMISSAL — no close button exists. Approver roles only.
 */
function UnreadFindingsMarker() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const isApprover = user?.organizationRole === "admin" || user?.organizationRole === "accountant";
  const { data } = useQuery<{ escalated: boolean; lastScheduledRun: { ranAt: string; openAfter: number } | null }>({
    queryKey: ["findings-status"],
    queryFn: () => apiFetch("/findings/status"),
    enabled: isApprover,
  });
  if (!isApprover || !data?.escalated || !data.lastScheduledRun) return null;
  return (
    <Link
      href="/findings"
      className="mb-6 flex items-start gap-3 rounded-lg border border-attention-surface/40 border-s-4 border-s-attention-surface bg-attention-surface/10 p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <SearchCheck className="mt-0.5 h-5 w-5 shrink-0 text-attention" />
      <div>
        <p className="text-sm font-semibold text-foreground">
          {t(
            `Scheduled findings from ${data.lastScheduledRun.ranAt.slice(0, 10)} have not been opened — ${data.lastScheduledRun.openAfter} open`,
            `ملاحظات الفحص المجدول بتاريخ ${data.lastScheduledRun.ranAt.slice(0, 10)} لم تُفتح بعد — ${data.lastScheduledRun.openAfter} مفتوحة`,
          )}
        </p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {t(
            "This notice stays until someone reviews them. Opening the Findings page is what clears it.",
            "يبقى هذا التنبيه حتى تتم مراجعتها. فتح صفحة الملاحظات هو ما يزيله.",
          )}
        </p>
      </div>
      <ChevronRight className="ms-auto mt-1 h-4 w-4 text-muted-foreground rtl:-scale-x-100" />
    </Link>
  );
}

/* ── Panels ─────────────────────────────────────────────────────────────── */

function CashMovementPanel() {
  const { t, lang } = useLanguage();
  const win = sixMonthWindow();
  const { data, isLoading, isError } = useGetCashReconciliation({ from: win.from, to: win.to });
  const points = (data?.points ?? []).map((p) => {
    const [yy, mm] = p.period.split("-").map(Number);
    const label = new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB", {
      month: "short", timeZone: "UTC",
    }).format(new Date(Date.UTC(yy, mm - 1, 1)));
    return { label, value: p.ledgerCash };
  });
  const net = points.reduce((s, p) => s + p.value, 0);

  return (
    <Panel
      title={t("Cash movement, last six months", "حركة النقد، آخر ستة أشهر")}
      description={t(
        "Net change in the ledger's cash accounts each month — money in above the line, money out below.",
        "صافي التغيّر في حسابات النقد بدفتر الأستاذ كل شهر — الداخل فوق الخط والخارج تحته.",
      )}
      actions={
        <Link href="/analytics" className="text-[13px] font-medium text-primary hover:underline">
          {t("Analytics", "التحليلات")}
        </Link>
      }
      data-testid="dash-cash-movement"
    >
      {isError ? (
        <EmptyState title={t("Cash movement could not be loaded.", "تعذّر تحميل حركة النقد.")} />
      ) : isLoading ? (
        <div className="h-56 animate-pulse rounded-md bg-muted/60" />
      ) : points.every((p) => p.value === 0) ? (
        <EmptyState
          icon={TrendingUp}
          title={t("No cash has moved in the last six months.", "لم تتحرك أي أموال نقدية في آخر ستة أشهر.")}
          description={t("Record a payment or import a bank statement to see it here.", "سجّل دفعة أو استورد كشف حساب بنكي لتظهر هنا.")}
        />
      ) : (
        <>
          <div className="mb-3 flex items-baseline gap-2">
            <span className="text-[13px] text-muted-foreground">{t("Six-month net", "صافي ستة أشهر")}</span>
            <span className="text-lg font-semibold tabular-nums">{fmtNum(net)}</span>
          </div>
          <div className="h-56" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={lang === "ar" ? [...points].reverse() : points} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  orientation={lang === "ar" ? "right" : "left"}
                  tickFormatter={compact}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                />
                <Tooltip
                  cursor={{ fill: "hsl(var(--muted))" }}
                  formatter={(v: number) => [fmtNum(v), t("Net cash", "صافي النقد")]}
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    color: "hsl(var(--popover-foreground))",
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="value" radius={[3, 3, 3, 3]} maxBarSize={44}>
                  {(lang === "ar" ? [...points].reverse() : points).map((p, i) => (
                    <Cell key={i} fill={p.value >= 0 ? UP : DOWN} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 flex gap-4 text-[12px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: UP }} />{t("Net in", "صافي داخل")}</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: DOWN }} />{t("Net out", "صافي خارج")}</span>
          </div>
        </>
      )}
    </Panel>
  );
}

function ReceivablesAgePanel({ ar }: { ar: ArAgingReport | undefined }) {
  const { t } = useLanguage();
  const total = ar?.total ?? 0;
  return (
    <Panel
      title={t("Owed to you, by age", "المستحق لك حسب العمر")}
      actions={
        <Link href="/ar-aging" className="text-[13px] font-medium text-primary hover:underline">
          {t("AR aging", "أعمار الذمم")}
        </Link>
      }
      data-testid="dash-ar-age"
    >
      {!ar ? (
        <div className="h-40 animate-pulse rounded-md bg-muted/60" />
      ) : total === 0 ? (
        <EmptyState title={t("Nothing is owed to you right now.", "لا يوجد مبالغ مستحقة لك حاليًا.")} />
      ) : (
        <>
          <div className="text-[22px] font-semibold tabular-nums">{fmtNum(total)}</div>
          {/* One bar, split by age. Order and a text list carry the meaning; colour is a second cue. */}
          <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={t("Receivables split by age", "الذمم المدينة حسب العمر")}>
            {BUCKETS.map((b) => {
              const v = ar.buckets[b.key];
              return v > 0 ? <span key={b.key} className={b.cls} style={{ width: `${(v / total) * 100}%` }} /> : null;
            })}
          </div>
          <dl className="mt-4 space-y-2.5">
            {BUCKETS.map((b) => (
              <div key={b.key} className="flex items-center justify-between gap-3 text-[13px]">
                <dt className="flex items-center gap-2 text-muted-foreground">
                  <span className={`h-2 w-2 rounded-full ${b.cls}`} />
                  {t(b.en, b.ar)}
                </dt>
                <dd className="tabular-nums text-foreground">{fmtNum(ar.buckets[b.key])}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </Panel>
  );
}

function RecentInvoicesPanel() {
  const { t, lang } = useLanguage();
  const { data, isLoading } = useQuery<ListInvoices200>({
    queryKey: ["dash-recent-invoices"],
    queryFn: () => apiFetch("/invoices?limit=6"),
  });
  const rows = data?.items ?? [];
  return (
    <Panel
      title={t("Recent invoices", "أحدث الفواتير")}
      flush
      actions={
        <Link href="/invoices" className="text-[13px] font-medium text-primary hover:underline">
          {t("All invoices", "كل الفواتير")}
        </Link>
      }
      data-testid="dash-recent-invoices"
    >
      {isLoading ? (
        <div className="m-5 h-40 animate-pulse rounded-md bg-muted/60" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={t("No invoices yet.", "لا توجد فواتير بعد.")}
          action={
            <Button asChild size="sm"><Link href="/invoices">{t("Create an invoice", "أنشئ فاتورة")}</Link></Button>
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="border-b border-border">
                <th className="h-9 px-3 text-start text-[12px] font-medium text-muted-foreground">{t("Invoice", "الفاتورة")}</th>
                <th className="h-9 px-3 text-start text-[12px] font-medium text-muted-foreground">{t("Customer", "العميل")}</th>
                <th className="hidden h-9 px-3 text-start text-[12px] font-medium text-muted-foreground sm:table-cell">{t("Date", "التاريخ")}</th>
                <th className="h-9 px-3 text-end text-[12px] font-medium text-muted-foreground">{t("Total", "الإجمالي")}</th>
                <th className="h-9 px-3 text-start text-[12px] font-medium text-muted-foreground">{t("Status", "الحالة")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => (
                <tr key={inv.id} className="border-b border-border/70 last:border-0">
                  <td className="whitespace-nowrap px-3 py-3 font-medium text-foreground">{inv.invoiceNumber}</td>
                  <td className="max-w-[16rem] truncate px-3 py-3 text-foreground">{inv.customerName ?? "—"}</td>
                  <td className="hidden whitespace-nowrap px-3 py-3 text-muted-foreground sm:table-cell">{fmtDate(inv.date, lang)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-end tabular-nums text-foreground">{fmtNum(inv.total)}</td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-medium capitalize ${STATUS_STYLE[inv.status] ?? STATUS_STYLE.draft}`}>
                      {statusLabel(inv.status, lang)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function AttentionPanel({ overdueInvoices }: { overdueInvoices: number | undefined }) {
  const { t } = useLanguage();
  const { user } = useAuth();
  const isApprover = user?.organizationRole === "admin" || user?.organizationRole === "accountant";
  const { data: books } = useGetBooksStatus();
  const { data: approvals } = useQuery<ApprovalPendingRow[]>({
    queryKey: ["dash-approvals-pending"],
    queryFn: () => apiFetch("/approvals/pending"),
    enabled: isApprover,
  });

  const items: Array<{ href: string; icon: React.ElementType; en: string; ar: string; count: number | undefined; show: boolean }> = [
    { href: "/review", icon: ListChecks, en: "Transactions to review", ar: "معاملات للمراجعة", count: books?.unreviewedCount, show: true },
    { href: "/approvals", icon: ClipboardCheck, en: "Documents awaiting approval", ar: "مستندات بانتظار الاعتماد", count: approvals?.length, show: isApprover },
    { href: "/invoices?status=overdue", icon: AlertTriangle, en: "Overdue invoices", ar: "فواتير متأخرة", count: overdueInvoices, show: true },
    { href: "/categorize", icon: SearchCheck, en: "Rows needing attention", ar: "بنود تحتاج انتباهًا", count: books?.needsAttentionCount, show: true },
  ];

  return (
    <Panel title={t("Needs your attention", "يحتاج انتباهك")} flush data-testid="dash-attention">
      <ul>
        {items.filter((i) => i.show).map((i) => {
          const Icon = i.icon;
          const zero = i.count === 0;
          return (
            <li key={i.href} className="border-b border-border/70 last:border-0">
              <Link href={i.href} className="group flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-muted/50">
                <Icon className={`h-4 w-4 shrink-0 ${zero ? "text-muted-foreground" : "text-primary"}`} />
                <span className={`flex-1 text-sm ${zero ? "text-muted-foreground" : "text-foreground"}`}>{t(i.en, i.ar)}</span>
                <span
                  className={`min-w-7 rounded-md px-1.5 py-0.5 text-center text-[12px] font-semibold tabular-nums ${
                    zero ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"
                  }`}
                >
                  {i.count ?? "—"}
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground/60 group-hover:text-foreground rtl:-scale-x-100" />
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/* ── Page ───────────────────────────────────────────────────────────────── */

export default function Dashboard() {
  const { t, lang } = useLanguage();
  const { user } = useAuth();
  const first = user?.name?.split(" ")[0];

  const { data: cash } = useGetCashPosition();
  const { data: tax } = useGetTaxCompliance();
  const { data: ar } = useQuery<ArAgingReport>({ queryKey: ["ar-aging"], queryFn: () => apiFetch("/reports/ar-aging") });
  const { data: ap } = useQuery<ApAgingReport>({ queryKey: ["ap-aging"], queryFn: () => apiFetch("/reports/ap-aging") });
  // The overdue COUNT, from the list's own filter — `page.total` is "rows
  // matching the filter", so limit=1 asks the question without fetching rows.
  const { data: overdue } = useQuery<ListInvoices200>({
    queryKey: ["dash-overdue-count"],
    queryFn: () => apiFetch("/invoices?status=overdue&limit=1"),
  });

  const arOverdue = ar ? ar.total - ar.buckets.current : undefined;
  const apOverdue = ap ? ap.total - ap.buckets.current : undefined;
  const vat = tax?.vat;
  const activeBanks = cash?.banks.filter((b) => b.isActive).length;

  return (
    <div className="mx-auto max-w-7xl">
      <header className="mb-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            {first ? t(`Welcome back, ${first}`, `مرحبًا بعودتك، ${first}`) : t("Welcome back", "مرحبًا بعودتك")}
          </p>
          <h1 className="mt-1 text-[28px] font-semibold leading-tight text-foreground">{t("Overview", "نظرة عامة")}</h1>
        </div>
        <div className="flex items-end gap-4">
          <Today />
          <Button asChild className="hidden gap-1.5 sm:inline-flex">
            <Link href="/invoices"><Plus className="h-4 w-4" />{t("New invoice", "فاتورة جديدة")}</Link>
          </Button>
        </div>
      </header>

      <UnreadFindingsMarker />

      <StatStrip cols={4} data-testid="dash-figures">
        <Stat
          label={t("Cash in your banks", "النقد في حساباتك البنكية")}
          value={money(cash?.totalLedgerBalance)}
          hint={
            cash
              ? t(`${activeBanks} account${activeBanks === 1 ? "" : "s"} · per the ledger, ${fmtDate(cash.asOf, lang)}`, `${activeBanks} حساب · حسب الدفاتر، ${fmtDate(cash.asOf, lang)}`)
              : undefined
          }
          href="/cash-position"
        />
        <Stat
          label={t("Owed to you", "مستحق لك")}
          value={money(ar?.total)}
          hint={arOverdue != null ? t(`${fmtNum(arOverdue)} past due`, `${fmtNum(arOverdue)} متأخر السداد`) : undefined}
          href="/ar-aging"
        />
        <Stat
          label={t("You owe suppliers", "مستحق للموردين")}
          value={money(ap?.total)}
          hint={apOverdue != null ? t(`${fmtNum(apOverdue)} past due`, `${fmtNum(apOverdue)} متأخر السداد`) : undefined}
          href="/ap-aging"
        />
        <Stat
          label={
            vat && vat.refund > 0
              ? t("VAT refund, this period", "استرداد ضريبة القيمة المضافة، هذه الفترة")
              : t("VAT due, this period", "ضريبة القيمة المضافة المستحقة، هذه الفترة")
          }
          value={vat ? fmtNum(vat.refund > 0 ? vat.refund : vat.payable) : "—"}
          hint={vat ? `${fmtDate(vat.periodFrom, lang)} – ${fmtDate(vat.periodTo, lang)}` : undefined}
          href="/vat"
        />
      </StatStrip>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CashMovementPanel />
        </div>
        <ReceivablesAgePanel ar={ar} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RecentInvoicesPanel />
        </div>
        <AttentionPanel overdueInvoices={overdue?.page.total} />
      </div>

      {/* The two places that answer a question in depth. */}
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        {[
          { href: "/analytics", icon: TrendingUp, en: "How is the business doing?", ar: "كيف يسير أداء المنشأة؟", sub: ["Analytics", "التحليلات"] },
          { href: "/finance-hub", icon: ShieldCheck, en: "Are the books right, current and closed?", ar: "هل دفاترك صحيحة ومحدَّثة ومقفلة؟", sub: ["Finance Hub", "لوحة المالية"] },
        ].map((d) => (
          <Link
            key={d.href}
            href={d.href}
            className="group flex items-center gap-4 rounded-lg border border-border bg-card px-5 py-4 transition-colors hover:border-primary/40 hover:bg-accent/40"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
              <d.icon className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] text-muted-foreground">{t(d.sub[0], d.sub[1])}</span>
              <span className="block text-[15px] font-medium text-foreground">{t(d.en, d.ar)}</span>
            </span>
            <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground rtl:-scale-x-100" />
          </Link>
        ))}
      </div>
    </div>
  );
}
