import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { DualDate } from "@/components/DualDate";

import type { Category, GeneralLedgerReport } from "@workspace/api-client-react";

export default function GeneralLedger() {
  // M20.1 — the report does not mount until its default window is known, so a
  // wrong window (the old hardcoded Jan–Dec) is never queried or rendered,
  // even for a frame.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <GeneralLedgerInner range={range} />;
}

function GeneralLedgerInner({ range }: { range: ReportDefaultRange }) {
  const { n, t } = useLanguage();
  const [accountId, setAccountId] = useState("all");
  const [dateFrom,  setDateFrom]  = useState(range.from);
  const [dateTo,    setDateTo]    = useState(range.to);
  const [applied,   setApplied]   = useState<{ accountId: string; from: string; to: string } | null>(null);

  const { data: cats = [] } = useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () => apiFetch("/categories"),
  });

  const { data, isLoading } = useQuery<GeneralLedgerReport>({
    queryKey: ["general-ledger", applied],
    queryFn: () => {
      if (!applied) return Promise.reject("no selection");
      const params = new URLSearchParams({ date_from: applied.from, date_to: applied.to });
      if (applied.accountId !== "all") params.set("account_id", applied.accountId);
      return apiFetch(`/reports/general-ledger?${params}`);
    },
    enabled: !!applied,
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={t("General Ledger", "دفتر الأستاذ العام")}
        description={t("All journal entry lines in date order with running balance", "جميع سطور قيود اليومية بترتيب التاريخ مع الرصيد الجاري")}
      >
        <div className="mt-2"><FiscalRangeNotice source={range.source} /></div>
      </PageHeader>

      <Panel>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="min-w-56">
            <Label className="text-xs text-muted-foreground">{t("Account", "الحساب")}</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("All Accounts", "جميع الحسابات")}</SelectItem>
                {cats.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name} <span className="text-muted-foreground text-xs">({c.type})</span></SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          <Button size="sm" className="h-8" onClick={() => setApplied({ accountId, from: dateFrom, to: dateTo })}>{t("Generate", "إنشاء")}</Button>
        </div>
        <div className="mt-3">
          <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied({accountId,from:r.from,to:r.to});}} />
        </div>
      </Panel>

      {data && (
        <StatStrip cols={4}>
          <Stat label={t("Account", "الحساب")} value={<span className="block truncate text-[18px]">{n(data.accountName, data.accountNameAr)}</span>} />
          <Stat label={t("Opening Balance", "الرصيد الافتتاحي")} value={fmtNum(data.openingBalance)} />
          <Stat label={t("Total Debits", "إجمالي المدين")} value={fmtNum(data.totalDebit)} />
          <Stat label={t("Total Credits", "إجمالي الدائن")} value={fmtNum(data.totalCredit)} />
        </StatStrip>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>
      ) : !applied ? (
        <Panel>
          <EmptyState icon={BookOpen} title={t("Select an account and date range, then click Generate.", "اختر حساباً ونطاق تاريخ، ثم انقر على إنشاء.")} />
        </Panel>
      ) : !data || data.movements.length === 0 ? (
        <Panel>
          <EmptyState icon={BookOpen} title={t("No posted movements for this account in the selected period.", "لا توجد حركات مرحّلة لهذا الحساب في الفترة المختارة.")} />
        </Panel>
      ) : (
        <Panel flush>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {([
                  [t("Date", "التاريخ"), false],
                  [t("Entry #", "رقم القيد"), false],
                  [t("Reference", "المرجع"), false],
                  [t("Description", "الوصف"), false],
                  [t("Debit", "مدين"), true],
                  [t("Credit", "دائن"), true],
                  [t("Running Balance", "الرصيد الجاري"), true],
                ] as const).map(([h, num]) => (
                  <th key={h} className={`${num ? "text-end" : "text-start"} px-3`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border/70 bg-muted/30">
                <td colSpan={6} className="py-3 px-3 font-medium text-muted-foreground">{t("Opening Balance", "الرصيد الافتتاحي")}</td>
                <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums font-semibold">{fmtNum(data.openingBalance)}</td>
              </tr>
              {data.movements.map((m, i) => (
                <tr key={i} className="border-b border-border/70 hover:bg-muted/40 transition-colors">
                  <td className="py-3 px-3 text-muted-foreground whitespace-nowrap"><DualDate date={m.date} /></td>
                  <td className="py-3 px-3 font-medium text-primary whitespace-nowrap">{m.entryNumber}</td>
                  <td className="py-3 px-3 text-muted-foreground">{m.reference ?? "—"}</td>
                  <td className="py-3 px-3">{m.description}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{m.debit > 0 ? fmtNum(m.debit) : "—"}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{m.credit > 0 ? fmtNum(m.credit) : "—"}</td>
                  <td className={cn("py-3 px-3 text-end whitespace-nowrap tabular-nums font-semibold", m.balance < 0 ? "text-negative" : "")}>{fmtNum(m.balance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td colSpan={4} className="py-3.5 px-3">{t("Closing Balance", "الرصيد الختامي")}</td>
                <td className="py-3.5 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(data.totalDebit)}</td>
                <td className="py-3.5 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(data.totalCredit)}</td>
                <td className={cn("py-3.5 px-3 text-end whitespace-nowrap tabular-nums text-base", data.closingBalance < 0 ? "text-negative" : "")}>{fmtNum(data.closingBalance)}</td>
              </tr>
            </tfoot>
          </table></div>
        </Panel>
      )}
    </div>
  );
}
