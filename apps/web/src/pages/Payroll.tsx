import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { statusLabel } from "@/lib/statusLabel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Banknote, Play } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BankPicker } from "@/components/payments/shared";
import { ApiError } from "@/lib/api";

import type { CreatePayrollRunInput, PayPayrollRunInput, PayrollRunDetail, PayrollRunListItem } from "@workspace/api-client-react";
import { businessToday } from "@workspace/shared";

/** Request bodies go through the GENERATED input types (contract batch 4): a request the server does not accept is a compile error here. */
const json = { create: (b: CreatePayrollRunInput) => JSON.stringify(b), pay: (b: PayPayrollRunInput) => JSON.stringify(b) };

/** DR-41: the pay path's refusals, titled by their CODE in both languages (the server's sentence is the description). */
const PAY_REFUSALS: Record<string, [string, string]> = {
  payroll_payable_already_settled: ["Not paid — a bank line already paid this run, or is waiting to", "لم يُدفع — سطر بنكي دفع هذا المسير بالفعل أو بانتظار ذلك"],
  payroll_already_paid: ["This payroll run is already paid", "مسير الرواتب هذا مدفوع بالفعل"],
  payroll_not_approved: ["Approve the payroll run before paying it", "اعتمد مسير الرواتب قبل دفعه"],
};

const STATUS_STYLES: Record<string, string> = { draft: "bg-attention-surface/20 text-attention", approved: "bg-positive-surface/20 text-positive", paid: "bg-info-surface/20 text-info" };

export default function Payroll() {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [period, setPeriod] = useState(businessToday().slice(0, 7));
  // DR-41: paying an approved run's net pay (Dr Salaries Payable / Cr the bank) — never the salary expense again
  const [payRun, setPayRun] = useState<PayrollRunListItem | null>(null);
  const [payBank, setPayBank] = useState("");
  const [paidAt, setPaidAt] = useState(businessToday());
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

  const payMut = useMutation({
    mutationFn: (v: { id: number; body: PayPayrollRunInput }) => apiFetch(`/payroll/${v.id}/pay`, { method: "POST", body: json.pay(v.body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["payroll"] }); setPayRun(null); toast({ title: t("Net pay recorded — Salaries Payable settled", "سُجِّل صافي الرواتب — سُوِّيت الرواتب المستحقة") }); },
    onError: (e: Error) => {
      const pair = e instanceof ApiError && e.code ? PAY_REFUSALS[e.code] : undefined;
      toast({ title: pair ? t(pair[0], pair[1]) : t("Error", "خطأ"), description: e.message, variant: "destructive" });
    },
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
        <Dialog open={payRun !== null} onOpenChange={(o)=>{ if (!o) setPayRun(null); }}>
          <DialogContent className="max-w-sm" data-testid="payroll-pay-dialog">
            <DialogHeader><DialogTitle>{t("Pay net salaries", "دفع صافي الرواتب")} — {payRun?.period}</DialogTitle></DialogHeader>
            <div className="mt-2 space-y-3">
              <p className="text-sm">{t("Net pay", "صافي الراتب")}: <span className="font-mono font-semibold" dir="ltr">{payRun ? fmtNum(payRun.totalNetPay) : ""}</span></p>
              <BankPicker value={payBank} onChange={setPayBank} testId="payroll-pay-bank" label={t("Paid from", "دُفع من")} />
              <div><Label className="text-xs text-muted-foreground">{t("Paid on", "تاريخ الدفع")}</Label><Input type="date" dir="ltr" value={paidAt} onChange={e=>setPaidAt(e.target.value)} className="mt-1 h-8 text-sm" data-testid="payroll-pay-date" /></div>
              <p className="text-xs text-muted-foreground">{t("The salaries were expensed when the run was approved; paying settles Salaries Payable from the bank. If the bank's salary line is imported later, reconcile it to this payment rather than categorising it.", "سُجِّلت الرواتب مصروفًا عند اعتماد المسير؛ والدفع يسوّي الرواتب المستحقة من البنك. وإذا استُورد سطر الرواتب البنكي لاحقًا فطابقه مع هذه الدفعة بدل تصنيفه.")}</p>
            </div>
            <Button className="w-full mt-4" data-testid="payroll-pay-submit" disabled={!payBank || !paidAt || payMut.isPending} onClick={()=>payRun && payMut.mutate({ id: payRun.id, body: { bankAccountId: Number(payBank), paidAt } })}>{payMut.isPending ? t("Recording...", "جارٍ التسجيل...") : t("Record payment", "تسجيل الدفعة")}</Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
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

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
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
                      <Badge className={`text-xs ${STATUS_STYLES[r.status]??""}`}>{statusLabel(r.status, lang)}</Badge>
                      {r.status==="draft"&&<Button variant="ghost" size="sm" className="h-6 text-xs text-positive" onClick={ev=>{ev.stopPropagation();approveMut.mutate(r.id);}}>{t("Approve", "موافقة")}</Button>}
                      {r.status==="approved"&&<Button variant="ghost" size="sm" className="h-6 text-xs text-primary" data-testid={`payroll-pay-${r.id}`} onClick={ev=>{ev.stopPropagation();setPayRun(r);setPayBank("");setPaidAt(businessToday());}}>{t("Pay", "دفع")}</Button>}
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
