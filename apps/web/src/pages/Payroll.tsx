import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Banknote, Play } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

import type { CreatePayrollRunInput, PayrollRunDetail, PayrollRunListItem } from "@workspace/api-client-react";

/** Request bodies go through the GENERATED input types (contract batch 4): a request the server does not accept is a compile error here. */
const json = { create: (b: CreatePayrollRunInput) => JSON.stringify(b) };

const STATUS_STYLES: Record<string, string> = { draft: "bg-attention-surface/20 text-attention", approved: "bg-positive-surface/20 text-positive", paid: "bg-info-surface/20 text-info" };

export default function Payroll() {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Payroll", "الرواتب")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Saudi payroll processing · GOSI · WPS-ready", "معالجة رواتب سعودية · GOSI · متوافق مع WPS")}</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Play className="w-4 h-4" /> {t("Run Payroll", "تشغيل الرواتب")}</Button></DialogTrigger>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>{t("Generate Payroll Run", "إنشاء مسير رواتب")}</DialogTitle></DialogHeader>
            <div className="mt-2 space-y-3">
              <div><Label className="text-xs text-muted-foreground">{t("Period (YYYY-MM)", "الفترة (YYYY-MM)")}</Label><Input type="month" value={period} onChange={e=>setPeriod(e.target.value)} className="mt-1 h-8 text-sm" /></div>
              <p className="text-xs text-muted-foreground">{t("This will generate payroll items for all active employees based on their current salary setup and GOSI rates.", "سيُنشئ هذا بنود الرواتب لجميع الموظفين النشطين بناءً على إعداد الراتب الحالي ونسب GOSI.")}</p>
            </div>
            <Button className="w-full mt-4" onClick={()=>generateMut.mutate(period)} disabled={generateMut.isPending}>{generateMut.isPending ? t("Generating...", "جارٍ الإنشاء...") : t("Generate Payroll", "إنشاء مسير الرواتب")}</Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-5 gap-4">
        {runs.length > 0 && (() => {
          const last = runs[0];
          return [
            [t("Net Pay", "صافي الراتب"), fmtNum(last.totalNetPay), "text-primary"],
            [t("Basic Salary", "الراتب الأساسي"), fmtNum(last.totalBasicSalary), "text-foreground"],
            [t("Allowances", "البدلات"), fmtNum(last.totalAllowances), "text-muted-foreground"],
            [t("GOSI (Employee)", "GOSI (الموظف)"), fmtNum(last.totalGosiEmployee), "text-attention"],
            [t("GOSI (Employer)", "GOSI (صاحب العمل)"), fmtNum(last.totalGosiEmployer), "text-negative"],
          ].map(([l,v,c])=>(
            <Card key={String(l)} className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-lg font-bold font-mono ${c}`}>{v}</div><div className="text-xs text-muted-foreground mt-1">{last.period}</div></CardContent></Card>
          ));
        })()}
      </div>

      <div className="grid grid-cols-5 gap-4">
        <Card className="col-span-2 border-border bg-card">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Payroll Runs", "مسيرات الرواتب")}</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <div className="text-muted-foreground text-sm">{t("Loading...", "جارٍ التحميل...")}</div> : runs.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground"><Banknote className="w-8 h-8 mx-auto mb-3 opacity-40" /><p className="text-sm">{t("No payroll runs yet.", "لا توجد مسيرات رواتب بعد.")}</p></div>
            ) : (
              <div className="space-y-2">
                {runs.map(r=>(
                  <div data-row key={r.id} className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${selectedId===r.id?"border-primary/40 bg-primary/5":"border-border hover:bg-secondary/20"}`} onClick={()=>setSelectedId(selectedId===r.id?null:r.id)}>
                    <div>
                      <div className="font-mono text-sm font-semibold">{r.period}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{fmtNum(r.totalNetPay)} {t("net", "صافي")}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge className={`text-xs ${STATUS_STYLES[r.status]??""}`}>{r.status}</Badge>
                      {r.status==="draft"&&<Button variant="ghost" size="sm" className="h-6 text-xs text-positive" onClick={ev=>{ev.stopPropagation();approveMut.mutate(r.id);}}>{t("Approve", "موافقة")}</Button>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-3 border-border bg-card">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{detail ? `${t("Payslips", "قسائم الراتب")} — ${detail.period}` : t("Select a Run", "اختر مسير رواتب")}</CardTitle></CardHeader>
          <CardContent>
            {!detail ? <div className="text-center py-12 text-muted-foreground text-sm">{t("Select a payroll run to view payslips", "اختر مسير رواتب لعرض قسائم الراتب")}</div> : (
              <div className="overflow-x-auto"><table className="w-full text-xs">
                <thead><tr className="border-b border-border text-muted-foreground uppercase">{[t("Employee", "الموظف"), t("Basic", "الأساسي"), t("GOSI (Emp)", "GOSI (موظف)"), t("GOSI (Er)", "GOSI (صاحب عمل)"), t("Net Pay", "صافي الراتب")].map(h=><th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>)}</tr></thead>
                <tbody>{detail.items.map(item=>(
                  <tr key={item.id} className="border-b border-border/50 hover:bg-secondary/10">
                    <td className="py-2 pe-3"><div className="font-medium text-sm">{item.employeeName}</div><div className="text-muted-foreground font-mono">{item.employeeNumber}</div></td>
                    <td className="py-2 pe-3 font-mono">{fmtNum(item.basicSalary)}</td>
                    <td className="py-2 pe-3 font-mono text-attention">{fmtNum(item.gosiEmployee)}</td>
                    <td className="py-2 pe-3 font-mono text-negative">{fmtNum(item.gosiEmployer)}</td>
                    <td className="py-2 font-mono font-semibold text-positive text-sm">{fmtNum(item.netPay)}</td>
                  </tr>
                ))}</tbody>
                <tfoot>
                  <tr className="border-t border-border font-semibold text-sm">
                    <td className="py-2 text-muted-foreground">{t("Total", "الإجمالي")}</td>
                    <td className="py-2 font-mono">{fmtNum(detail.totalBasicSalary)}</td>
                    <td className="py-2 font-mono text-attention">{fmtNum(detail.totalGosiEmployee)}</td>
                    <td className="py-2 font-mono text-negative">{fmtNum(detail.totalGosiEmployer)}</td>
                    <td className="py-2 font-mono text-positive">{fmtNum(detail.totalNetPay)}</td>
                  </tr>
                </tfoot>
              </table></div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
