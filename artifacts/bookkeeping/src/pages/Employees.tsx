import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, UserCheck, Users, TrendingUp, Shield } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Employee { id: number; employeeNumber: string; name: string; nameAr: string; nationality: string; jobTitle: string; department: string; basicSalary: number; grossSalary: number; gosiEmployee: number; gosiEmployer: number; status: string; joiningDate: string; }

const emptyForm = { employeeNumber: `EMP-${Date.now().toString().slice(-5)}`, name: "", nameAr: "", nationalId: "", nationality: "SA", jobTitle: "", jobTitleAr: "", department: "", basicSalary: "", housingAllowance: "", transportAllowance: "", otherAllowances: "", iban: "", bank: "", joiningDate: new Date().toISOString().split("T")[0], status: "active" };

export default function Employees() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [statusFilter, setStatusFilter] = useState("active");
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: employees = [], isLoading } = useQuery<Employee[]>({
    queryKey: ["employees", statusFilter],
    queryFn: () => apiFetch(`/employees?status=${statusFilter}`),
  });

  const createMut = useMutation({
    mutationFn: (body: any) => apiFetch("/employees", { method: "POST", body: JSON.stringify({ ...body, basicSalary: Number(body.basicSalary), housingAllowance: Number(body.housingAllowance || 0), transportAllowance: Number(body.transportAllowance || 0), otherAllowances: Number(body.otherAllowances || 0) }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["employees"] }); setOpen(false); setForm(emptyForm); toast({ title: "Employee added" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const f = (k: string) => (e: any) => setForm(p => ({ ...p, [k]: e.target?.value ?? e }));

  const totalPayroll = employees.reduce((s, e) => s + e.grossSalary, 0);
  const totalGOSIEr = employees.reduce((s, e) => s + e.gosiEmployer, 0);
  const saudiCount = employees.filter(e => e.nationality === "SA").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Employees</h1>
          <p className="text-muted-foreground text-sm mt-1">HR register · GOSI auto-calculated per Saudi Labour Law</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> Add Employee</Button></DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader><DialogTitle>New Employee</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3 mt-2">
              {([["employeeNumber","Employee #"],["name","Full Name *"],["nameAr","الاسم بالعربي"],["nationalId","National ID / Iqama"],["jobTitle","Job Title"],["jobTitleAr","المسمى الوظيفي"],["department","Department"],["iban","IBAN"],["bank","Bank"],["joiningDate","Joining Date"]] as [string,string][]).map(([k,l])=>(
                <div key={k} className={["iban","bank"].includes(k)?"col-span-2":""}>
                  <Label className="text-xs text-muted-foreground">{l}</Label>
                  <Input value={(form as any)[k]} onChange={f(k)} className="mt-1 h-8 text-sm" type={k==="joiningDate"?"date":"text"} />
                </div>
              ))}
              <div><Label className="text-xs text-muted-foreground">Nationality</Label>
                <Select value={form.nationality} onValueChange={v=>setForm(p=>({...p,nationality:v}))}><SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="SA">Saudi (SA)</SelectItem><SelectItem value="EX">Expatriate</SelectItem></SelectContent></Select>
              </div>
              <div><Label className="text-xs text-muted-foreground">Status</Label>
                <Select value={form.status} onValueChange={v=>setForm(p=>({...p,status:v}))}><SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger><SelectContent>{["active","inactive"].map(s=><SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select>
              </div>
              <div className="col-span-2 border-t border-border pt-3"><p className="text-xs text-muted-foreground uppercase tracking-wide mb-2 font-medium">Compensation (SAR)</p></div>
              {([["basicSalary","Basic Salary *"],["housingAllowance","Housing Allowance"],["transportAllowance","Transport Allowance"],["otherAllowances","Other Allowances"]] as [string,string][]).map(([k,l])=>(
                <div key={k}><Label className="text-xs text-muted-foreground">{l}</Label><Input type="number" value={(form as any)[k]} onChange={f(k)} className="mt-1 h-8 text-sm font-mono" /></div>
              ))}
              {form.basicSalary && (
                <div className="col-span-2 bg-secondary/30 rounded-lg p-3 text-xs space-y-1">
                  <p className="font-medium text-muted-foreground">GOSI Preview ({form.nationality === "SA" ? "Saudi" : "Expat"})</p>
                  <div className="flex justify-between"><span className="text-muted-foreground">Employee contribution ({form.nationality==="SA"?"9.75%":"0%"})</span><span className="font-mono text-amber-400">{fmtNum(Number(form.basicSalary)*(form.nationality==="SA"?0.0975:0))}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Employer contribution ({form.nationality==="SA"?"11.75%":"2%"})</span><span className="font-mono text-amber-400">{fmtNum(Number(form.basicSalary)*(form.nationality==="SA"?0.1175:0.02))}</span></div>
                </div>
              )}
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.name||!form.basicSalary||createMut.isPending}>{createMut.isPending?"Adding...":"Add Employee"}</Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[["Headcount", employees.length, "text-primary"],["Saudi Nationals", `${saudiCount} / ${employees.length}`, "text-amber-400"],["Monthly Payroll", fmtNum(totalPayroll), "text-foreground"],["Monthly GOSI (Employer)", fmtNum(totalGOSIEr), "text-red-400"]].map(([l,v,c])=>(
          <Card key={String(l)} className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-xl font-bold font-mono ${c}`}>{v}</div></CardContent></Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="flex gap-2">
            {["active","inactive","terminated"].map(s=>(<Button key={s} variant={statusFilter===s?"default":"ghost"} size="sm" className="h-7 text-xs capitalize" onClick={()=>setStatusFilter(s)}>{s}</Button>))}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <div className="text-muted-foreground text-sm p-4">Loading...</div> : employees.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><Users className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>No employees found.</p></div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{["Employee","Department","Nationality","Basic Salary","Gross","GOSI Emp","GOSI Er","Join Date","Status"].map(h=><th key={h} className="text-left pb-2 pr-3 font-medium">{h}</th>)}</tr></thead>
              <tbody>{employees.map(e=>(
                <tr key={e.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="py-3 pr-3"><div className="font-medium">{e.name}</div><div className="text-xs text-muted-foreground font-mono">{e.employeeNumber}</div></td>
                  <td className="py-3 pr-3 text-muted-foreground text-xs">{e.department||"—"}</td>
                  <td className="py-3 pr-3"><Badge variant="outline" className={`text-xs ${e.nationality==="SA"?"border-primary/40 text-primary":"border-blue-500/40 text-blue-400"}`}>{e.nationality==="SA"?"🇸🇦 Saudi":"Expat"}</Badge></td>
                  <td className="py-3 pr-3 font-mono text-sm">{fmtNum(e.basicSalary)}</td>
                  <td className="py-3 pr-3 font-mono text-sm font-semibold">{fmtNum(e.grossSalary)}</td>
                  <td className="py-3 pr-3 font-mono text-xs text-amber-400">{fmtNum(e.gosiEmployee)}</td>
                  <td className="py-3 pr-3 font-mono text-xs text-red-400">{fmtNum(e.gosiEmployer)}</td>
                  <td className="py-3 pr-3 text-xs text-muted-foreground">{e.joiningDate ? fmtDate(e.joiningDate) : "—"}</td>
                  <td className="py-3"><Badge className={`text-xs ${e.status==="active"?"bg-emerald-500/20 text-emerald-400":"bg-secondary text-muted-foreground"}`}>{e.status}</Badge></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
