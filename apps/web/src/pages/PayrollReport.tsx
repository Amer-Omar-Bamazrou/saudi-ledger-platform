import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Banknote, Download } from "lucide-react";
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
interface PayrollRow {
  id: number; period: string; employeeCount: number; grossSalary: number;
  totalGosiEmployer: number; totalGosiEmployee: number; totalAllowances: number;
  totalDeductions: number; totalNetPay: number; status: string;
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  processed: "bg-blue-500/20 text-blue-400",
  paid: "bg-emerald-500/20 text-emerald-400",
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

  const { data: rows = [], isLoading } = useQuery<PayrollRow[]>({
    queryKey: ["payroll-report", from, to],
    queryFn: () => apiFetch<PayrollRow[]>("/payroll").catch(() => [] as PayrollRow[]),
  });

  const filtered = rows.filter(r => r.period >= from.slice(0, 7) && r.period <= to.slice(0, 7));
  const totalGross = filtered.reduce((s, r) => s + r.grossSalary, 0);
  // Employer cost and employee deduction are separate stored facts, and the
  // report keeps them apart rather than printing one "GOSI" number that could
  // be read as either.
  const totalGosiEmployer = filtered.reduce((s, r) => s + r.totalGosiEmployer, 0);
  const totalNet = filtered.reduce((s, r) => s + r.totalNetPay, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Payroll Summary", "ملخص الرواتب")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Monthly payroll costs — gross, GOSI, and net", "تكاليف الرواتب الشهرية — الإجمالي والتأمينات والصافي")}</p>
        </div>
        <Button variant="outline" className="gap-2"><Download className="w-4 h-4" /> Export</Button>
      </div>

      <FiscalRangeNotice source={range.source} />

      <Card className="border-border bg-card">
        <CardContent className="pt-4 pb-4">
          <div className="flex gap-4 items-end">
            <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label>
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label>
              <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          </div>
          <div className="mt-3">
            <PeriodShortcuts from={from} to={to} onSelect={(r)=>{setFrom(r.from);setTo(r.to);}} />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-4">
        {[
          [t("Total Gross", "إجمالي الرواتب"), fmtNum(totalGross), "text-primary"],
          [t("GOSI (Employer)", "التأمينات (صاحب العمل)"), fmtNum(totalGosiEmployer), "text-amber-400"],
          [t("Total Net Paid", "صافي المدفوع"), fmtNum(totalNet), "text-red-400"],
        ].map(([l, v, c]) => (
          <Card key={String(l)} className="border-border bg-card">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
            <CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-6">
          {isLoading ? <div className="text-sm text-muted-foreground p-4">Loading…</div>
          : filtered.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Banknote className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No payroll runs in this period.", "لا توجد مسيّرات رواتب في هذه الفترة.")}</p>
              <p className="text-xs mt-1 opacity-60">Process payroll in HR &amp; Payroll to see data here.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[
                    t("Month", "الشهر"), t("Employees", "الموظفون"), t("Gross Salary", "إجمالي الراتب"),
                    t("GOSI (Employer)", "التأمينات (صاحب العمل)"), t("GOSI (Employee)", "التأمينات (الموظف)"),
                    t("Allowances", "البدلات"), t("Deductions", "الاستقطاعات"),
                    t("Net Salary", "صافي الراتب"), t("Status", "الحالة"),
                  ].map(h => (
                    <th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-2 pe-3 font-medium">{r.period}</td>
                    <td className="py-2 pe-3 font-mono">{r.employeeCount}</td>
                    <td className="py-2 pe-3 font-mono">{fmtNum(r.grossSalary)}</td>
                    <td className="py-2 pe-3 font-mono text-amber-400">{fmtNum(r.totalGosiEmployer)}</td>
                    <td className="py-2 pe-3 font-mono text-amber-400">{fmtNum(r.totalGosiEmployee)}</td>
                    <td className="py-2 pe-3 font-mono text-emerald-400">{fmtNum(r.totalAllowances)}</td>
                    <td className="py-2 pe-3 font-mono text-red-400">{fmtNum(r.totalDeductions)}</td>
                    <td className="py-2 pe-3 font-mono font-semibold">{fmtNum(r.totalNetPay)}</td>
                    <td className="py-2"><Badge className={`text-xs ${STATUS_STYLES[r.status] ?? ""}`}>{r.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
