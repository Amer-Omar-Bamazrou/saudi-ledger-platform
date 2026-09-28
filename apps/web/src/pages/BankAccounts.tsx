import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Landmark, CreditCard } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { PageHeader, StatStrip, Stat, Panel, EmptyState, Field } from "@/components/kit";

interface BankAccount { id: number; name: string; bankName: string; accountNumber?: string; iban?: string; currency: string; balance: number; openingBalance: number; isDefault: boolean; isActive: boolean; notes?: string; glAccountId: number | null; glAccountName: string | null; ledgerBalance: number | null; ledgerBalanceOnLeaf: number | null; attributedHistory: number | null; }

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

  // The account whose details print on issued invoices. One effective default
  // is enforced by the server on write (bankAccounts.service); this control
  // only says which one. Same PATCH the route already accepted.
  const setDefaultMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/bank-accounts/${id}`, { method: "PATCH", body: JSON.stringify({ isDefault: true }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bank-accounts"] }); toast({ title: t("This account will now appear on invoices", "سيظهر هذا الحساب على الفواتير الآن") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });
  const invoiceAccount = accounts.find(a => a.isDefault);

  // 🔴 Phase 12D: the total is the LEDGER's — the one definition every report
  // uses — never the typed `balance`, which no posting ever updates. An account
  // whose ledger figure is missing makes the total NOT KNOWN, not a smaller sum.
  const activeSar = accounts.filter(a => a.isActive && a.currency === "SAR");
  const totalBalance = activeSar.some(a => a.ledgerBalance == null) ? null : activeSar.reduce((s, a) => s + (a.ledgerBalance ?? 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("Bank Accounts", "الحسابات البنكية")}
        description={<>{t("Cash & banking", "النقد والبنوك")} · {accounts.length} {t("accounts", "حسابات")}</>}
        actions={
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
        }
      >
      <p className="mt-3 text-[13px] text-muted-foreground max-w-[70ch]" data-testid="invoice-bank-account">
        {invoiceAccount
          ? t(`Invoices show the bank details of: ${invoiceAccount.name} (${invoiceAccount.bankName}).`, `تعرض الفواتير بيانات الحساب: ${invoiceAccount.name} (${invoiceAccount.bankName}).`)
          : t("No account is set to appear on invoices — issued invoices will carry no bank details until you choose one below.", "لم يُحدَّد حساب للظهور على الفواتير — ستصدر الفواتير بدون بيانات بنكية حتى تختار حسابًا أدناه.")}
      </p>
      </PageHeader>

      <StatStrip cols={3}>
        <Stat label={t("Total Cash (SAR)", "إجمالي النقد (ر.س)")} value={<span data-testid="total-ledger-balance">{totalBalance == null ? "—" : fmtNum(totalBalance)}</span>} />
        <Stat label={t("Accounts", "الحسابات")} value={accounts.length} />
        <Stat label={t("Banks", "البنوك")} value={new Set(accounts.map(a=>a.bankName)).size} />
      </StatStrip>

      {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Loading...", "جارٍ التحميل...")}</div> : accounts.length === 0 ? (
        <Panel><EmptyState icon={Landmark} title={t("No bank accounts yet.", "لا توجد حسابات بنكية بعد.")} /></Panel>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {accounts.map(acc=>(
            <section data-row key={acc.id} className={`rounded-lg border bg-card text-card-foreground transition-colors hover:border-primary/40 ${acc.isDefault?"border-primary/40":"border-border"}`}>
              <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <CreditCard className="w-4 h-4 shrink-0 text-primary" />
                    <span className="truncate text-[15px] font-semibold text-foreground">{acc.name}</span>
                    {acc.isDefault && <Badge className="text-xs bg-primary/10 text-primary">{t("Default", "افتراضي")}</Badge>}
                  </div>
                  <p className="text-[13px] text-muted-foreground mt-0.5">{acc.bankName}</p>
                </div>
                <span className="text-xs text-muted-foreground">{acc.currency}</span>
              </div>
              <div className="px-5 py-4">
                {/* 🔴 Phase 12D: the headline is what the BOOKS say for this account — Σ of
                    the ledger lines on its own GL cash account (D-3), the same figure as the
                    cash position and every report. The typed balance is shown below it for
                    what it is: a number entered by hand, which no posting updates. */}
                <div data-testid="ledger-balance">
                  <div className="text-[13px] text-muted-foreground">{t("Ledger balance", "الرصيد الدفتري")}</div>
                  <div className={`mt-1 text-[24px] leading-tight font-semibold tabular-nums ${(acc.ledgerBalance ?? 0) >= 0 ? "text-foreground" : "text-negative"}`}>{acc.ledgerBalance != null ? fmtNum(acc.ledgerBalance) : "—"}</div>
                </div>
                <div className="text-[12px] text-muted-foreground mt-2 space-y-0.5">
                  <div data-testid="typed-balance">{t("Balance as typed (not updated by postings)", "الرصيد كما أُدخل (لا تحدّثه القيود)")}: <span className="tabular-nums whitespace-nowrap">{fmtNum(acc.balance)}</span></div>
                  {acc.glAccountName ? <div className="truncate">{t("GL account", "حساب الأستاذ")}: {acc.glAccountName}</div> : null}
                  {/* Annotation model: history posted before per-bank accounts stays on
                      "Cash and Bank" and is attributed to this bank — shown, not folded away,
                      so the balance sheet's two lines and this figure can be reconciled. */}
                  {acc.attributedHistory != null && acc.attributedHistory !== 0 ? (
                    <div>{t("of which on Cash and Bank (pre-per-bank history)", "منها على «النقد والبنك» (سجل ما قبل الحسابات المستقلة)")}: <span className="tabular-nums whitespace-nowrap">{fmtNum(acc.attributedHistory)}</span></div>
                  ) : null}
                </div>
                <dl className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-border">
                  <Field label="IBAN"><span className="font-mono text-[13px]" dir="ltr">{acc.iban ? acc.iban.slice(0, 16) + "..." : "—"}</span></Field>
                  <Field label={t("A/C", "حساب")}><span className="font-mono text-[13px]" dir="ltr">{acc.accountNumber || "—"}</span></Field>
                </dl>
              </div>
              <div className="flex items-center border-t border-border px-5 py-3">
                {acc.isDefault ? (
                  <span className="text-[13px] text-primary">{t("Shown on invoices", "يظهر على الفواتير")}</span>
                ) : (
                  <Button variant="outline" size="sm" className="h-7 text-xs" disabled={setDefaultMut.isPending} onClick={() => setDefaultMut.mutate(acc.id)}>
                    {t("Use on invoices", "استخدمه على الفواتير")}
                  </Button>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
