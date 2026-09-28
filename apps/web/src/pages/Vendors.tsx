import { useState } from "react";
import { Link } from "wouter";
import { arabicFieldStatus } from "@/lib/arabicUtils";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Search, Building2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { ListPagination } from "@/components/ListPagination";
import { PAGE_SIZE, type Paged } from "@/lib/pagedList";

import type { CreateVendorInput, PartyTotals, VendorWithBalance } from "@workspace/api-client-react";


/**
 * B8 (2026-09-22): `residency` starts as `unknown` and STAYS there unless
 * somebody says otherwise. It is a fact about the supplier, and "resident" is
 * the answer that withholds nothing — so it must never be the silent default.
 * Nothing in the platform withholds on it yet; see the schema's note.
 */
const emptyForm = { name: "", nameAr: "", taxNumber: "", crNumber: "", phone: "", email: "", address: "", city: "", iban: "", paymentTermsDays: "30", residency: "unknown" as "unknown" | "resident" | "non_resident" };

export default function Vendors() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();

  const { data: paged, isLoading } = useQuery<Paged<VendorWithBalance, PartyTotals>>({
    queryKey: ["vendors", search, page],
    queryFn: () =>
      apiFetch(
        `/vendors?search=${encodeURIComponent(search)}&is_active=true` +
          `&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      ),
  });
  const vendors = paged?.items ?? [];

  const createMut = useMutation({
    mutationFn: (body: CreateVendorInput) => apiFetch("/vendors", { method: "POST", body: JSON.stringify(body) }),
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
      <PageHeader
        title={t("Vendors", "الموردون")}
        description={<>{t("Accounts Payable", "الحسابات الدائنة")} — {paged?.page.total ?? 0} {t("active vendors", "مورد نشط")}</>}
        actions={
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
              <div className="col-span-2">
                <Label className="text-xs text-muted-foreground">{t("Residency (for withholding tax)", "الإقامة (لأغراض ضريبة الاستقطاع)")}</Label>
                <Select value={form.residency} onValueChange={(v)=>setForm(p=>({...p,residency:v as typeof p.residency}))}>
                  <SelectTrigger className="mt-1 h-8 text-sm" data-testid="vendor-residency-select"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unknown">{t("Not stated", "غير محدد")}</SelectItem>
                    <SelectItem value="resident">{t("Resident in Saudi Arabia", "مقيم في السعودية")}</SelectItem>
                    <SelectItem value="non_resident">{t("Non-resident", "غير مقيم")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {t("Recorded only. Nothing is withheld and no rate is applied — the rate depends on what the payment is for, which is an accountant's decision.",
                     "يُسجَّل فقط. لا يُستقطع شيء ولا تُطبَّق نسبة — فالنسبة تعتمد على طبيعة الدفعة، وهذا قرار المحاسب.")}
                </p>
              </div>
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.name || createMut.isPending}>
              {createMut.isPending ? t("Creating...", "جارٍ الإنشاء...") : t("Create Vendor", "إنشاء مورد")}
            </Button>
          </DialogContent>
        </Dialog>
        }
      />

      <StatStrip cols={3}>
        <Stat label={t("Total Vendors", "إجمالي الموردين")} value={paged?.page.total ?? 0} />
        <Stat label={t("Total Billed", "إجمالي المفوتر")} value={fmtNum(totalBilled)} />
        <Stat label={t("Outstanding AP", "الحسابات الدائنة المستحقة")} value={fmtNum(totalAP)} tone={totalAP > 0 ? "negative" : "positive"} />
      </StatStrip>

      <Panel flush>
        <div className="border-b border-border px-5 py-3">
          <div className="relative max-w-xs">
            <Search className="absolute start-3 top-2.5 w-4 h-4 text-muted-foreground" />
            <Input placeholder={t("Search vendors...", "بحث عن الموردين...")} className="ps-9 h-9" value={search} onChange={e=>setSearch(e.target.value)} />
          </div>
        </div>
        <div>
          {isLoading ? <div className="text-muted-foreground text-sm p-5">{t("Loading...", "جارٍ التحميل...")}</div> : vendors.length === 0 ? (
            <EmptyState icon={Building2} title={t("No vendors yet. Add your first vendor.", "لا يوجد موردون بعد. أضف أول مورد.")} />
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="border-b border-border">{([[t("Vendor","المورد"),false],[t("City","المدينة"),false],[t("VAT Number","رقم ضريبة القيمة المضافة"),false],[t("IBAN","IBAN"),false],[t("Total Bills","إجمالي الفواتير"),true],[t("Outstanding","المستحق"),true],["",false]] as const).map(([h,num])=><th key={h} className={`${num ? "text-end" : "text-start"} px-3`}>{h}</th>)}</tr></thead>
              <tbody>{vendors.map(v=>(
                <tr key={v.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors">
                  <td className="py-3 px-3 min-w-[12rem]">
                    <div className="font-medium text-foreground">{v.name}</div>
                    {arabicFieldStatus(v.nameAr) === "ok"
                      ? <div className="text-xs text-muted-foreground" dir="rtl">{v.nameAr}</div>
                      : arabicFieldStatus(v.nameAr) === "wrong-script"
                      ? <div className="text-[10px] text-severe italic mt-0.5">⚠ {t("not Arabic script", "ليس نصًا عربيًا")}</div>
                      : <div className="text-[10px] text-attention-surface/60 italic mt-0.5">{t("needs Arabic translation", "يحتاج إلى ترجمة عربية")}</div>}
                  </td>
                  <td className="py-3 px-3 text-muted-foreground">{v.city||"—"}</td>
                  <td className="py-3 px-3 text-[13px] tabular-nums whitespace-nowrap text-muted-foreground">{v.taxNumber||"—"}</td>
                  <td className="py-3 px-3 text-[13px] tabular-nums whitespace-nowrap text-muted-foreground" dir="ltr">{v.iban ? `${v.iban.slice(0,12)}...` : "—"}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-foreground">{fmtNum(v.totalBilled??0)}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums"><span className={`font-medium ${(v.balance??0)>0?"text-negative":"text-positive"}`}>{fmtNum(v.balance??0)}</span></td>
                  <td className="py-3 px-3 text-end"><Link href={`/vendors/${v.id}`}><Button variant="ghost" size="sm" className="text-xs h-7">{t("View", "عرض")}</Button></Link></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          <div className="border-t border-border px-5 pb-3 empty:hidden">
            <ListPagination
              page={paged?.page}
              shown={vendors.length}
              onPrev={() => setPage((p) => Math.max(0, p - 1))}
              onNext={() => setPage((p) => p + 1)}
            />
          </div>
        </div>
      </Panel>
    </div>
  );
}
