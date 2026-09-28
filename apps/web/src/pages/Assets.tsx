/**
 * FIXED ASSETS — the register (FA-A, 2026-09-22).
 *
 * What the page shows is what the server DERIVES: accumulated depreciation and
 * the carrying amount come from the posted schedule rows, never a stored
 * column. A new asset is a DRAFT — its facts and nothing posted; capitalising
 * it (the entry that puts the cost in the books) and running depreciation are
 * their own acts, arriving with the next FA phases.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Package } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { ListPagination } from "@/components/ListPagination";
import { PAGE_SIZE, type Paged } from "@/lib/pagedList";
import { DualDate } from "@/components/DualDate";
import { Link } from "wouter";
import { businessToday } from "@workspace/shared";
import type { Asset, AssetTotals, AssetCategory, IncomeTaxGroup, CreateAssetInput, CreateAssetCategoryInput } from "@workspace/api-client-react";

type Categories = { items: AssetCategory[]; incomeTaxGroups: IncomeTaxGroup[] };

const emptyAsset = { assetNumber: "", name: "", nameAr: "", categoryId: "", acquisitionDate: businessToday(), availableForUseDate: "", cost: "", residualValue: "", usefulLifeMonths: "", serialNumber: "", location: "", vatInputTaxAmount: "", notes: "" };
const emptyCategory = { name: "", nameAr: "", defaultUsefulLifeMonths: "60", incomeTaxGroup: "3", vatCapitalAssetClass: "movable", defaultResidualPct: "0" };

export function useAssetCategories() {
  return useQuery<Categories>({ queryKey: ["asset-categories"], queryFn: () => apiFetch("/asset-categories") });
}

export function statusLabel(t: (en: string, ar: string) => string, a: Pick<Asset, "status" | "fullyDepreciated">) {
  if (a.status === "in_service" && a.fullyDepreciated) return t("Fully depreciated", "مُهلك بالكامل");
  return ({ draft: t("Draft", "مسودة"), in_service: t("In service", "في الخدمة"), disposed: t("Disposed", "مستبعد"), cancelled: t("Cancelled", "ملغى") } as Record<string, string>)[a.status] ?? a.status;
}

const STATUS_STYLES: Record<string, string> = { draft: "bg-secondary text-muted-foreground", in_service: "bg-positive-surface/20 text-positive", disposed: "bg-negative-surface/20 text-negative", cancelled: "bg-secondary text-muted-foreground" };

export default function Assets() {
  const [open, setOpen] = useState(false);
  const [catOpen, setCatOpen] = useState(false);
  const [form, setForm] = useState(emptyAsset);
  const [catForm, setCatForm] = useState(emptyCategory);
  const [page, setPage] = useState(0);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, lang } = useLanguage();

  const { data: paged, isLoading } = useQuery<Paged<Asset, AssetTotals>>({
    queryKey: ["assets", page],
    queryFn: () => apiFetch(`/assets?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`),
  });
  const { data: cats } = useAssetCategories();
  const assets = paged?.items ?? [];
  const category = cats?.items.find((c) => String(c.id) === form.categoryId) ?? null;

  const createMut = useMutation({
    mutationFn: () => {
      const body: CreateAssetInput = {
        assetNumber: form.assetNumber.trim() || null, name: form.name.trim(), nameAr: form.nameAr.trim() || null, categoryId: Number(form.categoryId),
        acquisitionDate: form.acquisitionDate, availableForUseDate: form.availableForUseDate || null, cost: Number(form.cost),
        residualValue: form.residualValue === "" ? null : Number(form.residualValue), usefulLifeMonths: form.usefulLifeMonths === "" ? null : Number(form.usefulLifeMonths),
        serialNumber: form.serialNumber.trim() || null, location: form.location.trim() || null, vatInputTaxAmount: form.vatInputTaxAmount === "" ? null : Number(form.vatInputTaxAmount), notes: form.notes.trim() || null,
      };
      return apiFetch<Asset>("/assets", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (a) => { qc.invalidateQueries({ queryKey: ["assets"] }); qc.invalidateQueries({ queryKey: ["asset-categories"] }); setOpen(false); setForm(emptyAsset); toast({ title: t("Asset registered as a draft", "سُجّل الأصل كمسودة"), description: `${a.assetNumber} · ${a.name}` }); },
  });
  const createCatMut = useMutation({
    mutationFn: () => {
      const body: CreateAssetCategoryInput = { name: catForm.name.trim(), nameAr: catForm.nameAr.trim() || null, defaultUsefulLifeMonths: Number(catForm.defaultUsefulLifeMonths), incomeTaxGroup: Number(catForm.incomeTaxGroup), vatCapitalAssetClass: catForm.vatCapitalAssetClass as CreateAssetCategoryInput["vatCapitalAssetClass"], defaultResidualPct: Number(catForm.defaultResidualPct) };
      return apiFetch<AssetCategory>("/asset-categories", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (c) => { qc.invalidateQueries({ queryKey: ["asset-categories"] }); setCatOpen(false); setCatForm(emptyCategory); setForm((f) => ({ ...f, categoryId: String(c.id) })); toast({ title: t("Category created", "أُنشئت الفئة"), description: c.name }); },
  });

  const totals = paged?.totals;
  const cost = Number(form.cost) || 0;
  const life = form.usefulLifeMonths === "" ? category?.defaultUsefulLifeMonths ?? 0 : Number(form.usefulLifeMonths);
  const residual = form.residualValue === "" ? (category ? (cost * category.defaultResidualPct) / 100 : 0) : Number(form.residualValue);
  const monthly = life > 0 ? (cost - residual) / life : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("Fixed Assets", "الأصول الثابتة")}
        description={t("The register · straight-line monthly depreciation · figures derived from the posted schedule", "سجل الأصول · إهلاك شهري بالقسط الثابت · الأرقام مشتقة من الجدول المرحَّل")}
        actions={
        <>
          <Dialog open={catOpen} onOpenChange={setCatOpen}>
            <DialogTrigger asChild><Button variant="outline" className="gap-2" data-testid="new-asset-category"><Plus className="w-4 h-4" /> {t("Category", "فئة")}</Button></DialogTrigger>
            <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid="asset-category-dialog">
              <DialogHeader>
                <DialogTitle>{t("New asset category", "فئة أصول جديدة")}</DialogTitle>
                <DialogDescription>{t("A category binds its assets to one account triple (cost, accumulated depreciation, depreciation expense) and to the two Saudi classifications every asset inherits: the Income Tax Law Art. 17 group and the VAT Art. 52 capital-asset class.", "تربط الفئة أصولها بثلاثية حسابات واحدة (التكلفة، مجمع الإهلاك، مصروف الإهلاك) وبالتصنيفين السعوديين اللذين يرثهما كل أصل: مجموعة المادة 17 من نظام ضريبة الدخل وفئة الأصل الرأسمالي وفق المادة 52 من لائحة ضريبة القيمة المضافة.")}</DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2"><Label className="text-[13px] text-muted-foreground">{t("Name *", "الاسم *")}</Label><Input value={catForm.name} onChange={(e) => setCatForm((p) => ({ ...p, name: e.target.value }))} className="mt-1 h-9" data-testid="category-name" /></div>
                <div className="col-span-2"><Label className="text-[13px] text-muted-foreground">{t("Arabic name", "الاسم بالعربية")}</Label><Input value={catForm.nameAr} onChange={(e) => setCatForm((p) => ({ ...p, nameAr: e.target.value }))} className="mt-1 h-9" dir="rtl" /></div>
                <div><Label className="text-[13px] text-muted-foreground">{t("Default life (months)", "العمر الافتراضي (أشهر)")}</Label><Input type="number" min={1} value={catForm.defaultUsefulLifeMonths} onChange={(e) => setCatForm((p) => ({ ...p, defaultUsefulLifeMonths: e.target.value }))} className="mt-1 h-9 font-mono" data-testid="category-life" /></div>
                <div><Label className="text-[13px] text-muted-foreground">{t("Default residual %", "نسبة القيمة المتبقية الافتراضية")}</Label><Input type="number" min={0} max={99} value={catForm.defaultResidualPct} onChange={(e) => setCatForm((p) => ({ ...p, defaultResidualPct: e.target.value }))} className="mt-1 h-9 font-mono" /></div>
                <div className="col-span-2"><Label className="text-[13px] text-muted-foreground">{t("Income tax group (Art. 17)", "مجموعة ضريبة الدخل (المادة 17)")}</Label>
                  <Select value={catForm.incomeTaxGroup} onValueChange={(v) => setCatForm((p) => ({ ...p, incomeTaxGroup: v }))}>
                    <SelectTrigger className="mt-1 h-9" data-testid="category-tax-group"><SelectValue /></SelectTrigger>
                    <SelectContent>{(cats?.incomeTaxGroups ?? []).map((g) => <SelectItem key={g.group} value={String(g.group)}>{g.group} · {lang === "ar" ? g.labelAr : g.label} · {g.ratePct}%</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="col-span-2"><Label className="text-[13px] text-muted-foreground">{t("VAT capital-asset class (Art. 52)", "فئة الأصل الرأسمالي لضريبة القيمة المضافة (المادة 52)")}</Label>
                  <Select value={catForm.vatCapitalAssetClass} onValueChange={(v) => setCatForm((p) => ({ ...p, vatCapitalAssetClass: v }))}>
                    <SelectTrigger className="mt-1 h-9" data-testid="category-vat-class"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="movable">{t("Movable (6-year adjustment period)", "منقول (فترة تعديل 6 سنوات)")}</SelectItem>
                      <SelectItem value="immovable">{t("Immovable (10-year adjustment period)", "غير منقول (فترة تعديل 10 سنوات)")}</SelectItem>
                      <SelectItem value="not_capital">{t("Not a capital asset", "ليس أصلًا رأسماليًا")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button className="w-full mt-2" onClick={() => createCatMut.mutate()} disabled={!catForm.name.trim() || createCatMut.isPending} data-testid="category-submit">{createCatMut.isPending ? t("Saving…", "جارٍ الحفظ…") : t("Create category", "إنشاء الفئة")}</Button>
            </DialogContent>
          </Dialog>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button className="gap-2" data-testid="new-asset"><Plus className="w-4 h-4" /> {t("Register asset", "تسجيل أصل")}</Button></DialogTrigger>
            <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-lg" data-testid="asset-dialog">
              <DialogHeader>
                <DialogTitle>{t("Register a fixed asset", "تسجيل أصل ثابت")}</DialogTitle>
                <DialogDescription>{t("A draft: its facts are recorded and nothing is posted. Capitalising it puts the cost in the books; depreciation starts in the month it is available for use (IAS 16.55).", "مسودة: تُسجَّل حقائقه ولا يُرحَّل شيء. الرسملة تضع التكلفة في الدفاتر؛ ويبدأ الإهلاك في الشهر الذي يصبح فيه جاهزًا للاستخدام (معيار المحاسبة الدولي 16.55).")}</DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2"><Label className="text-[13px] text-muted-foreground">{t("Category *", "الفئة *")}</Label>
                  <Select value={form.categoryId} onValueChange={(v) => setForm((p) => ({ ...p, categoryId: v }))}>
                    <SelectTrigger className="mt-1 h-9" data-testid="asset-category"><SelectValue placeholder={t("Choose a category", "اختر فئة")} /></SelectTrigger>
                    <SelectContent>{(cats?.items ?? []).map((c) => <SelectItem key={c.id} value={String(c.id)}>{lang === "ar" && c.nameAr ? c.nameAr : c.name}</SelectItem>)}</SelectContent>
                  </Select>
                  {cats && cats.items.length === 0 && <p className="text-[11px] text-muted-foreground mt-1">{t("No category yet — create one first.", "لا توجد فئة بعد — أنشئ واحدة أولًا.")}</p>}
                </div>
                <div><Label className="text-[13px] text-muted-foreground">{t("Asset #", "رقم الأصل")}</Label><Input value={form.assetNumber} onChange={(e) => setForm((p) => ({ ...p, assetNumber: e.target.value }))} placeholder={t("auto", "تلقائي")} className="mt-1 h-9 font-mono" dir="ltr" data-testid="asset-number" /></div>
                <div><Label className="text-[13px] text-muted-foreground">{t("Serial number", "الرقم التسلسلي")}</Label><Input value={form.serialNumber} onChange={(e) => setForm((p) => ({ ...p, serialNumber: e.target.value }))} className="mt-1 h-9" dir="ltr" /></div>
                <div><Label className="text-[13px] text-muted-foreground">{t("Name *", "الاسم *")}</Label><Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="mt-1 h-9" data-testid="asset-name" /></div>
                <div><Label className="text-[13px] text-muted-foreground">{t("Arabic name", "الاسم بالعربية")}</Label><Input value={form.nameAr} onChange={(e) => setForm((p) => ({ ...p, nameAr: e.target.value }))} className="mt-1 h-9" dir="rtl" /></div>
                <div><Label className="text-[13px] text-muted-foreground">{t("Acquisition date *", "تاريخ الاقتناء *")}</Label><Input type="date" value={form.acquisitionDate} onChange={(e) => setForm((p) => ({ ...p, acquisitionDate: e.target.value }))} className="mt-1 h-9" data-testid="asset-acquired" /></div>
                <div><Label className="text-[13px] text-muted-foreground">{t("Available for use", "جاهز للاستخدام")}</Label><Input type="date" value={form.availableForUseDate} onChange={(e) => setForm((p) => ({ ...p, availableForUseDate: e.target.value }))} className="mt-1 h-9" data-testid="asset-available" /></div>
                <div><Label className="text-[13px] text-muted-foreground">{t("Cost (SAR, net of deductible VAT) *", "التكلفة (ر.س، بدون الضريبة القابلة للخصم) *")}</Label><Input type="number" min={0} step="0.01" value={form.cost} onChange={(e) => setForm((p) => ({ ...p, cost: e.target.value }))} className="mt-1 h-9 font-mono" dir="ltr" data-testid="asset-cost" /></div>
                <div><Label className="text-[13px] text-muted-foreground">{t("Input VAT deducted", "ضريبة المدخلات المخصومة")}</Label><Input type="number" min={0} step="0.01" value={form.vatInputTaxAmount} onChange={(e) => setForm((p) => ({ ...p, vatInputTaxAmount: e.target.value }))} className="mt-1 h-9 font-mono" dir="ltr" /></div>
                <div><Label className="text-[13px] text-muted-foreground">{t("Residual value", "القيمة المتبقية")}</Label><Input type="number" min={0} step="0.01" value={form.residualValue} onChange={(e) => setForm((p) => ({ ...p, residualValue: e.target.value }))} placeholder={category ? fmtNum((cost * category.defaultResidualPct) / 100) : ""} className="mt-1 h-9 font-mono" dir="ltr" /></div>
                <div><Label className="text-[13px] text-muted-foreground">{t("Useful life (months)", "العمر الإنتاجي (أشهر)")}</Label><Input type="number" min={1} value={form.usefulLifeMonths} onChange={(e) => setForm((p) => ({ ...p, usefulLifeMonths: e.target.value }))} placeholder={category ? String(category.defaultUsefulLifeMonths) : ""} className="mt-1 h-9 font-mono" dir="ltr" data-testid="asset-life" /></div>
                <div><Label className="text-[13px] text-muted-foreground">{t("Location", "الموقع")}</Label><Input value={form.location} onChange={(e) => setForm((p) => ({ ...p, location: e.target.value }))} className="mt-1 h-9" /></div>
                {cost > 0 && life > 0 && (
                  <div className="col-span-2 bg-secondary/30 rounded-lg p-3 text-xs" data-testid="asset-preview">
                    <div className="flex justify-between"><span>{t("Depreciable amount", "المبلغ القابل للإهلاك")}</span><span className="font-mono">{fmtNum(cost - residual)}</span></div>
                    <div className="flex justify-between mt-0.5"><span>{t("Per month (straight-line)", "شهريًا (القسط الثابت)")}</span><span className="font-mono text-attention">{fmtNum(monthly)}</span></div>
                    {category && <div className="flex justify-between mt-0.5 text-muted-foreground"><span>{t("Income tax group · VAT class", "مجموعة ضريبة الدخل · فئة ض.ق.م")}</span><span>{category.incomeTaxGroup} ({category.incomeTaxRatePct}%) · {category.vatCapitalAssetClass}</span></div>}
                  </div>
                )}
              </div>
              <Button className="w-full mt-2" onClick={() => createMut.mutate()} disabled={!form.name.trim() || !form.categoryId || form.cost === "" || createMut.isPending} data-testid="asset-submit">{createMut.isPending ? t("Registering…", "جارٍ التسجيل…") : t("Register as a draft", "تسجيل كمسودة")}</Button>
            </DialogContent>
          </Dialog>
        </>
        }
      />

      <StatStrip cols={4}>
        <Stat label={t("In service", "في الخدمة")} value={<span data-testid="kpi-in-service">{String(totals?.inService ?? 0)}</span>} />
        <Stat label={t("Cost", "التكلفة")} value={<span data-testid="kpi-cost">{fmtNum(totals?.cost ?? 0)}</span>} />
        <Stat label={t("Accumulated depreciation", "مجمع الإهلاك")} value={<span data-testid="kpi-accumulated">{fmtNum(totals?.accumulatedDepreciation ?? 0)}</span>} />
        <Stat label={t("Carrying amount", "القيمة الدفترية")} value={<span data-testid="kpi-carrying">{fmtNum(totals?.carryingAmount ?? 0)}</span>} />
      </StatStrip>

      <Panel flush>
          {isLoading ? <div className="text-muted-foreground text-sm p-5">{t("Loading…", "جارٍ التحميل…")}</div> : assets.length === 0 ? (
            <EmptyState data-testid="assets-empty" icon={Package} title={t("No fixed assets registered.", "لا توجد أصول ثابتة مسجلة.")} description={t("Register an asset to start its depreciation schedule.", "سجّل أصلًا لبدء جدول إهلاكه.")} />
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="border-b border-border">{([[t("Asset", "الأصل"), false], [t("Category", "الفئة"), false], [t("Acquired", "الاقتناء"), false], [t("Cost", "التكلفة"), true], [t("Accum. dep.", "مجمع الإهلاك"), true], [t("Carrying", "القيمة الدفترية"), true], [t("Life", "العمر"), true], [t("Status", "الحالة"), false]] as const).map(([h, num]) => <th key={h} className={`px-3 ${num ? "text-end" : "text-start"}`}>{h}</th>)}</tr></thead>
              <tbody>{assets.map((a) => (
                <tr key={a.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors" data-testid={`asset-row-${a.assetNumber}`}>
                  <td className="py-3 px-3"><Link href={`/assets/${a.id}`} className="font-medium text-primary hover:underline" data-testid={`open-asset-${a.assetNumber}`}>{lang === "ar" && a.nameAr ? a.nameAr : a.name}</Link><div className="text-xs text-muted-foreground tabular-nums" dir="ltr">{a.assetNumber}</div></td>
                  <td className="py-3 px-3 text-[13px]">{a.categoryName ?? "—"}</td>
                  <td className="py-3 px-3 text-muted-foreground whitespace-nowrap"><DualDate date={a.acquisitionDate} /></td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(a.cost)}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{fmtNum(a.accumulatedDepreciation)}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums font-semibold">{fmtNum(a.carryingAmount)}</td>
                  <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums text-[13px] text-muted-foreground">{a.postedPeriods}/{a.usefulLifeMonths}</td>
                  <td className="py-3 px-3"><Badge className={`text-xs capitalize ${STATUS_STYLES[a.status] ?? ""}`} data-testid={`asset-status-${a.assetNumber}`}>{statusLabel(t, a)}</Badge></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          <div className="border-t border-border px-5 pb-3 empty:hidden">
            <ListPagination page={paged?.page} shown={assets.length} onPrev={() => setPage((p) => Math.max(0, p - 1))} onNext={() => setPage((p) => p + 1)} />
          </div>
      </Panel>
    </div>
  );
}
