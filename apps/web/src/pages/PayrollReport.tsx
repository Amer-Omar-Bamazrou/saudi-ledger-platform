import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Banknote } from "lucide-react";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { useLanguage } from "@/contexts/LanguageContext";

/**
 * 🔴 These are GET /payroll's real field names, checked by
 * `tests/list-response-shape.test.ts` against the live response.
 *
 * This interface previously named seven fields the endpoint has never returned
 * (`month`, `grossSalary`, `gosi`, `allowances`, `deductions`, `netSalary`,
 * `employeeCount`). `apiFetch<T>` is a cast, so TypeScript agreed; the visible
 * consequence was that the period filter compared `undefined >= "2026-01"` —
 * false for every row — and **the report rendered "No payroll runs in this
 * period" no matter what the tenant had run**.
 */
import type { PayrollRunListItem } from "@workspace/api-client-react";

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  processed: "bg-info-surface/20 text-info",
  paid: "bg-positive-surface/20 text-positive",
};

export default function PayrollReport() {
  // M20.1 — the report does not mount until its default window is known, so a
  // wrong window (the old hardcoded Jan–Dec) is never queried or rendered,
  // even for a frame.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <PayrollReportInner range={range} />;
}

function PayrollReportInner({ range }: { range: ReportDefaultRange }) {
  const { t } = useLanguage();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);

  const { data: rows = [], isLoading } = useQuery<PayrollRunListItem[]>({
    queryKey: ["payroll-report", from, to],
    // No `.catch(() => [])`: a failed fetch is surfaced, never rendered as "no payroll".
    queryFn: () => apiFetch<PayrollRunListItem[]>("/payroll"),
  });

  const filtered = rows.filter(r => r.period >= from.slice(0, 7) && r.period <= to.slice(0, 7));
  const totalGross = filtered.reduce((s, r) => s + r.grossSalary, 0);
  // Employer cost and employee deduction are separate stored facts, and the
  // report keeps them apart rather than printing one "GOSI" number that could
  // be read as either.
  const totalGosiEmployer = filtered.reduce((s, r) => s + r.totalGosiEmployer, 0);
  const totalNet = filtered.reduce((s, r) => s + r.totalNetPay, 0);

  return (
    <div className="space-y-6 max-w-6xl">
      <PageHeader
        title={t("Payroll Summary", "ملخص الرواتب")}
        description={t("Monthly payroll costs — gross, GOSI, and net", "تكاليف الرواتب الشهرية — الإجمالي والتأمينات والصافي")}
      />

      <FiscalRangeNotice source={range.source} />

      <Panel>
          <div className="flex flex-wrap gap-4 items-end">
            <div><Label className="text-[13px] text-muted-foreground">{t("From", "من")}</Label>
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="mt-1 w-44" /></div>
            <div><Label className="text-[13px] text-muted-foreground">{t("To", "إلى")}</Label>
              <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="mt-1 w-44" /></div>
          </div>
          <div className="mt-3">
            <PeriodShortcuts from={from} to={to} onSelect={(r)=>{setFrom(r.from);setTo(r.to);}} />
          </div>
      </Panel>

      <StatStrip cols={3}>
        <Stat label={t("Total Gross", "إجمالي الرواتب")} value={fmtNum(totalGross)} />
        <Stat label={t("GOSI (Employer)", "التأمينات (صاحب العمل)")} value={fmtNum(totalGosiEmployer)} />
        <Stat label={t("Total Net Paid", "صافي المدفوع")} value={fmtNum(totalNet)} tone="negative" />
      </StatStrip>

      <Panel flush>
          {isLoading ? <div className="text-sm text-muted-foreground p-5">{t("Loading…", "جارٍ التحميل…")}</div>
          : filtered.length === 0 ? (
            <EmptyState
              icon={Banknote}
              title={t("No payroll runs in this period.", "لا توجد مسيّرات رواتب في هذه الفترة.")}
              description={t("Process payroll in HR & Payroll to see data here.", "عالِج الرواتب في الموارد البشرية والرواتب لتظهر البيانات هنا.")}
            />
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {([
                    [t("Month", "الشهر"), false], [t("Employees", "الموظفون"), true], [t("Gross Salary", "إجمالي الراتب"), true],
                    [t("GOSI (Employer)", "التأمينات (صاحب العمل)"), true], [t("GOSI (Employee)", "التأمينات (الموظف)"), true],
                    [t("Allowances", "البدلات"), true], [t("Deductions", "الاستقطاعات"), true],
                    [t("Net Salary", "صافي الراتب"), true], [t("Status", "الحالة"), false],
                  ] as const).map(([h, num]) => (
                    <th key={h} className={`${num ? "text-end" : "text-start"} px-3`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors">
                    <td className="py-3 px-3 font-medium whitespace-nowrap tabular-nums">{r.period}</td>
                    <td className="py-3 px-3 text-end tabular-nums">{r.employeeCount}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(r.grossSalary)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{fmtNum(r.totalGosiEmployer)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{fmtNum(r.totalGosiEmployee)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{fmtNum(r.totalAllowances)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{fmtNum(r.totalDeductions)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums font-semibold">{fmtNum(r.totalNetPay)}</td>
                    <td className="py-3 px-3"><Badge className={`text-xs capitalize ${STATUS_STYLES[r.status] ?? ""}`}>{r.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
      </Panel>
    </div>
  );
}
