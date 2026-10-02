/**
 * Phase 15 — budgets (decision pack §5).
 *
 * A budget belongs to ONE fiscal year of the company and FREEZES it (D15-01);
 * each budget has versions — draft → submitted → approved → superseded — and
 * the detail page (`/budgets/:id`) holds the lines and the budget-vs-actual.
 *
 * 🔴 Creating a budget needs a DECLARED fiscal year (D15-15). The page checks
 * first and says so, naming Company Settings — the control stays visible and
 * the server's own refusal is the backstop ("explain a refusal; do not hide
 * the control", §3).
 */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListBudgets, useCreateBudget, useListFiscalYears, getListBudgetsQueryKey,
  type BudgetSummary, type CreateBudgetInputScenario,
} from "@workspace/api-client-react";
import { fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Target } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { scenarioLabel, versionStatusLabel } from "@/lib/budgetLabels";

export default function Budgets() {
  const { t, n } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [year, setYear] = useState<string>("");
  const [scenario, setScenario] = useState<CreateBudgetInputScenario>("base");

  const { data: budgets = [], isLoading } = useListBudgets();
  const { data: fiscal } = useListFiscalYears();
  const declared = fiscal?.declared === true;
  const years = fiscal?.periods ?? [];
  const chosenYear = year || (fiscal?.current ? String(fiscal.current.label) : "");

  const create = useCreateBudget({
    mutation: {
      onSuccess: (b) => {
        qc.invalidateQueries({ queryKey: getListBudgetsQueryKey() });
        setOpen(false); setName(""); setNameAr("");
        toast({ title: t("Budget created — add its lines", "تم إنشاء الميزانية — أضف بنودها") });
        navigate(`/budgets/${b.id}`);
      },
    },
  });

  return (
    <div className="space-y-6" data-testid="budgets-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Budgets", "الميزانيات")}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t("Per fiscal year, versioned and approved; compared with the posted ledger.", "لكل سنة مالية، بإصدارات واعتماد؛ وتُقارن بالدفتر المرحَّل.")}
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2" data-testid="budget-create"><Plus className="w-4 h-4" />{t("New budget", "ميزانية جديدة")}</Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>{t("New budget", "ميزانية جديدة")}</DialogTitle></DialogHeader>
            {!declared ? (
              <p className="text-sm text-muted-foreground" data-testid="fy-undeclared">
                {t("A budget is set per fiscal year, and this company has not declared one. Declare it in ", "تُحدَّد الميزانية لكل سنة مالية، ولم تُعلن هذه الشركة سنتها المالية بعد. أعلنها من ")}
                <Link href="/company" className="underline">{t("Company Settings", "إعدادات الشركة")}</Link>
                {t(" — it is never assumed to be the calendar year.", " — ولا تُفترض أبداً أنها السنة الميلادية.")}
              </p>
            ) : (
              <div className="space-y-3 mt-2">
                <div><Label className="text-xs text-muted-foreground">{t("Name (English)", "الاسم (إنجليزي)")}</Label><Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 h-8 text-sm" data-testid="budget-create-name" /></div>
                <div><Label className="text-xs text-muted-foreground">{t("Name (Arabic)", "الاسم (عربي)")}</Label><Input dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} className="mt-1 h-8 text-sm" data-testid="budget-create-name-ar" /></div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Fiscal year", "السنة المالية")}</Label>
                  <Select value={chosenYear} onValueChange={setYear}>
                    <SelectTrigger className="mt-1 h-8 text-sm" data-testid="budget-create-year"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {years.map((p) => (
                        <SelectItem key={p.label} value={String(p.label)}>{p.label} · {fmtDate(p.startDate)} – {fmtDate(p.endDate)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Scenario", "السيناريو")}</Label>
                  <Select value={scenario} onValueChange={(v) => setScenario(v as CreateBudgetInputScenario)}>
                    <SelectTrigger className="mt-1 h-8 text-sm" data-testid="budget-create-scenario"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(["base", "best_case", "worst_case"] as const).map((s) => <SelectItem key={s} value={s}>{scenarioLabel(s, t)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  className="w-full mt-2" data-testid="budget-create-submit"
                  disabled={!name.trim() || !chosenYear || create.isPending}
                  onClick={() => create.mutate({ data: { name: name.trim(), nameAr: nameAr.trim() || null, fiscalYearLabel: Number(chosenYear), scenario } })}
                >
                  {create.isPending ? t("Creating…", "جارٍ الإنشاء…") : t("Create draft", "إنشاء مسودة")}
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("All budgets", "كل الميزانيات")}</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-muted-foreground text-sm p-4">{t("Loading…", "جارٍ التحميل…")}</div>
          ) : budgets.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground" data-testid="budgets-empty">
              <Target className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p>{t("No budgets yet. Create one for a fiscal year, add its lines, and submit it for approval.", "لا توجد ميزانيات بعد. أنشئ ميزانية لسنة مالية، وأضف بنودها، ثم قدّمها للاعتماد.")}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs">
                    {[t("Budget", "الميزانية"), t("Fiscal year", "السنة المالية"), t("Scenario", "السيناريو"), t("Approved", "المعتمد"), t("Open", "المفتوح")].map((h) => <th key={h} className="text-start pb-2 pe-4 font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {budgets.map((b: BudgetSummary) => {
                    const approved = b.versions.find((v) => v.id === b.approvedVersionId);
                    const openV = b.versions.find((v) => v.id === b.openVersionId);
                    return (
                      <tr key={b.id} className="border-b border-border/50 hover:bg-secondary/20" data-testid={`budget-row-${b.id}`}>
                        <td className="py-3 pe-4"><Link href={`/budgets/${b.id}`} className="font-medium hover:text-primary hover:underline">{n(b.name, b.nameAr)}</Link></td>
                        <td className="py-3 pe-4 text-xs text-muted-foreground whitespace-nowrap">{b.fiscalYear.label} · {fmtDate(b.fiscalYear.startDate)} – {fmtDate(b.fiscalYear.endDate)}</td>
                        <td className="py-3 pe-4 text-xs">{scenarioLabel(b.scenario, t)}</td>
                        <td className="py-3 pe-4 text-xs">{approved ? `v${approved.versionNo}` : "—"}</td>
                        <td className="py-3 pe-4 text-xs">{openV ? `v${openV.versionNo} · ${versionStatusLabel(openV.status, t)}` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
