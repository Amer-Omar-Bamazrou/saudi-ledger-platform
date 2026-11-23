/**
 * 🔴 19B S2a (v4 §10, D8 O2; owner 2026-11-22) — ONE form for creating and EDITING an employee.
 *
 * Until now an employee could not be changed after creation (the page had no edit form): a raise, a departure, or the
 * pay of an employee a bookkeeper created without it could not be recorded. This form edits every field — but only the
 * fields THIS role may write, as the server says (`GET /employees/field-access`, from the one class table and the one
 * matrix): an accountant or admin edits pay, status, nationality, the joining and end dates and GOSI; a bookkeeper,
 * under O2, the name, number, job, department, the national ID (written, never read back) and the IBAN (its last four
 * digits shown). A field the role may not write is not offered; a field it may write but not read starts empty and is
 * sent only when typed. An edit sends ONLY the fields that changed — a withheld value is never sent back as blank.
 * The server refuses anything else by name (field_write_not_granted); this form is not the boundary.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { gosiContributoryWage, gosiInKindHousingValue, gosiLineAmounts, gosiPercentLabel, gosiRatesFor, businessToday, type GosiRegime } from "@workspace/shared";
import type { CreateEmployeeInput, Employee, FieldAccess, UpdateEmployeeInput } from "@workspace/api-client-react";
import { apiFetch, fmtNum } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { ibanSaveNotice } from "@/components/PartyIbanLine";

export type RegimeChoice = "" | "law_1421h" | "law_2024";
export const REGIME_LABELS: Record<Exclude<RegimeChoice, "">, [string, string]> = {
  law_1421h: ["1421H law — contributed before 3 July 2024", "نظام 1421هـ — مشترك قبل 3 يوليو 2024"],
  law_2024: ["2024 law — no contribution before 3 July 2024", "نظام 2024 — لا اشتراك قبل 3 يوليو 2024"],
};
export type HousingChoice = "cash" | "in_kind" | "in_kind_exempt";
export const HOUSING_LABELS: Record<HousingChoice, [string, string]> = {
  cash: ["Housing: cash allowance or none", "السكن: بدل نقدي أو لا يوجد"],
  in_kind: ["Housing in kind (GOSI: basic × 2 ÷ 12 a month)", "سكن عيني (التأمينات: الأساسي × 2 ÷ 12 شهرياً)"],
  in_kind_exempt: ["Housing in kind, exempted by GOSI", "سكن عيني معفى من التأمينات"],
};
export const housingOf = (e: { gosiInKindHousing?: boolean; gosiInKindHousingExempt?: boolean }): HousingChoice =>
  !e.gosiInKindHousing ? "cash" : e.gosiInKindHousingExempt ? "in_kind_exempt" : "in_kind";
export const housingFlags = (h: HousingChoice) => ({ gosiInKindHousing: h !== "cash", gosiInKindHousingExempt: h === "in_kind_exempt" });
export const STATUSES = ["active", "inactive", "terminated"] as const;
export const statusLabel = (s: string, t: (en: string, ar: string) => string) =>
  s === "active" ? t("active", "نشط") : s === "inactive" ? t("inactive", "غير نشط") : t("terminated", "منتهي الخدمة");

/** The page's preview for the current period, from the one GOSI table and its rules: null when it cannot be computed. */
function gosiPreview(nationality: string, regime: RegimeChoice, basic: number, housing: number, housingChoice: HousingChoice) {
  const r: GosiRegime | null = nationality === "SA" ? (regime || null) : "non_saudi";
  const rates = r ? gosiRatesFor(r, businessToday().slice(0, 7)) : null;
  if (!rates) return null;
  const inKind = housingChoice === "in_kind" ? Math.round(gosiInKindHousingValue(basic) * 100) / 100 : 0;
  const wage = gosiContributoryWage(basic, housing, inKind);
  const a = gosiLineAmounts({ rates, wage });
  return { wage, inKind, pensionFloorWage: a.pensionFloorWage, employeeRate: rates.employeeRate, employerRate: rates.employerRate, employee: a.employee, employer: a.employer };
}

type Text = "employeeNumber" | "name" | "nameAr" | "jobTitle" | "jobTitleAr" | "department" | "nationalId" | "gosiNumber" | "iban" | "bank" | "joiningDate" | "endDate" | "gosiRegimeBasis" | "notes";
type Money = "basicSalary" | "housingAllowance" | "transportAllowance" | "otherAllowances";
type Form = Record<Text | Money | "nationality" | "status", string> & { gosiRegime: RegimeChoice; housing: HousingChoice };

