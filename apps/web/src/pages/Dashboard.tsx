import { useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  useGetSummary,
  useGetLiquidity,
  useGetBooksStatus,
  useGetTaxCompliance,
  useGetCashReconciliation,
  useListTransactions,
  useListInvoices,
  useListBills,
} from "@workspace/api-client-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch, fmtDate } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  TrendingUp, TrendingDown, Wallet, Banknote,
  FileText, FileInput, ArrowUpRight, ArrowDownRight,
  Clock, AlertTriangle, Receipt, ListChecks,
  Upload, BookOpen,
} from "lucide-react";

/** Last N months as {from, to} in YYYY-MM for the analytics endpoints. */
function lastNMonths(n: number): { from: string; to: string } {
  const now = new Date();
  const to = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1), 1));
  return { from: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`, to };
}

// ── KPI Card ─────────────────────────────────────────────────────────────
function StatCard({
  label, value, icon: Icon, trend, accent,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  trend?: { direction: "up" | "down"; label: string };
  accent: "income" | "expense" | "net" | "cash";
}) {
  const accentMap = {
    income: "text-positive bg-positive-surface/10",
    expense: "text-negative bg-negative-surface/10",
    net: "text-info bg-info-surface/10",
    cash: "text-primary bg-primary/10",
  };
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
            <p className="text-2xl font-bold text-foreground tabular-nums">{value}</p>
            {trend && (
              <div className={`flex items-center gap-1 text-xs font-medium ${trend.direction === "up" ? "text-positive" : "text-negative"}`}>
                {trend.direction === "up" ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                {trend.label}
              </div>
            )}
          </div>
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${accentMap[accent]}`}>
            <Icon className="w-5 h-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────
function Panel({ title, icon: Icon, action, children }: {
  title: string;
  icon: React.ElementType;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────
function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-4 rounded bg-muted/50 animate-pulse" style={{ width: `${100 - i * 15}%` }} />
      ))}
    </div>
  );
}

