import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, Panel, EmptyState } from "@/components/kit";
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

import type { AccountSummaryReport, AccountSummaryRow } from "@workspace/api-client-react";

// The account-TYPE tokens (not the state palette): a type is a category, not a verdict.
const TYPE_COLOR: Record<string, string> = { income: "text-income", expense: "text-expense", asset: "text-asset", liability: "text-liability", equity: "text-equity" };

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

  const { data, isLoading } = useQuery<AccountSummaryReport>({
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

  const num = "px-3 text-end whitespace-nowrap tabular-nums";
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={t("Account Summary", "ملخص الحسابات")}
        description={t("Opening balance, period movements, and closing balance for every account", "الرصيد الافتتاحي وحركات الفترة والرصيد الختامي لكل حساب")}
      >
        {/* Export removed: no onClick — one of seven dead Export buttons (2026-09-01). */}
        <div className="mt-2"><FiscalRangeNotice source={range.source} /></div>
      </PageHeader>

      <Panel>
        <div className="flex flex-wrap items-end gap-3">
          <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          <Button size="sm" className="h-8" onClick={() => setApplied({ from: dateFrom, to: dateTo })}>{t("Generate", "إنشاء")}</Button>
        </div>
        <div className="mt-3">
          <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied(r);}} />
        </div>
      </Panel>

      {isLoading ? (
        <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>
      ) : !data || data.accounts.length === 0 ? (
        <Panel>
          <EmptyState
            icon={Scale}
            title={t("No account data for this period.", "لا توجد بيانات حسابات لهذه الفترة.")}
            description={t("Post journal entries to see account summaries.", "رحّل قيود يومية لرؤية ملخصات الحسابات.")}
          />
        </Panel>
      ) : (
        <Panel flush>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {([
                  [t("Account", "الحساب"), false],
                  [t("Type", "النوع"), false],
                  [t("Opening Balance", "الرصيد الافتتاحي"), true],
                  [t("Period Debits", "مدين الفترة"), true],
                  [t("Period Credits", "دائن الفترة"), true],
                  [t("Closing Balance", "الرصيد الختامي"), true],
                ] as const).map(([h, isNum]) => (
                  <th key={h} className={`${isNum ? "text-end" : "text-start"} px-3`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {typeOrder.filter(t => byType[t]?.length > 0).map(type => (
                <Fragment key={type}>
                  <tr>
                    <td colSpan={6} className="px-3 pt-6 pb-2 text-[13px] font-semibold capitalize text-foreground">{type}</td>
                  </tr>
                  {byType[type].map((r, i) => (
                    <tr key={i} className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 px-3 text-foreground"><span className="block ps-4">{r.name}</span></td>
                      <td className="py-2 px-3"><Badge variant="outline" className={cn("text-xs capitalize border-0 px-0", TYPE_COLOR[r.type] ?? "")}>{r.type}</Badge></td>
                      <td className={cn("py-2", num)}>{fmtNum(r.openingBalance)}</td>
                      <td className={cn("py-2", num)}>{r.periodDebit > 0 ? fmtNum(r.periodDebit) : "—"}</td>
                      <td className={cn("py-2", num)}>{r.periodCredit > 0 ? fmtNum(r.periodCredit) : "—"}</td>
                      <td className={cn("py-2 font-semibold", num, r.closingBalance < 0 ? "text-negative" : "")}>{fmtNum(r.closingBalance)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-border font-semibold">
                    <td className="py-2.5 px-3" colSpan={2}>{t("Subtotal", "المجموع الفرعي")} — <span className="capitalize">{type}</span></td>
                    <td className={cn("py-2.5", num)}>{fmtNum(byType[type].reduce((s, r) => s + r.openingBalance, 0))}</td>
                    <td className={cn("py-2.5", num)}>{fmtNum(byType[type].reduce((s, r) => s + r.periodDebit, 0))}</td>
                    <td className={cn("py-2.5", num)}>{fmtNum(byType[type].reduce((s, r) => s + r.periodCredit, 0))}</td>
                    <td className={cn("py-2.5", num)}>{fmtNum(byType[type].reduce((s, r) => s + r.closingBalance, 0))}</td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table></div>
        </Panel>
      )}
    </div>
  );
}
