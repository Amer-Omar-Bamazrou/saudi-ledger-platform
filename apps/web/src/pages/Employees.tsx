import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Users, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { ListPagination } from "@/components/ListPagination";
import { PAGE_SIZE, type Paged } from "@/lib/pagedList";
import { DualDate } from "@/components/DualDate";
import { PayNotSet, Withheld } from "@/components/Withheld";
import {
  EmployeeForm, HOUSING_LABELS, REGIME_LABELS, STATUSES, housingFlags, housingOf, statusLabel,
  type HousingChoice, type RegimeChoice,
} from "@/components/employees/EmployeeForm";

import type { Employee, EmployeeTotals, FieldAccess, UpdateEmployeeInput } from "@workspace/api-client-react";

/** Request bodies go through the GENERATED input types (contract batch 4): a request the server does not accept is a compile error here. */
const json = { update: (b: UpdateEmployeeInput) => JSON.stringify(b) };

/**
 * 🔴 GOSI (Phase 18, 2026-10-26): the Social Insurance law a SAUDI employee contributes under is the employer's
 * statement, from the employee's contribution history — never inferred from the hire date. Not stated = payroll
 * refuses to run for that employee (the server's rule; this page only lets the employer state it).
 *
 * 🔴 19B S2a (v4 §10, D8 O2): what this page offers and shows follows the server's answer for THIS role
 * (`GET /employees/field-access`): a field the role may not read is marked withheld, never blank; an employee without
 * pay shows "pay not set"; the edit form offers only the fields the role may write.
 */