const NUMBERS: Money[] = ["basicSalary", "housingAllowance", "transportAllowance", "otherAllowances"];
const blankForm = (): Form => ({
  employeeNumber: `EMP-${Date.now().toString().slice(-5)}`, name: "", nameAr: "", jobTitle: "", jobTitleAr: "", department: "",
  nationalId: "", gosiNumber: "", iban: "", bank: "", joiningDate: businessToday(), endDate: "", gosiRegimeBasis: "", notes: "",
  basicSalary: "", housingAllowance: "", transportAllowance: "", otherAllowances: "", nationality: "SA", status: "active",
  gosiRegime: "", housing: "cash",
});
/** The form's starting values from an employee: a withheld field (absent) or a partly shown IBAN starts EMPTY. */
function formOf(e: Employee, access: FieldAccess | undefined): Form {
  const s = (v: unknown) => (v == null ? "" : String(v));
  const readable = (f: string) => (access?.fields[f]?.read ?? "read") === "read";
  return {
    employeeNumber: s(e.employeeNumber), name: s(e.name), nameAr: s(e.nameAr), jobTitle: s(e.jobTitle), jobTitleAr: s(e.jobTitleAr), department: s(e.department),
    nationalId: readable("nationalId") ? s(e.nationalId) : "", gosiNumber: readable("gosiNumber") ? s(e.gosiNumber) : "",
    iban: readable("iban") ? s(e.iban) : "", bank: readable("bank") ? s(e.bank) : "",
    joiningDate: s(e.joiningDate), endDate: s(e.endDate), gosiRegimeBasis: s(e.gosiRegimeBasis), notes: s(e.notes),
    basicSalary: s(e.basicSalary), housingAllowance: s(e.housingAllowance), transportAllowance: s(e.transportAllowance), otherAllowances: s(e.otherAllowances),
    nationality: s(e.nationality) || "SA", status: s(e.status) || "active", gosiRegime: (e.gosiRegime ?? "") as RegimeChoice, housing: housingOf(e),
  };
}

