import { useState } from "react";
import { Link } from "wouter";
import { arabicFieldStatus } from "@/lib/arabicUtils";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Search, Users } from "lucide-react";
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { ListPagination } from "@/components/ListPagination";
import { PAGE_SIZE, type Paged } from "@/lib/pagedList";

import type { CreateCustomerInput, CustomerTotals, CustomerWithBalance } from "@workspace/api-client-react";


const emptyForm = { name: "", nameAr: "", taxNumber: "", crNumber: "", phone: "", email: "", address: "", city: "", paymentTermsDays: "30", creditLimit: "" };

/**
 * The form holds strings; the contract wants `creditLimit: number | null`, and
 * "" means "no limit". The server used to accept "" and store it — `Number("")`
 * is 0 — so every such customer read back with a limit of 0.00. The generated
 * body type makes sending "" a compile error here and a 400 there.
 */
function toCreateInput(f: typeof emptyForm): CreateCustomerInput {
  const { creditLimit, ...rest } = f;
  return { ...rest, creditLimit: creditLimit.trim() === "" ? null : Number(creditLimit) };
}

export default function Customers() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();

  const { data: paged, isLoading } = useQuery<Paged<CustomerWithBalance, CustomerTotals>>({
    queryKey: ["customers", search, page],
    queryFn: () =>
      apiFetch(
        `/customers?search=${encodeURIComponent(search)}&is_active=true` +
          `&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      ),
  });
  const customers = paged?.items ?? [];

  const createMut = useMutation({
    mutationFn: (body: CreateCustomerInput) => apiFetch("/customers", { method: "POST", body: JSON.stringify(body) }),
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
  // Phase F (2026-09-17): the position has THREE components (D-4). The tile
  // that used to show the NET as "Outstanding AR" now shows the receivable
  // itself, and what we owe customers (credit-note balances + deposits) stands
  // beside it — a liability is never folded into AR as a negative.
  const totalAR = paged?.totals.receivable ?? 0;
  const owedToCustomers = (paged?.totals.creditBalance ?? 0) + (paged?.totals.depositBalance ?? 0);
  const totalBilled = paged?.totals.totalBilled ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("Customers", "العملاء")}
        description={<>{t("Accounts Receivable", "الحسابات المدينة")} — {paged?.page.total ?? 0} {t("active customers", "عميل نشط")}</>}
        actions={
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="w-4 h-4" /> {t("New Customer", "عميل جديد")}</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>{t("New Customer", "عميل جديد")}</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3 mt-2">
              {[["name",t("Company Name *","اسم الشركة *")],["nameAr","اسم الشركة"],["taxNumber",t("VAT Number","رقم ضريبة القيمة المضافة")],["crNumber",t("CR Number","رقم السجل التجاري")],["phone",t("Phone","الهاتف")],["email","Email"],["address",t("Address","العنوان")],["city",t("City","المدينة")],["paymentTermsDays",t("Payment Terms (days)","شروط الدفع (أيام)")],["creditLimit",t("Credit Limit (SAR)","حد الائتمان (ر.س)")]].map(([k,l])=>(
                <div key={k} className={k==="address"?"col-span-2":""}>
                  <Label className="text-[13px] text-muted-foreground">{l}</Label>
                  <Input value={(form as any)[k]} onChange={e=>setForm(p=>({...p,[k]:e.target.value}))} className="mt-1.5" />
                </div>
              ))}
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(toCreateInput(form))} disabled={!form.name || createMut.isPending}>
              {createMut.isPending ? t("Creating...", "جارٍ الإنشاء...") : t("Create Customer", "إنشاء عميل")}
            </Button>
          </DialogContent>
        </Dialog>
        }
      />

      <StatStrip cols={4}>
        <Stat label={t("Total Customers", "إجمالي العملاء")} value={paged?.page.total ?? 0} />
        <Stat label={t("Total Billed", "إجمالي المفوتر")} value={fmtNum(totalBilled)} />
        <Stat label={t("Accounts receivable", "الذمم المدينة")} value={<span data-testid="customers-total-receivable">{fmtNum(totalAR)}</span>} />
        <Stat label={t("Owed to customers (credits + deposits)", "مستحق للعملاء (أرصدة دائنة + عرابين)")} value={<span data-testid="customers-owed">{fmtNum(owedToCustomers)}</span>} />
      </StatStrip>

      <Panel flush>
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute start-3 top-2.5 w-4 h-4 text-muted-foreground" />
            <Input placeholder={t("Search customers...", "بحث عن العملاء...")} className="ps-9 h-9" value={search} onChange={e=>setSearch(e.target.value)} />
          </div>
        </div>
        {isLoading ? <div className="text-muted-foreground text-sm p-5">{t("Loading...", "جارٍ التحميل...")}</div> : customers.length === 0 ? (
          <EmptyState icon={Users} title={t("No customers yet. Add your first customer.", "لا يوجد عملاء بعد. أضف أول عميل.")} />
        ) : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="border-b border-border">{([
              [t("Customer","العميل"), false],
              [t("City","المدينة"), false],
              [t("VAT Number","رقم ضريبة القيمة المضافة"), false],
              [t("Payment Terms","شروط الدفع"), false],
              [t("Billed","المفوتر"), true],
              [t("Receivable","الذمم المدينة"), true],
              ["", false],
            ] as const).map(([h, num])=><th key={h} className={`${num ? "text-end" : "text-start"} px-3`}>{h}</th>)}</tr></thead>
            <tbody>{customers.map(c=>(
              <tr key={c.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors">
                <td className="py-3 px-3 min-w-[12rem]">
                  <div className="font-medium text-foreground">{c.name}</div>
                  {arabicFieldStatus(c.nameAr) === "ok"
                    ? <div className="text-xs text-muted-foreground" dir="rtl">{c.nameAr}</div>
                    : arabicFieldStatus(c.nameAr) === "wrong-script"
                    ? <div className="text-[11px] text-severe italic mt-0.5">⚠ {t("not Arabic script — please correct", "ليس نصًا عربيًا — يرجى التصحيح")}</div>
                    : <div className="text-[11px] text-attention italic mt-0.5">{t("needs Arabic translation", "يحتاج إلى ترجمة عربية")}</div>}
                </td>
                <td className="py-3 px-3 text-muted-foreground">{c.city||"—"}</td>
                <td className="py-3 px-3 whitespace-nowrap tabular-nums text-muted-foreground">{c.taxNumber||"—"}</td>
                <td className="py-3 px-3"><Badge variant="outline" className="text-xs tabular-nums">{c.paymentTermsDays ?? "—"}d</Badge></td>
                <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-foreground">{fmtNum(c.totalBilled??0)}</td>
                <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">
                  <span className="font-medium text-foreground">{fmtNum(c.receivable??0)}</span>
                  {((c.creditBalance ?? 0) + (c.depositBalance ?? 0)) > 0.005 && (
                    <span className="block text-xs text-info">{t("owed to them", "مستحق لهم")} {fmtNum((c.creditBalance ?? 0) + (c.depositBalance ?? 0))}</span>
                  )}
                </td>
                <td className="py-3 px-3 text-end"><Link href={`/customers/${c.id}`}><Button variant="ghost" size="sm" className="text-xs h-7">{t("View", "عرض")}</Button></Link></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <div className="border-t border-border px-5 pb-3 empty:hidden">
          <ListPagination
            page={paged?.page}
            shown={customers.length}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </div>
      </Panel>
    </div>
  );
}