export default function Dashboard() {
  const { t, lang } = useLanguage();
  const cashWindow = useMemo(() => lastNMonths(6), []);

  // ── Data ────────────────────────────────────────────────────────────────
  const { data: summary } = useGetSummary();
  const { data: liquidity } = useGetLiquidity();
  const { data: books } = useGetBooksStatus();
  const { data: tax } = useGetTaxCompliance();
  const { data: cash } = useGetCashReconciliation({ from: cashWindow.from, to: cashWindow.to });
  const { data: txResult } = useListTransactions({ limit: 6 });
  const { data: invoiceResult } = useListInvoices({ limit: 5 });
  const { data: billResult } = useListBills({ limit: 5 });

  const transactions = txResult?.transactions ?? [];
  const invoices = invoiceResult?.items ?? [];
  const bills = billResult?.items ?? [];
  const cashPoints = cash?.points ?? [];

  // ── Derived ─────────────────────────────────────────────────────────────
  const totalIncome = summary?.totalIncome ?? 0;
  const totalExpenses = summary?.totalExpenses ?? 0;
  const netPosition = summary?.netPosition ?? 0;
  const cashBalance = liquidity?.quickAssets ?? 0;

  const arOutstanding = invoiceResult?.totals?.outstanding ?? 0;
  const arOverdue = invoiceResult?.totals?.overdue ?? 0;
  const apOutstanding = billResult?.totals?.outstanding ?? 0;
  const apOverdueCount = billResult?.totals?.overdue ?? 0;

  const unreviewedCount = books?.unreviewedCount ?? 0;
  const needsAttention = books?.needsAttentionCount ?? 0;
  const netVatDue = tax?.vat?.netVatDue ?? 0;

  const chartData = cashPoints.map((p) => ({
    period: p.period,
    inflow: Math.max(0, p.bankMovement),
    outflow: Math.min(0, p.bankMovement),
  }));

  return (
    <div className="space-y-6 max-w-7xl">
      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Dashboard", "لوحة التحكم")}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t("Financial overview at a glance", "نظرة مالية عامة")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/invoices">
            <Button variant="outline" size="sm" className="gap-1.5">
              <FileText className="w-3.5 h-3.5" />
              {t("New Invoice", "فاتورة جديدة")}
            </Button>
          </Link>
          <Link href="/bills">
            <Button variant="outline" size="sm" className="gap-1.5">
              <FileInput className="w-3.5 h-3.5" />
              {t("New Bill", "فاتورة مورد")}
            </Button>
          </Link>
          <Link href="/upload">
            <Button size="sm" className="gap-1.5">
              <Upload className="w-3.5 h-3.5" />
              {t("Import Statement", "استيراد كشف")}
            </Button>
          </Link>
        </div>
      </div>

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label={t("Total Income", "إجمالي الإيرادات")}
          value={formatCurrency(totalIncome)}
          icon={TrendingUp}
          accent="income"
        />
        <StatCard
          label={t("Total Expenses", "إجمالي المصروفات")}
          value={formatCurrency(totalExpenses)}
          icon={TrendingDown}
          accent="expense"
        />
        <StatCard
          label={t("Net Profit", "صافي الربح")}
          value={formatCurrency(netPosition)}
          icon={Banknote}
          accent="net"
          trend={netPosition >= 0
            ? { direction: "up", label: t("Surplus", "فائض") }
            : { direction: "down", label: t("Deficit", "عجز") }}
        />
        <StatCard
          label={t("Cash & Equivalents", "النقد وما يعادله")}
          value={formatCurrency(cashBalance)}
          icon={Wallet}
          accent="cash"
        />
      </div>

      {/* ── Cash Flow Chart + Status ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Cash Flow Chart — spans 2 cols */}
        <div className="lg:col-span-2">
          <Panel
            title={t("Cash Flow (6 months)", "التدفق النقدي (٦ أشهر)")}
            icon={Banknote}
            action={
              <Link href="/cash-flow">
                <Button variant="ghost" size="sm" className="text-xs text-muted-foreground hover:text-foreground">
                  {t("View report", "عرض التقرير")} →
                </Button>
              </Link>
            }
          >
            {chartData.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
                {t("No cash flow data yet", "لا توجد بيانات للتدفق النقدي بعد")}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="cashIn" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--color-income))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--color-income))" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="cashOut" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--color-expense))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--color-expense))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="period" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} tickFormatter={(v) => Intl.NumberFormat("en", { notation: "compact" }).format(v)} />
                  <Tooltip
                    contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--popover-border))", borderRadius: "0.5rem", fontSize: 12, color: "hsl(var(--popover-foreground))" }}
                    labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                    itemStyle={{ color: "hsl(var(--popover-foreground))" }}
                    formatter={(v: number) => formatCurrency(v)}
                  />
                  <Area type="monotone" dataKey="inflow" name={t("Inflow", "وارد")} stroke="hsl(var(--color-income))" strokeWidth={2} fill="url(#cashIn)" />
                  <Area type="monotone" dataKey="outflow" name={t("Outflow", "منصرف")} stroke="hsl(var(--color-expense))" strokeWidth={2} fill="url(#cashOut)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </Panel>
        </div>

        {/* Books Status + VAT */}
        <div className="space-y-4">
          <Panel title={t("Books Status", "حالة الدفاتر")} icon={ListChecks}>
            <div className="space-y-3">
              <Link href="/review" className="flex items-center justify-between rounded-lg p-2.5 hover:bg-secondary/60 transition-colors">
                <div className="flex items-center gap-2.5">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${unreviewedCount > 0 ? "bg-attention-surface/10 text-attention" : "bg-muted text-muted-foreground"}`}>
                    <Clock className="w-4 h-4" />
                  </div>
                  <span className="text-sm text-foreground">{t("Unreviewed", "غير مراجع")}</span>
                </div>
                <Badge variant={unreviewedCount > 0 ? "default" : "secondary"}>{unreviewedCount}</Badge>
              </Link>
              <Link href="/review" className="flex items-center justify-between rounded-lg p-2.5 hover:bg-secondary/60 transition-colors">
                <div className="flex items-center gap-2.5">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${needsAttention > 0 ? "bg-negative-surface/10 text-negative" : "bg-muted text-muted-foreground"}`}>
                    <AlertTriangle className="w-4 h-4" />
                  </div>
                  <span className="text-sm text-foreground">{t("Needs Attention", "تحتاج انتباه")}</span>
                </div>
                <Badge variant={needsAttention > 0 ? "destructive" : "secondary"}>{needsAttention}</Badge>
              </Link>
            </div>
          </Panel>

          <Panel title={t("VAT Position", "موقف الضريبة")} icon={Receipt} action={
            <Link href="/vat"><Button variant="ghost" size="sm" className="text-xs text-muted-foreground">→</Button></Link>
          }>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t("Net VAT Due", "صافي الضريبة المستحقة")}</span>
                <span className={`text-lg font-bold tabular-nums ${netVatDue >= 0 ? "text-foreground" : "text-positive"}`}>
                  {formatCurrency(netVatDue)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {tax?.vat
                  ? `${t("Period", "الفترة")}: ${tax.vat.periodFrom} → ${tax.vat.periodTo}`
                  : t("Loading…", "جارٍ التحميل…")}
              </p>
            </div>
          </Panel>
        </div>
      </div>

      {/* ── AR / AP Summary ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel
          title={t("Outstanding Invoices (AR)", "الفواتير المستحقة (ذمم مدينة)")}
          icon={FileText}
          action={<Link href="/invoices"><Button variant="ghost" size="sm" className="text-xs text-muted-foreground">→</Button></Link>}
        >
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <p className="text-xs text-muted-foreground">{t("Outstanding", "المستحقة")}</p>
              <p className="text-xl font-bold text-foreground tabular-nums">{formatCurrency(arOutstanding)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("Overdue", "متأخرة")}</p>
              <p className="text-xl font-bold text-negative tabular-nums">{formatCurrency(arOverdue)}</p>
            </div>
          </div>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground py-3">{t("No outstanding invoices", "لا توجد فواتير مستحقة")}</p>
          ) : (
            <div className="space-y-2">
              {invoices.slice(0, 4).map((inv) => (
                <Link key={inv.id} href="/invoices" className="flex items-center justify-between rounded-lg p-2 hover:bg-secondary/60 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{inv.invoiceNumber}</p>
                    <p className="text-xs text-muted-foreground truncate">{inv.customerName ?? "—"}</p>
                  </div>
                  <div className="text-right shrink-0 ps-2">
                    <p className="text-sm font-medium text-foreground tabular-nums">{formatCurrency(inv.total)}</p>
                    <Badge variant="outline" className="text-[10px]">{inv.status}</Badge>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title={t("Outstanding Bills (AP)", "فواتير الموردين المستحقة (ذمم دائنة)")}
          icon={FileInput}
          action={<Link href="/bills"><Button variant="ghost" size="sm" className="text-xs text-muted-foreground">→</Button></Link>}
        >
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <p className="text-xs text-muted-foreground">{t("Outstanding", "المستحقة")}</p>
              <p className="text-xl font-bold text-foreground tabular-nums">{formatCurrency(apOutstanding)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("Overdue Count", "عدد المتأخرة")}</p>
              <p className="text-xl font-bold text-negative tabular-nums">{apOverdueCount}</p>
            </div>
          </div>
          {bills.length === 0 ? (
            <p className="text-sm text-muted-foreground py-3">{t("No outstanding bills", "لا توجد فواتير مورد مستحقة")}</p>
          ) : (
            <div className="space-y-2">
              {bills.slice(0, 4).map((bill) => (
                <Link key={bill.id} href="/bills" className="flex items-center justify-between rounded-lg p-2 hover:bg-secondary/60 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{bill.billNumber}</p>
                    <p className="text-xs text-muted-foreground truncate">{bill.vendorName ?? "—"}</p>
                  </div>
                  <div className="text-right shrink-0 ps-2">
                    <p className="text-sm font-medium text-foreground tabular-nums">{formatCurrency(bill.total)}</p>
                    <Badge variant="outline" className="text-[10px]">{bill.status}</Badge>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* ── Recent Transactions ── */}
      <Panel
        title={t("Recent Transactions", "أحدث المعاملات")}
        icon={BookOpen}
        action={<Link href="/transactions"><Button variant="ghost" size="sm" className="text-xs text-muted-foreground">{t("View all", "عرض الكل")} →</Button></Link>}
      >
        {transactions.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {t("No transactions yet. Import a bank statement to get started.", "لا توجد معاملات بعد. استورد كشفاً بنكياً للبدء.")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border">
                  <th className="text-left font-medium pb-2 pr-4">{t("Date", "التاريخ")}</th>
                  <th className="text-left font-medium pb-2 pr-4">{t("Description", "الوصف")}</th>
                  <th className="text-left font-medium pb-2 pr-4">{t("Category", "التصنيف")}</th>
                  <th className="text-right font-medium pb-2">{t("Amount", "المبلغ")}</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr key={tx.id} className="border-b border-border/50 last:border-0">
                    <td className="py-2.5 pr-4 text-muted-foreground whitespace-nowrap">{fmtDate(tx.date, lang)}</td>
                    <td className="py-2.5 pr-4 text-foreground truncate max-w-48">{tx.description}</td>
                    <td className="py-2.5 pr-4">
                      {tx.categoryName ? (
                        <Badge variant="secondary" className="text-[10px]">{tx.categoryName}</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] text-attention border-attention-surface/30">{t("Uncategorized", "غير مصنف")}</Badge>
                      )}
                    </td>
                    <td className={`py-2.5 text-right font-medium tabular-nums whitespace-nowrap ${tx.type === "credit" ? "text-positive" : "text-foreground"}`}>
                      {tx.type === "credit" ? "+" : "−"}{formatCurrency(tx.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
