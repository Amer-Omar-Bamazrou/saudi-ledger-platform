import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Search, ShoppingBag } from "lucide-react";
import { PageHeader, StatStrip, Stat, Panel, FilterTabs, EmptyState } from "@/components/kit";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { ListPagination } from "@/components/ListPagination";
import { PAGE_SIZE, type Paged } from "@/lib/pagedList";

interface ProductTotals { serviceCount: number; productCount: number; vatApplicableCount: number; }

interface Product { id: number; code?: string; name: string; nameAr?: string; type: string; unitPrice: number; unitCost?: number; unit?: string; stockQty: number; reorderPoint?: number; vatApplicable: boolean; isActive: boolean; }

const emptyForm = { code: "", name: "", nameAr: "", type: "service", unitPrice: "", unitCost: "", unit: "unit", description: "", vatApplicable: true, stockQty: "0", reorderPoint: "" };

export default function Products() {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();

  const [page, setPage] = useState(0);
  const { data: paged, isLoading } = useQuery<Paged<Product, ProductTotals>>({
    queryKey: ["products", search, typeFilter, page],
    queryFn: () =>
      apiFetch(
        `/products?search=${encodeURIComponent(search)}${typeFilter !== "all" ? `&type=${typeFilter}` : ""}` +
          `&is_active=true&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      ),
  });
  const products = paged?.items ?? [];
  // Counts from the server, over the whole catalog — never the page.
  const counts = paged?.totals;

  const createMut = useMutation({
    mutationFn: (body: any) => apiFetch("/products", { method: "POST", body: JSON.stringify({ ...body, unitPrice: Number(body.unitPrice), unitCost: body.unitCost ? Number(body.unitCost) : null, stockQty: Number(body.stockQty || 0), reorderPoint: body.reorderPoint ? Number(body.reorderPoint) : null }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["products"] }); setOpen(false); setForm(emptyForm); toast({ title: t("Product created", "تم إنشاء المنتج") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const f = (k: string) => (e: any) => setForm(p => ({ ...p, [k]: e.target?.value ?? e }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("Products & Services", "المنتجات والخدمات")}
        description={<>{t("Item catalog for invoices and bills", "كتالوج العناصر للفواتير")} · {paged?.page.total ?? 0} {t("items", "عنصر")}</>}
        actions={
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> {t("New Item", "عنصر جديد")}</Button></DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>{t("New Product / Service", "منتج / خدمة جديدة")}</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3 mt-2">
              <div><Label className="text-[13px] text-muted-foreground">{t("Type", "النوع")}</Label>
                <Select value={form.type} onValueChange={v=>setForm(p=>({...p,type:v}))}><SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="service">{t("Service", "خدمة")}</SelectItem><SelectItem value="product">{t("Product", "منتج")}</SelectItem></SelectContent></Select>
              </div>
              <div><Label className="text-[13px] text-muted-foreground">{t("Code / SKU", "الرمز / الكود")}</Label><Input value={form.code} onChange={f("code")} className="mt-1.5" /></div>
              <div className="col-span-2"><Label className="text-[13px] text-muted-foreground">{t("Name *", "الاسم *")}</Label><Input value={form.name} onChange={f("name")} className="mt-1.5" /></div>
              <div className="col-span-2"><Label className="text-[13px] text-muted-foreground">الاسم بالعربي</Label><Input value={form.nameAr} onChange={f("nameAr")} className="mt-1.5" dir="rtl" /></div>
              <div><Label className="text-[13px] text-muted-foreground">{t("Unit Price (SAR) *", "سعر الوحدة (ر.س) *")}</Label><Input type="number" value={form.unitPrice} onChange={f("unitPrice")} className="mt-1.5 tabular-nums" /></div>
              <div><Label className="text-[13px] text-muted-foreground">{t("Unit Cost (SAR)", "تكلفة الوحدة (ر.س)")}</Label><Input type="number" value={form.unitCost} onChange={f("unitCost")} className="mt-1.5 tabular-nums" /></div>
              <div><Label className="text-[13px] text-muted-foreground">{t("Unit of Measure", "وحدة القياس")}</Label><Input value={form.unit} onChange={f("unit")} className="mt-1.5" placeholder={t("unit, hr, kg...", "وحدة، ساعة، كجم...")} /></div>
              <div><Label className="text-[13px] text-muted-foreground">{t("VAT Applicable", "خاضع لضريبة القيمة المضافة")}</Label>
                <Select value={String(form.vatApplicable)} onValueChange={v=>setForm(p=>({...p,vatApplicable:v==="true"}))}><SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="true">{t("Yes (15%)", "نعم (15%)")}</SelectItem><SelectItem value="false">{t("No / Exempt", "لا / معفى")}</SelectItem></SelectContent></Select>
              </div>
              {form.type === "product" && <>
                <div><Label className="text-[13px] text-muted-foreground">{t("Opening Stock Qty", "كمية المخزون الافتتاحية")}</Label><Input type="number" value={form.stockQty} onChange={f("stockQty")} className="mt-1.5 tabular-nums" /></div>
                <div><Label className="text-[13px] text-muted-foreground">{t("Reorder Point", "نقطة إعادة الطلب")}</Label><Input type="number" value={form.reorderPoint} onChange={f("reorderPoint")} className="mt-1.5 tabular-nums" /></div>
              </>}
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.name||!form.unitPrice||createMut.isPending}>{createMut.isPending ? t("Creating...", "جارٍ الإنشاء...") : t("Create Item", "إنشاء عنصر")}</Button>
          </DialogContent>
        </Dialog>
        }
      />

      <StatStrip cols={4}>
        <Stat label={t("Total Items","إجمالي العناصر")} value={paged?.page.total ?? 0} />
        <Stat label={t("Services","الخدمات")} value={counts?.serviceCount ?? 0} />
        <Stat label={t("Products","المنتجات")} value={counts?.productCount ?? 0} />
        <Stat label={t("VAT-Applicable","خاضع لضريبة القيمة المضافة")} value={counts?.vatApplicableCount ?? 0} />
      </StatStrip>

      <Panel flush>
        <FilterTabs
          options={["all","service","product"].map((tp) => ({ value: tp, label: tp === "all" ? t("all","الكل") : tp === "service" ? t("service","خدمة") : t("product","منتج") }))}
          value={typeFilter}
          onChange={setTypeFilter}
          className="[&_button]:capitalize"
          end={
            <div className="relative w-64 max-w-full">
              <Search className="absolute start-3 top-2.5 w-4 h-4 text-muted-foreground" />
              <Input placeholder={t("Search items...", "بحث عن العناصر...")} className="ps-9 h-9" value={search} onChange={e=>setSearch(e.target.value)} />
            </div>
          }
        />
        {isLoading ? <div className="text-muted-foreground text-sm p-5">{t("Loading...", "جارٍ التحميل...")}</div> : products.length === 0 ? (
          <EmptyState icon={ShoppingBag} title={t("No items yet. Add your first product or service.", "لا توجد عناصر بعد. أضف أول منتج أو خدمة.")} />
        ) : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="border-b border-border">{([
              [t("Item","العنصر"), false],
              [t("Type","النوع"), false],
              [t("Unit","الوحدة"), false],
              [t("Price","السعر"), true],
              [t("Cost","التكلفة"), true],
              [t("Margin","هامش الربح"), true],
              [t("Stock","المخزون"), true],
              [t("VAT","ضريبة القيمة المضافة"), false],
            ] as const).map(([h, num])=><th key={h} className={`${num ? "text-end" : "text-start"} px-3`}>{h}</th>)}</tr></thead>
            <tbody>{products.map(p=>{
              const margin = p.unitCost && p.unitPrice > 0 ? ((p.unitPrice - p.unitCost) / p.unitPrice * 100) : null;
              return (
                <tr key={p.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors">
                  <td className="py-3 px-3"><div className="font-medium">{p.name}</div>{p.code&&<div className="text-xs text-muted-foreground">{p.code}</div>}</td>
                  <td className="py-3 px-3"><Badge variant="outline" className="text-xs">{p.type === "service" ? t("Service", "خدمة") : p.type === "product" ? t("Product", "منتج") : p.type}</Badge></td>
                  <td className="py-3 px-3 text-muted-foreground">{p.unit === "unit" ? t("unit", "وحدة") : (p.unit || "—")}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(p.unitPrice)}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{p.unitCost ? fmtNum(p.unitCost) : "—"}</td>
                  {/* A margin is a ratio, not a state — neutral, never a status colour (CLAUDE.md §4). */}
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{margin != null ? `${margin.toFixed(1)}%` : "—"}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{p.type==="product"?<span className={p.reorderPoint && p.stockQty <= p.reorderPoint ? "text-negative" : "text-foreground"}>{p.stockQty}</span>:"—"}</td>
                  <td className="py-3 px-3"><Badge className={`text-xs ${p.vatApplicable?"bg-info-surface/20 text-info":"bg-secondary text-muted-foreground"}`}>{p.vatApplicable ? t("15%","15%") : t("Exempt","معفى")}</Badge></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
        <div className="border-t border-border px-5 pb-3 empty:hidden">
          <ListPagination
            page={paged?.page}
            shown={products.length}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        </div>
      </Panel>
    </div>
  );
}
