/**
 * Phase 17 — Treasury (docs/product/phase-16-17-tax-treasury-decision-pack.md §8).
 *
 * 🔴 THE PAGE COMPUTES NO FIGURE. Cash is the ledger's (D17-01), every
 * expected flow is its subledger's own definition (D17-02), and the forecast,
 * liquidity and funding requirement are the API's (D17-03/04). This file only
 * ARRANGES them; the one comparison it makes itself — a plan's week against
 * the buffer (§8.7) — is done in halalas on the API's own figures.
 *
 * 🔴 A FORECAST IS NEVER CASH. Only the opening is "Actual"; every other
 * figure carries its kind (Committed · Expected · Forecast · Manual
 * assumption) and the page says "projection" wherever one is shown.
 *
 * 🔴 NEUTRAL INK FOR JUDGMENTS. A shortfall against a self-chosen buffer is a
 * judgment, not a state (CLAUDE.md §4): words, never the status palette. The
 * chart has ONE money axis; the buffer is a reference line in the same unit.
 *
 * 🔴 EXPLAIN A REFUSAL; DO NOT HIDE THE CONTROL (CLAUDE.md §3). Approve, pay,
 * cancel, delete and the settings form are shown to every role; the server
 * judges, and the mutation cache surfaces its refusal in its own words.
 *
 * The active tab is the URL's `?tab=` so a link to `/treasury?tab=plans`
 * opens that tab, and a row's drill inside the page is an ordinary link.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import {
  useGetTreasuryDashboard, useGetTreasuryPosition, useGetTreasuryForecast,
  useListPaymentPlans, useCreatePaymentPlan, useUpdatePaymentPlan, useDeletePaymentPlan,
  useApprovePaymentPlan, usePayPaymentPlan, useCancelPaymentPlan,
  useListForecastAssumptions, useCreateForecastAssumption, useUpdateForecastAssumption, useDeleteForecastAssumption,
  useGetTreasurySettings, useUpdateTreasurySettings, useListBills, useListVendors,
  getGetTreasuryPositionQueryKey, getGetTreasuryForecastQueryKey, getListPaymentPlansQueryKey,
  getListBillsQueryKey, getListVendorsQueryKey,
  type TreasuryDashboard, type TreasuryForecast, type TreasuryBucket, type TreasuryFlowRow, type TreasuryFlowRowSource,
  type PaymentPlan, type ForecastAssumption, type ListBillsParams, type ListPaymentPlansParams, type Bill,
  type ForecastAssumptionInputCategory, type ForecastAssumptionInputDirection, type CreatePaymentPlanInputPriority,
  type PayPaymentPlanInput,
} from "@workspace/api-client-react";
import { businessToday } from "@workspace/shared";
import { fmtDate, fmtNum } from "@/lib/api";
import { refusalOf } from "@/lib/openingVatRefusals";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { useBankOptions } from "@/components/payments/shared";
import {
  flowKindLabel, flowCategoryLabel, planStatusLabel, priorityLabel, assumptionCategoryLabel,
  whtTypeLabel, WHT_TYPES, notSubjectLabel, residencyLabel,
} from "@/lib/taxLabels";
import {
  TREASURY_TABS, parseTreasuryTab, treasuryTabLabel, bucketReasonLabel, directionLabel, assumptionDirectionLabel,
  sourceTypeLabel, sourceHref, type TreasuryTab,
} from "@/lib/treasuryLabels";

type T = (en: string, ar: string) => string;

/** The validated categorical slot 1 (Analytics.tsx) — the only series colour on this page. */
const SERIES_1 = "#2a78d6";
/** Chart-axis ticks only — compact so a currency scale fits a phone; never for a figure a reader acts on. */
const compactTick = (v: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v);
/** Halalas — the only arithmetic this page does on money is comparison. */
const h = (x: number) => Math.round(x * 100);
/** Radix Select refuses an empty-string item; this stands for "none / all". */
const NONE = "__none";
const PRIORITIES = ["high", "normal", "low"] as const;
const ASSUMPTION_CATEGORIES = ["financing", "capex", "tax", "payroll", "receipt", "payment", "other"] as const;
const PLAN_STATUSES = ["planned", "approved", "paid", "cancelled"] as const;

/**
 * A typed amount, or null when it is not one. `Number("")` is 0 and
 * `Number("1,000")` is NaN (JSON-serialised as null) — neither may reach the
 * server as an amount, so the submit stays disabled until this returns one.
 */
function parseAmount(s: string, opts: { allowZero?: boolean } = {}): number | null {
  const v = s.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const x = Number(v);
  if (!Number.isFinite(x) || (opts.allowZero ? x < 0 : x <= 0)) return null;
  return x;
}
const parseWeeks = (s: string): number | null => {
  const v = s.trim();
  if (!/^\d{1,2}$/.test(v)) return null;
  const x = Number(v);
  return x >= 1 && x <= 52 ? x : null;
};

/** Every treasury figure moves together; a paid plan also moves bills, payments, tax and the reports. */
const TREASURY_KEYS = ["/api/treasury"];
const PAYMENT_KEYS = ["/api/bills", "/api/supplier-payments", "/api/supplier-statements", "/api/vendors", "/api/tax", "/api/reports", "/api/journal-entries", "/api/cash-position", "/api/finance-hub", "/api/summary"];
const LEGACY_PAYMENT_KEYS = ["bills", "bank-accounts", "payments", "vendors", "journal-entries"];
function useRefresh() {
  const qc = useQueryClient();
  return (alsoPayments = false) =>
    qc.invalidateQueries({
      predicate: (q) => {
        const k = q.queryKey[0];
        if (typeof k !== "string") return false;
        if (TREASURY_KEYS.some((p) => k.startsWith(p))) return true;
        return alsoPayments && (PAYMENT_KEYS.some((p) => k.startsWith(p)) || LEGACY_PAYMENT_KEYS.includes(k));
      },
    });
}

function M({ v, testId, bold }: { v: number | null | undefined; testId?: string; bold?: boolean }) {
  return <span className={`font-mono whitespace-nowrap ${bold ? "font-semibold" : ""}`} dir="ltr" data-testid={testId}>{v == null ? "—" : fmtNum(v)}</span>;
}
function D({ d }: { d: string | null | undefined }) {
  return <span className="whitespace-nowrap">{d ? fmtDate(d) : "—"}</span>;
}
/** A flow's kind in neutral ink — the kind is a label, not a state. */
function KindTag({ kind }: { kind: string }) {
  const { t } = useLanguage();
  const text = kind === "projection" ? t("Projection", "إسقاط") : flowKindLabel(kind, t);
  return <span className="inline-block rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground whitespace-nowrap align-middle">{text}</span>;
}
function Loading() {
  const { t } = useLanguage();
  return <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>;
}
function Refused({ error, testId }: { error: unknown; testId?: string }) {
  const { t } = useLanguage();
  return (
    <p className="text-sm p-4" data-testid={testId}>
      {t("The server refused this: ", "رفض الخادم هذا الطلب: ")}{refusalOf(error).words}
    </p>
  );
}
function bucketName(b: TreasuryBucket, n: (en: string, ar?: string | null) => string) {
  return n(b.label, b.labelAr);
}
/** The bucket a date falls in, by the API's own bucket edges; bucket 0 for a date before today. */
function bucketOfDate(f: TreasuryForecast, date: string): TreasuryBucket | "beyond" | null {
  if (date < f.asOf) return f.buckets.find((b) => b.index === 0) ?? null;
  return f.buckets.find((b) => b.from != null && b.to != null && b.from <= date && date <= b.to) ?? "beyond";
}

// ─────────────────────────────────────────────────────────────────────────────

