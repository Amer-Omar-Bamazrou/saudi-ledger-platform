import { useMemo, useState } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, Cell, ReferenceLine,
} from "recharts";
import {
  useGetTrend, useGetDecomposition, useGetSummary, useListBudgets,
  useGetReceivablesBridge,
} from "@workspace/api-client-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { classifyChartState, type EmptyReason } from "@/lib/chartState";
import { TrendingUp, TriangleAlert, Table as TableIcon } from "lucide-react";

/**
 * Analytics (M19.3) — "how is the business doing".
 *
 * The Finance Hub owns the point-in-time claim; this owns the TREND
 * (design-analytics.md §3). Same figures, different question.
 *
 * ── 🔴 The three rules this page exists to honour ──────────────────────────
 *
 * 1. **The withholding propagates PER POINT.** A month whose figures cannot be
 *    stood behind is not drawn as an ordinary segment — the line BREAKS at it.
 *    Charting a smooth line through unreliable months would defeat M18.3's
 *    discipline by drawing the claim instead of saying it.
 *
 * 2. **WHERE, never WHY.** The decomposition names the contributors and their
 *    arithmetic share. It never says "because", never recommends. That is what
 *    keeps this outside the parked-AI trigger.
 *
 * 3. **No dual-axis charts.** Money and ratios are different units, so they get
 *    SEPARATE charts. Two y-scales can be slid until any two lines appear to
 *    track, which invents a relationship the reader will believe.
 *
 * Colours are the validated categorical slots 1 and 2 (blue/orange), which pass
 * the CVD, lightness, chroma and contrast checks in both light and dark. Series
 * identity is never colour-alone: every chart with two series carries a legend.
 */

/** Validated categorical slots — see the palette validator run for M19.3. */
const SERIES_1 = "#2a78d6";
const SERIES_2 = "#eb6834";
/** Diverging poles for change (blue ↔ red), NOT the status palette. */
const UP = "#2a78d6";
const DOWN = "#e34948";

type Dim = "category" | "customer" | "vendor";

