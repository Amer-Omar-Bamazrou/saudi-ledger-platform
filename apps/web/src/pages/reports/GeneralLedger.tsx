import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BookOpen, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { DualDate } from "@/components/DualDate";

interface Category { id: number; name: string; type: string; }
interface Movement { date: string; entryNumber: string; reference: string | null; description: string; debit: number; credit: number; balance: number; }
interface GLData { accountId: number | null; accountName: string; accountNameAr?: string; openingBalance: number; movements: Movement[]; closingBalance: number; totalDebit: number; totalCredit: number; }

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

  const { data, isLoading } = useQuery<GLData>({
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("General Ledger", "دفتر الأستاذ العام")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("All journal entry lines in date order with running balance", "جميع سطور قيود اليومية بترتيب التاريخ مع الرصيد الجاري")}</p>
        </div>
        <Button variant="outline" className="gap-2"><Download className="w-4 h-4" /> {t("Export", "تصدير")}</Button>
      </div>

      <FiscalRangeNotice source={range.source} />

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4 flex-wrap">
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
        </CardContent>
      </Card>

      {data && (
        <div className="grid grid-cols-4 gap-4">
          {[
            [t("Account", "الحساب"), n(data.accountName, data.accountNameAr), "text-primary"],
            [t("Opening Balance", "الرصيد الافتتاحي"), fmtNum(data.openingBalance), "text-primary"],
            [t("Total Debits", "إجمالي المدين"), fmtNum(data.totalDebit), "text-blue-400"],
            [t("Total Credits", "إجمالي الدائن"), fmtNum(data.totalCredit), "text-emerald-400"],
          ].map(([l, v, c]) => (
            <Card key={String(l)} className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
              <CardContent><div className={cn("text-lg font-bold font-mono truncate", c)}>{v}</div></CardContent>
            </Card>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>
      ) : !applied ? (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <div className="text-center py-16 text-muted-foreground">
              <BookOpen className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("Select an account and date range, then click Generate.", "اختر حساباً ونطاق تاريخ، ثم انقر على إنشاء.")}</p>
            </div>
          </CardContent>
        </Card>
      ) : !data || data.movements.length === 0 ? (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <div className="text-center py-16 text-muted-foreground">
              <BookOpen className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No posted movements for this account in the selected period.", "لا توجد حركات مرحّلة لهذا الحساب في الفترة المختارة.")}</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[t("Date", "التاريخ"), t("Entry #", "رقم القيد"), t("Reference", "المرجع"), t("Description", "الوصف"), t("Debit", "مدين"), t("Credit", "دائن"), t("Running Balance", "الرصيد الجاري")].map(h => (
                    <th key={h} className="text-left pb-2.5 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border/50 bg-secondary/20">
                  <td colSpan={6} className="py-2 px-2 text-xs font-semibold text-muted-foreground">{t("Opening Balance", "الرصيد الافتتاحي")}</td>
                  <td className="py-2 font-mono text-xs font-bold">{fmtNum(data.openingBalance)}</td>
                </tr>
                {data.movements.map((m, i) => (
                  <tr key={i} className="border-b border-border/30 hover:bg-secondary/10">
                    <td className="py-2 pr-4 text-xs text-muted-foreground whitespace-nowrap"><DualDate date={m.date} /></td>
                    <td className="py-2 pr-4 font-mono text-xs text-primary">{m.entryNumber}</td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">{m.reference ?? "—"}</td>
                    <td className="py-2 pr-4 text-xs">{m.description}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-blue-400">{m.debit > 0 ? fmtNum(m.debit) : "—"}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-emerald-400">{m.credit > 0 ? fmtNum(m.credit) : "—"}</td>
                    <td className={cn("py-2 font-mono text-xs font-semibold", m.balance < 0 ? "text-red-400" : "")}>{fmtNum(m.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-bold">
                  <td colSpan={4} className="pt-3 text-xs font-semibold text-muted-foreground">{t("Closing Balance", "الرصيد الختامي")}</td>
                  <td className="pt-3 font-mono text-xs text-blue-400">{fmtNum(data.totalDebit)}</td>
                  <td className="pt-3 font-mono text-xs text-emerald-400">{fmtNum(data.totalCredit)}</td>
                  <td className={cn("pt-3 font-mono text-sm font-bold", data.closingBalance < 0 ? "text-red-400" : "")}>{fmtNum(data.closingBalance)}</td>
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
