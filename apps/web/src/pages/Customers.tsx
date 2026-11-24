import { useState } from "react";
import { Link } from "wouter";
import { arabicActiveCustomers, arabicDays, arabicNameStatus, englishActiveCustomers } from "@/lib/arabicUtils";
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
import { CustomerForm } from "@/components/customers/CustomerForm";
import { Withheld } from "@/components/Withheld";
import { useGetCustomerFieldAccess } from "@workspace/api-client-react";
import { ListPagination } from "@/components/ListPagination";
import { PAGE_SIZE, type Paged } from "@/lib/pagedList";

import type { CreateCustomerInput, CustomerTotals, CustomerWithBalance } from "@workspace/api-client-react";




// The create form is the shared CustomerForm (components/customers): the structured national address and the national
// ID, role-aware (2026-11-24).
export default function Customers() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, lang } = useLanguage();
  // 19B S2b (D4): what this role may read of the record, from the server's one class table and matrix — a withheld field is marked
  const access = useGetCustomerFieldAccess();
  const cityWithheld = access.data?.fields.city?.read === "none";

  const { data: paged, isLoading } = useQuery<Paged<CustomerWithBalance, CustomerTotals>>({
    queryKey: ["customers", search, page],
    queryFn: () =>
      apiFetch(
        `/customers?search=${encodeURIComponent(search)}&is_active=true` +
          `&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      ),
  });
  const customers = paged?.items ?? [];


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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Customers", "العملاء")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Accounts Receivable", "الحسابات المدينة")} — {lang === "ar" ? arabicActiveCustomers(paged?.page.total ?? 0) : englishActiveCustomers(paged?.page.total ?? 0)}</p>
        </div>
        <Button className="gap-2" onClick={() => setOpen(true)} data-testid="customer-new"><Plus className="w-4 h-4" /> {t("New Customer", "عميل جديد")}</Button>
        <CustomerForm mode="create" access={access.data} open={open} onOpenChange={setOpen} />
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Total Customers", "إجمالي العملاء")}</CardTitle></CardHeader><CardContent><div className="text-xl sm:text-2xl font-bold font-mono text-primary">{paged?.page.total ?? 0}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Total Billed", "إجمالي المفوتر")}</CardTitle></CardHeader><CardContent><div className="text-xl sm:text-2xl font-bold font-mono text-foreground">{fmtNum(totalBilled)}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Accounts receivable", "الذمم المدينة")}</CardTitle></CardHeader><CardContent><div className={`text-xl sm:text-2xl font-bold font-mono ${totalAR > 0 ? "text-attention" : "text-positive"}`} data-testid="customers-total-receivable">{fmtNum(totalAR)}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("Owed to customers (credits + deposits)", "مستحق للعملاء (أرصدة دائنة + عرابين)")}</CardTitle></CardHeader><CardContent><div className="text-xl sm:text-2xl font-bold font-mono text-info" data-testid="customers-owed">{fmtNum(owedToCustomers)}</div></CardContent></Card>
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
            <div className="overflow-x-auto"><table className="w-full text-sm table-cards">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{[t("Customer","العميل"),t("City","المدينة"),t("VAT Number","رقم ضريبة القيمة المضافة"),t("Payment Terms","شروط الدفع"),t("Billed","المفوتر"),t("Receivable","الذمم المدينة"),""].map(h=><th key={h} className="text-start pb-2 pe-4 font-medium">{h}</th>)}</tr></thead>
              <tbody>{customers.map(c=>(
                <tr key={c.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="py-3 pe-4" data-label={t("Customer", "العميل")}>
                    <div className="font-medium text-foreground">{c.name}</div>
                    {arabicNameStatus(c.name, c.nameAr) === "ok"
                      ? (c.nameAr ? <div className="text-xs text-muted-foreground" dir="rtl">{c.nameAr}</div> : null)
                      : arabicNameStatus(c.name, c.nameAr) === "wrong-script"
                      ? <div className="text-[10px] text-orange-400 italic mt-0.5">⚠ {t("not Arabic script — please correct", "ليس نصًا عربيًا — يرجى التصحيح")}</div>
                      : <div className="text-[10px] text-attention-surface/60 italic mt-0.5">{t("needs Arabic translation", "يحتاج إلى ترجمة عربية")}</div>}
                  </td>
                  <td className="py-3 pe-4 text-muted-foreground" data-label={t("City", "المدينة")}>{cityWithheld ? <Withheld cls="contact" testId={`customer-city-withheld-${c.id}`} /> : c.city||"—"}</td>
                  <td className="py-3 pe-4 font-mono text-xs text-muted-foreground" data-label={t("VAT Number", "رقم ضريبة القيمة المضافة")}>{c.taxNumber||"—"}</td>
                  <td className="py-3 pe-4" data-label={t("Payment Terms", "شروط الدفع")}><Badge variant="outline" className="text-xs font-mono">{c.paymentTermsDays == null ? "—" : t(`${c.paymentTermsDays}d`, arabicDays(Number(c.paymentTermsDays)))}</Badge></td>
                  <td className="py-3 pe-4 font-mono text-foreground" data-label={t("Billed", "المفوتر")}>{fmtNum(c.totalBilled??0)}</td>
                  <td className="py-3 pe-4" data-label={t("Receivable", "الذمم المدينة")}>
                    <span className={`font-mono font-medium ${(c.receivable??0)>0?"text-attention":"text-positive"}`}>{fmtNum(c.receivable??0)}</span>
                    {((c.creditBalance ?? 0) + (c.depositBalance ?? 0)) > 0.005 && (
                      <span className="block text-xs text-info font-mono">{t("owed to them", "مستحق لهم")} {fmtNum((c.creditBalance ?? 0) + (c.depositBalance ?? 0))}</span>
                    )}
                  </td>
                  <td className="py-3"><Link href={`/customers/${c.id}`}><Button variant="ghost" size="sm" className="text-xs h-7">{t("View", "عرض")}</Button></Link></td>
                </tr>
              ))}</tbody>
            </table></div>
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
