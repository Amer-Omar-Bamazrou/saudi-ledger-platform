import { useMemo, useState } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, Cell, ReferenceLine,
} from "recharts";
import { useGetTrend, useGetDecomposition } from "@workspace/api-client-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
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
  const [months, setMonths] = useState(12);
  const [dimension, setDimension] = useState<Dim>("category");
  const [showTable, setShowTable] = useState(false);

  const window_ = useMemo(() => lastNMonths(months), [months]);
  const decompWindow = useMemo(() => currentMonthRange(), []);

  const { data: trend } = useGetTrend({ from: window_.from, to: window_.to });
  const { data: decomp } = useGetDecomposition({
    dimension,
    from: decompWindow.from,
    to: decompWindow.to,
  });

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
          {[6, 12, 24].map((n) => (
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
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
              <XAxis dataKey="period" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} width={64} />
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
        </CardContent>
      </Card>

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
