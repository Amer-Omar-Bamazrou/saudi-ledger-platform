import { useState } from "react";
import { Link } from "wouter";
import { arabicFieldStatus } from "@/lib/arabicUtils";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Search, Building2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { ListPagination } from "@/components/ListPagination";
import { PAGE_SIZE, type Paged } from "@/lib/pagedList";

interface Vendor { id: number; name: string; nameAr: string; taxNumber: string; crNumber: string; phone: string; email: string; city: string; iban: string; paymentTermsDays: string; isActive: boolean; totalBilled?: number; totalPaid?: number; balance?: number; }

interface VendorTotals { totalBilled: number; totalPaid: number; balance: number; }

const emptyForm = { name: "", nameAr: "", taxNumber: "", crNumber: "", phone: "", email: "", address: "", city: "", iban: "", paymentTermsDays: "30" };

export default function Vendors() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();

  const { data: paged, isLoading } = useQuery<Paged<Vendor, VendorTotals>>({
    queryKey: ["vendors", search, page],
    queryFn: () =>
      apiFetch(
        `/vendors?search=${encodeURIComponent(search)}&is_active=true` +
          `&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      ),
  });
  const vendors = paged?.items ?? [];

  const createMut = useMutation({
    mutationFn: (body: typeof emptyForm) => apiFetch("/vendors", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vendors"] }); setOpen(false); setForm(emptyForm); toast({ title: t("Vendor created", "تم إنشاء المورد") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  /**
   * 🔴 From the server, over every matching vendor — never `reduce`d over the
   * page. Both figures used to sum a field the API did not send, so each read
   * 0.00 for every tenant.
   */
  const totalAP = paged?.totals.balance ?? 0;
  const totalBilled = paged?.totals.totalBilled ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Vendors", "الموردون")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Accounts Payable", "الحسابات الدائنة")} — {paged?.page.total ?? 0} {t("active vendors", "مورد نشط")}</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> {t("New Vendor", "مورد جديد")}</Button></DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>{t("New Vendor", "مورد جديد")}</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3 mt-2">
              {[[("name"),(t("Vendor Name *", "اسم المورد *"))],[("nameAr"),("اسم المورد")],[("taxNumber"),(t("VAT Number", "رقم ضريبة القيمة المضافة"))],[("crNumber"),(t("CR Number", "رقم السجل التجاري"))],[("phone"),(t("Phone", "الهاتف"))],[("email"),("Email")],[("address"),(t("Address", "العنوان"))],[("city"),(t("City", "المدينة"))],[("iban"),("IBAN")],[("paymentTermsDays"),(t("Payment Terms (days)", "شروط الدفع (أيام)"))]].map(([k,l])=>(
                <div key={k} className={k==="address"||k==="iban"?"col-span-2":""}>
                  <Label className="text-xs text-muted-foreground">{l}</Label>
                  <Input value={(form as any)[k]} onChange={e=>setForm(p=>({...p,[k]:e.target.value}))} className="mt-1 h-8 text-sm" />
                </div>
              ))}
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.name || createMut.isPending}>
              {createMut.isPending ? t("Creating...", "جارٍ الإنشاء...") : t("Create Vendor", "إنشاء مورد")}
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Total Vendors", "إجمالي الموردين")}</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-primary">{paged?.page.total ?? 0}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Total Billed", "إجمالي المفوتر")}</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-foreground">{fmtNum(totalBilled)}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Outstanding AP", "الحسابات الدائنة المستحقة")}</CardTitle></CardHeader><CardContent><div className={`text-2xl font-bold font-mono ${totalAP > 0 ? "text-negative" : "text-positive"}`}>{fmtNum(totalAP)}</div></CardContent></Card>
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="relative max-w-xs">
            <Search className="absolute start-3 top-2.5 w-4 h-4 text-muted-foreground" />
            <Input placeholder={t("Search vendors...", "بحث عن الموردين...")} className="ps-9 h-9" value={search} onChange={e=>setSearch(e.target.value)} />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Loading...", "جارٍ التحميل...")}</div> : vendors.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><Building2 className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>{t("No vendors yet. Add your first vendor.", "لا يوجد موردون بعد. أضف أول مورد.")}</p></div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{[t("Vendor","المورد"),t("City","المدينة"),t("VAT Number","رقم ضريبة القيمة المضافة"),t("IBAN","IBAN"),t("Total Bills","إجمالي الفواتير"),t("Outstanding","المستحق"),""].map(h=><th key={h} className="text-start pb-2 pe-4 font-medium">{h}</th>)}</tr></thead>
              <tbody>{vendors.map(v=>(
                <tr key={v.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="py-3 pe-4">
                    <div className="font-medium text-foreground">{v.name}</div>
                    {arabicFieldStatus(v.nameAr) === "ok"
                      ? <div className="text-xs text-muted-foreground" dir="rtl">{v.nameAr}</div>
                      : arabicFieldStatus(v.nameAr) === "wrong-script"
                      ? <div className="text-[10px] text-orange-400 italic mt-0.5">⚠ {t("not Arabic script", "ليس نصًا عربيًا")}</div>
                      : <div className="text-[10px] text-attention-surface/60 italic mt-0.5">{t("needs Arabic translation", "يحتاج إلى ترجمة عربية")}</div>}
                  </td>
                  <td className="py-3 pe-4 text-muted-foreground">{v.city||"—"}</td>
                  <td className="py-3 pe-4 font-mono text-xs text-muted-foreground">{v.taxNumber||"—"}</td>
                  <td className="py-3 pe-4 font-mono text-xs text-muted-foreground">{v.iban ? `${v.iban.slice(0,12)}...` : "—"}</td>
                  <td className="py-3 pe-4 font-mono text-foreground">{fmtNum(v.totalBilled??0)}</td>
                  <td className="py-3 pe-4"><span className={`font-mono font-medium ${(v.balance??0)>0?"text-negative":"text-positive"}`}>{fmtNum(v.balance??0)}</span></td>
                  <td className="py-3"><Link href={`/vendors/${v.id}`}><Button variant="ghost" size="sm" className="text-xs h-7">{t("View", "عرض")}</Button></Link></td>
                </tr>
              ))}</tbody>
            </table>
          )}
          <ListPagination
            page={paged?.page}
            shown={vendors.length}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
