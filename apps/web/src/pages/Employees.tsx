import { GOSI_RATES, gosiPercentLabel } from "@workspace/shared";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel, FilterTabs, EmptyState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { ListPagination } from "@/components/ListPagination";
import { PAGE_SIZE, type Paged } from "@/lib/pagedList";
import { DualDate } from "@/components/DualDate";

import type { CreateEmployeeInput, Employee, EmployeeTotals } from "@workspace/api-client-react";
import { businessToday } from "@workspace/shared";

/** Request bodies go through the GENERATED input types (contract batch 4): a request the server does not accept is a compile error here. */
const json = { create: (b: CreateEmployeeInput) => JSON.stringify(b) };


const emptyForm = { employeeNumber: `EMP-${Date.now().toString().slice(-5)}`, name: "", nameAr: "", nationalId: "", nationality: "SA", jobTitle: "", jobTitleAr: "", department: "", basicSalary: "", housingAllowance: "", transportAllowance: "", otherAllowances: "", iban: "", bank: "", joiningDate: businessToday(), status: "active" };

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
    mutationFn: (body: typeof emptyForm) => apiFetch("/employees", { method: "POST", body: json.create({ ...body, joiningDate: body.joiningDate || undefined, basicSalary: Number(body.basicSalary), housingAllowance: Number(body.housingAllowance || 0), transportAllowance: Number(body.transportAllowance || 0), otherAllowances: Number(body.otherAllowances || 0) }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["employees"] }); setOpen(false); setForm(emptyForm); toast({ title: t("Employee added", "تمت إضافة الموظف") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const f = (k: string) => (e: any) => setForm(p => ({ ...p, [k]: e.target?.value ?? e }));

  // From the server, over every matching employee — never over the page.
  const totalPayroll = paged?.totals.grossSalary ?? 0;
  const totalGOSIEr = paged?.totals.gosiEmployer ?? 0;
  const saudiCount = paged?.totals.saudiCount ?? 0;
  const headcount = paged?.page.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("Employees", "الموظفون")}
        description={t("HR register · GOSI auto-calculated per Saudi Labour Law", "سجل الموارد البشرية · يُحسب التأمين الاجتماعي تلقائيًا وفق نظام العمل السعودي")}
        actions={
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
              <div className="col-span-2 border-t border-border pt-3"><p className="text-xs text-muted-foreground mb-2 font-medium">{t("Compensation (SAR)", "المكافآت (ر.س)")}</p></div>
              {([["basicSalary",t("Basic Salary *","الراتب الأساسي *")],["housingAllowance",t("Housing Allowance","بدل السكن")],["transportAllowance",t("Transport Allowance","بدل النقل")],["otherAllowances",t("Other Allowances","بدلات أخرى")]] as [string,string][]).map(([k,l])=>(
                <div key={k}><Label className="text-xs text-muted-foreground">{l}</Label><Input type="number" value={(form as any)[k]} onChange={f(k)} className="mt-1 h-8 text-sm font-mono" /></div>
              ))}
              {form.basicSalary && (
                <div className="col-span-2 bg-secondary/30 rounded-lg p-3 text-xs space-y-1">
                  <p className="font-medium text-muted-foreground">{t("GOSI Preview", "معاينة التأمين الاجتماعي")} ({form.nationality === "SA" ? t("Saudi", "سعودي") : t("Expat", "وافد")})</p>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t("Employee contribution", "مساهمة الموظف")} ({form.nationality==="SA"?gosiPercentLabel(GOSI_RATES.saudiEmployee):"0%"})</span><span className="font-mono text-attention">{fmtNum(Number(form.basicSalary)*(form.nationality==="SA"?GOSI_RATES.saudiEmployee:0))}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t("Employer contribution", "مساهمة صاحب العمل")} ({gosiPercentLabel(form.nationality==="SA"?GOSI_RATES.saudiEmployer:GOSI_RATES.nonSaudiEmployer)})</span><span className="font-mono text-attention">{fmtNum(Number(form.basicSalary)*(form.nationality==="SA"?GOSI_RATES.saudiEmployer:GOSI_RATES.nonSaudiEmployer))}</span></div>
                </div>
              )}
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.name||!form.basicSalary||createMut.isPending}>{createMut.isPending ? t("Adding...", "جارٍ الإضافة...") : t("Add Employee", "إضافة موظف")}</Button>
          </DialogContent>
        </Dialog>
        }
      />

      <StatStrip cols={4}>
        <Stat label={t("Headcount","إجمالي الموظفين")} value={headcount} />
        <Stat label={t("Saudi Nationals","المواطنون السعوديون")} value={`${saudiCount} / ${headcount}`} />
        <Stat label={t("Monthly Payroll","الرواتب الشهرية")} value={fmtNum(totalPayroll)} />
        <Stat label={t("Monthly GOSI (Employer)","التأمين الاجتماعي الشهري (صاحب العمل)")} value={fmtNum(totalGOSIEr)} tone="negative" />
      </StatStrip>

      <Panel flush>
        <FilterTabs
          options={["active","inactive","terminated"].map(s => ({ value: s, label: s === "active" ? t("active","نشط") : s === "inactive" ? t("inactive","غير نشط") : t("terminated","منتهي الخدمة") }))}
          value={statusFilter}
          onChange={setStatusFilter}
          className="[&_button]:capitalize"
        />
          {isLoading ? <div className="text-muted-foreground text-sm p-5">{t("Loading...", "جارٍ التحميل...")}</div> : employees.length === 0 ? (
            <EmptyState icon={Users} title={t("No employees found.", "لا يوجد موظفون.")} />
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="border-b border-border">{([[t("Employee","الموظف"),false],[t("Department","القسم"),false],[t("Nationality","الجنسية"),false],[t("Basic Salary","الراتب الأساسي"),true],[t("Gross","الإجمالي"),true],[t("GOSI Emp","تأمين الموظف"),true],[t("GOSI Er","تأمين صاحب العمل"),true],[t("Join Date","تاريخ الالتحاق"),false],[t("Status","الحالة"),false]] as const).map(([h,num])=><th key={h} className={`${num ? "text-end" : "text-start"} px-3`}>{h}</th>)}</tr></thead>
              <tbody>{employees.map(e=>(
                <tr key={e.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors">
                  <td className="py-3 px-3"><div className="font-medium">{e.name}</div><div className="text-[12px] text-muted-foreground">{e.employeeNumber}</div></td>
                  <td className="py-3 px-3 text-muted-foreground text-[13px]">{e.department||"—"}</td>
                  <td className="py-3 px-3"><Badge variant="outline" className={`text-xs ${e.nationality==="SA"?"border-primary/40 text-primary":"border-info-surface/40 text-info"}`}>{e.nationality==="SA" ? t("🇸🇦 Saudi","🇸🇦 سعودي") : t("Expat","وافد")}</Badge></td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(e.basicSalary)}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums font-semibold">{fmtNum(e.grossSalary)}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{fmtNum(e.gosiEmployee)}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{fmtNum(e.gosiEmployer)}</td>
                  <td className="py-3 px-3 text-[13px] text-muted-foreground whitespace-nowrap"><DualDate date={e.joiningDate} /></td>
                  <td className="py-3 px-3"><Badge className={`text-xs capitalize ${e.status==="active"?"bg-positive-surface/20 text-positive":"bg-secondary text-muted-foreground"}`}>{e.status === "active" ? t("active","نشط") : e.status === "inactive" ? t("inactive","غير نشط") : t("terminated","منتهي الخدمة")}</Badge></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          <div className="border-t border-border px-5 pb-3 empty:hidden">
            <ListPagination
              page={paged?.page}
              shown={employees.length}
              onPrev={() => setPage((p) => Math.max(0, p - 1))}
              onNext={() => setPage((p) => p + 1)}
            />
          </div>
      </Panel>
    </div>
  );
}
