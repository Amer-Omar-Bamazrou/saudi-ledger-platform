import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Scale } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";

interface AccountSummaryRow {
  name: string; type: string;
  openingBalance: number; periodDebit: number; periodCredit: number; closingBalance: number;
}
interface AccountSummaryData { accounts: AccountSummaryRow[]; count: number; }

const TYPE_COLOR: Record<string, string> = { income: "text-positive", expense: "text-negative", asset: "text-info", liability: "text-attention", equity: "text-purple-400" };

export default function AccountSummary() {
  // M20.1 — the report does not mount until its default window is known, so a
  // wrong window (the old hardcoded Jan–Dec) is never queried or rendered,
  // even for a frame.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <AccountSummaryInner range={range} />;
}

function AccountSummaryInner({ range }: { range: ReportDefaultRange }) {
  const { t } = useLanguage();
  const [dateFrom, setDateFrom] = useState(range.from);
  const [dateTo,   setDateTo]   = useState(range.to);
  const [applied,  setApplied]  = useState({ from: range.from, to: range.to });

  const { data, isLoading } = useQuery<AccountSummaryData>({
    queryKey: ["account-summary", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/account-summary?date_from=${applied.from}&date_to=${applied.to}`),
  });

  const byType = data ? data.accounts.reduce((acc, r) => {
    if (!acc[r.type]) acc[r.type] = [];
    acc[r.type].push(r);
    return acc;
  }, {} as Record<string, AccountSummaryRow[]>) : {};

  /** See the note in `TrialBalance.tsx`: a fixed list silently DROPPED any
   *  account type it did not name — including "other", which the service
   *  assigns to journal lines whose account resolves to no category — while
   *  the server-side totals still counted them. Derived from the data so a
   *  type cannot go missing. */
  const KNOWN_TYPES = ["asset", "liability", "equity", "income", "expense"];
  const typeOrder = [
    ...KNOWN_TYPES.filter(t => byType[t]?.length),
    ...Object.keys(byType).filter(t => !KNOWN_TYPES.includes(t)).sort(),
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Account Summary", "ملخص الحسابات")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Opening balance, period movements, and closing balance for every account", "الرصيد الافتتاحي وحركات الفترة والرصيد الختامي لكل حساب")}</p>
        </div>
        {/* Export removed: no onClick — one of seven dead Export buttons (2026-09-01). */}
      </div>

      <FiscalRangeNotice source={range.source} />

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4">
            <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <Button size="sm" className="h-8" onClick={() => setApplied({ from: dateFrom, to: dateTo })}>{t("Generate", "إنشاء")}</Button>
          </div>
          <div className="mt-3">
            <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied(r);}} />
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>
      ) : !data || data.accounts.length === 0 ? (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <div className="text-center py-16 text-muted-foreground">
              <Scale className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No account data for this period.", "لا توجد بيانات حسابات لهذه الفترة.")}</p>
              <p className="text-xs mt-1 opacity-60">{t("Post journal entries to see account summaries.", "رحّل قيود يومية لرؤية ملخصات الحسابات.")}</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[t("Account", "الحساب"), t("Type", "النوع"), t("Opening Balance", "الرصيد الافتتاحي"), t("Period Debits", "مدين الفترة"), t("Period Credits", "دائن الفترة"), t("Closing Balance", "الرصيد الختامي")].map(h => (
                    <th key={h} className="text-start pb-3 pe-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {typeOrder.filter(t => byType[t]?.length > 0).map(type => (
                  <Fragment key={type}>
                    <tr className="bg-secondary/20">
                      <td colSpan={6} className={cn("py-2 px-2 text-xs font-bold uppercase tracking-widest", TYPE_COLOR[type] ?? "text-muted-foreground")}>{type}</td>
                    </tr>
                    {byType[type].map((r, i) => (
                      <tr key={i} className="border-b border-border/30 hover:bg-secondary/10">
                        <td className="py-2.5 pe-4 ps-4 text-foreground text-sm">{r.name}</td>
                        <td className="py-2.5 pe-4"><Badge variant="outline" className={cn("text-xs capitalize border-0 px-0", TYPE_COLOR[r.type] ?? "")}>{r.type}</Badge></td>
                        <td className="py-2.5 pe-4 font-mono text-xs">{fmtNum(r.openingBalance)}</td>
                        <td className="py-2.5 pe-4 font-mono text-xs text-info">{r.periodDebit > 0 ? fmtNum(r.periodDebit) : "—"}</td>
                        <td className="py-2.5 pe-4 font-mono text-xs text-positive">{r.periodCredit > 0 ? fmtNum(r.periodCredit) : "—"}</td>
                        <td className={cn("py-2.5 font-mono text-xs font-semibold", r.closingBalance < 0 ? "text-negative" : "")}>{fmtNum(r.closingBalance)}</td>
                      </tr>
                    ))}
                    <tr className="border-b-2 border-border/50">
                      <td className="py-2 ps-4 text-xs text-muted-foreground" colSpan={2}>Subtotal — {type}</td>
                      <td className="py-2 font-mono text-xs pe-4">{fmtNum(byType[type].reduce((s, r) => s + r.openingBalance, 0))}</td>
                      <td className="py-2 font-mono text-xs pe-4 text-info">{fmtNum(byType[type].reduce((s, r) => s + r.periodDebit, 0))}</td>
                      <td className="py-2 font-mono text-xs pe-4 text-positive">{fmtNum(byType[type].reduce((s, r) => s + r.periodCredit, 0))}</td>
                      <td className="py-2 font-mono text-xs font-bold">{fmtNum(byType[type].reduce((s, r) => s + r.closingBalance, 0))}</td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
