import { useState } from "react";
import { arabicFieldStatus } from "@/lib/arabicUtils";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Search, Users, TrendingUp, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { ListPagination } from "@/components/ListPagination";
import { PAGE_SIZE, type Paged } from "@/lib/pagedList";

interface Customer { id: number; name: string; nameAr: string; taxNumber: string; crNumber: string; phone: string; email: string; city: string; isActive: boolean; creditLimit: number | null; paymentTermsDays: string; totalBilled?: number; totalPaid?: number; balance?: number; }

interface CustomerTotals { totalBilled: number; totalPaid: number; balance: number; }

const emptyForm = { name: "", nameAr: "", taxNumber: "", crNumber: "", phone: "", email: "", address: "", city: "", paymentTermsDays: "30", creditLimit: "" };

export default function Customers() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();

  const { data: paged, isLoading } = useQuery<Paged<Customer, CustomerTotals>>({
    queryKey: ["customers", search, page],
    queryFn: () =>
      apiFetch(
        `/customers?search=${encodeURIComponent(search)}&is_active=true` +
          `&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      ),
  });
  const customers = paged?.items ?? [];

  const createMut = useMutation({
    mutationFn: (body: typeof emptyForm) => apiFetch("/customers", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["customers"] }); setOpen(false); setForm(emptyForm); toast({ title: t("Customer created", "تم إنشاء العميل") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  /**
   * 🔴 From the server, over every matching customer — never `reduce`d over the
   * page. These two figures used to sum `c.balance ?? 0` over a field the API
   * did not send, so both read 0.00 for every tenant; making them real and
   * making them set-wide is one change, because a page-scoped AR total would
   * have been the next wrong number.
   */
  const totalAR = paged?.totals.balance ?? 0;
  const totalBilled = paged?.totals.totalBilled ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Customers", "العملاء")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Accounts Receivable", "الحسابات المدينة")} — {paged?.page.total ?? 0} {t("active customers", "عميل نشط")}</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="w-4 h-4" /> {t("New Customer", "عميل جديد")}</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>{t("New Customer", "عميل جديد")}</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3 mt-2">
              {[["name",t("Company Name *","اسم الشركة *")],["nameAr","اسم الشركة"],["taxNumber",t("VAT Number","رقم ضريبة القيمة المضافة")],["crNumber",t("CR Number","رقم السجل التجاري")],["phone",t("Phone","الهاتف")],["email","Email"],["address",t("Address","العنوان")],["city",t("City","المدينة")],["paymentTermsDays",t("Payment Terms (days)","شروط الدفع (أيام)")],["creditLimit",t("Credit Limit (SAR)","حد الائتمان (ر.س)")]].map(([k,l])=>(
                <div key={k} className={k==="address"?"col-span-2":""}>
                  <Label className="text-xs text-muted-foreground">{l}</Label>
                  <Input value={(form as any)[k]} onChange={e=>setForm(p=>({...p,[k]:e.target.value}))} className="mt-1 h-8 text-sm" />
                </div>
              ))}
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.name || createMut.isPending}>
              {createMut.isPending ? t("Creating...", "جارٍ الإنشاء...") : t("Create Customer", "إنشاء عميل")}
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Total Customers", "إجمالي العملاء")}</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-primary">{paged?.page.total ?? 0}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Total Billed", "إجمالي المفوتر")}</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-foreground">{fmtNum(totalBilled)}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Outstanding AR", "الحسابات المدينة المستحقة")}</CardTitle></CardHeader><CardContent><div className={`text-2xl font-bold font-mono ${totalAR > 0 ? "text-amber-400" : "text-emerald-400"}`}>{fmtNum(totalAR)}</div></CardContent></Card>
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute start-3 top-2.5 w-4 h-4 text-muted-foreground" />
              <Input placeholder={t("Search customers...", "بحث عن العملاء...")} className="ps-9 h-9" value={search} onChange={e=>setSearch(e.target.value)} />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Loading...", "جارٍ التحميل...")}</div> : customers.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><Users className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>{t("No customers yet. Add your first customer.", "لا يوجد عملاء بعد. أضف أول عميل.")}</p></div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{[t("Customer","العميل"),t("City","المدينة"),t("VAT Number","رقم ضريبة القيمة المضافة"),t("Payment Terms","شروط الدفع"),t("Billed","المفوتر"),t("Outstanding","المستحق"),""].map(h=><th key={h} className="text-start pb-2 pe-4 font-medium">{h}</th>)}</tr></thead>
              <tbody>{customers.map(c=>(
                <tr key={c.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="py-3 pe-4">
                    <div className="font-medium text-foreground">{c.name}</div>
                    {arabicFieldStatus(c.nameAr) === "ok"
                      ? <div className="text-xs text-muted-foreground" dir="rtl">{c.nameAr}</div>
                      : arabicFieldStatus(c.nameAr) === "wrong-script"
                      ? <div className="text-[10px] text-orange-400 italic mt-0.5">⚠ {t("not Arabic script — please correct", "ليس نصًا عربيًا — يرجى التصحيح")}</div>
                      : <div className="text-[10px] text-amber-500/60 italic mt-0.5">{t("needs Arabic translation", "يحتاج إلى ترجمة عربية")}</div>}
                  </td>
                  <td className="py-3 pe-4 text-muted-foreground">{c.city||"—"}</td>
                  <td className="py-3 pe-4 font-mono text-xs text-muted-foreground">{c.taxNumber||"—"}</td>
                  <td className="py-3 pe-4"><Badge variant="outline" className="text-xs font-mono">{c.paymentTermsDays}d</Badge></td>
                  <td className="py-3 pe-4 font-mono text-foreground">{fmtNum(c.totalBilled??0)}</td>
                  <td className="py-3 pe-4"><span className={`font-mono font-medium ${(c.balance??0)>0?"text-amber-400":"text-emerald-400"}`}>{fmtNum(c.balance??0)}</span></td>
                  <td className="py-3"><Button variant="ghost" size="sm" className="text-xs h-7">{t("View", "عرض")}</Button></td>
                </tr>
              ))}</tbody>
            </table>
          )}
          <ListPagination
            page={paged?.page}
            shown={customers.length}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
