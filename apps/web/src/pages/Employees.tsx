import { gosiContributoryWage, gosiPercentLabel, gosiRatesFor, type GosiRegime } from "@workspace/shared";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, UserCheck, Users, TrendingUp, Shield } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { ListPagination } from "@/components/ListPagination";
import { PAGE_SIZE, type Paged } from "@/lib/pagedList";
import { DualDate } from "@/components/DualDate";

import type { CreateEmployeeInput, Employee, EmployeeTotals, UpdateEmployeeInput } from "@workspace/api-client-react";
import { businessToday } from "@workspace/shared";

/** Request bodies go through the GENERATED input types (contract batch 4): a request the server does not accept is a compile error here. */
const json = { create: (b: CreateEmployeeInput) => JSON.stringify(b), update: (b: UpdateEmployeeInput) => JSON.stringify(b) };

/**
 * 🔴 GOSI (Phase 18, 2026-10-26): the Social Insurance law a SAUDI employee contributes under is the employer's
 * statement, from the employee's contribution history — never inferred from the hire date. Not stated = payroll
 * refuses to run for that employee (the server's rule; this page only lets the employer state it).
 */
type RegimeChoice = "" | "law_1421h" | "law_2024";
const REGIME_LABELS: Record<Exclude<RegimeChoice, "">, [string, string]> = {
  law_1421h: ["1421H law — contributed before 3 July 2024", "نظام 1421هـ — مشترك قبل 3 يوليو 2024"],
  law_2024: ["2024 law — no contribution before 3 July 2024", "نظام 2024 — لا اشتراك قبل 3 يوليو 2024"],
};

/** The page's preview for the current period, from the one GOSI table: null when it cannot be computed. */
function gosiPreview(nationality: string, regime: RegimeChoice, basic: number, housing: number) {
  const r: GosiRegime | null = nationality === "SA" ? (regime || null) : "non_saudi";
  const rates = r ? gosiRatesFor(r, businessToday().slice(0, 7)) : null;
  if (!rates) return null;
  const wage = gosiContributoryWage(basic, housing);
  return { wage, employeeRate: rates.employeeRate, employerRate: rates.employerRate, employee: wage * rates.employeeRate, employer: wage * rates.employerRate };
}


const emptyForm = { employeeNumber: `EMP-${Date.now().toString().slice(-5)}`, name: "", nameAr: "", nationalId: "", nationality: "SA", jobTitle: "", jobTitleAr: "", department: "", basicSalary: "", housingAllowance: "", transportAllowance: "", otherAllowances: "", iban: "", bank: "", joiningDate: businessToday(), status: "active", gosiRegime: "" as RegimeChoice, gosiRegimeBasis: "" };

