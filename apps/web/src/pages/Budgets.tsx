import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel, FilterTabs, EmptyState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Target } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";

import type { BudgetInput, BudgetLine, Category } from "@workspace/api-client-react";

/** Request bodies go through the GENERATED input types (contract batch 5): a request the server does not accept is a compile error here. */
const json = { create: (b: BudgetInput) => JSON.stringify(b) };

const NEEDS_AR = "(not yet translated)";
const emptyForm = { name: "", nameAr: "", period: String(new Date().getFullYear()), categoryId: "", budgetedAmount: "", notes: "" };

export default function Budgets() {
  const [period, setPeriod] = useState(String(new Date().getFullYear()));
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();

  const { data: budgets = [], isLoading } = useQuery<BudgetLine[]>({
    queryKey: ["budgets", period],
    queryFn: () => apiFetch(`/budgets?period=${period}`),
  });

  const { data: categories = [] } = useQuery<Category[]>({ queryKey: ["categories"], queryFn: () => apiFetch("/categories") });

  const createMut = useMutation({
    mutationFn: (body: any) => apiFetch("/budgets", { method: "POST", body: json.create({ ...body, categoryId: body.categoryId ? Number(body.categoryId) : null, budgetedAmount: Number(body.budgetedAmount) }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["budgets"] }); setOpen(false); setForm(emptyForm); toast({ title: t("Budget line added", "تم إضافة سطر الميزانية") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/budgets/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["budgets"] }); toast({ title: t("Budget line deleted", "تم حذف سطر الميزانية") }); },
  });

  const totalBudgeted = budgets.reduce((s, b) => s + b.budgetedAmount, 0);
  const totalActual = budgets.reduce((s, b) => s + b.actualAmount, 0);
  const totalVariance = totalBudgeted - totalActual;
  const budgetsOver = budgets.filter(b => b.variance < 0).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("Budgeting", "الميزانية")}
        description={t("Budget vs. Actual · Variance analysis", "الميزانية مقابل الفعلي · تحليل الانحراف")}
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> {t("Add Budget", "إضافة ميزانية")}</Button></DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader><DialogTitle>{t("Add Budget Line", "إضافة سطر ميزانية")}</DialogTitle></DialogHeader>
              <div className="space-y-3 mt-2">
                <div><Label className="text-xs text-muted-foreground">{t("Budget Name (English)", "اسم الميزانية (إنجليزي)")}</Label><Input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} className="mt-1 h-8 text-sm" placeholder={t("e.g., Marketing Budget 2025", "مثال: ميزانية التسويق 2025")} /></div>
                <div><Label className="text-xs text-muted-foreground">اسم الميزانية (عربي)</Label><Input dir="rtl" value={form.nameAr} onChange={e=>setForm(p=>({...p,nameAr:e.target.value}))} className="mt-1 h-8 text-sm" placeholder="مثال: ميزانية التسويق ٢٠٢٥" /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label className="text-xs text-muted-foreground">{t("Period (Year)", "الفترة (السنة)")}</Label><Input value={form.period} onChange={e=>setForm(p=>({...p,period:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
                  <div><Label className="text-xs text-muted-foreground">{t("Budgeted Amount (SAR)", "المبلغ المدرج في الميزانية (ر.س)")}</Label><Input type="number" value={form.budgetedAmount} onChange={e=>setForm(p=>({...p,budgetedAmount:e.target.value}))} className="mt-1 h-8 text-sm font-mono" /></div>
                </div>
                <div><Label className="text-xs text-muted-foreground">{t("Category (optional)", "الفئة (اختياري)")}</Label>
                  <Select value={form.categoryId} onValueChange={v=>setForm(p=>({...p,categoryId:v}))}><SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder={t("Select category...", "اختر الفئة...")} /></SelectTrigger><SelectContent>{categories.map(c=><SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent></Select>
                </div>
              </div>
              <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.name||!form.budgetedAmount||createMut.isPending}>{createMut.isPending ? t("Adding...", "جارٍ الإضافة...") : t("Add Budget Line", "إضافة سطر ميزانية")}</Button>
            </DialogContent>
          </Dialog>
        }
      />

      {/* A budget variance is a judgment, not a state (CLAUDE.md §4): neutral figures, words for direction. */}
      <StatStrip cols={4}>
        <Stat label={t("Total Budgeted", "إجمالي الميزانية")} value={fmtNum(totalBudgeted)} />
        <Stat label={t("Total Actual", "إجمالي الفعلي")} value={fmtNum(totalActual)} />
        <Stat label={t("Variance", "الانحراف")} value={fmtNum(totalVariance)} hint={totalVariance >= 0 ? t("under budget", "ضمن الميزانية") : t("over budget", "تجاوز الميزانية")} />
        <Stat label={t("Over Budget Lines", "سطور تجاوزت الميزانية")} value={budgetsOver} />
      </StatStrip>

      <Panel flush>
        <FilterTabs
          options={[String(new Date().getFullYear()-1), String(new Date().getFullYear()), String(new Date().getFullYear()+1)].map(y => ({ value: y, label: y }))}
          value={period}
          onChange={setPeriod}
          end={<span className="text-[13px] text-muted-foreground">{t("Budget vs. Actual —", "الميزانية مقابل الفعلي —")} {period}</span>}
        />
          {isLoading ? <div className="text-muted-foreground text-sm p-5">{t("Loading...", "جارٍ التحميل...")}</div> : budgets.length === 0 ? (
            <EmptyState icon={Target} title={<>{t("No budget lines for", "لا توجد سطور ميزانية لـ")} {period}.</>} />
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="border-b border-border">{([
                [t("Budget", "الميزانية"), false],
                [t("Category", "الفئة"), false],
                [t("Budgeted", "المدرج"), true],
                [t("Actual", "الفعلي"), true],
                [t("Variance", "الانحراف"), true],
                [t("Utilization", "نسبة الاستخدام"), false],
                ["", false],
              ] as const).map(([h, num])=><th key={h} className={`${num ? "text-end" : "text-start"} px-3`}>{h}</th>)}</tr></thead>
              <tbody>{budgets.map(b=>{
                const pct = b.budgetedAmount > 0 ? Math.min((b.actualAmount / b.budgetedAmount) * 100, 100) : 0;
                const over = b.variance < 0;
                return (
                  <tr key={b.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors">
                    <td className="py-3 px-3">
                        <p className="font-medium">{b.name}</p>
                        {b.nameAr && b.nameAr !== NEEDS_AR
                          ? <p className="text-xs text-muted-foreground" dir="rtl">{b.nameAr}</p>
                          : <p className="text-[11px] text-attention">{t("needs Arabic translation", "يحتاج ترجمة عربية")}</p>}
                      </td>
                    <td className="py-3 px-3 text-muted-foreground">{b.categoryName || "—"}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(b.budgetedAmount)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(b.actualAmount)}</td>
                    <td className={`py-3 px-3 text-end whitespace-nowrap tabular-nums font-semibold ${over?"text-negative":"text-positive"}`}>{over?"-":"+"}{ fmtNum(Math.abs(b.variance))}</td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <div className="w-24 bg-muted rounded-full h-1.5">
                          <div className={`h-1.5 rounded-full transition-all ${over?"bg-negative":"bg-positive"}`} style={{width:`${pct}%`}} />
                        </div>
                        <span className={`text-xs tabular-nums ${over?"text-negative":"text-muted-foreground"}`}>{b.budgetedAmount > 0 ? ((b.actualAmount/b.budgetedAmount)*100).toFixed(0) : 0}%</span>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-end"><Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={()=>deleteMut.mutate(b.id)}>{t("Delete", "حذف")}</Button></td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
      </Panel>
    </div>
  );
}