export default function Treasury() {
  const { t, lang } = useLanguage();
  const search = useSearch();
  const [location, navigate] = useLocation();
  const tab = parseTreasuryTab(new URLSearchParams(search).get("tab"));
  const go = (next: TreasuryTab) => navigate(`${location.split("?")[0]}?tab=${next}`);
  const dash = useGetTreasuryDashboard();

  return (
    <div className="space-y-6" data-testid="treasury-page">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("Treasury", "الخزينة")}</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
          {t("Cash in the ledger, what is expected to come in and go out, and the payments you plan. A forecast is a projection, never cash; nothing here moves money or instructs a bank.",
            "النقد في الدفاتر، وما يُتوقع وروده وصرفه، والمدفوعات التي تخطط لها. التوقع إسقاط وليس نقدًا؛ ولا شيء هنا يحرّك أموالًا أو يرسل تعليمات إلى بنك.")}
        </p>
      </div>

      {/* Radix Tabs writes its own dir="ltr" unless told otherwise (BudgetDetail, pre-merge audit 2026-10-02) */}
      <Tabs value={tab} onValueChange={(v) => go(parseTreasuryTab(v))} dir={lang === "ar" ? "rtl" : "ltr"}>
        <TabsList className="flex-wrap h-auto">
          {TREASURY_TABS.map((v) => <TabsTrigger key={v} value={v} data-testid={`treasury-tab-${v}`}>{treasuryTabLabel(v, t)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="overview">
          {dash.isLoading ? <Loading /> : dash.isError || !dash.data ? <Refused error={dash.error} testId="treasury-error" /> : <OverviewTab data={dash.data} onTab={go} />}
        </TabsContent>
        <TabsContent value="forecast">
          {dash.isLoading ? <Loading /> : dash.isError || !dash.data ? <Refused error={dash.error} /> : <ForecastTab defaultForecast={dash.data.forecast} />}
        </TabsContent>
        <TabsContent value="plans"><PlansTab forecast={dash.data?.forecast} onTab={go} /></TabsContent>
        <TabsContent value="assumptions"><AssumptionsTab /></TabsContent>
        <TabsContent value="settings"><SettingsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({ data, onTab }: { data: TreasuryDashboard; onTab: (t: TreasuryTab) => void }) {
  const { t } = useLanguage();
  const f = data.forecast;
  return (
    <div className="space-y-4">
      <PositionCard todays={data.position} />
      <LiquidityCard f={f} />
      <FundingCard f={f} onTab={onTab} />
      <Card className="border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground">{t("Upcoming outflows — the next 30 days, and everything overdue or undated", "المدفوعات القادمة — الثلاثون يومًا القادمة، وكل متأخر أو غير مؤرَّخ")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.upcomingOutflows.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="treasury-upcoming-empty">{t("Nothing is due to go out in the next 30 days, and nothing is overdue or undated.", "لا شيء مستحق الدفع خلال الثلاثين يومًا القادمة، ولا شيء متأخر أو غير مؤرَّخ.")}</p>
          ) : (
            <>
              <FlowRowsTable rows={data.upcomingOutflows} f={f} testId="treasury-upcoming" />
              {data.upcomingOutflowsTotal > data.upcomingOutflows.length && (
                <p className="text-xs text-muted-foreground" data-testid="treasury-upcoming-more">
                  {t(`Showing the first ${data.upcomingOutflows.length} of ${data.upcomingOutflowsTotal} — `, `تُعرض أول ${data.upcomingOutflows.length} من ${data.upcomingOutflowsTotal} — `)}
                  <button type="button" className="underline" onClick={() => onTab("forecast")}>{t("the Forecast tab lists them all.", "تبويب التوقع يعرضها كلها.")}</button>
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PositionCard({ todays }: { todays: TreasuryDashboard["position"] }) {
  const { t } = useLanguage();
  const today = businessToday();
  const [asOf, setAsOf] = useState("");
  const params = { as_of: asOf };
  // a past date reads the position endpoint; today is the dashboard's own position
  const past = useGetTreasuryPosition(params, { query: { enabled: asOf !== "" && asOf !== today, queryKey: getGetTreasuryPositionQueryKey(params), retry: false } });
  const usingPast = asOf !== "" && asOf !== today;
  const p = usingPast ? past.data : todays;

  return (
    <Card className="border-border">
      <CardHeader className="pb-2 space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <CardTitle className="text-sm text-muted-foreground">{t("Cash position", "المركز النقدي")}</CardTitle>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label className="text-xs text-muted-foreground">{t("As of", "في تاريخ")}</Label>
              <Input type="date" dir="ltr" max={today} value={asOf || today} onChange={(e) => setAsOf(e.target.value)} className="mt-1 h-8 w-40 text-sm" data-testid="treasury-as-of" />
            </div>
            {usingPast && <Button size="sm" variant="outline" className="h-8" onClick={() => setAsOf("")}>{t("Today", "اليوم")}</Button>}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("A position is what the ledger holds on a day that has happened — a later date is refused; the Forecast tab projects the future.", "المركز هو ما تحمله الدفاتر في يوم مضى — يُرفض أي تاريخ لاحق؛ وتبويب التوقع يتولى إسقاط المستقبل.")}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {usingPast && past.isLoading ? <Loading /> : usingPast && past.isError ? <Refused error={past.error} testId="treasury-position-refused" /> : !p ? <Loading /> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="treasury-banks">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    {[t("Bank account", "الحساب البنكي"), t("Ledger balance", "الرصيد في الدفاتر"), t("Latest statement — beside, never netted", "آخر كشف — بجانبه، لا يُخصم منه"), t("Reconciled through", "مطابق حتى")].map((x) => <th key={x} className="text-start pb-2 pe-3 font-medium">{x}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {p.banks.map((b) => (
                    <tr key={b.bankAccountId} className="border-b border-border/50" data-testid={`treasury-bank-${b.bankAccountId}`}>
                      <td className="py-2 pe-3">
                        <Link href="/bank-accounts" className="hover:underline">{b.name}</Link>
                        {b.bankName ? <span className="text-xs text-muted-foreground"> — {b.bankName}</span> : null}
                        {!b.isActive && <span className="ms-1 text-[10px] text-muted-foreground">({t("inactive", "غير نشط")})</span>}
                      </td>
                      <td className="py-2 pe-3 text-end"><M v={b.ledgerBalance} testId={`treasury-bank-balance-${b.bankAccountId}`} /></td>
                      <td className="py-2 pe-3 text-xs">
                        {b.latestStatement
                          ? <Link href="/bank-statements" className="hover:underline"><M v={b.latestStatement.closingBalance} /> · {t("closing on", "الإقفال في")} <D d={b.latestStatement.periodTo} /></Link>
                          : <span className="text-muted-foreground">{t("No statement imported", "لم يُستورد كشف")}</span>}
                      </td>
                      <td className="py-2 pe-3 text-xs">
                        {b.reconciledThrough ? <Link href="/bank-reconciliations" className="hover:underline"><D d={b.reconciledThrough} /></Link> : <span className="text-muted-foreground">{t("Not reconciled", "لم تُطابق")}</span>}
                      </td>
                    </tr>
                  ))}
                  {p.banks.length === 0 && (
                    <tr><td colSpan={4} className="py-2 text-sm text-muted-foreground" data-testid="treasury-no-banks">{t("No bank accounts yet.", "لا حسابات بنكية بعد.")}</td></tr>
                  )}
                  <tr className="border-b border-border/50" data-testid="treasury-unattributed">
                    <td className="py-2 pe-3">
                      {t("Not attributed to a bank", "غير منسوب إلى بنك")}
                      <span className="block text-[11px] text-muted-foreground">{t("History still on the Cash and Bank header, from before each bank had its own account.", "حركات تاريخية ما زالت على حساب النقد والبنك الرئيسي، من قبل أن يكون لكل بنك حسابه.")}</span>
                    </td>
                    <td className="py-2 pe-3 text-end"><M v={p.unattributedCash} testId="treasury-unattributed-amount" /></td>
                    <td colSpan={2} />
                  </tr>
                  <tr className="font-semibold">
                    <td className="py-2 pe-3">{t("Total cash", "إجمالي النقد")} <KindTag kind="actual" /></td>
                    <td className="py-2 pe-3 text-end"><Link href="/balance-sheet" className="hover:underline"><M v={p.totalCash} testId="treasury-total-cash" bold /></Link></td>
                    <td colSpan={2} className="py-2 text-xs font-normal text-muted-foreground">{t("as of", "في")} <D d={p.asOf} /></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-sm">
              {t("In transit — own-account transfers not yet arrived; shown beside cash, never added to it: ", "قيد التحويل — تحويلات بين حساباتك لم تصل بعد؛ تُعرض بجانب النقد ولا تُضاف إليه: ")}
              <Link href="/bank-transfers" className="hover:underline"><M v={p.inTransit} testId="treasury-in-transit" /></Link>
            </p>
            <p className="text-sm" data-testid="treasury-reconciles">
              {p.reconciliation.reconciles
                ? <>{t("Equals the balance sheet's cash exactly ", "يطابق النقد في قائمة المركز المالي تمامًا ")}(<M v={p.reconciliation.balanceSheetCash} />).</>
                : <>{t("Does NOT equal the balance sheet's cash — the total above is ", "لا يطابق النقد في قائمة المركز المالي — الإجمالي أعلاه ")}<M v={p.totalCash} />{t(", the balance sheet shows ", "، والقائمة تُظهر ")}<M v={p.reconciliation.balanceSheetCash} />.</>}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="treasury-policy">{t(p.policy.en, p.policy.ar)}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, kind, children, hint, testId }: { label: string; kind?: string; children: ReactNode; hint?: string; testId?: string }) {
  return (
    <div className="rounded-md border border-border p-3 min-w-0" data-testid={testId}>
      <p className="text-xs text-muted-foreground flex flex-wrap items-center gap-1">{label} {kind && <KindTag kind={kind} />}</p>
      <p className="text-lg mt-1">{children}</p>
      {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

function LiquidityCard({ f }: { f: TreasuryForecast }) {
  const { t, n } = useLanguage();
  const L = f.liquidity;
  const lowest = f.buckets.find((b) => h(b.closing) === h(L.lowestClosing));
  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-muted-foreground">{t("Liquidity — today, and the next 30 days", "السيولة — اليوم وخلال الثلاثين يومًا القادمة")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Stat label={t("Actual cash", "النقد الفعلي")} kind="actual"><M v={L.actualCash} testId="treasury-actual-cash" /></Stat>
          <Stat label={t("Committed — approved plans not yet paid", "ملتزم به — خطط معتمدة لم تُدفع")} kind="committed"><M v={L.committed} testId="treasury-committed" /></Stat>
          <Stat label={t("Available — actual cash less committed", "المتاح — النقد الفعلي ناقص الملتزم به")}><M v={L.available} testId="treasury-available" bold /></Stat>
          <Stat label={t("Expected inflows, next 30 days", "التدفقات الواردة المتوقعة خلال 30 يومًا")} kind="projection"><M v={L.expectedInflows30} testId="treasury-in-30" /></Stat>
          <Stat label={t("Expected outflows, next 30 days", "التدفقات الصادرة المتوقعة خلال 30 يومًا")} kind="projection"><M v={L.expectedOutflows30} testId="treasury-out-30" /></Stat>
          <Stat label={t("Overdue receivables", "مستحقات العملاء المتأخرة")} kind="expected"><M v={L.overdueReceivables} testId="treasury-overdue-receivables" /></Stat>
          <Stat label={t("Overdue payables — bills, plans and tax past their date", "مستحقات متأخرة الدفع — فواتير وخطط وضرائب فات موعدها")} kind="projection"><M v={L.overduePayables} testId="treasury-overdue-payables" /></Stat>
          <Stat label={t("Undated obligations", "التزامات بلا تاريخ")} kind="expected" hint={t("Payroll payables and anything the rules cannot date — counted at once; their timing is unknown, not today.", "الرواتب المستحقة وكل ما لا تحدد القواعد تاريخه — تُحتسب فورًا؛ توقيتها غير معروف، وليس اليوم.")}><M v={L.undatedObligations} testId="treasury-undated" /></Stat>
          <Stat label={t("Lowest projected closing", "أدنى إقفال متوقع")} kind="projection" hint={lowest ? bucketName(lowest, n) : undefined}><M v={L.lowestClosing} testId="treasury-lowest-closing" /></Stat>
        </div>
      </CardContent>
    </Card>
  );
}

function FundingCard({ f, onTab }: { f: TreasuryForecast; onTab: (t: TreasuryTab) => void }) {
  const { t, n } = useLanguage();
  const F = f.funding;
  const first = F.firstShortfallBucket != null ? f.buckets.find((b) => b.index === F.firstShortfallBucket) : undefined;
  const peak = F.peakShortfallBucket != null ? f.buckets.find((b) => b.index === F.peakShortfallBucket) : undefined;
  const range = (b: TreasuryBucket) => (b.from ? <> (<D d={b.from} /> – <D d={b.to} />)</> : null);
  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-muted-foreground">{t("Funding requirement", "الاحتياج التمويلي")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0" data-testid="treasury-buffer">
            <p className="text-xs text-muted-foreground">{t("Minimum cash balance", "الحد الأدنى لرصيد النقد")}</p>
            {F.bufferDeclared
              ? <p className="text-lg mt-1"><M v={F.minimumBalance} /></p>
              : <p className="text-sm mt-1">{t("No minimum balance is declared — measured against zero.", "لم يُحدَّد حد أدنى للرصيد — يُقاس مقابل الصفر.")} <button type="button" className="underline text-xs" onClick={() => onTab("settings")}>{t("Set one in Settings", "حدّده من الإعدادات")}</button></p>}
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{t("Largest shortfall in the horizon", "أكبر عجز خلال الأفق")} <KindTag kind="projection" /></p>
            <p className="text-lg mt-1"><M v={F.requirement} testId="treasury-funding-requirement" bold /></p>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{t("First week below it", "أول أسبوع دونه")}</p>
            <p className="text-sm mt-1" data-testid="treasury-first-shortfall">{first ? <>{bucketName(first, n)}{range(first)}</> : t("None in the horizon", "لا يوجد خلال الأفق")}</p>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{t("Deepest shortfall", "أعمق عجز")}</p>
            <p className="text-sm mt-1" data-testid="treasury-peak-shortfall">{peak ? <>{bucketName(peak, n)}{range(peak)}</> : t("None in the horizon", "لا يوجد خلال الأفق")}</p>
          </div>
        </div>
        <p className="text-sm rounded-md border border-border px-3 py-2" data-testid="treasury-recommendation">
          {F.recommendation
            ? t(F.recommendation.en, F.recommendation.ar)
            : t(`The projection stays at or above the measure throughout the ${f.horizonWeeks}-week horizon — no funding is indicated.`, `يبقى الإسقاط عند المقياس أو فوقه طوال أفق ${f.horizonWeeks} أسبوعًا — لا يُشار إلى أي تمويل.`)}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("A calculation and a recommendation in words — never a transaction. This product does not borrow or book funding; a loan is recorded through the ledger when it exists. The minimum balance is your own policy, so a shortfall against it is a judgment, not an alarm.",
            "حساب وتوصية بالكلمات — وليس معاملة أبدًا. لا يقترض هذا النظام ولا يسجّل تمويلًا؛ يُسجَّل القرض في الدفاتر عند وجوده. الحد الأدنى للرصيد سياستك أنت، فالعجز عنه تقدير وليس إنذارًا.")}
        </p>
      </CardContent>
    </Card>
  );
}

// ── one table for forecast rows (Overview's upcoming outflows, Forecast's rows) ──

function SourceCell({ s }: { s: TreasuryFlowRowSource }) {
  const { t, lang } = useLanguage();
  const href = sourceHref(s.type);
  // a tax row's id is its period; its `reference` is an explanatory note the API writes in English only
  const isTax = s.type.startsWith("tax_");
  const ref = isTax ? (s.id != null ? String(s.id) : null) : (s.reference ?? (s.id != null ? String(s.id) : null));
  const text = <>{sourceTypeLabel(s.type, t)}{ref ? <> · <span dir="ltr">{ref}</span></> : null}</>;
  return (
    <span className="text-xs">
      {href ? <Link href={href} className="underline hover:text-primary">{text}</Link> : text}
      {isTax && s.reference && lang === "en" ? <span className="block text-[11px] text-muted-foreground">{s.reference}</span> : null}
    </span>
  );
}

function FlowRowsTable({ rows, f, testId }: { rows: TreasuryFlowRow[]; f: TreasuryForecast; testId: string }) {
  const { t, n } = useLanguage();
  const byIndex = new Map(f.buckets.map((b) => [b.index, b]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid={testId}>
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            {[t("Date", "التاريخ"), t("Week", "الأسبوع"), t("Kind", "النوع"), t("Category", "الفئة"), t("Direction", "الاتجاه"), t("Amount", "المبلغ"), t("Description", "الوصف"), t("Source", "المصدر")].map((x) => <th key={x} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{x}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const b = byIndex.get(r.bucket);
            return (
              <tr key={`${r.source.type}-${String(r.source.id)}-${r.date ?? "u"}-${i}`} className="border-b border-border/50" data-testid={`${testId}-row-${i}`}>
                <td className="py-1.5 pe-3 text-xs">{r.date ? <D d={r.date} /> : null}{r.bucketReason ? <span className="block text-muted-foreground">{bucketReasonLabel(r.bucketReason, t)}</span> : null}</td>
                <td className="py-1.5 pe-3 text-xs whitespace-nowrap">{b ? bucketName(b, n) : r.bucket}</td>
                <td className="py-1.5 pe-3"><KindTag kind={r.kind} /></td>
                <td className="py-1.5 pe-3 text-xs">{flowCategoryLabel(r.category, t)}</td>
                <td className="py-1.5 pe-3 text-xs">{directionLabel(r.direction, t)}</td>
                <td className="py-1.5 pe-3 text-end"><M v={r.amount} /></td>
                <td className="py-1.5 pe-3 text-xs min-w-40">{n(r.label, r.labelAr)}</td>
                <td className="py-1.5 pe-3"><SourceCell s={r.source} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Forecast ────────────────────────────────────────────────────────────────

function ForecastTab({ defaultForecast }: { defaultForecast: TreasuryForecast }) {
  const { t, n } = useLanguage();
  const [weeksInput, setWeeksInput] = useState("");
  const [weeks, setWeeks] = useState<number | null>(null);
  const params = { weeks: weeks ?? undefined };
  const custom = useGetTreasuryForecast(params, { query: { enabled: weeks != null, queryKey: getGetTreasuryForecastQueryKey(params) } });
  const f = weeks == null ? defaultForecast : custom.data;
  const [bucketFilter, setBucketFilter] = useState(NONE);
  const [categoryFilter, setCategoryFilter] = useState(NONE);
  const parsedWeeks = parseWeeks(weeksInput);

  const rows = (f?.rows ?? []).filter((r) => (bucketFilter === NONE || String(r.bucket) === bucketFilter) && (categoryFilter === NONE || r.category === categoryFilter));
  const categories = Array.from(new Set((f?.rows ?? []).map((r) => r.category)));
  const kinds = (o: Record<string, number>, keys: string[]) => keys.filter((k) => h(o[k] ?? 0) !== 0);

  return (
    <div className="space-y-4">
      <Card className="border-border">
        <CardContent className="pt-4 space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label className="text-xs text-muted-foreground">{t("Horizon (weeks, 1–52)", "الأفق (بالأسابيع، 1–52)")}</Label>
              <Input dir="ltr" inputMode="numeric" className="mt-1 h-8 w-28 text-sm" placeholder={String(defaultForecast.horizonWeeks)} value={weeksInput} onChange={(e) => setWeeksInput(e.target.value)} data-testid="treasury-forecast-weeks" />
            </div>
            <Button size="sm" className="h-8" disabled={parsedWeeks == null} onClick={() => setWeeks(parsedWeeks)} data-testid="treasury-forecast-weeks-apply">{t("Show", "عرض")}</Button>
            {weeks != null && <Button size="sm" variant="ghost" className="h-8" onClick={() => { setWeeks(null); setWeeksInput(""); }}>{t("Back to the default", "العودة إلى الافتراضي")}</Button>}
          </div>
          {weeksInput.trim() !== "" && parsedWeeks == null && <p className="text-xs text-muted-foreground">{t("A whole number of weeks from 1 to 52.", "عدد صحيح من الأسابيع بين 1 و52.")}</p>}
          <p className="text-sm" data-testid="treasury-projection-note">
            {t("Projection — not cash. Only the opening is actual; every other figure is labelled with its kind.", "إسقاط — وليس نقدًا. الرصيد الافتتاحي وحده فعلي؛ وكل رقم آخر موسوم بنوعه.")}
          </p>
          {f && (
            <p className="text-sm">
              {t("Opening cash today", "النقد الافتتاحي اليوم")} <KindTag kind={f.opening.kind} /> <M v={f.opening.amount} testId="treasury-opening" bold />
              {" · "}{t(`${f.horizonWeeks} weeks, through`, `${f.horizonWeeks} أسبوعًا، حتى`)} <D d={f.horizonEnd} />
            </p>
          )}
        </CardContent>
      </Card>

      {weeks != null && custom.isLoading ? <Loading /> : weeks != null && custom.isError ? <Refused error={custom.error} /> : !f ? <Loading /> : (
        <>
          <Card className="border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">{t("Projected closing cash by week", "الإقفال النقدي المتوقع لكل أسبوع")} <KindTag kind="projection" /></CardTitle>
              <p className="text-xs text-muted-foreground">{t("One money axis. The dashed line is the minimum balance — or zero when none is declared — in the same unit. The first point is the overdue-and-undated bucket.", "محور مالي واحد. الخط المتقطع هو الحد الأدنى للرصيد — أو الصفر إن لم يُحدَّد — بالوحدة نفسها. النقطة الأولى هي فترة المتأخر وغير المؤرَّخ.")}</p>
            </CardHeader>
            <CardContent><ClosingChart f={f} /></CardContent>
          </Card>

          <Card className="border-border">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Weekly buckets", "الفترات الأسبوعية")}</CardTitle></CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="treasury-buckets">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      {[t("Bucket", "الفترة"), t("Dates", "التواريخ"), t("Opening", "الافتتاحي"), t("Inflows", "الوارد"), t("Outflows", "الصادر"), t("Net", "الصافي"), t("Closing (projection)", "الإقفال (إسقاط)")].map((x) => <th key={x} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{x}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {f.buckets.map((b) => (
                      <tr key={b.index} className="border-b border-border/50 align-top" data-testid={`treasury-bucket-${b.index}`}>
                        <td className="py-2 pe-3 whitespace-nowrap">{bucketName(b, n)}</td>
                        <td className="py-2 pe-3 text-xs">{b.from ? <><D d={b.from} /> – <D d={b.to} /></> : <span className="text-muted-foreground">{t("past their date, or no date", "فات تاريخها، أو بلا تاريخ")}</span>}</td>
                        <td className="py-2 pe-3 text-end"><M v={b.opening} />{b.index === 0 && <span className="block"><KindTag kind="actual" /></span>}</td>
                        <td className="py-2 pe-3 text-end">
                          <M v={b.inflow.total} bold />
                          {kinds(b.inflow, ["expected", "forecast", "manual"]).map((k) => <span key={k} className="block text-[11px] text-muted-foreground whitespace-nowrap">{flowKindLabel(k, t)} <M v={(b.inflow as Record<string, number>)[k]} /></span>)}
                        </td>
                        <td className="py-2 pe-3 text-end">
                          <M v={b.outflow.total} bold />
                          {kinds(b.outflow, ["committed", "expected", "forecast", "manual"]).map((k) => <span key={k} className="block text-[11px] text-muted-foreground whitespace-nowrap">{flowKindLabel(k, t)} <M v={(b.outflow as Record<string, number>)[k]} /></span>)}
                        </td>
                        <td className="py-2 pe-3 text-end"><M v={b.net} /></td>
                        <td className="py-2 pe-3 text-end"><M v={b.closing} testId={`treasury-bucket-closing-${b.index}`} bold /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border">
            <CardHeader className="pb-2 space-y-2">
              <CardTitle className="text-sm text-muted-foreground">{t("Every expected flow, with its source", "كل تدفق متوقع، مع مصدره")}</CardTitle>
              <div className="flex flex-wrap gap-2">
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Week", "الأسبوع")}</Label>
                  <Select value={bucketFilter} onValueChange={setBucketFilter}>
                    <SelectTrigger className="mt-1 h-8 w-48 text-sm" data-testid="treasury-rows-bucket"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t("All", "الكل")}</SelectItem>
                      {f.buckets.map((b) => <SelectItem key={b.index} value={String(b.index)}>{bucketName(b, n)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Category", "الفئة")}</Label>
                  <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                    <SelectTrigger className="mt-1 h-8 w-48 text-sm" data-testid="treasury-rows-category"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{t("All", "الكل")}</SelectItem>
                      {categories.map((c) => <SelectItem key={c} value={c}>{flowCategoryLabel(c, t)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {(f.rows.length === 0 || rows.length === 0) && (
                <p className="text-sm text-muted-foreground" data-testid="treasury-rows-empty">
                  {f.rows.length === 0
                    ? t("Nothing is expected to come in or go out within the horizon.", "لا يُتوقع ورود أو صرف أي شيء خلال الأفق.")
                    : t("No flow matches these filters.", "لا يوجد تدفق يطابق هذه المرشحات.")}
                </p>
              )}
              {/* the table stays mounted (empty) so its frame — and its test id — never depends on the data */}
              <FlowRowsTable rows={rows} f={f} testId="treasury-rows" />
              <p className="text-xs text-muted-foreground">{t(`${rows.length} of ${f.rows.length} flow(s) shown.`, `${rows.length} من ${f.rows.length} تدفق معروضة.`)}</p>
            </CardContent>
          </Card>

          <Card className="border-border">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("What the forecast leaves out, and how it is built", "ما يستبعده التوقع، وكيف يُبنى")}</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm" data-testid="treasury-excluded">
              <ul className="space-y-1">
                <li>{t(`Beyond the horizon, not counted: ${f.excluded.beyondHorizon.count} item(s) — in `, `بعد الأفق، لا تُحتسب: ${f.excluded.beyondHorizon.count} بند — وارد `)}<M v={f.excluded.beyondHorizon.inflow} />{t(", out ", "، صادر ")}<M v={f.excluded.beyondHorizon.outflow} />.</li>
                <li>{t(`Past-dated assumptions (stale), not counted: ${f.excluded.staleAssumptions}.`, `افتراضات مضى تاريخها (متقادمة)، لا تُحتسب: ${f.excluded.staleAssumptions}.`)}</li>
                <li>{t(`Journal-entry recurring rules — no cash meaning, not counted: ${f.excluded.journalEntryRules}.`, `قواعد القيود المتكررة — بلا معنى نقدي، لا تُحتسب: ${f.excluded.journalEntryRules}.`)}</li>
                <li>{t(`Recurring rules that have never run — no amount to project: ${f.excluded.rulesWithoutHistory}.`, `قواعد متكررة لم تُشغَّل قط — لا مبلغ لإسقاطه: ${f.excluded.rulesWithoutHistory}.`)}</li>
              </ul>
              <ul className="space-y-1 text-xs text-muted-foreground list-disc ps-5" data-testid="treasury-notes">
                {f.notes.map((x, i) => <li key={i}>{t(x.en, x.ar)}</li>)}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function ClosingChart({ f }: { f: TreasuryForecast }) {
  const { t, n } = useLanguage();
  const buffer = f.funding.bufferDeclared && f.funding.minimumBalance != null ? f.funding.minimumBalance : 0;
  const data = f.buckets.map((b) => ({
    name: b.index === 0 ? t("Overdue", "المتأخر") : String(b.index),
    label: `${bucketName(b, n)}${b.from ? ` · ${b.from} – ${b.to}` : ""}`,
    closing: b.closing,
  }));
  // the chart is a time axis: drawn left-to-right in both languages, its tooltip in the page's own words
  return (
    <div className="h-[260px] text-muted-foreground" dir="ltr" data-testid="treasury-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 18, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} width={56} tickFormatter={(v) => compactTick(Number(v))} />
          <Tooltip
            formatter={(v: number) => [fmtNum(Number(v)), t("Projected closing", "الإقفال المتوقع")]}
            labelFormatter={(_l, payload) => (payload?.[0]?.payload as { label?: string } | undefined)?.label ?? ""}
          />
          <ReferenceLine
            y={buffer} stroke="currentColor" strokeDasharray="6 4" opacity={0.6} ifOverflow="extendDomain"
            label={{ value: f.funding.bufferDeclared ? t("Minimum balance", "الحد الأدنى للرصيد") : t("Zero — no minimum declared", "الصفر — لا حد أدنى محدد"), position: "insideTopLeft", fontSize: 11, fill: "currentColor" }}
          />
          <Line type="linear" dataKey="closing" name={t("Projected closing", "الإقفال المتوقع")} stroke={SERIES_1} strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Payment plans ───────────────────────────────────────────────────────────

function BankSelect({ value, onChange, testId, allowNone }: { value: string; onChange: (v: string) => void; testId: string; allowNone?: boolean }) {
  const { t } = useLanguage();
  const { active } = useBankOptions();
  return (
    <>
      <Select value={allowNone ? (value || NONE) : value} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
        <SelectTrigger className="mt-1 h-9 text-sm" data-testid={testId}><SelectValue placeholder={t("Choose the bank account", "اختر الحساب البنكي")} /></SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value={NONE}>{t("No bank yet", "بدون بنك بعد")}</SelectItem>}
          {active.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}{b.bankName ? ` — ${b.bankName}` : ""}</SelectItem>)}
        </SelectContent>
      </Select>
      {active.length === 0 && <p className="text-xs text-muted-foreground mt-1">{t("No active bank account — add one in Bank accounts; money moves through a named bank.", "لا يوجد حساب بنكي نشط — أضف حسابًا من الحسابات البنكية؛ تتحرك الأموال عبر بنك محدد.")}</p>}
    </>
  );
}

function NatureSelect({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }) {
  const { t } = useLanguage();
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <SelectTrigger className="mt-1 h-9 text-sm" data-testid={testId}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t("Not stated — the supplier's default nature applies at payment", "غير مذكورة — تُطبَّق طبيعة المورد الافتراضية عند الدفع")}</SelectItem>
        {WHT_TYPES.map((x) => <SelectItem key={x} value={x}>{whtTypeLabel(x, t)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function PlansTab({ forecast, onTab }: { forecast: TreasuryForecast | undefined; onTab: (t: TreasuryTab) => void }) {
  const { t, n } = useLanguage();
  const [status, setStatus] = useState(NONE);
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState<{ kind: "edit" | "pay" | "cancel" | "delete"; id: number } | null>(null);
  const params: ListPaymentPlansParams | undefined = status === NONE ? undefined : { status };
  const plans = useListPaymentPlans(params, { query: { queryKey: getListPaymentPlansQueryKey(params) } });
  const list = plans.data ?? [];
  const flags = new Map((forecast?.planFlags ?? []).map((x) => [x.planId, x]));

  return (
    <div className="space-y-4">
      <Card className="border-border">
        <CardContent className="pt-4 space-y-2 text-sm">
          <p>{t("A plan is an intention, not a payment: it moves nothing in the books. An approver approves it — from then it counts as committed — and pays it through the bill's ordinary payment, withholding tax included. Nothing is sent to a bank, and nothing runs on a schedule.",
            "الخطة نية وليست دفعة: لا تحرّك شيئًا في الدفاتر. يعتمدها معتمِد — فتُحتسب بعدها ملتزمًا بها — ثم يدفعها عبر سداد الفاتورة المعتاد، بما في ذلك ضريبة الاستقطاع. لا يُرسل شيء إلى أي بنك، ولا يُنفَّذ شيء تلقائيًا بجدول زمني.")}</p>
          <p className="text-xs text-muted-foreground" data-testid="treasury-plans-roles">{t("Approving, paying and cancelling are an approver's acts (accountant or administrator). Deleting a plan not yet approved is an administrator's act — anyone else asks an approver to cancel it with a reason. The server refuses what a role may not do, and says why.",
            "الاعتماد والدفع والإلغاء من صلاحيات المعتمِد (المحاسب أو المدير). وحذف خطة لم تُعتمد من صلاحيات المدير وحده — ويطلب غيره من معتمِد إلغاءها مع ذكر السبب. يرفض الخادم ما لا يسمح به الدور ويذكر السبب.")}</p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">{t("Status", "الحالة")}</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="mt-1 h-8 w-44 text-sm" data-testid="treasury-plans-status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t("All", "الكل")}</SelectItem>
              {PLAN_STATUSES.map((s) => <SelectItem key={s} value={s}>{planStatusLabel(s, t)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button className="gap-2" onClick={() => setCreating((c) => !c)} data-testid="treasury-plan-create">{t("Plan a payment", "تخطيط دفعة")}</Button>
      </div>

      {creating && <PlanCreateForm onDone={() => setCreating(false)} />}

      <Card className="border-border">
        <CardContent className="pt-4">
          {plans.isLoading ? <Loading /> : plans.isError ? <Refused error={plans.error} /> : list.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center" data-testid="treasury-plans-empty">
              {status === NONE
                ? t("No payment plans yet. Plan a payment against a posted bill that still owes.", "لا خطط دفع بعد. خطط دفعة مقابل فاتورة مورد مرحَّلة لم تُسدَّد بالكامل.")
                : t("No plans with this status.", "لا خطط بهذه الحالة.")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="treasury-plans">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    {[t("Bill", "الفاتورة"), t("Bill due", "استحقاق الفاتورة"), t("Bill owes now", "المتبقي على الفاتورة الآن"), t("Planned for", "التاريخ المخطط"), t("Amount", "المبلغ"), t("Bank", "البنك"), t("Priority", "الأولوية"), t("Status", "الحالة"), t("WHT / cash (estimate)", "الاستقطاع / النقد (تقدير)"), t("Its week's projected closing", "الإقفال المتوقع لأسبوعها"), ""].map((x, i) => <th key={`${x}-${i}`} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{x}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <PlanRow key={p.id} p={p} forecast={forecast} covered={flags.get(p.id)?.covered} n={n} t={t}
                      action={action?.id === p.id ? action.kind : null}
                      onAction={(kind) => setAction(kind ? { kind, id: p.id } : null)} onTab={onTab} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PlanRow({ p, forecast, covered, action, onAction, n, t, onTab }: {
  p: PaymentPlan; forecast: TreasuryForecast | undefined; covered: number | undefined;
  action: "edit" | "pay" | "cancel" | "delete" | null; onAction: (k: "edit" | "pay" | "cancel" | "delete" | null) => void;
  n: (en: string, ar?: string | null) => string; t: T; onTab: (t: TreasuryTab) => void;
}) {
  const open = p.status === "planned" || p.status === "approved";
  const nonResident = p.vendorResidency === "non_resident";
  const refresh = useRefresh();
  const { toast } = useToast();
  const approve = useApprovePaymentPlan({ mutation: { onSuccess: () => { refresh(); toast({ title: t("Plan approved — it now counts as committed", "اعتُمدت الخطة — تُحتسب الآن ملتزمًا بها") }); } } });

  // §8.7: the projected closing of the plan's week, and whether it falls below the buffer — words, neutral ink
  let week: ReactNode = "—";
  if (open && forecast) {
    const b = bucketOfDate(forecast, p.plannedDate);
    if (b === "beyond") week = <span className="text-xs text-muted-foreground">{t(`Beyond the ${forecast.horizonWeeks}-week forecast`, `بعد أفق التوقع البالغ ${forecast.horizonWeeks} أسبوعًا`)}</span>;
    else if (b) {
      const measure = forecast.funding.bufferDeclared && forecast.funding.minimumBalance != null ? forecast.funding.minimumBalance : 0;
      const below = h(b.closing) < h(measure);
      week = (
        <span className="text-xs" data-testid={`treasury-plan-week-${p.id}`}>
          {n(b.label, b.labelAr)}: <M v={b.closing} />
          <span className="block">
            {forecast.funding.bufferDeclared
              ? (below ? t("below the minimum balance", "دون الحد الأدنى للرصيد") : t("at or above the minimum balance", "عند الحد الأدنى للرصيد أو فوقه"))
              : (below ? t("below zero (no minimum declared)", "دون الصفر (لا حد أدنى محدد)") : t("at or above zero (no minimum declared)", "عند الصفر أو فوقه (لا حد أدنى محدد)"))}
          </span>
        </span>
      );
    }
  }

  const flagWords: { key: string; text: string }[] = [];
  if (p.overdue) flagWords.push({ key: "overdue", text: t("Its day passed unpaid.", "فات يومها دون دفع.") });
  if (p.exceedsOutstanding) flagWords.push({ key: "exceeds", text: t("Larger than the bill now owes — it will be refused; cancel it and plan what is left.", "أكبر مما تبقى على الفاتورة الآن — سيُرفض دفعها؛ ألغِها وخطط للمتبقي.") });
  if (p.billReversed) flagWords.push({ key: "reversed", text: t("Its bill is an opening item the migration reversed — it owes nothing; cancel this plan.", "فاتورتها بند افتتاحي عكسه الترحيل — لا شيء مستحق عليها؛ ألغِ هذه الخطة.") });
  if (open && covered != null && h(covered) < h(p.amount) && !p.billReversed) {
    flagWords.push({ key: "covered", text: t(`The forecast counts ${fmtNum(covered)} of it — what the bill still owes after earlier plans.`, `يحتسب التوقع منها ${fmtNum(covered)} — ما تبقى على الفاتورة بعد الخطط السابقة.`) });
  }

  return (
    <>
      <tr className="border-b border-border/50 align-top" data-testid={`treasury-plan-${p.id}`}>
        <td className="py-2 pe-3">
          <Link href="/bills" className="font-medium hover:underline" dir="ltr">{p.billNumber ?? `#${p.billId}`}</Link>
          <span className="block text-xs text-muted-foreground">
            {p.vendorId != null ? <Link href={`/vendors/${p.vendorId}`} className="hover:underline">{p.vendorName ? n(p.vendorName, p.vendorNameAr) : `#${p.vendorId}`}</Link> : t("No supplier", "بدون مورد")}
            {" · "}{residencyLabel(p.vendorResidency, t)}
          </span>
        </td>
        <td className="py-2 pe-3 text-xs"><D d={p.billDueDate || p.billDate} />{!p.billDueDate && <span className="block text-muted-foreground">{t("no due date — its own date", "بلا تاريخ استحقاق — تاريخها")}</span>}</td>
        <td className="py-2 pe-3 text-end"><M v={p.billOutstanding} /></td>
        <td className="py-2 pe-3 text-xs"><D d={p.plannedDate} /></td>
        <td className="py-2 pe-3 text-end"><M v={p.amount} bold testId={`treasury-plan-amount-${p.id}`} /></td>
        <td className="py-2 pe-3 text-xs">{p.bankName ?? (p.bankAccountId != null ? `#${p.bankAccountId}` : <span className="text-muted-foreground">{t("not named yet", "لم يُحدَّد بعد")}</span>)}</td>
        <td className="py-2 pe-3 text-xs">{priorityLabel(p.priority, t)}</td>
        <td className="py-2 pe-3 text-xs" data-testid={`treasury-plan-status-${p.id}`}>
          {planStatusLabel(p.status, t)}
          {p.status === "paid" && p.paidAt && <span className="block text-muted-foreground">{t("on", "في")} <D d={p.paidAt} /></span>}
          {p.status === "cancelled" && p.cancelReason && <span className="block text-muted-foreground">{p.cancelReason}</span>}
        </td>
        <td className="py-2 pe-3 text-xs">
          {nonResident
            ? (p.whtEstimate != null
              ? <>{whtTypeLabel(p.whtPaymentType, t)}<span className="block">{t("WHT", "الاستقطاع")} <M v={p.whtEstimate} /> · {t("cash", "النقد")} <M v={p.cashEstimate} /></span></>
              : <span className="text-muted-foreground">{t("No nature stated — no estimate", "لم تُذكر طبيعة الدفعة — لا تقدير")}</span>)
            : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="py-2 pe-3">{week}</td>
        <td className="py-2">
          <div className="flex flex-wrap gap-1">
            {p.status === "planned" && <Button size="sm" variant="outline" className="h-7" onClick={() => onAction(action === "edit" ? null : "edit")} data-testid={`treasury-plan-edit-${p.id}`}>{t("Edit", "تعديل")}</Button>}
            {p.status === "planned" && <Button size="sm" variant="secondary" className="h-7" disabled={approve.isPending} onClick={() => approve.mutate({ id: p.id })} data-testid={`treasury-plan-approve-${p.id}`}>{t("Approve", "اعتماد")}</Button>}
            {p.status === "approved" && <Button size="sm" className="h-7" onClick={() => onAction(action === "pay" ? null : "pay")} data-testid={`treasury-plan-pay-${p.id}`}>{t("Pay", "دفع")}</Button>}
            {open && <Button size="sm" variant="outline" className="h-7" onClick={() => onAction(action === "cancel" ? null : "cancel")} data-testid={`treasury-plan-cancel-${p.id}`}>{t("Cancel plan", "إلغاء الخطة")}</Button>}
            {p.status === "planned" && <Button size="sm" variant="ghost" className="h-7" onClick={() => onAction(action === "delete" ? null : "delete")} data-testid={`treasury-plan-delete-${p.id}`}>{t("Delete", "حذف")}</Button>}
          </div>
        </td>
      </tr>
      {(flagWords.length > 0 || p.notes) && (
        <tr className="border-b border-border/50">
          <td colSpan={11} className="pb-2 pe-3 text-xs" data-testid={`treasury-plan-flags-${p.id}`}>
            {flagWords.map((f) => <span key={f.key} className="block" data-testid={`treasury-plan-flag-${f.key}-${p.id}`}>{f.text}</span>)}
            {p.notes && <span className="block text-muted-foreground">{t("Note: ", "ملاحظة: ")}{p.notes}</span>}
          </td>
        </tr>
      )}
      {action && (
        <tr className="border-b border-border">
          <td colSpan={11} className="py-3">
            {action === "edit" && <PlanEditPanel p={p} onClose={() => onAction(null)} />}
            {action === "pay" && <PlanPayPanel p={p} onClose={() => onAction(null)} onTab={onTab} />}
            {action === "cancel" && <PlanCancelPanel p={p} onClose={() => onAction(null)} />}
            {action === "delete" && <PlanDeletePanel p={p} onClose={() => onAction(null)} />}
          </td>
        </tr>
      )}
    </>
  );
}

function PlanCreateForm({ onDone }: { onDone: () => void }) {
  const { t, n } = useLanguage();
  const { toast } = useToast();
  const refresh = useRefresh();
  const today = businessToday();
  const [vendorFilter, setVendorFilter] = useState(NONE);
  const [billId, setBillId] = useState("");
  const [amount, setAmount] = useState("");
  const [plannedDate, setPlannedDate] = useState("");
  const [bank, setBank] = useState("");
  const [priority, setPriority] = useState<CreatePaymentPlanInputPriority>("normal");
  const [nature, setNature] = useState("");
  const [notes, setNotes] = useState("");

  const vendorParams = { limit: 200 };
  const vendors = useListVendors(vendorParams, { query: { queryKey: getListVendorsQueryKey(vendorParams) } });
  const vendorItems = vendors.data?.items ?? [];
  const vendorById = new Map(vendorItems.map((v) => [v.id, v]));
  const billParams: ListBillsParams = vendorFilter === NONE ? { limit: 200 } : { vendor_id: Number(vendorFilter), limit: 200 };
  const bills = useListBills(billParams, { query: { queryKey: getListBillsQueryKey(billParams) } });
  // what a plan can name: a POSTED bill or debit note that still owes, by the server's own figure (billPosition)
  const open = (bills.data?.items ?? []).filter((b: Bill) =>
    !["draft", "submitted"].includes(b.status) && (b.documentType === "bill" || b.documentType === "debit_note") &&
    h(Number(b.outstanding ?? 0)) > 0 && !b.reversedAt && (vendorFilter === NONE || b.vendorId === Number(vendorFilter)));
  const capped = bills.data != null && bills.data.page.total > bills.data.items.length;
  const chosen = open.find((b) => String(b.id) === billId);
  const vendor = chosen?.vendorId != null ? vendorById.get(chosen.vendorId) : undefined;
  const nonResident = vendor?.residency === "non_resident";
  const residencyUnread = chosen != null && chosen.vendorId != null && vendor == null;
  const parsed = parseAmount(amount);
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(plannedDate) && plannedDate >= today;

  const create = useCreatePaymentPlan({
    mutation: {
      onSuccess: () => { refresh(); toast({ title: t("Plan created — an approver approves it before it is paid", "أُنشئت الخطة — يعتمدها معتمِد قبل دفعها") }); onDone(); },
    },
  });

  const pickBill = (v: string) => {
    setBillId(v);
    const b = open.find((x) => String(x.id) === v);
    if (b && amount.trim() === "") setAmount(Number(b.outstanding ?? 0).toFixed(2));
    // never pre-filled from the supplier's default: the pay path already falls back to it, and the nature is
    // a declaration the person makes (what is declared at payment replaces it — paymentPlans.service.pay)
    setNature("");
  };

  return (
    <Card className="border-border" data-testid="treasury-plan-form">
      <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Plan a payment", "تخطيط دفعة")}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs text-muted-foreground">{t("Supplier (optional — narrows the bills)", "المورد (اختياري — يضيّق قائمة الفواتير)")}</Label>
            <Select value={vendorFilter} onValueChange={(v) => { setVendorFilter(v); setBillId(""); setNature(""); }}>
              <SelectTrigger className="mt-1 h-9 text-sm" data-testid="treasury-plan-vendor"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("All suppliers", "كل الموردين")}</SelectItem>
                {vendorItems.map((v) => <SelectItem key={v.id} value={String(v.id)}>{n(v.name, v.nameAr)}</SelectItem>)}
              </SelectContent>
            </Select>
            {vendors.data && vendors.data.page.total > vendorItems.length && (
              <p className="text-xs text-muted-foreground mt-1">{t(`The first ${vendorItems.length} of ${vendors.data.page.total} suppliers are listed.`, `تُعرض أول ${vendorItems.length} من ${vendors.data.page.total} موردًا.`)}</p>
            )}
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Bill that still owes", "فاتورة لم تُسدَّد")}</Label>
            <Select value={billId} onValueChange={pickBill}>
              <SelectTrigger className="mt-1 h-9 text-sm" data-testid="treasury-plan-bill"><SelectValue placeholder={bills.isLoading ? t("Loading…", "جارٍ التحميل…") : t("Choose a bill…", "اختر فاتورة…")} /></SelectTrigger>
              <SelectContent>
                {open.map((b) => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.billNumber}{b.documentType === "debit_note" ? ` (${t("debit note", "إشعار مدين")})` : ""} — {b.vendorId != null && vendorById.get(b.vendorId) ? n(vendorById.get(b.vendorId)!.name, vendorById.get(b.vendorId)!.nameAr) : (b.vendorName ?? "—")} — {t("owes", "المتبقي")} {fmtNum(Number(b.outstanding ?? 0))} — {t("due", "الاستحقاق")} {fmtDate(b.dueDate || b.date)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {bills.data && open.length === 0 && <p className="text-xs text-muted-foreground mt-1" data-testid="treasury-plan-no-bills">{t("No posted bill or debit note in this list still owes anything.", "لا توجد في هذه القائمة فاتورة أو إشعار مدين مرحَّل لم يُسدَّد.")}</p>}
            {capped && vendorFilter === NONE && <p className="text-xs text-muted-foreground mt-1" data-testid="treasury-plan-bills-capped">{t(`Only the ${bills.data!.items.length} most recent bills were read (of ${bills.data!.page.total}). Choose the supplier to list all of theirs.`, `قُرئت أحدث ${bills.data!.items.length} فاتورة فقط (من ${bills.data!.page.total}). اختر المورد لعرض كل فواتيره.`)}</p>}
            {capped && vendorFilter !== NONE && <p className="text-xs text-muted-foreground mt-1">{t(`Only this supplier's ${bills.data!.items.length} most recent bills were read (of ${bills.data!.page.total}).`, `قُرئت أحدث ${bills.data!.items.length} فاتورة فقط لهذا المورد (من ${bills.data!.page.total}).`)}</p>}
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Amount — at most what the bill owes, less its other open plans", "المبلغ — بحد أقصى ما تبقى على الفاتورة ناقص خططها المفتوحة الأخرى")}</Label>
            <Input dir="ltr" inputMode="decimal" className="mt-1 h-9 text-sm font-mono" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="treasury-plan-amount" />
            {amount.trim() !== "" && parsed == null && <p className="text-xs text-muted-foreground mt-1">{t("An amount above zero with at most two decimals (no thousands separators).", "مبلغ أكبر من الصفر بخانتين عشريتين على الأكثر (دون فواصل الآلاف).")}</p>}
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Planned date (today or later)", "التاريخ المخطط (اليوم أو بعده)")}</Label>
            <Input type="date" dir="ltr" min={today} className="mt-1 h-9 text-sm" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} data-testid="treasury-plan-date" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Bank (optional — it can be named at payment)", "البنك (اختياري — يمكن تحديده عند الدفع)")}</Label>
            <BankSelect value={bank} onChange={setBank} testId="treasury-plan-bank" allowNone />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Priority", "الأولوية")}</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as CreatePaymentPlanInputPriority)}>
              <SelectTrigger className="mt-1 h-9 text-sm" data-testid="treasury-plan-priority"><SelectValue /></SelectTrigger>
              <SelectContent>{PRIORITIES.map((x) => <SelectItem key={x} value={x}>{priorityLabel(x, t)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {(nonResident || residencyUnread) && (
            <div className="sm:col-span-2">
              <Label className="text-xs text-muted-foreground">{t("Payment nature for withholding tax (non-resident supplier)", "طبيعة الدفعة لضريبة الاستقطاع (مورد غير مقيم)")}</Label>
              <NatureSelect value={nature} onChange={setNature} testId="treasury-plan-wht" />
              {nonResident && (
                <p className="text-xs text-muted-foreground mt-1" data-testid="treasury-plan-wht-default">
                  {vendor?.whtDefaultPaymentType
                    ? t(`The supplier's declared default nature: ${whtTypeLabel(vendor.whtDefaultPaymentType, t)}. State a nature here to see the withholding estimate on the plan.`, `طبيعة الدفعة الافتراضية المصرَّح بها للمورد: ${whtTypeLabel(vendor.whtDefaultPaymentType, t)}. حدّد طبيعة هنا لترى تقدير الاستقطاع على الخطة.`)
                    : t("The supplier has no declared default nature: one must be stated here or at payment — it is never assumed.", "ليس للمورد طبيعة دفعة افتراضية مصرَّح بها: يجب ذكرها هنا أو عند الدفع — ولا تُفترض أبدًا.")}
                </p>
              )}
              {residencyUnread && <p className="text-xs text-muted-foreground mt-1">{t("This supplier's residency could not be read here; a nature applies only to a non-resident supplier, and the server refuses one for anyone else.", "تعذّر قراءة إقامة هذا المورد هنا؛ لا تنطبق طبيعة الدفعة إلا على مورد غير مقيم، ويرفضها الخادم لغيره.")}</p>}
            </div>
          )}
          <div className="sm:col-span-2">
            <Label className="text-xs text-muted-foreground">{t("Notes (optional)", "ملاحظات (اختياري)")}</Label>
            <Textarea className="mt-1 text-sm" maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="treasury-plan-notes" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!chosen || parsed == null || !dateOk || create.isPending} data-testid="treasury-plan-submit"
            onClick={() => create.mutate({ data: {
              billId: Number(billId), amount: parsed!, plannedDate, priority,
              bankAccountId: bank ? Number(bank) : null,
              whtPaymentType: nature || null,
              notes: notes.trim() || null,
            } })}>
            {create.isPending ? t("Creating…", "جارٍ الإنشاء…") : t("Create plan", "إنشاء الخطة")}
          </Button>
          <Button variant="ghost" onClick={onDone}>{t("Close", "إغلاق")}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PlanEditPanel({ p, onClose }: { p: PaymentPlan; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const refresh = useRefresh();
  const today = businessToday();
  const [amount, setAmount] = useState(p.amount.toFixed(2));
  const [plannedDate, setPlannedDate] = useState(p.plannedDate);
  const [bank, setBank] = useState(p.bankAccountId != null ? String(p.bankAccountId) : "");
  const [priority, setPriority] = useState<CreatePaymentPlanInputPriority>(p.priority);
  const [nature, setNature] = useState(p.whtPaymentType ?? "");
  const [notes, setNotes] = useState(p.notes ?? "");
  const parsed = parseAmount(amount);
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(plannedDate) && plannedDate >= today;
  const update = useUpdatePaymentPlan({ mutation: { onSuccess: () => { refresh(); toast({ title: t("Plan updated", "حُدّثت الخطة") }); onClose(); } } });
  return (
    <div className="space-y-3" data-testid={`treasury-plan-edit-form-${p.id}`}>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label className="text-xs text-muted-foreground">{t("Amount", "المبلغ")}</Label>
          <Input dir="ltr" inputMode="decimal" className="mt-1 h-9 text-sm font-mono" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="treasury-plan-edit-amount" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">{t("Planned date (today or later)", "التاريخ المخطط (اليوم أو بعده)")}</Label>
          <Input type="date" dir="ltr" min={today} className="mt-1 h-9 text-sm" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} data-testid="treasury-plan-edit-date" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">{t("Bank (optional)", "البنك (اختياري)")}</Label>
          <BankSelect value={bank} onChange={setBank} testId="treasury-plan-edit-bank" allowNone />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">{t("Priority", "الأولوية")}</Label>
          <Select value={priority} onValueChange={(v) => setPriority(v as CreatePaymentPlanInputPriority)}>
            <SelectTrigger className="mt-1 h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>{PRIORITIES.map((x) => <SelectItem key={x} value={x}>{priorityLabel(x, t)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {p.vendorResidency === "non_resident" && (
          <div className="sm:col-span-2">
            <Label className="text-xs text-muted-foreground">{t("Payment nature for withholding tax", "طبيعة الدفعة لضريبة الاستقطاع")}</Label>
            <NatureSelect value={nature} onChange={setNature} testId="treasury-plan-edit-wht" />
          </div>
        )}
        <div className="sm:col-span-3">
          <Label className="text-xs text-muted-foreground">{t("Notes (optional)", "ملاحظات (اختياري)")}</Label>
          <Textarea className="mt-1 text-sm" maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      {amount.trim() !== "" && parsed == null && <p className="text-xs text-muted-foreground">{t("An amount above zero with at most two decimals (no thousands separators).", "مبلغ أكبر من الصفر بخانتين عشريتين على الأكثر (دون فواصل الآلاف).")}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={parsed == null || !dateOk || update.isPending} data-testid="treasury-plan-edit-submit"
          onClick={() => update.mutate({ id: p.id, data: {
            amount: parsed!, plannedDate, priority, bankAccountId: bank ? Number(bank) : null,
            ...(p.vendorResidency === "non_resident" ? { whtPaymentType: nature || null } : {}),
            notes: notes.trim() || null,
          } })}>
          {t("Save changes", "حفظ التغييرات")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>{t("Back", "رجوع")}</Button>
      </div>
    </div>
  );
}

function PlanPayPanel({ p, onClose, onTab }: { p: PaymentPlan; onClose: () => void; onTab: (t: TreasuryTab) => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const refresh = useRefresh();
  const today = businessToday();
  const nonResident = p.vendorResidency === "non_resident";
  const [paidAt, setPaidAt] = useState(today);
  const [bank, setBank] = useState(p.bankAccountId != null ? String(p.bankAccountId) : "");
  const [mode, setMode] = useState<"withhold" | "not_subject">("withhold");
  const [nature, setNature] = useState(p.whtPaymentType ?? "");
  const [reason, setReason] = useState<"goods" | "not_kingdom_source">("goods");
  const [note, setNote] = useState("");
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(paidAt) && paidAt <= today;
  const noteOk = !(nonResident && mode === "not_subject" && reason === "not_kingdom_source") || note.trim().length >= 10;

  const pay = usePayPaymentPlan({
    mutation: {
      onSuccess: (r) => {
        refresh(true);
        toast({ title: t(`Paid — cash ${fmtNum(r.payment.cashPaid)}, withheld ${fmtNum(r.payment.withheld)}`, `دُفعت — النقد ${fmtNum(r.payment.cashPaid)}، المستقطع ${fmtNum(r.payment.withheld)}`) });
        onClose();
      },
    },
  });
  const submit = () => {
    const data: PayPaymentPlanInput = { paidAt, bankAccountId: bank ? Number(bank) : null };
    if (nonResident && mode === "withhold" && nature) data.whtPaymentType = nature;
    if (nonResident && mode === "not_subject") { data.whtNotSubjectReason = reason; data.whtNotSubjectNote = note.trim() || null; }
    pay.mutate({ id: p.id, data });
  };

  return (
    <div className="space-y-3" data-testid={`treasury-plan-pay-form-${p.id}`}>
      <p className="text-sm">{t("Records the payment through the bill's ordinary payment — the books move exactly as paying the bill does. No instruction is sent to any bank.", "يسجّل الدفعة عبر سداد الفاتورة المعتاد — تتحرك الدفاتر تمامًا كما عند سداد الفاتورة. لا تُرسل أي تعليمات إلى أي بنك.")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label className="text-xs text-muted-foreground">{t("Paid on (today or earlier)", "تاريخ الدفع (اليوم أو قبله)")}</Label>
          <Input type="date" dir="ltr" max={today} className="mt-1 h-9 text-sm" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} data-testid="treasury-plan-pay-date" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">{t("Paid from", "دُفع من")}</Label>
          <BankSelect value={bank} onChange={setBank} testId="treasury-plan-pay-bank" />
        </div>
        {nonResident && (
          <>
            <div className="sm:col-span-2">
              <Label className="text-xs text-muted-foreground">{t("Withholding tax (non-resident supplier)", "ضريبة الاستقطاع (مورد غير مقيم)")}</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                <SelectTrigger className="mt-1 h-9 text-sm" data-testid="treasury-plan-pay-wht-mode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="withhold">{t("Withhold — state the payment's nature", "استقطاع — حدّد طبيعة الدفعة")}</SelectItem>
                  <SelectItem value="not_subject">{t("Not subject — state the reason", "غير خاضعة — اذكر السبب")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {mode === "withhold" ? (
              <div className="sm:col-span-2">
                <Label className="text-xs text-muted-foreground">{t("Payment nature", "طبيعة الدفعة")}</Label>
                <NatureSelect value={nature} onChange={setNature} testId="treasury-plan-pay-wht" />
              </div>
            ) : (
              <>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Reason", "السبب")}</Label>
                  <Select value={reason} onValueChange={(v) => setReason(v as typeof reason)}>
                    <SelectTrigger className="mt-1 h-9 text-sm" data-testid="treasury-plan-pay-reason"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="goods">{notSubjectLabel("goods", t)}</SelectItem>
                      <SelectItem value="not_kingdom_source">{notSubjectLabel("not_kingdom_source", t)}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    {reason === "not_kingdom_source"
                      ? t("Why — at least 10 characters; kept with the record", "السبب — 10 أحرف على الأقل؛ يُحفظ مع السجل")
                      : t("Note (optional; kept with the record)", "ملاحظة (اختياري؛ تُحفظ مع السجل)")}
                  </Label>
                  <Textarea className="mt-1 text-sm" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} data-testid="treasury-plan-pay-note" />
                </div>
                {p.whtPaymentType && (
                  <p className="sm:col-span-2 text-xs text-muted-foreground" data-testid="treasury-plan-pay-replaces">
                    {t(`The plan was made with a nature (${whtTypeLabel(p.whtPaymentType, t)}); the reason you give now replaces it for this payment — what is declared at payment governs.`,
                      `أُعدّت الخطة بطبيعة دفعة (${whtTypeLabel(p.whtPaymentType, t)})؛ والسبب الذي تذكره الآن يحل محلها لهذه الدفعة — العبرة بما يُصرَّح به عند الدفع.`)}
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
      {!dateOk && <p className="text-xs text-muted-foreground">{t("A payment records money that has left — today or an earlier day, never a later one.", "الدفعة تسجّل أموالًا خرجت — اليوم أو يومًا سابقًا، وليس لاحقًا أبدًا.")}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!dateOk || !bank || !noteOk || pay.isPending} onClick={submit} data-testid="treasury-plan-pay-submit">
          {pay.isPending ? t("Recording…", "جارٍ التسجيل…") : t(`Record payment of ${fmtNum(p.amount)}`, `تسجيل دفعة بمبلغ ${fmtNum(p.amount)}`)}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>{t("Back", "رجوع")}</Button>
        <button type="button" className="text-xs underline text-muted-foreground" onClick={() => onTab("forecast")}>{t("See the forecast", "عرض التوقع")}</button>
      </div>
    </div>
  );
}

function PlanCancelPanel({ p, onClose }: { p: PaymentPlan; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const refresh = useRefresh();
  const [reason, setReason] = useState("");
  const cancel = useCancelPaymentPlan({ mutation: { onSuccess: () => { refresh(); toast({ title: t("Plan cancelled", "أُلغيت الخطة") }); onClose(); } } });
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="grow min-w-48">
        <Label className="text-xs text-muted-foreground">{t("Why is this plan cancelled? (at least 3 characters; the record keeps it)", "لماذا تُلغى هذه الخطة؟ (3 أحرف على الأقل؛ يحفظها السجل)")}</Label>
        <Input className="mt-1 h-9 text-sm" maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="treasury-plan-cancel-reason" />
      </div>
      <Button size="sm" disabled={reason.trim().length < 3 || cancel.isPending} onClick={() => cancel.mutate({ id: p.id, data: { reason: reason.trim() } })} data-testid="treasury-plan-cancel-confirm">{t("Cancel the plan", "إلغاء الخطة")}</Button>
      <Button size="sm" variant="ghost" onClick={onClose}>{t("Back", "رجوع")}</Button>
    </div>
  );
}

function PlanDeletePanel({ p, onClose }: { p: PaymentPlan; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const refresh = useRefresh();
  const remove = useDeletePaymentPlan({ mutation: { onSuccess: () => { refresh(); toast({ title: t("Plan deleted", "حُذفت الخطة") }); onClose(); } } });
  return (
    <div className="space-y-2">
      <p className="text-sm">{t("Delete this plan? It was never approved, so no record of a commitment is lost. Deleting is an administrator's act — anyone else asks an approver to cancel it with a reason.", "حذف هذه الخطة؟ لم تُعتمد قط، فلا يضيع سجل التزام. الحذف من صلاحيات المدير — ويطلب غيره من معتمِد إلغاءها مع ذكر السبب.")}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={remove.isPending} onClick={() => remove.mutate({ id: p.id })} data-testid="treasury-plan-delete-confirm">{t("Delete plan", "حذف الخطة")}</Button>
        <Button size="sm" variant="ghost" onClick={onClose}>{t("Back", "رجوع")}</Button>
      </div>
    </div>
  );
}

// ── Assumptions ─────────────────────────────────────────────────────────────

type AssumptionForm = { entryDate: string; direction: ForecastAssumptionInputDirection; amount: string; category: ForecastAssumptionInputCategory; description: string; notes: string };
const blankAssumption = (): AssumptionForm => ({ entryDate: "", direction: "outflow", amount: "", category: "other", description: "", notes: "" });

function AssumptionsTab() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const refresh = useRefresh();
  const today = businessToday();
  const list = useListForecastAssumptions();
  const [form, setForm] = useState<AssumptionForm>(blankAssumption);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const parsed = parseAmount(form.amount);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(form.entryDate) && parsed != null && form.description.trim().length >= 3;
  const reset = () => { setForm(blankAssumption()); setEditingId(null); };
  const create = useCreateForecastAssumption({ mutation: { onSuccess: () => { refresh(); reset(); toast({ title: t("Assumption added", "أُضيف الافتراض") }); } } });
  const update = useUpdateForecastAssumption({ mutation: { onSuccess: () => { refresh(); reset(); toast({ title: t("Assumption updated", "حُدّث الافتراض") }); } } });
  const remove = useDeleteForecastAssumption({ mutation: { onSuccess: () => { refresh(); setDeleting(null); toast({ title: t("Assumption deleted", "حُذف الافتراض") }); } } });
  const set = <K extends keyof AssumptionForm>(k: K, v: AssumptionForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const startEdit = (a: ForecastAssumption) => {
    setEditingId(a.id); setDeleting(null);
    setForm({ entryDate: a.entryDate, direction: a.direction, amount: a.amount.toFixed(2), category: a.category, description: a.description, notes: a.notes ?? "" });
  };
  const submit = () => {
    const data = { entryDate: form.entryDate, direction: form.direction, amount: parsed!, category: form.category, description: form.description.trim(), notes: form.notes.trim() || null };
    if (editingId != null) update.mutate({ id: editingId, data });
    else create.mutate({ data });
  };
  const items = list.data ?? [];

  return (
    <div className="space-y-4">
      <Card className="border-border">
        <CardContent className="pt-4 space-y-2 text-sm">
          <p>{t("Money the books cannot know is coming or going — a loan drawdown, an asset purchase, a capital injection. Each counts in the forecast as a manual assumption on its date; it is never posted. A past-dated one is stale and not counted.",
            "أموال لا يمكن للدفاتر معرفة ورودها أو صرفها — سحب قرض، شراء أصل، زيادة رأس مال. يُحتسب كل منها في التوقع افتراضًا يدويًا في تاريخه، ولا يُرحَّل أبدًا. ما مضى تاريخه يُعد متقادمًا ولا يُحتسب.")}</p>
          <p className="text-xs text-muted-foreground" data-testid="treasury-assumptions-roles">{t("Deleting an assumption is an administrator's act; anyone else edits it instead, or asks an administrator. The server refuses what a role may not do, and says why.", "حذف الافتراض من صلاحيات المدير؛ ويعدّله غيره بدلًا من ذلك أو يطلب ذلك من المدير. يرفض الخادم ما لا يسمح به الدور ويذكر السبب.")}</p>
        </CardContent>
      </Card>

      <Card className="border-border" data-testid="treasury-assumption-form">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{editingId != null ? t("Edit the assumption", "تعديل الافتراض") : t("Add an assumption", "إضافة افتراض")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <Label className="text-xs text-muted-foreground">{t("Date", "التاريخ")}</Label>
              <Input type="date" dir="ltr" className="mt-1 h-9 text-sm" value={form.entryDate} onChange={(e) => set("entryDate", e.target.value)} data-testid="treasury-assumption-date" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("Direction", "الاتجاه")}</Label>
              <Select value={form.direction} onValueChange={(v) => set("direction", v as ForecastAssumptionInputDirection)}>
                <SelectTrigger className="mt-1 h-9 text-sm" data-testid="treasury-assumption-direction"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="inflow">{assumptionDirectionLabel("inflow", t)}</SelectItem>
                  <SelectItem value="outflow">{assumptionDirectionLabel("outflow", t)}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("Amount", "المبلغ")}</Label>
              <Input dir="ltr" inputMode="decimal" className="mt-1 h-9 text-sm font-mono" value={form.amount} onChange={(e) => set("amount", e.target.value)} data-testid="treasury-assumption-amount" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("Category", "الفئة")}</Label>
              <Select value={form.category} onValueChange={(v) => set("category", v as ForecastAssumptionInputCategory)}>
                <SelectTrigger className="mt-1 h-9 text-sm" data-testid="treasury-assumption-category"><SelectValue /></SelectTrigger>
                <SelectContent>{ASSUMPTION_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{assumptionCategoryLabel(c, t)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs text-muted-foreground">{t("Description — what money, and why it is expected", "الوصف — أي أموال، ولماذا يُتوقع ورودها أو صرفها")}</Label>
              <Input className="mt-1 h-9 text-sm" maxLength={500} value={form.description} onChange={(e) => set("description", e.target.value)} data-testid="treasury-assumption-description" />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs text-muted-foreground">{t("Notes (optional)", "ملاحظات (اختياري)")}</Label>
              <Input className="mt-1 h-9 text-sm" maxLength={2000} value={form.notes} onChange={(e) => set("notes", e.target.value)} data-testid="treasury-assumption-notes" />
            </div>
          </div>
          {form.amount.trim() !== "" && parsed == null && <p className="text-xs text-muted-foreground">{t("An amount above zero with at most two decimals (no thousands separators).", "مبلغ أكبر من الصفر بخانتين عشريتين على الأكثر (دون فواصل الآلاف).")}</p>}
          {form.entryDate !== "" && form.entryDate < today && <p className="text-xs text-muted-foreground">{t("This date has passed: the assumption will be kept but not counted in the forecast.", "هذا التاريخ مضى: سيُحفظ الافتراض لكنه لن يُحتسب في التوقع.")}</p>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={!valid || create.isPending || update.isPending} onClick={submit} data-testid="treasury-assumption-submit">
              {editingId != null ? t("Save changes", "حفظ التغييرات") : t("Add assumption", "إضافة افتراض")}
            </Button>
            {editingId != null && <Button variant="ghost" onClick={reset}>{t("Stop editing", "إلغاء التعديل")}</Button>}
          </div>
        </CardContent>
      </Card>

      <Card className="border-border">
        <CardContent className="pt-4">
          {list.isLoading ? <Loading /> : list.isError ? <Refused error={list.error} /> : items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center" data-testid="treasury-assumptions-empty">{t("No assumptions yet.", "لا افتراضات بعد.")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="treasury-assumptions">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    {[t("Date", "التاريخ"), t("Direction", "الاتجاه"), t("Amount", "المبلغ"), t("Category", "الفئة"), t("Description", "الوصف"), t("Notes", "ملاحظات"), ""].map((x, i) => <th key={`${x}-${i}`} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{x}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {items.map((a) => (
                    <tr key={a.id} className="border-b border-border/50 align-top" data-testid={`treasury-assumption-${a.id}`}>
                      <td className="py-2 pe-3 text-xs">
                        <D d={a.entryDate} />
                        {a.entryDate < today && <span className="block text-muted-foreground" data-testid={`treasury-assumption-stale-${a.id}`}>{t("Stale — not counted in the forecast", "متقادم — لا يُحتسب في التوقع")}</span>}
                      </td>
                      <td className="py-2 pe-3 text-xs">{assumptionDirectionLabel(a.direction, t)}</td>
                      <td className="py-2 pe-3 text-end"><M v={a.amount} /></td>
                      <td className="py-2 pe-3 text-xs">{assumptionCategoryLabel(a.category, t)}</td>
                      <td className="py-2 pe-3 text-xs min-w-40">{a.description}</td>
                      <td className="py-2 pe-3 text-xs text-muted-foreground">{a.notes ?? "—"}</td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-1">
                          <Button size="sm" variant="outline" className="h-7" onClick={() => startEdit(a)} data-testid={`treasury-assumption-edit-${a.id}`}>{t("Edit", "تعديل")}</Button>
                          {deleting === a.id ? (
                            <>
                              <Button size="sm" variant="outline" className="h-7" disabled={remove.isPending} onClick={() => remove.mutate({ id: a.id })} data-testid={`treasury-assumption-delete-confirm-${a.id}`}>{t("Confirm delete", "تأكيد الحذف")}</Button>
                              <Button size="sm" variant="ghost" className="h-7" onClick={() => setDeleting(null)}>{t("Back", "رجوع")}</Button>
                            </>
                          ) : (
                            <Button size="sm" variant="ghost" className="h-7" onClick={() => setDeleting(a.id)} data-testid={`treasury-assumption-delete-${a.id}`}>{t("Delete", "حذف")}</Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

function SettingsTab() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const refresh = useRefresh();
  const s = useGetTreasurySettings();
  const [minimum, setMinimum] = useState("");
  const [weeks, setWeeks] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (s.data && !dirty) {
      setMinimum(s.data.minimumCashBalance == null ? "" : s.data.minimumCashBalance.toFixed(2));
      setWeeks(String(s.data.forecastHorizonWeeks));
    }
  }, [s.data, dirty]);
  const save = useUpdateTreasurySettings({ mutation: { onSuccess: () => { setDirty(false); refresh(); toast({ title: t("Settings saved — the forecast is measured against them now", "حُفظت الإعدادات — يُقاس التوقع مقابلها الآن") }); } } });
  // blank = no minimum declared; anything else must BE an amount — `Number("abc")` would serialise as null and clear it silently
  const minParsed = minimum.trim() === "" ? null : parseAmount(minimum, { allowZero: true });
  const minOk = minimum.trim() === "" || minParsed != null;
  const weeksParsed = parseWeeks(weeks);

  return (
    <Card className="border-border">
      <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Treasury policy", "سياسة الخزينة")}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {s.isLoading ? <Loading /> : s.isError ? <Refused error={s.error} /> : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs text-muted-foreground">{t("Minimum cash balance (blank = none declared)", "الحد الأدنى لرصيد النقد (فارغ = غير محدد)")}</Label>
                <Input dir="ltr" inputMode="decimal" className="mt-1 h-9 text-sm font-mono" value={minimum} onChange={(e) => { setMinimum(e.target.value); setDirty(true); }} data-testid="treasury-settings-minimum" />
                {!minOk && <p className="text-xs text-muted-foreground mt-1">{t("Zero or more, with at most two decimals (no thousands separators) — or blank for none.", "صفر أو أكثر بخانتين عشريتين على الأكثر (دون فواصل الآلاف) — أو فارغ لعدم التحديد.")}</p>}
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t("Forecast horizon (weeks, 1–52)", "أفق التوقع (بالأسابيع، 1–52)")}</Label>
                <Input dir="ltr" inputMode="numeric" className="mt-1 h-9 text-sm" value={weeks} onChange={(e) => { setWeeks(e.target.value); setDirty(true); }} data-testid="treasury-settings-weeks" />
                {weeks.trim() !== "" && weeksParsed == null && <p className="text-xs text-muted-foreground mt-1">{t("A whole number of weeks from 1 to 52.", "عدد صحيح من الأسابيع بين 1 و52.")}</p>}
              </div>
            </div>
            <p className="text-xs text-muted-foreground" data-testid="treasury-settings-roles">
              {t("Saving is an approver's act (accountant or administrator) — the server refuses a bookkeeper and says so. The minimum balance is your own policy: the funding requirement is measured against it, or against zero when none is declared.",
                "الحفظ من صلاحيات المعتمِد (المحاسب أو المدير) — يرفض الخادم طلب أمين الدفاتر ويذكر السبب. الحد الأدنى للرصيد سياستك أنت: يُقاس الاحتياج التمويلي مقابله، أو مقابل الصفر إن لم يُحدَّد.")}
            </p>
            {s.data && (
              <p className="text-xs text-muted-foreground">
                {s.data.updatedAt ? <>{t("Last changed", "آخر تعديل")} <D d={s.data.updatedAt} /></> : t("Never saved — the server's defaults apply.", "لم تُحفظ قط — تُطبَّق القيم الافتراضية للخادم.")}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button disabled={!minOk || weeksParsed == null || save.isPending} data-testid="treasury-settings-save"
                onClick={() => save.mutate({ data: { minimumCashBalance: minParsed, forecastHorizonWeeks: weeksParsed! } })}>
                {save.isPending ? t("Saving…", "جارٍ الحفظ…") : t("Save settings", "حفظ الإعدادات")}
              </Button>
              {dirty && <Button variant="ghost" onClick={() => setDirty(false)}>{t("Discard changes", "تجاهل التغييرات")}</Button>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