function lastNMonths(n: number): { from: string; to: string } {
  const now = new Date();
  const to = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1), 1));
  return { from: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`, to };
}

/** First and last day of the current month, for the decomposition window. */
function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const pad = (d: Date) => d.toISOString().slice(0, 10);
  return { from: pad(new Date(Date.UTC(y, m, 1))), to: pad(new Date(Date.UTC(y, m + 1, 0))) };
}

export default function Analytics() {
  const { t } = useLanguage();
  /**
   * 6 months by default, not 12 or 24. A long window on a young or quiet tenant
   * is mostly empty months, and an empty month is not informative — it is just
   * a wider axis. The longer ranges stay one click away for anyone who has the
   * history to fill them.
   */
  const [months, setMonths] = useState(6);
  const [dimension, setDimension] = useState<Dim>("category");
  const [showTable, setShowTable] = useState(false);

  const window_ = useMemo(() => lastNMonths(months), [months]);
  const decompWindow = useMemo(() => currentMonthRange(), []);

  const { data: trend } = useGetTrend({ from: window_.from, to: window_.to });

  /**
   * M19.6 — the receivables bridge (design §4, §6.1).
   *
   * 🔴 It answers what the outstanding BALANCE cannot. Receivables rising does
   * not say whether you invoiced more or collected less, and those call for
   * opposite responses. The balance is the stock; this is the flow.
   *
   * Same window as everything else on the page, so the charts describe one span.
   */
  const { data: bridge } = useGetReceivablesBridge({ from: window_.from, to: window_.to });

  const bridgeSeries = (bridge ?? []).map((p) => ({
    period: p.period,
    invoiced: p.invoiced,
    collected: p.collected,
    outstanding: p.closing,
  }));

  /**
   * 🔴 No per-point `claimable` here, deliberately — and the reason matters.
   *
   * The liquidity trend is withheld when the platform cannot classify accounts
   * or has unidentified money in suspense, because those defeat the CLAIM it
   * makes. The bridge makes no such claim: every term is a debit or a credit on
   * the receivables account, so it is true whatever else is unclassified. A
   * suspense balance does not make "you invoiced 40,000 and collected 25,000"
   * any less accurate. Withholding it anyway would be cargo-culting the
   * mechanism rather than applying it.
   */
  const allClaimable = bridge?.map(() => ({ claimable: true }));
  const flowsState = classifyChartState(
    allClaimable,
    bridgeSeries.flatMap((b) => [b.invoiced, b.collected]),
  );
  const outstandingState = classifyChartState(
    allClaimable,
    bridgeSeries.map((b) => b.outstanding),
  );
  /** Non-zero means AR moved by something that was neither a payment nor a credit note. */
  const bridgeOther = (bridge ?? []).reduce((sum, p) => sum + p.other, 0);

  /**
   * M19.4 — absorbed from the old "Financial Cockpit" (owner decision A11).
   *
   * 🔴 And fixed on the way in: the Cockpit called `getSummary()` with NO date
   * range at all, so its "Total Income" was every transaction since the tenant
   * began, shown on a page with no period control. Here it is bounded by the
   * window the charts already use, so the figure and the charts describe the
   * same span.
   *
   * Net VAT and the transaction counts did NOT come with it — the Finance Hub
   * already reports both, and duplicating them is how two destinations become
   * two answers.
   */
  const summaryRange = useMemo(() => {
    const [ty, tm] = window_.to.split("-").map(Number);
    return {
      date_from: `${window_.from}-01`,
      date_to: new Date(Date.UTC(ty, tm, 0)).toISOString().slice(0, 10),
    };
  }, [window_]);
  const { data: summary } = useGetSummary(summaryRange);
  const { data: decomp } = useGetDecomposition({
    dimension,
    from: decompWindow.from,
    to: decompWindow.to,
  });

  /**
   * M19.5 — budget vs actual, ANNUAL ONLY (owner decision, design §7).
   *
   * 🔴 It compares the whole YEAR, not the window above, and the card says so.
   * `budgets.period` is a `YYYY` string — one row per category per year — and
   * apportioning it across months was ruled out: a business with a Ramadan peak
   * does not spend a twelfth each month, so ÷12 would render a guess about
   * seasonality as a variance in performance. Stating the limitation is honest;
   * inventing the missing precision is not.
   */
  const budgetYear = window_.to.slice(0, 4);
  const { data: budgets } = useListBudgets({ period: budgetYear });
  const budgetRows = [...(budgets ?? [])].sort(
    (a, b) => Math.abs(b.variance) - Math.abs(a.variance),
  );

  /**
   * 🔴 THE GAP. recharts breaks a line wherever the value is `null`, so an
   * unclaimable month becomes a visible hole rather than a segment drawn
   * through data we have disowned. The point is still in the dataset — the
   * axis keeps its place and the table below still lists it with its reason.
   */
  const series = (trend ?? []).map((p) => ({
    period: p.period,
    currentRatio: p.claimable ? p.currentRatio : null,
    quickRatio: p.claimable ? p.quickRatio : null,
    currentAssets: p.claimable ? p.currentAssets : null,
    currentLiabilities: p.claimable ? p.currentLiabilities : null,
    claimable: p.claimable,
  }));

  const latest = trend && trend.length > 0 ? trend[trend.length - 1] : undefined;
  const withheldCount = (trend ?? []).filter((p) => !p.claimable).length;
  const sparse = (trend ?? []).length > 0 && (trend ?? []).length < 3;

  const ratioState = classifyChartState(
    trend,
    series.flatMap((s) => [s.currentRatio, s.quickRatio]),
    { ratio: true },
  );
  const moneyState = classifyChartState(
    trend,
    series.flatMap((s) => [s.currentAssets, s.currentLiabilities]),
  );

  /** The message a chart shows INSTEAD of an empty or flat frame. */
  const emptyMessage = (reason: Exclude<EmptyReason, null>) => {
    switch (reason) {
      case "loading":
        return t("Loading…", "جارٍ التحميل…");
      case "all_withheld":
        return t(
          `Every month in this range has figures we cannot stand behind, so there is nothing to chart. ${withheldCount} month(s) are affected — clear the unidentified money or classify the accounts, and this fills in.`,
          `كل شهر في هذا النطاق يحتوي أرقاماً لا يمكننا الاعتماد عليها، فلا يوجد ما يُرسم. ${withheldCount} شهراً متأثرة — صنّف الحسابات أو عالج المبالغ غير المحددة، وسيظهر الرسم.`,
        );
      /*
        🔴 Both remaining cases must mention the withheld months when there are
        any. "You had no short-term obligations in this period" is FALSE if two
        of the six months had obligations we simply could not stand behind —
        it would describe a data-quality problem as a fact about the business,
        which is the exact error this whole mechanism exists to avoid.
      */
      case "undefined_ratio":
        return (
          t(
            "You had no short-term obligations in the months we can rely on, so there is no ratio to show — not a ratio of zero.",
            "لم تكن عليك التزامات قصيرة الأجل في الأشهر التي يمكن الاعتماد عليها، لذا لا توجد نسبة تُعرض — وليست نسبة صفر.",
          ) + withheldSuffix()
        );
      case "no_activity":
        return (
          t(
            "Nothing was recorded in the months we can rely on. Try a longer range, or import your transactions.",
            "لم يُسجَّل شيء في الأشهر التي يمكن الاعتماد عليها. جرّب نطاقاً أطول، أو استورد معاملاتك.",
          ) + withheldSuffix()
        );
    }
  };

  /** Names the withheld months so a message never describes only half the window. */
  const withheldSuffix = () =>
    withheldCount === 0
      ? ""
      : t(
          ` ${withheldCount} other month(s) in this range are withheld because their figures cannot be relied on.`,
          ` وهناك ${withheldCount} شهراً آخر في هذا النطاق محجوبة لأن أرقامها غير موثوقة.`,
        );

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-muted-foreground" />
            {t("Analytics", "التحليلات")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t(
              "How the business is doing over time — and where the change came from.",
              "كيف يسير أداء المنشأة عبر الزمن — ومن أين جاء التغيّر.",
            )}
          </p>
        </div>
        <div className="flex gap-1">
          {[3, 6, 12, 24].map((n) => (
            <Button
              key={n}
              size="sm"
              variant={months === n ? "default" : "outline"}
              onClick={() => setMonths(n)}
            >
              {n}m
            </Button>
          ))}
        </div>
      </div>

      {/*
        The summary sentence is WITHHELD when the newest point is unclaimable —
        exactly as the Finance Hub withholds it. The charts still render, with
        their gaps, because the history remains informative.
      */}
      {latest && !latest.claimable && (
        <Alert>
          <TriangleAlert className="h-4 w-4" />
          <AlertDescription>
            {t(
              `The most recent month cannot be relied on, so no conclusion is drawn from it. ${withheldCount} month(s) in this range are shown as gaps.`,
              `لا يمكن الاعتماد على أحدث شهر، لذلك لا نستخلص منه نتيجة. وتظهر ${withheldCount} شهراً في هذا النطاق كفجوات.`,
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Absorbed from the Cockpit (A11), now bounded by the chart window. */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { label: t("Income", "الدخل"), value: summary.totalIncome },
            { label: t("Expenses", "المصروفات"), value: summary.totalExpenses },
            { label: t("Net", "الصافي"), value: summary.netPosition },
          ].map((s) => (
            <div key={s.label} className="rounded-md border border-border bg-secondary/20 p-3">
              <p className="text-[11px] text-muted-foreground">
                {s.label} · {window_.from} → {window_.to}
              </p>
              <p className="text-sm font-mono mt-0.5">{formatCurrency(s.value)}</p>
            </div>
          ))}
        </div>
      )}

      {sparse && (
        <p className="text-xs text-muted-foreground">
          {t(
            "Only a couple of months of history so far — shown, but two points are not yet a trend.",
            "لا يتوفر سوى شهرين من السجل حتى الآن — معروضان، لكن نقطتين لا تشكلان اتجاهاً بعد.",
          )}
        </p>
      )}

      {/* ── Chart 1: RATIOS (unitless) ─────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("Can you cover what's due?", "هل تغطي ما هو مستحق؟")}</CardTitle>
          <CardDescription>
            {t(
              "Above 1 means short-term assets cover short-term obligations. A rule of thumb, not a pass mark — it varies by industry.",
              "أعلى من 1 يعني أن الأصول قصيرة الأجل تغطي الالتزامات قصيرة الأجل. قاعدة استرشادية لا معيار نجاح — وتختلف حسب القطاع.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="h-[260px]">
          {ratioState ? (
            <div className="h-full flex items-center justify-center text-center px-6">
              <p className="text-sm text-muted-foreground max-w-md">{emptyMessage(ratioState)}</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={44} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {/* The rule-of-thumb line — neutral, never a status colour. */}
                <ReferenceLine y={1} stroke="currentColor" strokeDasharray="4 4" opacity={0.35} />
                <Line
                  type="monotone" dataKey="currentRatio" name={t("Current ratio", "النسبة المتداولة")}
                  stroke={SERIES_1} strokeWidth={2} dot={{ r: 3 }} connectNulls={false}
                />
                <Line
                  type="monotone" dataKey="quickRatio" name={t("Quick ratio", "النسبة السريعة")}
                  stroke={SERIES_2} strokeWidth={2} dot={{ r: 3 }} connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── Chart 2: MONEY (SAR) — a SEPARATE chart, never a second y-axis ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("What you hold and what you owe", "ما تملكه وما عليك")}</CardTitle>
          <CardDescription>
            {t("Short-term assets against short-term obligations.", "الأصول قصيرة الأجل مقابل الالتزامات قصيرة الأجل.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="h-[260px]">
          {moneyState ? (
            <div className="h-full flex items-center justify-center text-center px-6">
              <p className="text-sm text-muted-foreground max-w-md">{emptyMessage(moneyState)}</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={64} tickFormatter={(v) => formatCurrency(Number(v))} />
                <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone" dataKey="currentAssets" name={t("Current assets", "الأصول المتداولة")}
                  stroke={SERIES_1} strokeWidth={2} dot={{ r: 3 }} connectNulls={false}
                />
                <Line
                  type="monotone" dataKey="currentLiabilities" name={t("Due within a year", "المستحق خلال سنة")}
                  stroke={SERIES_2} strokeWidth={2} dot={{ r: 3 }} connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── Chart 3: RECEIVABLES FLOWS — invoiced vs collected (M19.6) ─────
           Two series, ONE axis: both are money, so a single scale is honest
           and the gap between the lines is the point. ────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {t("Invoiced against collected", "المفوتر مقابل المحصّل")}
          </CardTitle>
          <CardDescription>
            {t(
              "What you billed each month, and what actually came in. The gap is work done but not yet paid for — it is timing, not a loss.",
              "ما فوترته كل شهر وما تم تحصيله فعلياً. الفارق هو عمل أُنجز ولم يُدفع بعد — توقيت وليس خسارة.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="h-[260px]">
          {flowsState ? (
            <div className="h-full flex items-center justify-center text-center px-6">
              <p className="text-sm text-muted-foreground max-w-md">
                {flowsState === "loading"
                  ? t("Loading…", "جارٍ التحميل…")
                  : t(
                      "No invoices were raised or settled in this range. Approve an invoice, or try a longer range.",
                      "لم تُصدر أو تُسوَّ أي فواتير في هذا النطاق. اعتمد فاتورة، أو جرّب نطاقاً أطول.",
                    )}
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={bridgeSeries} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={64} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone" dataKey="invoiced" name={t("Invoiced", "المفوتر")}
                  stroke={SERIES_1} strokeWidth={2} dot={{ r: 3 }}
                />
                {/*
                  🔴 "Collected", never "revenue" (design §4). A cash figure and
                  an accrual figure both called revenue disagree for as long as
                  any invoice is unpaid — two numbers with one name in two places
                  is meta-finding #9 restated. The income statement keeps sole
                  ownership of the word.
                */}
                <Line
                  type="monotone" dataKey="collected" name={t("Collected", "المحصّل")}
                  stroke={SERIES_2} strokeWidth={2} dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── Chart 4: RECEIVABLES OUTSTANDING — the STOCK, on its own canvas ──
           Deliberately not overlaid on the flows above. A stock and a flow
           share a unit but not a meaning, and drawing them together invites the
           reader to compare a balance with a monthly movement. ───────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {t("Owed to you, month by month", "المستحق لك، شهراً بشهر")}
          </CardTitle>
          <CardDescription>
            {t(
              "The receivables balance at each month end — the same figure the balance sheet shows for that date.",
              "رصيد الذمم المدينة في نهاية كل شهر — نفس الرقم الذي تعرضه الميزانية العمومية لذلك التاريخ.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="h-[220px]">
          {outstandingState ? (
            <div className="h-full flex items-center justify-center text-center px-6">
              <p className="text-sm text-muted-foreground max-w-md">
                {outstandingState === "loading"
                  ? t("Loading…", "جارٍ التحميل…")
                  : t(
                      "Nothing is owed to you in this range — every invoice raised was settled.",
                      "لا توجد مبالغ مستحقة لك في هذا النطاق — كل فاتورة صدرت تم تحصيلها.",
                    )}
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={bridgeSeries} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={64} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                {/* One series — the title names it, so no legend box (dataviz). */}
                <Line
                  type="monotone" dataKey="outstanding" name={t("Outstanding", "المستحق")}
                  stroke={SERIES_1} strokeWidth={2} dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── The bridge itself: the identity, as numbers ────────────────────── */}
      {bridge && bridge.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {t("Why the balance moved", "لماذا تغيّر الرصيد")}
            </CardTitle>
            <CardDescription>
              {t(
                "Opening + invoiced − collected − credited = closing. Every figure is a movement on the receivables account, so the row always adds up.",
                "الافتتاحي + المفوتر − المحصّل − إشعارات الدائن = الختامي. كل رقم حركة على حساب الذمم المدينة، لذا يتوازن السطر دائماً.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3 font-medium">{t("Month", "الشهر")}</th>
                  <th className="py-2 px-3 font-medium text-right">{t("Opening", "الافتتاحي")}</th>
                  <th className="py-2 px-3 font-medium text-right">{t("Invoiced", "المفوتر")}</th>
                  <th className="py-2 px-3 font-medium text-right">{t("Collected", "المحصّل")}</th>
                  <th className="py-2 px-3 font-medium text-right">{t("Credited", "إشعارات دائن")}</th>
                  {bridgeOther !== 0 && (
                    <th className="py-2 px-3 font-medium text-right">{t("Other", "أخرى")}</th>
                  )}
                  <th className="py-2 pl-3 font-medium text-right">{t("Closing", "الختامي")}</th>
                </tr>
              </thead>
              <tbody className="font-mono text-xs">
                {bridge.map((p) => (
                  <tr key={p.period} className="border-b border-border/50">
                    <td className="py-1.5 pr-3 font-sans">{p.period}</td>
                    <td className="py-1.5 px-3 text-right">{formatCurrency(p.opening)}</td>
                    <td className="py-1.5 px-3 text-right">{formatCurrency(p.invoiced)}</td>
                    <td className="py-1.5 px-3 text-right">{formatCurrency(p.collected)}</td>
                    <td className="py-1.5 px-3 text-right">{formatCurrency(p.credited)}</td>
                    {bridgeOther !== 0 && (
                      <td className="py-1.5 px-3 text-right">{formatCurrency(p.other)}</td>
                    )}
                    <td className="py-1.5 pl-3 text-right font-semibold">
                      {formatCurrency(p.closing)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/*
              🔴 Shown ONLY when non-zero, and named rather than absorbed. A
              write-off or an offset is neither a payment nor a credit note;
              folding it into "credited" would describe a movement the platform
              did not understand as one it did.
            */}
            {bridgeOther !== 0 && (
              <p className="text-xs text-muted-foreground mt-3">
                {t(
                  "Other is a movement on receivables that was neither a payment nor a credit note — a write-off or an offset. It is listed separately rather than assumed.",
                  "«أخرى» حركة على الذمم المدينة ليست دفعة ولا إشعار دائن — شطب أو مقاصة. تُعرض منفصلة بدلاً من افتراضها.",
                )}
              </p>
            )}

            {/*
              🔴 Stating an absence, because the alternative is inventing it.
              An overdue split needs each invoice's outstanding balance AS AT
              each past month end, and partial payments are stored as a running
              `paid_amount` with no dated history — so it is not derivable for
              any month but today. Approximating it would put a number under
              "overdue" that the ledger cannot support.
            */}
            <p className="text-xs text-muted-foreground mt-2">
              {t(
                "How much of this is overdue is shown for today on the AR Aging report. Historically it cannot be derived, because payment dates are not kept per instalment.",
                "نسبة المتأخر من هذا تظهر لليوم في تقرير أعمار الذمم المدينة. أما تاريخياً فلا يمكن اشتقاقها، لأن تواريخ الدفعات الجزئية غير محفوظة.",
              )}
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Decomposition: WHERE, never WHY ────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-base">{t("Where the change came from", "من أين جاء التغيّر")}</CardTitle>
              <CardDescription>
                {decomp
                  ? t(
                      `${decompWindow.from} to ${decompWindow.to}, against the same length before it.`,
                      `من ${decompWindow.from} إلى ${decompWindow.to}، مقارنةً بالفترة المماثلة قبلها.`,
                    )
                  : ""}
              </CardDescription>
            </div>
            <div className="flex gap-1">
              {(["category", "customer", "vendor"] as Dim[]).map((d) => (
                <Button
                  key={d}
                  size="sm"
                  variant={dimension === d ? "default" : "outline"}
                  onClick={() => setDimension(d)}
                >
                  {t(
                    d === "category" ? "Category" : d === "customer" ? "Customer" : "Vendor",
                    d === "category" ? "الفئة" : d === "customer" ? "العميل" : "المورّد",
                  )}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {decomp && decomp.contributors.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("Nothing moved in this period.", "لم يطرأ أي تغيّر في هذه الفترة.")}
            </p>
          ) : decomp ? (
            <>
              {/*
                🔴 The wording turns on shareOfChange being null. With offsetting
                movements the net is ~zero and no contributor "caused" it, so the
                sentence says these MOVED, never that they explain a change.
              */}
              <p className="text-sm">
                {decomp.contributors[0]?.shareOfChange == null
                  ? t(
                      "Movements offset each other, so the net barely changed — these moved the most:",
                      "تعادلت الحركات، فلم يتغيّر الصافي تقريباً — وهذه أكثرها حركة:",
                    )
                  : t(
                      `${decomp.concentration?.count ?? 0} of them account for ${Math.round((decomp.concentration?.share ?? 0) * 100)}% of the movement:`,
                      `${decomp.concentration?.count ?? 0} منها تمثّل ${Math.round((decomp.concentration?.share ?? 0) * 100)}% من الحركة:`,
                    )}
              </p>
              <div style={{ height: Math.max(140, decomp.contributors.slice(0, 8).length * 32) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={decomp.contributors.slice(0, 8)}
                    layout="vertical"
                    margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" opacity={0.15} horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                    <ReferenceLine x={0} stroke="currentColor" opacity={0.4} />
                    <Bar dataKey="change" radius={[0, 4, 4, 0]} name={t("Change", "التغيّر")}>
                      {decomp.contributors.slice(0, 8).map((c) => (
                        <Cell key={c.id} fill={c.change >= 0 ? UP : DOWN} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Budget vs actual — ANNUAL, and it says so (M19.5) ─────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("Against budget", "مقارنةً بالميزانية")}</CardTitle>
          <CardDescription>
            {/*
              🔴 The limitation is stated, not implied by an empty axis.
              Budgets are annual; a monthly budget line would have to be
              invented, and an invented figure presented as a variance is worse
              than no figure at all.
            */}
            {t(
              `Budgets are set per year, so this compares the whole of ${budgetYear} — not the range selected above.`,
              `تُحدَّد الميزانيات سنوياً، لذا تقارن هذه البطاقة عام ${budgetYear} بأكمله — وليس النطاق المحدد أعلاه.`,
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {budgetRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t(
                `No budgets are set for ${budgetYear}. Set them in Planning → Budgets and this fills in.`,
                `لم تُحدَّد ميزانيات لعام ${budgetYear}. حدِّدها من التخطيط ← الميزانيات وسيظهر المحتوى.`,
              )}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground uppercase border-b">
                  <tr>
                    <th className="px-2 py-2 text-left">{t("Category", "الفئة")}</th>
                    <th className="px-2 py-2 text-right">{t("Budgeted", "المُدرج")}</th>
                    <th className="px-2 py-2 text-right">{t("Actual", "الفعلي")}</th>
                    <th className="px-2 py-2 text-right">{t("Difference", "الفرق")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {budgetRows.map((b) => (
                    <tr key={b.id}>
                      <td className="px-2 py-2">{b.categoryName ?? b.name ?? "—"}</td>
                      <td className="px-2 py-2 text-right font-mono text-xs">{formatCurrency(b.budgetedAmount)}</td>
                      <td className="px-2 py-2 text-right font-mono text-xs">{formatCurrency(b.actualAmount)}</td>
                      {/*
                        Neutral ink, never the status palette: over budget is a
                        judgment about a plan, not a system state, and a plan
                        may have been wrong.
                      */}
                      <td className="px-2 py-2 text-right font-mono text-xs">
                        {b.variance < 0 ? "+" : ""}
                        {formatCurrency(Math.abs(b.variance))}
                        <span className="text-muted-foreground ml-1">
                          {b.variance < 0 ? t("over", "تجاوز") : t("left", "متبقٍ")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── The table view. Required, not optional: an accountant wants the
           numbers, and it is the accessibility fallback for every chart. ──── */}
      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((s) => !s)}>
          <TableIcon className="w-3.5 h-3.5 mr-1.5" />
          {showTable ? t("Hide the numbers", "إخفاء الأرقام") : t("Show the numbers", "عرض الأرقام")}
        </Button>
        {showTable && trend && (
          <div className="mt-3 border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground uppercase bg-secondary/50 border-b">
                <tr>
                  <th className="px-4 py-2 text-left">{t("Month", "الشهر")}</th>
                  <th className="px-4 py-2 text-right">{t("Current assets", "الأصول المتداولة")}</th>
                  <th className="px-4 py-2 text-right">{t("Due within a year", "المستحق خلال سنة")}</th>
                  <th className="px-4 py-2 text-right">{t("Current", "المتداولة")}</th>
                  <th className="px-4 py-2 text-right">{t("Quick", "السريعة")}</th>
                  <th className="px-4 py-2 text-left">{t("Reliable?", "موثوق؟")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {trend.map((p) => (
                  <tr key={p.period}>
                    <td className="px-4 py-2 font-mono text-xs">{p.period}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">{formatCurrency(p.currentAssets)}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">{formatCurrency(p.currentLiabilities)}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">{p.currentRatio ?? "—"}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">{p.quickRatio ?? "—"}</td>
                    <td className="px-4 py-2 text-xs">
                      {p.claimable ? (
                        <span className="text-muted-foreground">{t("yes", "نعم")}</span>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          {p.blockers[0]?.code === "suspense_balance"
                            ? t("unidentified money", "مبالغ غير محددة")
                            : t("unclassified accounts", "حسابات غير مصنفة")}
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