export default function Employees() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [statusFilter, setStatusFilter] = useState("active");
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();

  const [page, setPage] = useState(0);
  const { data: paged, isLoading } = useQuery<Paged<Employee, EmployeeTotals>>({
    queryKey: ["employees", statusFilter, page],
    queryFn: () =>
      apiFetch(`/employees?status=${statusFilter}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`),
  });
  const employees = paged?.items ?? [];

  const createMut = useMutation({
    // 🔴 joiningDate is OPTIONAL and the input is clearable: the raw spread
    // sent "" and the server (rightly) refused it as not-a-date — the exact
    // Bills dueDate class, found by sweeping the spread-into-body shape.
    mutationFn: (body: typeof emptyForm) => apiFetch("/employees", { method: "POST", body: json.create({ ...body, joiningDate: body.joiningDate || undefined, basicSalary: Number(body.basicSalary), housingAllowance: Number(body.housingAllowance || 0), transportAllowance: Number(body.transportAllowance || 0), otherAllowances: Number(body.otherAllowances || 0), gosiRegime: body.nationality === "SA" && body.gosiRegime ? body.gosiRegime : null, gosiRegimeBasis: body.nationality === "SA" && body.gosiRegimeBasis.trim() ? body.gosiRegimeBasis.trim() : null }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["employees"] }); setOpen(false); setForm(emptyForm); toast({ title: t("Employee added", "تمت إضافة الموظف") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const f = (k: string) => (e: any) => setForm(p => ({ ...p, [k]: e.target?.value ?? e }));

  // GOSI (Phase 18): state an existing Saudi employee's law from the table.
  const regimeMut = useMutation({
    mutationFn: (v: { id: number; gosiRegime: RegimeChoice }) => apiFetch(`/employees/${v.id}`, { method: "PATCH", body: json.update({ gosiRegime: v.gosiRegime || null }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["employees"] }); toast({ title: t("GOSI law saved", "تم حفظ نظام التأمينات") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });
  const preview = gosiPreview(form.nationality, form.gosiRegime, Number(form.basicSalary || 0), Number(form.housingAllowance || 0));
  const unstated = paged?.totals.gosiUnstatedCount ?? 0;

  // From the server, over every matching employee — never over the page.
  const totalPayroll = paged?.totals.grossSalary ?? 0;
  const totalGOSIEr = paged?.totals.gosiEmployer ?? 0;
  const saudiCount = paged?.totals.saudiCount ?? 0;
  const headcount = paged?.page.total ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Employees", "الموظفون")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("HR register · GOSI calculated under the Social Insurance Law", "سجل الموارد البشرية · يُحسب التأمين الاجتماعي وفق نظام التأمينات الاجتماعية")}</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> {t("Add Employee", "إضافة موظف")}</Button></DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader><DialogTitle>{t("New Employee", "موظف جديد")}</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3 mt-2">
              {([["employeeNumber",t("Employee #","رقم الموظف")],["name",t("Full Name *","الاسم الكامل *")],["nameAr","الاسم بالعربي"],["nationalId",t("National ID / Iqama","رقم الهوية / الإقامة")],["jobTitle",t("Job Title","المسمى الوظيفي")],["jobTitleAr","المسمى الوظيفي"],["department",t("Department","القسم")],["iban","IBAN"],["bank",t("Bank","البنك")],["joiningDate",t("Joining Date","تاريخ الالتحاق")]] as [string,string][]).map(([k,l])=>(
                <div key={k} className={["iban","bank"].includes(k)?"col-span-2":""}>
                  <Label className="text-xs text-muted-foreground">{l}</Label>
                  <Input value={(form as any)[k]} onChange={f(k)} className="mt-1 h-8 text-sm" type={k==="joiningDate"?"date":"text"} />
                </div>
              ))}
              <div><Label className="text-xs text-muted-foreground">{t("Nationality", "الجنسية")}</Label>
                <Select value={form.nationality} onValueChange={v=>setForm(p=>({...p,nationality:v}))}><SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="SA">{t("Saudi (SA)", "سعودي (SA)")}</SelectItem><SelectItem value="EX">{t("Expatriate", "وافد")}</SelectItem></SelectContent></Select>
              </div>
              <div><Label className="text-xs text-muted-foreground">{t("Status", "الحالة")}</Label>
                <Select value={form.status} onValueChange={v=>setForm(p=>({...p,status:v}))}><SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger><SelectContent>{["active","inactive"].map(s=><SelectItem key={s} value={s}>{s === "active" ? t("active","نشط") : t("inactive","غير نشط")}</SelectItem>)}</SelectContent></Select>
              </div>
              {form.nationality === "SA" && (
                <>
                  <div><Label className="text-xs text-muted-foreground">{t("GOSI law", "نظام التأمينات")}</Label>
                    <Select value={form.gosiRegime || "unstated"} onValueChange={v=>setForm(p=>({...p,gosiRegime:(v === "unstated" ? "" : v) as RegimeChoice}))}><SelectTrigger className="mt-1 h-8 text-sm" data-testid="employee-gosi-regime"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="unstated">{t("Not stated yet", "لم يُحدَّد بعد")}</SelectItem>{(Object.keys(REGIME_LABELS) as Array<keyof typeof REGIME_LABELS>).map(r=><SelectItem key={r} value={r}>{t(...REGIME_LABELS[r])}</SelectItem>)}</SelectContent></Select>
                  </div>
                  <div><Label className="text-xs text-muted-foreground">{t("Basis (e.g. GOSI certificate)", "المستند (مثل شهادة التأمينات)")}</Label><Input value={form.gosiRegimeBasis} onChange={f("gosiRegimeBasis")} className="mt-1 h-8 text-sm" /></div>
                  <p className="col-span-2 text-xs text-muted-foreground">{t("State it from the employee's GOSI contribution history, not the hire date. Payroll will not run for a Saudi employee whose law is not stated.", "حدّده من سجل اشتراكات الموظف في التأمينات، لا من تاريخ التعيين. لا يُنشأ مسير الرواتب لموظف سعودي لم يُحدَّد نظامه.")}</p>
                </>
              )}
              <div className="col-span-2 border-t border-border pt-3"><p className="text-xs text-muted-foreground uppercase tracking-wide mb-2 font-medium">{t("Compensation (SAR)", "المكافآت (ر.س)")}</p></div>
              {([["basicSalary",t("Basic Salary *","الراتب الأساسي *")],["housingAllowance",t("Housing Allowance","بدل السكن")],["transportAllowance",t("Transport Allowance","بدل النقل")],["otherAllowances",t("Other Allowances","بدلات أخرى")]] as [string,string][]).map(([k,l])=>(
                <div key={k}><Label className="text-xs text-muted-foreground">{l}</Label><Input type="number" value={(form as any)[k]} onChange={f(k)} className="mt-1 h-8 text-sm font-mono" /></div>
              ))}
              {form.basicSalary && (
                <div className="col-span-2 bg-secondary/30 rounded-lg p-3 text-xs space-y-1">
                  <p className="font-medium text-muted-foreground">{t("GOSI Preview", "معاينة التأمين الاجتماعي")} ({form.nationality === "SA" ? t("Saudi", "سعودي") : t("Expat", "وافد")})</p>
                  {preview ? (
                    <>
                      <div className="flex justify-between"><span className="text-muted-foreground">{t("Contributory wage (basic + housing, up to 45,000)", "الأجر الخاضع (الأساسي + السكن، حتى 45,000)")}</span><span className="font-mono">{fmtNum(preview.wage)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">{t("Employee contribution", "مساهمة الموظف")} ({gosiPercentLabel(preview.employeeRate)})</span><span className="font-mono text-attention">{fmtNum(preview.employee)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">{t("Employer contribution", "مساهمة صاحب العمل")} ({gosiPercentLabel(preview.employerRate)})</span><span className="font-mono text-attention">{fmtNum(preview.employer)}</span></div>
                    </>
                  ) : (
                    <p className="text-muted-foreground">{t("State the employee's GOSI law to see the contribution.", "حدّد نظام التأمينات للموظف لعرض الاشتراك.")}</p>
                  )}
                </div>
              )}
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.name||!form.basicSalary||createMut.isPending}>{createMut.isPending ? t("Adding...", "جارٍ الإضافة...") : t("Add Employee", "إضافة موظف")}</Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[[t("Headcount","إجمالي الموظفين"), headcount, "text-primary"],[t("Saudi Nationals","المواطنون السعوديون"), `${saudiCount} / ${headcount}`, "text-attention"],[t("Monthly Payroll","الرواتب الشهرية"), fmtNum(totalPayroll), "text-foreground"],[t("Monthly GOSI (Employer)","التأمين الاجتماعي الشهري (صاحب العمل)"), fmtNum(totalGOSIEr), "text-negative"]].map(([l,v,c])=>(
          <Card key={String(l)} className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-xl font-bold font-mono ${c}`}>{v}</div></CardContent></Card>
        ))}
      </div>

      {unstated > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="employees-gosi-unstated">{t(`${unstated} Saudi employee(s) have no GOSI law stated, so they are left out of the GOSI total, and payroll will not run until each one is set (the GOSI law column below).`, `لم يُحدَّد نظام التأمينات لـ ${unstated} من الموظفين السعوديين، فلم يُحتسبوا في إجمالي التأمينات، ولن يُنشأ مسير الرواتب حتى يُحدَّد لكل منهم (عمود نظام التأمينات أدناه).`)}</p>
      )}

      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="flex gap-2">
            {["active","inactive","terminated"].map(s=>(<Button key={s} variant={statusFilter===s?"default":"ghost"} size="sm" className="h-7 text-xs capitalize" onClick={()=>setStatusFilter(s)}>{s === "active" ? t("active","نشط") : s === "inactive" ? t("inactive","غير نشط") : t("terminated","منتهي الخدمة")}</Button>))}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Loading...", "جارٍ التحميل...")}</div> : employees.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><Users className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>{t("No employees found.", "لا يوجد موظفون.")}</p></div>
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{[t("Employee","الموظف"),t("Department","القسم"),t("Nationality","الجنسية"),t("Basic Salary","الراتب الأساسي"),t("Gross","الإجمالي"),t("GOSI law","نظام التأمينات"),t("GOSI Emp","تأمين الموظف"),t("GOSI Er","تأمين صاحب العمل"),t("Join Date","تاريخ الالتحاق"),t("Status","الحالة")].map(h=><th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>)}</tr></thead>
              <tbody>{employees.map(e=>(
                <tr key={e.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="py-3 pe-3"><div className="font-medium">{e.name}</div><div className="text-xs text-muted-foreground font-mono">{e.employeeNumber}</div></td>
                  <td className="py-3 pe-3 text-muted-foreground text-xs">{e.department||"—"}</td>
                  <td className="py-3 pe-3"><Badge variant="outline" className={`text-xs ${e.nationality==="SA"?"border-primary/40 text-primary":"border-info-surface/40 text-info"}`}>{e.nationality==="SA" ? t("🇸🇦 Saudi","🇸🇦 سعودي") : t("Expat","وافد")}</Badge></td>
                  <td className="py-3 pe-3 font-mono text-sm">{fmtNum(e.basicSalary)}</td>
                  <td className="py-3 pe-3 font-mono text-sm font-semibold">{fmtNum(e.grossSalary)}</td>
                  <td className="py-3 pe-3 text-xs">{e.nationality === "SA" ? (
                    <Select value={e.gosiRegime ?? "unstated"} onValueChange={v => regimeMut.mutate({ id: e.id, gosiRegime: (v === "unstated" ? "" : v) as RegimeChoice })}>
                      <SelectTrigger className="h-7 text-xs w-44" data-testid={`employee-gosi-regime-${e.id}`}><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="unstated">{t("Not stated", "غير محدَّد")}</SelectItem>{(Object.keys(REGIME_LABELS) as Array<keyof typeof REGIME_LABELS>).map(r=><SelectItem key={r} value={r}>{t(...REGIME_LABELS[r])}</SelectItem>)}</SelectContent>
                    </Select>
                  ) : <span className="text-muted-foreground">—</span>}</td>
                  <td className="py-3 pe-3 font-mono text-xs text-attention">{e.gosiEmployee == null ? "—" : fmtNum(e.gosiEmployee)}</td>
                  <td className="py-3 pe-3 font-mono text-xs text-negative">{e.gosiEmployer == null ? "—" : fmtNum(e.gosiEmployer)}</td>
                  <td className="py-3 pe-3 text-xs text-muted-foreground"><DualDate date={e.joiningDate} /></td>
                  <td className="py-3"><Badge className={`text-xs ${e.status==="active"?"bg-positive-surface/20 text-positive":"bg-secondary text-muted-foreground"}`}>{e.status === "active" ? t("active","نشط") : e.status === "inactive" ? t("inactive","غير نشط") : t("terminated","منتهي الخدمة")}</Badge></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
                  <ListPagination
            page={paged?.page}
            shown={employees.length}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