export default function Employees() {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [statusFilter, setStatusFilter] = useState("active");
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();

  const { data: access } = useQuery<FieldAccess>({ queryKey: ["employees", "field-access"], queryFn: () => apiFetch("/employees/field-access") });
  const can = (f: string) => access?.fields[f]?.write === true;
  const readable = (f: string) => (access?.fields[f]?.read ?? "read") !== "none";
  const cls = (f: string) => access?.fields[f]?.class;

  const [page, setPage] = useState(0);
  const { data: paged, isLoading } = useQuery<Paged<Employee, EmployeeTotals>>({
    queryKey: ["employees", statusFilter, page],
    queryFn: () =>
      apiFetch(`/employees?status=${statusFilter}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`),
  });
  const employees = paged?.items ?? [];

  // GOSI (Phase 18): state an existing Saudi employee's law from the table (compensation: accountant and admin).
  const regimeMut = useMutation({
    mutationFn: (v: { id: number; gosiRegime: RegimeChoice }) => apiFetch(`/employees/${v.id}`, { method: "PATCH", body: json.update({ gosiRegime: v.gosiRegime || null }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["employees"] }); toast({ title: t("GOSI law saved", "تم حفظ نظام التأمينات") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });
  // GO-13: how an employee's housing counts for GOSI, from the table.
  const housingMut = useMutation({
    mutationFn: (v: { id: number; housing: HousingChoice }) => apiFetch(`/employees/${v.id}`, { method: "PATCH", body: json.update(housingFlags(v.housing)) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["employees"] }); toast({ title: t("GOSI housing saved", "تم حفظ السكن في التأمينات") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });
  const unstated = paged?.totals.gosiUnstatedCount ?? 0;
  const payNotSetCount = paged?.totals.payNotSetCount ?? 0;

  // From the server, over every matching employee — never over the page.
  const totalPayroll = paged?.totals.grossSalary ?? 0;
  const totalGOSIEr = paged?.totals.gosiEmployer ?? 0;
  const saudiCount = paged?.totals.saudiCount ?? 0;
  const headcount = paged?.page.total ?? 0;
  const canEdit = !!access && Object.values(access.fields).some((f) => f.write);

  /**
   * A money cell: pay not set (a STANDARD flag — every role sees it, one that cannot read pay included, v4 §10.1),
   * else withheld (the role cannot read pay), else the figure.
   */
  const money = (e: Employee, f: "basicSalary" | "grossSalary", bold = false) =>
    e.payNotSet ? <PayNotSet testId={`employee-pay-not-set-${e.id}`} />
      : !readable(f) ? <Withheld cls={cls(f)} testId={`withheld-${f}-${e.id}`} />
      : <span className={bold ? "font-semibold" : ""}>{fmtNum(e[f] ?? 0)}</span>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Employees", "الموظفون")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("HR register · GOSI calculated under the Social Insurance Law", "سجل الموارد البشرية · يُحسب التأمين الاجتماعي وفق نظام التأمينات الاجتماعية")}</p>
        </div>
        <Button className="gap-2" onClick={() => setCreateOpen(true)} data-testid="employee-add"><Plus className="w-4 h-4" /> {t("Add Employee", "إضافة موظف")}</Button>
      </div>
      <EmployeeForm mode="create" access={access} open={createOpen} onOpenChange={setCreateOpen} />
      {editing && <EmployeeForm mode="edit" employee={editing} access={access} open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }} />}

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        {[[t("Headcount","إجمالي الموظفين"), headcount, "text-primary"],[t("Saudi Nationals","المواطنون السعوديون"), `${saudiCount} / ${headcount}`, "text-attention"],[t("Monthly Payroll","الرواتب الشهرية"), fmtNum(totalPayroll), "text-foreground"],[t("Monthly GOSI (Employer)","التأمين الاجتماعي الشهري (صاحب العمل)"), fmtNum(totalGOSIEr), "text-negative"]].map(([l,v,c])=>(
          <Card key={String(l)} className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-xl font-bold font-mono ${c}`}>{v}</div></CardContent></Card>
        ))}
      </div>

      {payNotSetCount > 0 && (
        <p className="text-sm text-attention" data-testid="employees-pay-not-set">{t(`${payNotSetCount} employee(s) have no pay set. They are not in the totals above, and payroll leaves them out, by name, until an accountant or admin sets their pay.`, `${payNotSetCount} من الموظفين لم يُحدَّد راتبهم، فليسوا في الإجماليات أعلاه، ويستبعدهم مسير الرواتب بأسمائهم حتى يحدّد المحاسب أو المسؤول رواتبهم.`)}</p>
      )}
      {unstated > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="employees-gosi-unstated">{t(`${unstated} Saudi employee(s) have no GOSI law stated, so they are left out of the GOSI total, and payroll will not run until each one is set (the GOSI law column below).`, `لم يُحدَّد نظام التأمينات لـ ${unstated} من الموظفين السعوديين، فلم يُحتسبوا في إجمالي التأمينات، ولن يُنشأ مسير الرواتب حتى يُحدَّد لكل منهم (عمود نظام التأمينات أدناه).`)}</p>
      )}

      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap gap-2">
            {STATUSES.map(s=>(<Button key={s} variant={statusFilter===s?"default":"ghost"} size="sm" className="h-7 text-xs capitalize" onClick={()=>setStatusFilter(s)}>{statusLabel(s, t)}</Button>))}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Loading...", "جارٍ التحميل...")}</div> : employees.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><Users className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>{t("No employees found.", "لا يوجد موظفون.")}</p></div>
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{[t("Employee","الموظف"),t("Department","القسم"),t("Nationality","الجنسية"),t("Basic Salary","الراتب الأساسي"),t("Gross","الإجمالي"),t("GOSI law","نظام التأمينات"),t("GOSI Emp","تأمين الموظف"),t("GOSI Er","تأمين صاحب العمل"),t("Join Date","تاريخ الالتحاق"),t("End Date","تاريخ انتهاء الخدمة"),t("Status","الحالة"),""].map((h, i)=><th key={`${h}-${i}`} className="text-start pb-2 pe-3 font-medium">{h}</th>)}</tr></thead>
              <tbody>{employees.map(e=>(
                <tr key={e.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors" data-testid={`employee-row-${e.id}`}>
                  <td className="py-3 pe-3"><div className="font-medium">{e.name}</div><div className="text-xs text-muted-foreground font-mono">{e.employeeNumber}</div>{e.jobTitle && <div className="text-xs text-muted-foreground">{e.jobTitle}</div>}</td>
                  <td className="py-3 pe-3 text-muted-foreground text-xs">{e.department||"—"}</td>
                  <td className="py-3 pe-3">{!readable("nationality") ? <Withheld cls={cls("nationality")} testId={`withheld-nationality-${e.id}`} /> : <Badge variant="outline" className={`text-xs ${e.nationality==="SA"?"border-primary/40 text-primary":"border-info-surface/40 text-info"}`}>{e.nationality==="SA" ? t("🇸🇦 Saudi","🇸🇦 سعودي") : t("Expat","وافد")}</Badge>}</td>
                  <td className="py-3 pe-3 font-mono text-sm">{money(e, "basicSalary")}</td>
                  <td className="py-3 pe-3 font-mono text-sm">{money(e, "grossSalary", true)}</td>
                  <td className="py-3 pe-3 text-xs space-y-1">{!readable("gosiRegime") ? <Withheld cls={cls("gosiRegime")} testId={`withheld-gosiRegime-${e.id}`} /> : (
                    <>
                      {e.nationality !== "SA" ? <span className="text-muted-foreground">—</span> : can("gosiRegime") ? (
                        <Select value={e.gosiRegime ?? "unstated"} onValueChange={v => regimeMut.mutate({ id: e.id, gosiRegime: (v === "unstated" ? "" : v) as RegimeChoice })}>
                          <SelectTrigger className="h-7 text-xs w-44" data-testid={`employee-gosi-regime-${e.id}`}><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="unstated">{t("Not stated", "غير محدَّد")}</SelectItem>{(Object.keys(REGIME_LABELS) as Array<keyof typeof REGIME_LABELS>).map(r=><SelectItem key={r} value={r}>{t(...REGIME_LABELS[r])}</SelectItem>)}</SelectContent>
                        </Select>
                      ) : <span>{e.gosiRegime ? t(...REGIME_LABELS[e.gosiRegime as keyof typeof REGIME_LABELS]) : t("Not stated", "غير محدَّد")}</span>}
                      {can("gosiInKindHousing") ? (
                        <Select value={housingOf(e)} onValueChange={v => housingMut.mutate({ id: e.id, housing: v as HousingChoice })}>
                          <SelectTrigger className="h-7 text-xs w-44" data-testid={`employee-gosi-housing-${e.id}`}><SelectValue /></SelectTrigger>
                          <SelectContent>{(Object.keys(HOUSING_LABELS) as HousingChoice[]).map(h=><SelectItem key={h} value={h}>{t(...HOUSING_LABELS[h])}</SelectItem>)}</SelectContent>
                        </Select>
                      ) : <div>{t(...HOUSING_LABELS[housingOf(e)])}</div>}
                    </>
                  )}</td>
                  <td className="py-3 pe-3 font-mono text-xs text-attention">{!readable("gosiEmployee") ? <Withheld cls={cls("gosiEmployee")} /> : e.gosiEmployee == null ? "—" : fmtNum(e.gosiEmployee)}</td>
                  <td className="py-3 pe-3 font-mono text-xs text-negative">{!readable("gosiEmployer") ? <Withheld cls={cls("gosiEmployer")} /> : e.gosiEmployer == null ? "—" : fmtNum(e.gosiEmployer)}</td>
                  <td className="py-3 pe-3 text-xs text-muted-foreground"><DualDate date={e.joiningDate} /></td>
                  <td className="py-3 pe-3 text-xs text-muted-foreground" data-testid={`employee-end-date-${e.id}`}>{e.endDate ? <DualDate date={e.endDate} /> : "—"}</td>
                  <td className="py-3 pe-3"><Badge className={`text-xs ${e.status==="active"?"bg-positive-surface/20 text-positive":"bg-secondary text-muted-foreground"}`} data-testid={`employee-status-${e.id}`}>{statusLabel(e.status, t)}</Badge></td>
                  <td className="py-3">{canEdit && <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" data-testid={`employee-edit-${e.id}`} onClick={() => setEditing(e)}><Pencil className="w-3 h-3" />{t("Edit", "تعديل")}</Button>}</td>
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