export function EmployeeForm({ mode, employee, access, open, onOpenChange }: {
  mode: "create" | "edit"; employee?: Employee; access: FieldAccess | undefined; open: boolean; onOpenChange: (o: boolean) => void;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const initial = useMemo(() => (mode === "edit" && employee ? formOf(employee, access) : blankForm()), [mode, employee, access]);
  const [form, setForm] = useState<Form>(initial);
  useEffect(() => { if (open) setForm(initial); }, [open, initial]);
  const set = (k: keyof Form) => (v: string) => setForm((p) => ({ ...p, [k]: v }));

  const can = (f: string) => access?.fields[f]?.write === true;
  const read = (f: string) => access?.fields[f]?.read ?? "read";
  /** Write-only here: the role may write the field but not read it back (the national ID for a bookkeeper; an IBAN shown in part). */
  const blind = (f: string) => mode === "edit" && can(f) && read(f) !== "read";

  /** The body: on create every offered field with a value; on edit ONLY what changed (a blind field only when typed). */
  function body(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const text = (f: Text) => {
      if (!can(f)) return;
      const v = form[f].trim();
      if (mode === "create") { if (v) out[f] = v; return; }
      if (blind(f)) { if (v) out[f] = v; return; }
      if (v !== initial[f].trim()) out[f] = v === "" ? null : v;
    };
    (["employeeNumber", "name", "nameAr", "jobTitle", "jobTitleAr", "department", "nationalId", "gosiNumber", "iban", "bank", "gosiRegimeBasis", "notes", "joiningDate", "endDate"] as Text[]).forEach(text);
    for (const f of NUMBERS) {
      if (!can(f)) continue;
      const v = form[f].trim();
      if (mode === "create" ? v !== "" : v !== initial[f].trim() && v !== "") out[f] = Number(v);
    }
    for (const f of ["nationality", "status"] as const) if (can(f) && (mode === "create" || form[f] !== initial[f])) out[f] = form[f];
    if (can("gosiRegime")) {
      const regime = form.nationality === "SA" && form.gosiRegime ? form.gosiRegime : null;
      if (mode === "create" ? regime : regime !== (initial.nationality === "SA" && initial.gosiRegime ? initial.gosiRegime : null)) out.gosiRegime = regime;
    }
    if (can("gosiInKindHousing") && (mode === "create" ? form.housing !== "cash" : form.housing !== initial.housing)) Object.assign(out, housingFlags(form.housing));
    if (mode === "create" && out.employeeNumber == null) out.employeeNumber = form.employeeNumber;
    return out;
  }

  const save = useMutation({
    mutationFn: () =>
      mode === "create"
        ? apiFetch("/employees", { method: "POST", body: JSON.stringify(body() as unknown as CreateEmployeeInput) })
        : apiFetch(`/employees/${employee!.id}`, { method: "PATCH", body: JSON.stringify(body() as UpdateEmployeeInput) }),
    // 🔴 19B S3: an IBAN in the body is HELD for an accountant or admin who did not enter it (or applied at once, the fallback)
    onSuccess: (res: unknown) => {
      qc.invalidateQueries({ queryKey: ["employees"] });
      onOpenChange(false);
      toast(ibanSaveNotice(res, "iban" in (body() as Record<string, unknown>), t)
        ?? { title: mode === "create" ? t("Employee added", "تمت إضافة الموظف") : t("Employee saved", "تم حفظ بيانات الموظف") });
    },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const hint = (f: string) =>
    !blind(f) ? undefined
      : read(f) === "last4" && employee && (employee as unknown as Record<string, unknown>)[f]
        ? t(`Shown as ${String((employee as unknown as Record<string, unknown>)[f])} — type a new one to replace it`, `يظهر ${String((employee as unknown as Record<string, unknown>)[f])} — اكتب رقمًا جديدًا لاستبداله`)
        : t("Saved, not shown to your role — type a new one to replace it", "محفوظ ولا يظهر لدورك — اكتب قيمة جديدة لاستبدالها");
  const field = (f: Text, label: string, opts: { type?: string; wide?: boolean } = {}) =>
    can(f) && (
      <div key={f} className={opts.wide ? "col-span-2" : ""}>
        <Label className="text-xs text-muted-foreground" htmlFor={`employee-form-${f}`}>{label}</Label>
        <Input id={`employee-form-${f}`} data-testid={`employee-form-${f}`} value={form[f]} onChange={(e) => set(f)(e.target.value)} placeholder={hint(f)} className="mt-1 h-8 text-sm" type={opts.type ?? "text"} dir={opts.type === "date" || f === "iban" ? "ltr" : undefined} />
        {hint(f) && <p className="mt-1 text-xs text-muted-foreground">{hint(f)}</p>}
      </div>
    );
  const pay = NUMBERS.some(can);
  const preview = pay ? gosiPreview(form.nationality, form.gosiRegime, Number(form.basicSalary || 0), Number(form.housingAllowance || 0), form.housing) : null;
  const changes = mode === "edit" ? Object.keys(body()).length : 1;
  const notWritable = mode === "edit" && employee ? (["status", "joiningDate", "endDate"] as const).filter((f) => !can(f)) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto" data-testid="employee-form">
        <DialogHeader><DialogTitle>{mode === "create" ? t("New Employee", "موظف جديد") : t(`Edit ${employee?.name ?? ""}`, `تعديل ${employee?.name ?? ""}`)}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3 mt-2">
          {field("employeeNumber", t("Employee #", "رقم الموظف"))}
          {field("name", t("Full Name *", "الاسم الكامل *"))}
          {field("nameAr", "الاسم بالعربي")}
          {field("nationalId", t("National ID / Iqama", "رقم الهوية / الإقامة"))}
          {field("jobTitle", t("Job Title", "المسمى الوظيفي"))}
          {field("jobTitleAr", "المسمى الوظيفي")}
          {field("department", t("Department", "القسم"))}
          {field("gosiNumber", t("GOSI number", "رقم الاشتراك في التأمينات"))}
          {field("iban", "IBAN", { wide: true })}
          {field("bank", t("Bank", "البنك"), { wide: true })}
          {field("joiningDate", t("Joining Date", "تاريخ الالتحاق"), { type: "date" })}
          {field("endDate", t("End Date (last day of employment)", "تاريخ انتهاء الخدمة (آخر يوم عمل)"), { type: "date" })}
          {can("nationality") && (
            <div><Label className="text-xs text-muted-foreground">{t("Nationality", "الجنسية")}</Label>
              <Select value={form.nationality} onValueChange={set("nationality")}><SelectTrigger className="mt-1 h-8 text-sm" data-testid="employee-form-nationality"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="SA">{t("Saudi (SA)", "سعودي (SA)")}</SelectItem><SelectItem value="EX">{t("Expat", "وافد")}</SelectItem></SelectContent></Select>
            </div>
          )}
          {can("status") && (
            <div><Label className="text-xs text-muted-foreground">{t("Status", "الحالة")}</Label>
              <Select value={form.status} onValueChange={set("status")}><SelectTrigger className="mt-1 h-8 text-sm" data-testid="employee-form-status"><SelectValue /></SelectTrigger>
                <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}>{statusLabel(s, t)}</SelectItem>)}</SelectContent></Select>
            </div>
          )}
          {notWritable.length > 0 && (
            <p className="col-span-2 text-xs text-muted-foreground" data-testid="employee-form-readonly">
              {t("Status and dates (changed by an accountant or admin):", "الحالة والتواريخ (يغيّرها المحاسب أو المسؤول):")} {statusLabel(employee!.status, t)} · {employee!.joiningDate ?? "—"}{employee!.endDate ? ` → ${employee!.endDate}` : ""}
            </p>
          )}
          {can("gosiRegime") && form.nationality === "SA" && (
            <>
              <div><Label className="text-xs text-muted-foreground">{t("GOSI law", "نظام التأمينات")}</Label>
                <Select value={form.gosiRegime || "unstated"} onValueChange={(v) => setForm((p) => ({ ...p, gosiRegime: (v === "unstated" ? "" : v) as RegimeChoice }))}><SelectTrigger className="mt-1 h-8 text-sm" data-testid="employee-gosi-regime"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="unstated">{t("Not stated", "غير محدَّد")}</SelectItem>{(Object.keys(REGIME_LABELS) as Array<keyof typeof REGIME_LABELS>).map((r) => <SelectItem key={r} value={r}>{t(...REGIME_LABELS[r])}</SelectItem>)}</SelectContent></Select>
              </div>
              {field("gosiRegimeBasis", t("Basis (e.g. GOSI certificate)", "المستند (مثل شهادة التأمينات)"))}
            </>
          )}
          {pay && (
            <>
              <div className="col-span-2 border-t border-border pt-3"><p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">{t("Compensation (SAR)", "المكافآت (ر.س)")}</p>
                {mode === "create" && <p className="text-xs text-muted-foreground mt-1">{t("Leave the basic salary empty if it is not known yet: the employee shows \"pay not set\" and payroll leaves them out, by name, until it is set.", "اترك الراتب الأساسي فارغًا إن لم يُعرف بعد: يظهر الموظف «الراتب غير محدد» ويُستبعد من مسير الرواتب باسمه حتى يُحدَّد.")}</p>}
              </div>
              {NUMBERS.filter(can).map((f) => (
                <div key={f}><Label className="text-xs text-muted-foreground" htmlFor={`employee-form-${f}`}>{t(...({ basicSalary: ["Basic Salary", "الراتب الأساسي"], housingAllowance: ["Housing Allowance", "بدل السكن"], transportAllowance: ["Transport Allowance", "بدل النقل"], otherAllowances: ["Other Allowances", "بدلات أخرى"] } as Record<Money, [string, string]>)[f])}</Label>
                  <Input id={`employee-form-${f}`} data-testid={`employee-form-${f}`} type="number" dir="ltr" value={form[f]} onChange={(e) => set(f)(e.target.value)} className="mt-1 h-8 text-sm font-mono" placeholder={f === "basicSalary" && !form[f] ? t("Pay not set", "الراتب غير محدد") : undefined} /></div>
              ))}
              {can("gosiInKindHousing") && (
                <div className="col-span-2"><Label className="text-xs text-muted-foreground">{t("Housing for GOSI", "السكن في التأمينات")}</Label>
                  <Select value={form.housing} onValueChange={(v) => setForm((p) => ({ ...p, housing: v as HousingChoice }))}><SelectTrigger className="mt-1 h-8 text-sm" data-testid="employee-gosi-housing"><SelectValue /></SelectTrigger>
                    <SelectContent>{(Object.keys(HOUSING_LABELS) as HousingChoice[]).map((h) => <SelectItem key={h} value={h}>{t(...HOUSING_LABELS[h])}</SelectItem>)}</SelectContent></Select>
                </div>
              )}
              {field("notes", t("Notes", "ملاحظات"), { wide: true })}
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
            </>
          )}
        </div>
        <Button className="w-full mt-4" data-testid="employee-form-save" onClick={() => save.mutate()} disabled={!form.name.trim() || save.isPending || changes === 0}>
          {save.isPending ? t("Saving...", "جارٍ الحفظ...") : mode === "create" ? t("Add Employee", "إضافة موظف") : t("Save changes", "حفظ التعديلات")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
