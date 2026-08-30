import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Landmark, CreditCard } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";

interface BankAccount { id: number; name: string; bankName: string; accountNumber?: string; iban?: string; currency: string; balance: number; openingBalance: number; isDefault: boolean; isActive: boolean; notes?: string; }

const SAUDI_BANKS = ["Al-Rajhi Bank الراجحي","Saudi National Bank SNB","Riyad Bank بنك الرياض","Banque Saudi Fransi","Arab National Bank ANB","Saudi British Bank SABB","Alinma Bank بنك الإنماء","Al-Jazira Bank بنك الجزيرة","SAMBA Financial Group","Albilad Bank بنك البلاد"];

const emptyForm = { name: "", bankName: "", accountNumber: "", iban: "", currency: "SAR", balance: "", isDefault: false, notes: "" };

export default function BankAccounts() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();

  const { data: accounts = [], isLoading } = useQuery<BankAccount[]>({ queryKey: ["bank-accounts"], queryFn: () => apiFetch("/bank-accounts") });

  const createMut = useMutation({
    mutationFn: (body: any) => apiFetch("/bank-accounts", { method: "POST", body: JSON.stringify({ ...body, balance: Number(body.balance || 0), openingBalance: Number(body.balance || 0) }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bank-accounts"] }); setOpen(false); setForm(emptyForm); toast({ title: t("Bank account added", "تمت إضافة الحساب البنكي") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const totalBalance = accounts.filter(a => a.isActive && a.currency === "SAR").reduce((s, a) => s + a.balance, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Bank Accounts", "الحسابات البنكية")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Cash & banking", "النقد والبنوك")} · {accounts.length} {t("accounts", "حسابات")}</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> {t("Add Account", "إضافة حساب")}</Button></DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>{t("Add Bank Account", "إضافة حساب بنكي")}</DialogTitle></DialogHeader>
            <div className="space-y-3 mt-2">
              <div><Label className="text-xs text-muted-foreground">{t("Account Name *", "اسم الحساب *")}</Label><Input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} className="mt-1 h-8 text-sm" placeholder={t("e.g., Al-Rajhi Business Account", "مثال: حساب الأعمال الراجحي")} /></div>
              <div><Label className="text-xs text-muted-foreground">{t("Bank *", "البنك *")}</Label>
                <select className="w-full mt-1 h-8 text-sm rounded-md border border-input bg-background px-3 py-1" value={form.bankName} onChange={e=>setForm(p=>({...p,bankName:e.target.value}))}>
                  <option value="">{t("Select bank...", "اختر البنك...")}</option>
                  {SAUDI_BANKS.map(b=><option key={b} value={b}>{b}</option>)}
                  <option value="Other">{t("Other", "أخرى")}</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs text-muted-foreground">{t("Account Number", "رقم الحساب")}</Label><Input value={form.accountNumber} onChange={e=>setForm(p=>({...p,accountNumber:e.target.value}))} className="mt-1 h-8 text-sm font-mono" /></div>
                {/* Single-currency by construction: the ledger holds no exchange rates and
                    no aggregate consults `currency`, so the API refuses anything but SAR
                    (writeGuards.assertSupportedCurrency + CHECK 0062). A free-text input
                    here used to write straight through an unvalidated allowlist. */}
                <div><Label className="text-xs text-muted-foreground">{t("Currency", "العملة")}</Label><Input value="SAR" readOnly disabled className="mt-1 h-8 text-sm font-mono" /></div>
              </div>
              <div><Label className="text-xs text-muted-foreground">{t("IBAN (SA00 0000 0000 0000 0000 0000)", "الآيبان (SA00 0000 0000 0000 0000 0000)")}</Label><Input value={form.iban} onChange={e=>setForm(p=>({...p,iban:e.target.value}))} className="mt-1 h-8 text-sm font-mono" /></div>
              <div><Label className="text-xs text-muted-foreground">{t("Opening Balance (SAR)", "الرصيد الافتتاحي (ر.س)")}</Label><Input type="number" value={form.balance} onChange={e=>setForm(p=>({...p,balance:e.target.value}))} className="mt-1 h-8 text-sm font-mono" /></div>
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.name||!form.bankName||createMut.isPending}>{createMut.isPending ? t("Adding...", "جارٍ الإضافة...") : t("Add Account", "إضافة حساب")}</Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Total Cash (SAR)", "إجمالي النقد (ر.س)")}</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-positive">{fmtNum(totalBalance)}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Accounts", "الحسابات")}</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-primary">{accounts.length}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Banks", "البنوك")}</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-foreground">{new Set(accounts.map(a=>a.bankName)).size}</div></CardContent></Card>
      </div>

      {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Loading...", "جارٍ التحميل...")}</div> : accounts.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground"><Landmark className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>{t("No bank accounts yet.", "لا توجد حسابات بنكية بعد.")}</p></div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {accounts.map(acc=>(
            <Card key={acc.id} className={`border-border bg-card transition-colors hover:border-primary/30 ${acc.isDefault?"border-primary/30":""}`}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <CreditCard className="w-4 h-4 text-primary" />
                      <span className="font-semibold text-foreground">{acc.name}</span>
                      {acc.isDefault && <Badge className="text-xs bg-primary/20 text-primary">{t("Default", "افتراضي")}</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{acc.bankName}</p>
                  </div>
                  <span className="text-xs font-mono text-muted-foreground">{acc.currency}</span>
                </div>
              </CardHeader>
              <CardContent>
                <div className={`text-3xl font-bold font-mono ${acc.balance >= 0 ? "text-positive" : "text-negative"}`}>{fmtNum(acc.balance)}</div>
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
                  <div className="text-xs text-muted-foreground">IBAN: <span className="font-mono">{acc.iban ? acc.iban.slice(0, 16) + "..." : "—"}</span></div>
                  <div className="text-xs text-muted-foreground">{t("A/C", "حساب")}: <span className="font-mono">{acc.accountNumber || "—"}</span></div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
