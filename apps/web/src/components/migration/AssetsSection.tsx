/**
 * FA-D (2026-09-22) — the FIXED ASSETS the previous system held at cut-off.
 * Record: docs/product/fixed-assets-decision-pack.md §10, §23.
 *
 * 🔴 A migrated asset creates NO journal line: its cost and its accumulated
 * depreciation are already in the staged trial balance (A5 — one balanced
 * opening position, never a plug). The register therefore has to TIE to the
 * accounts its category names, and the section says so plainly beside the two
 * figures, because a register that does not tie is two truths.
 */
import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Package, Upload, Pencil, Plus } from "lucide-react";
import { DualDate } from "@/components/DualDate";
import { EmptyState, Money, Problems, focusClass, useCanRunMigration, useFocusRow, useMigrationAssets, useWorkspaceNav } from "./shared";
import { ImportDialog, RowEditorDialog } from "./StagingEditors";

export function AssetsSection({ batchId, editable }: { batchId: number; editable: boolean }) {
  const { t } = useLanguage();
  const canRun = useCanRunMigration();
  const { focus, blockedOnly } = useWorkspaceNav();
  const { data, isLoading, error } = useMigrationAssets(batchId);
  const [importing, setImporting] = useState(false);
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [onlyBlocked, setOnlyBlocked] = useState(blockedOnly);
  useFocusRow(focus, !!data);
  const can = editable && canRun;
  const all = data?.rows ?? [];
  const rows = useMemo(() => all.filter((r) => !onlyBlocked || r.problems.length > 0), [all, onlyBlocked]);
  useEffect(() => { if (onlyBlocked && data && data.summary.blocked === 0) setOnlyBlocked(false); }, [onlyBlocked, data]);

  if (isLoading) return <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (error || !data) return <p className="text-sm text-destructive p-4">{t("The assets could not be loaded.", "تعذر تحميل الأصول.")} {(error as Error)?.message}</p>;
  const s = data.summary;

  return (
    <div className="space-y-4" data-testid="section-assets-body">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("Fixed assets at the opening date", "الأصول الثابتة في تاريخ الافتتاح")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("The assets the previous system held, with what it had already depreciated. They post NO journal line of their own — their cost and accumulated depreciation are already in the staged trial balance — so the register must state the same figures the chart maps to the asset accounts. Each asset names an existing asset category, which carries its accounts, its Income Tax Law Art. 17 group and its VAT Art. 52 class.",
               "الأصول التي كان يحتفظ بها النظام السابق، وما سبق إهلاكه منها. لا تُنشئ قيدًا خاصًا بها — فتكلفتها ومجمع إهلاكها موجودان أصلًا في ميزان المراجعة المجهّز — ولذلك يجب أن يذكر السجل الأرقام نفسها التي يربطها الدليل بحسابات الأصول. ويسمّي كل أصل فئة أصول قائمة تحمل حساباته ومجموعة المادة 17 وفئة المادة 52.")}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {can && <Button size="sm" variant="outline" onClick={() => setEditingRow(-1)} data-testid="assets-add-row"><Plus className="w-3.5 h-3.5 me-1" />{t("Add asset", "إضافة أصل")}</Button>}
          {can && <Button size="sm" onClick={() => setImporting(true)} data-testid="assets-import"><Upload className="w-3.5 h-3.5 me-1" />{t("Import assets", "استيراد الأصول")}</Button>}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[[t("Assets", "الأصول"), String(s.assets)], [t("Cost", "التكلفة"), <Money key="c" v={s.cost} />], [t("Accumulated depreciation", "مجمع الإهلاك"), <Money key="a" v={s.accumulated} />], [t("Net book value", "صافي القيمة الدفترية"), <Money key="n" v={s.netBookValue} />]].map(([l, v], i) => (
          <Card key={i}><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className="text-lg font-semibold font-mono" data-testid={`assets-kpi-${i}`}>{v}</div></CardContent></Card>
        ))}
      </div>

      {all.length === 0 ? (
        <EmptyState icon={Package} title={t("No fixed assets staged", "لا توجد أصول ثابتة مجهّزة")}
          hint={t("If the old trial balance carries a cost and an accumulated-depreciation balance, stage the assets that make them up — the register must tie to those balances before the migration can commit.", "إذا كان ميزان المراجعة السابق يحمل رصيد تكلفة ومجمع إهلاك، فجهّز الأصول التي تكوّنهما — إذ يجب أن يطابق السجل هذين الرصيدين قبل اعتماد الترحيل.")}
          action={can ? <Button size="sm" onClick={() => setImporting(true)}><Upload className="w-3.5 h-3.5 me-1" />{t("Import assets", "استيراد الأصول")}</Button> : undefined} />
      ) : (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm text-muted-foreground">{t(`${rows.length} asset(s)`, `${rows.length} أصلًا`)}</CardTitle>
            <Button variant={onlyBlocked ? "default" : "ghost"} size="sm" className="h-7 text-xs" onClick={() => setOnlyBlocked((v) => !v)} data-testid="assets-only-blocked">{t(`Problems only (${s.blocked})`, `المشاكل فقط (${s.blocked})`)}</Button>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    {[t("Asset", "الأصل"), t("Category", "الفئة"), t("Acquired", "الاقتناء"), t("Cost", "التكلفة"), t("Accum. dep.", "مجمع الإهلاك"), t("NBV", "الصافي"), t("Life", "العمر"), t("State", "الحالة"), ""].map((h, i) => <th key={i} className="text-start pb-2 pe-3 font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} id={`staged-${r.id}`} className={`border-b border-border/50 align-top ${focusClass(r.id, focus)}`} data-testid={`asset-row-${r.sourceId}`}>
                      <td className="py-2 pe-3">
                        <span className="font-medium">{r.name}</span>
                        <span className="block text-[11px] text-muted-foreground font-mono" dir="ltr">{r.sourceId}{r.serialNumber ? ` · ${r.serialNumber}` : ""}</span>
                      </td>
                      <td className="py-2 pe-3 text-xs">{r.categoryName}</td>
                      <td className="py-2 pe-3 text-xs text-muted-foreground"><DualDate date={r.acquisitionDate} inline /></td>
                      <td className="py-2 pe-3 text-end"><Money v={r.cost} /></td>
                      <td className="py-2 pe-3 text-end text-muted-foreground"><Money v={r.openingAccumulatedDepreciation} /></td>
                      <td className="py-2 pe-3 text-end"><Money v={r.netBookValue} className="font-semibold" /></td>
                      <td className="py-2 pe-3 text-xs font-mono" dir="ltr">{r.openingPeriodsBooked}/{r.usefulLifeMonths}</td>
                      <td className="py-2 pe-3"><Problems list={r.problems} id={r.id} /></td>
                      <td className="py-2">
                        {can && <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditingRow(all.indexOf(r))} data-testid={`edit-asset-${r.id}`}><Pencil className="w-3 h-3 me-1" />{t("Correct", "تصحيح")}</Button>}
                        {r.resolvedAssetId != null && <Badge variant="outline" className="text-[10px] ms-1" data-testid={`asset-registered-${r.sourceId}`}>{t("in the register", "في السجل")} #{r.resolvedAssetId}</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold border-t border-border">
                    <td className="py-2 pe-3" colSpan={3}>{t("Total", "الإجمالي")}</td>
                    <td className="py-2 pe-3 text-end"><Money v={rows.reduce((a, r) => a + r.cost, 0)} /></td>
                    <td className="py-2 pe-3 text-end"><Money v={rows.reduce((a, r) => a + r.openingAccumulatedDepreciation, 0)} /></td>
                    <td className="py-2 pe-3 text-end"><Money v={rows.reduce((a, r) => a + r.netBookValue, 0)} /></td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              {t("At commit each asset becomes a register row in service on the opening journal, and its depreciation schedule resumes the month after the opening date over the life that remains. Nothing here is depreciated retrospectively.",
                 "عند الاعتماد يصبح كل أصل صفًا في السجل وفي الخدمة على قيد الافتتاح، ويستأنف جدول إهلاكه من الشهر التالي لتاريخ الافتتاح على ما تبقى من العمر. ولا يُهلك شيء هنا بأثر رجعي.")}
            </p>
          </CardContent>
        </Card>
      )}
      {importing && <ImportDialog batchId={batchId} kind="assets" hasRows={all.length > 0} onClose={() => setImporting(false)} />}
      {editingRow != null && <RowEditorDialog batchId={batchId} kind="assets" rows={all as unknown as Record<string, unknown>[]} index={editingRow} onClose={() => setEditingRow(null)} />}
    </div>
  );
}
