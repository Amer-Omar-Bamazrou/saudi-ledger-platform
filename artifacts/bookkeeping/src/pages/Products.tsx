import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Search, ShoppingBag } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Product { id: number; code?: string; name: string; nameAr?: string; type: string; unitPrice: number; unitCost?: number; unit?: string; stockQty: number; reorderPoint?: number; vatApplicable: boolean; isActive: boolean; }

const emptyForm = { code: "", name: "", nameAr: "", type: "service", unitPrice: "", unitCost: "", unit: "unit", description: "", vatApplicable: true, stockQty: "0", reorderPoint: "" };

export default function Products() {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: products = [], isLoading } = useQuery<Product[]>({
    queryKey: ["products", search, typeFilter],
    queryFn: () => apiFetch(`/products?search=${encodeURIComponent(search)}${typeFilter !== "all" ? `&type=${typeFilter}` : ""}&is_active=true`),
  });

  const createMut = useMutation({
    mutationFn: (body: any) => apiFetch("/products", { method: "POST", body: JSON.stringify({ ...body, unitPrice: Number(body.unitPrice), unitCost: body.unitCost ? Number(body.unitCost) : null, stockQty: Number(body.stockQty || 0), reorderPoint: body.reorderPoint ? Number(body.reorderPoint) : null }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["products"] }); setOpen(false); setForm(emptyForm); toast({ title: "Product created" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const f = (k: string) => (e: any) => setForm(p => ({ ...p, [k]: e.target?.value ?? e }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Products & Services</h1>
          <p className="text-muted-foreground text-sm mt-1">Item catalog for invoices and bills · {products.length} items</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> New Item</Button></DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>New Product / Service</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3 mt-2">
              <div><Label className="text-xs text-muted-foreground">Type</Label>
                <Select value={form.type} onValueChange={v=>setForm(p=>({...p,type:v}))}><SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="service">Service</SelectItem><SelectItem value="product">Product</SelectItem></SelectContent></Select>
              </div>
              <div><Label className="text-xs text-muted-foreground">Code / SKU</Label><Input value={form.code} onChange={f("code")} className="mt-1 h-8 text-sm" /></div>
              <div className="col-span-2"><Label className="text-xs text-muted-foreground">Name *</Label><Input value={form.name} onChange={f("name")} className="mt-1 h-8 text-sm" /></div>
              <div className="col-span-2"><Label className="text-xs text-muted-foreground">الاسم بالعربي</Label><Input value={form.nameAr} onChange={f("nameAr")} className="mt-1 h-8 text-sm" dir="rtl" /></div>
              <div><Label className="text-xs text-muted-foreground">Unit Price (SAR) *</Label><Input type="number" value={form.unitPrice} onChange={f("unitPrice")} className="mt-1 h-8 text-sm font-mono" /></div>
              <div><Label className="text-xs text-muted-foreground">Unit Cost (SAR)</Label><Input type="number" value={form.unitCost} onChange={f("unitCost")} className="mt-1 h-8 text-sm font-mono" /></div>
              <div><Label className="text-xs text-muted-foreground">Unit of Measure</Label><Input value={form.unit} onChange={f("unit")} className="mt-1 h-8 text-sm" placeholder="unit, hr, kg..." /></div>
              <div><Label className="text-xs text-muted-foreground">VAT Applicable</Label>
                <Select value={String(form.vatApplicable)} onValueChange={v=>setForm(p=>({...p,vatApplicable:v==="true"}))}><SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="true">Yes (15%)</SelectItem><SelectItem value="false">No / Exempt</SelectItem></SelectContent></Select>
              </div>
              {form.type === "product" && <>
                <div><Label className="text-xs text-muted-foreground">Opening Stock Qty</Label><Input type="number" value={form.stockQty} onChange={f("stockQty")} className="mt-1 h-8 text-sm font-mono" /></div>
                <div><Label className="text-xs text-muted-foreground">Reorder Point</Label><Input type="number" value={form.reorderPoint} onChange={f("reorderPoint")} className="mt-1 h-8 text-sm font-mono" /></div>
              </>}
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.name||!form.unitPrice||createMut.isPending}>{createMut.isPending?"Creating...":"Create Item"}</Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[["Total Items", products.length, "text-primary"],["Services", products.filter(p=>p.type==="service").length, "text-blue-400"],["Products", products.filter(p=>p.type==="product").length, "text-amber-400"],["VAT-Applicable", products.filter(p=>p.vatApplicable).length, "text-muted-foreground"]].map(([l,v,c])=>(
          <Card key={String(l)} className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent></Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search items..." className="pl-9 h-9" value={search} onChange={e=>setSearch(e.target.value)} />
            </div>
            {["all","service","product"].map(t=><Button key={t} variant={typeFilter===t?"default":"ghost"} size="sm" className="h-7 text-xs capitalize" onClick={()=>setTypeFilter(t)}>{t}</Button>)}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <div className="text-muted-foreground text-sm p-4">Loading...</div> : products.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><ShoppingBag className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>No items yet. Add your first product or service.</p></div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{["Item","Type","Unit","Price","Cost","Margin","Stock","VAT"].map(h=><th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>)}</tr></thead>
              <tbody>{products.map(p=>{
                const margin = p.unitCost && p.unitPrice > 0 ? ((p.unitPrice - p.unitCost) / p.unitPrice * 100) : null;
                return (
                  <tr key={p.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                    <td className="py-3 pr-4"><div className="font-medium">{p.name}</div>{p.code&&<div className="text-xs text-muted-foreground font-mono">{p.code}</div>}</td>
                    <td className="py-3 pr-4"><Badge variant="outline" className="text-xs capitalize">{p.type}</Badge></td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{p.unit||"—"}</td>
                    <td className="py-3 pr-4 font-mono">{fmtNum(p.unitPrice)}</td>
                    <td className="py-3 pr-4 font-mono text-muted-foreground">{p.unitCost ? fmtNum(p.unitCost) : "—"}</td>
                    <td className="py-3 pr-4"><span className={`font-mono text-xs ${margin && margin > 30 ? "text-emerald-400" : margin && margin > 0 ? "text-amber-400" : "text-muted-foreground"}`}>{margin != null ? `${margin.toFixed(1)}%` : "—"}</span></td>
                    <td className="py-3 pr-4 font-mono text-xs">{p.type==="product"?<span className={p.reorderPoint && p.stockQty <= p.reorderPoint ? "text-red-400" : "text-foreground"}>{p.stockQty}</span>:"—"}</td>
                    <td className="py-3"><Badge className={`text-xs ${p.vatApplicable?"bg-blue-500/20 text-blue-400":"bg-secondary text-muted-foreground"}`}>{p.vatApplicable?"15%":"Exempt"}</Badge></td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
