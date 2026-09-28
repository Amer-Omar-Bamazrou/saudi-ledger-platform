import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { statusLabel } from "@/lib/statusLabel";
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Banknote, Play } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

import type { CreatePayrollRunInput, PayrollRunDetail, PayrollRunListItem } from "@workspace/api-client-react";
import { businessToday } from "@workspace/shared";

/** Request bodies go through the GENERATED input types (contract batch 4): a request the server does not accept is a compile error here. */
const json = { create: (b: CreatePayrollRunInput) => JSON.stringify(b) };

const STATUS_STYLES: Record<string, string> = { draft: "bg-attention-surface/20 text-attention", approved: "bg-positive-surface/20 text-positive", paid: "bg-info-surface/20 text-info" };

export default function Payroll() {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [period, setPeriod] = useState(businessToday().slice(0, 7));
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, lang } = useLanguage();

  const { data: runs = [], isLoading } = useQuery<PayrollRunListItem[]>({ queryKey: ["payroll"], queryFn: () => apiFetch("/payroll") });
  const { data: detail } = useQuery<PayrollRunDetail>({ queryKey: ["payroll", selectedId], queryFn: () => apiFetch(`/payroll/${selectedId}`), enabled: selectedId !== null });

  const generateMut = useMutation({
    mutationFn: (p: string) => apiFetch("/payroll", { method: "POST", body: json.create({ period: p }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["payroll"] }); setOpen(false); toast({ title: t("Payroll run generated", "تم إنشاء مسير الرواتب") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const approveMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/payroll/${id}/approve`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["payroll"] }); toast({ title: t("Payroll approved", "تمت الموافقة على مسير الرواتب") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("Payroll", "الرواتب")}
        description={t("Saudi payroll processing · GOSI · WPS-ready", "معالجة رواتب سعودية · GOSI · متوافق مع WPS")}
        actions={
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Play className="w-4 h-4" /> {t("Run Payroll", "تشغيل الرواتب")}</Button></DialogTrigger>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>{t("Generate Payroll Run", "إنشاء مسير رواتب")}</DialogTitle></DialogHeader>
            <div className="mt-2 space-y-3">
              <div><Label className="text-[13px] text-muted-foreground">{t("Period (YYYY-MM)", "الفترة (YYYY-MM)")}</Label><Input type="month" value={period} onChange={e=>setPeriod(e.target.value)} className="mt-1" /></div>
              <p className="text-xs text-muted-foreground">{t("This will generate payroll items for all active employees based on their current salary setup and GOSI rates.", "سيُنشئ هذا بنود الرواتب لجميع الموظفين النشطين بناءً على إعداد الراتب الحالي ونسب GOSI.")}</p>
            </div>
            <Button className="w-full mt-4" onClick={()=>generateMut.mutate(period)} disabled={generateMut.isPending}>{generateMut.isPending ? t("Generating...", "جارٍ الإنشاء...") : t("Generate Payroll", "إنشاء مسير الرواتب")}</Button>
          </DialogContent>
        </Dialog>
        }
      />

      {runs.length > 0 && (() => {
        const last = runs[0];
        return (
          <StatStrip cols={5}>
            <Stat label={t("Net Pay", "صافي الراتب")} value={fmtNum(last.totalNetPay)} hint={last.period} />
            <Stat label={t("Basic Salary", "الراتب الأساسي")} value={fmtNum(last.totalBasicSalary)} hint={last.period} />
            <Stat label={t("Allowances", "البدلات")} value={fmtNum(last.totalAllowances)} hint={last.period} />
            <Stat label={t("GOSI (Employee)", "GOSI (الموظف)")} value={fmtNum(last.totalGosiEmployee)} hint={last.period} />
            <Stat label={t("GOSI (Employer)", "GOSI (صاحب العمل)")} value={fmtNum(last.totalGosiEmployer)} hint={last.period} tone="negative" />
          </StatStrip>
        );
      })()}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <Panel className="lg:col-span-2" title={t("Payroll Runs", "مسيرات الرواتب")} flush>
            {isLoading ? <div className="text-muted-foreground text-sm p-5">{t("Loading...", "جارٍ التحميل...")}</div> : runs.length === 0 ? (
              <EmptyState className="py-8" icon={Banknote} title={t("No payroll runs yet.", "لا توجد مسيرات رواتب بعد.")} />
            ) : (
              <div className="divide-y divide-border">
                {runs.map(r=>(
                  <div data-row key={r.id} className={`flex items-center justify-between gap-3 px-5 py-3 cursor-pointer transition-colors border-s-2 ${selectedId===r.id?"border-s-primary bg-primary/5":"border-s-transparent hover:bg-muted/40"}`} onClick={()=>setSelectedId(selectedId===r.id?null:r.id)}>
                    <div>
                      <div className="text-sm font-semibold tabular-nums">{r.period}</div>
                      <div className="text-[12px] text-muted-foreground mt-0.5 tabular-nums">{fmtNum(r.totalNetPay)} {t("net", "صافي")}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge className={`text-xs capitalize ${STATUS_STYLES[r.status]??""}`}>{statusLabel(r.status, lang)}</Badge>
                      {r.status==="draft"&&<Button variant="ghost" size="sm" className="h-6 text-xs text-positive" onClick={ev=>{ev.stopPropagation();approveMut.mutate(r.id);}}>{t("Approve", "موافقة")}</Button>}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </Panel>

        <Panel className="lg:col-span-3" title={detail ? `${t("Payslips", "قسائم الراتب")} — ${detail.period}` : t("Select a Run", "اختر مسير رواتب")} flush>
            {!detail ? <EmptyState className="py-12" icon={Banknote} title={t("Select a payroll run to view payslips", "اختر مسير رواتب لعرض قسائم الراتب")} /> : (
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead><tr className="border-b border-border">{([[t("Employee", "الموظف"), false], [t("Basic", "الأساسي"), true], [t("GOSI (Emp)", "GOSI (موظف)"), true], [t("GOSI (Er)", "GOSI (صاحب عمل)"), true], [t("Net Pay", "صافي الراتب"), true]] as const).map(([h, num])=><th key={h} className={`${num ? "text-end" : "text-start"} px-3`}>{h}</th>)}</tr></thead>
                <tbody>{detail.items.map(item=>(
                  <tr key={item.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors">
                    <td className="py-3 px-3"><div className="font-medium">{item.employeeName}</div><div className="text-[12px] text-muted-foreground">{item.employeeNumber}</div></td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(item.basicSalary)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{fmtNum(item.gosiEmployee)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{fmtNum(item.gosiEmployer)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums font-semibold">{fmtNum(item.netPay)}</td>
                  </tr>
                ))}</tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <td className="py-3 px-3">{t("Total", "الإجمالي")}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(detail.totalBasicSalary)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(detail.totalGosiEmployee)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(detail.totalGosiEmployer)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(detail.totalNetPay)}</td>
                  </tr>
                </tfoot>
              </table></div>
            )}
        </Panel>
      </div>
    </div>
  );
}
