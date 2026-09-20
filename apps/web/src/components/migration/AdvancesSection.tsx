/**
 * Batch 1C — customer advances held at the opening date: money received
 * before cut-off for work not yet invoiced. Each names its customer and the
 * bank it arrived in (an old chart row mapped to a bank), and states its VAT
 * position: `invoiced` (the advance invoice's number, date, time, VAT are
 * kept for the later invoice) or `unknown` (recorded at cash; downstream
 * fails closed). Missing required advance-invoice facts are the SERVER's
 * refusal, shown as the row's problems — never silenced here.
 */
import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Banknote, Upload, Pencil, Plus } from "lucide-react";
import { DualDate } from "@/components/DualDate";
import { EmptyState, Money, Problems, focusClass, useAdvances, useCanRunMigration, useFocusRow, useWorkspaceNav } from "./shared";
import { ImportDialog, RowEditorDialog } from "./StagingEditors";

export function AdvancesSection({ batchId, editable }: { batchId: number; editable: boolean }) {
  const { t } = useLanguage();
  const canRun = useCanRunMigration();
  const { focus, blockedOnly } = useWorkspaceNav();
  const { data, isLoading, error } = useAdvances(batchId);
  const [importing, setImporting] = useState(false);
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [onlyBlocked, setOnlyBlocked] = useState(blockedOnly);
  useFocusRow(focus, !!data);
  const can = editable && canRun;
  const all = data?.rows ?? [];
  const rows = useMemo(() => all.filter((r) => !onlyBlocked || r.problems.length > 0), [all, onlyBlocked]);
  // Walk defect 2026-09-20: with "problems only" on, correcting the last problem left an EMPTY table with a 0.00
  // total. The filter switches itself off once nothing is blocked, so the corrected row is what the operator sees.
  useEffect(() => { if (onlyBlocked && data && data.summary.blocked === 0) setOnlyBlocked(false); }, [onlyBlocked, data]);

  if (isLoading) return <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (error || !data) return <p className="text-sm text-destructive p-4">{t("The advances could not be loaded.", "تعذر تحميل الدفعات المقدمة.")} {(error as Error)?.message}</p>;
  const s = data.summary;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("Customer advances at the opening date", "دفعات العملاء المقدمة في تاريخ الافتتاح")}</h2>
          <p className="text-sm text-muted-foreground">{t("Money received before cut-off for work not yet invoiced. Σ advances must equal the customer-deposits balance in the staged chart; an advance whose VAT position is unknown is recorded at cash and fails closed downstream.", "أموال استُلمت قبل القطع مقابل أعمال لم تُفوتر بعد. يجب أن يساوي مجموع الدفعات رصيد دفعات العملاء في الدليل المجهّز؛ والدفعة ذات الموقف الضريبي غير المعروف تُسجَّل نقدًا وتُرفض لاحقًا.")}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {can && <Button size="sm" variant="outline" onClick={() => setEditingRow(-1)} data-testid="advances-add-row"><Plus className="w-3.5 h-3.5 me-1" />{t("Add advance", "إضافة دفعة")}</Button>}
          {can && <Button size="sm" onClick={() => setImporting(true)} data-testid="advances-import"><Upload className="w-3.5 h-3.5 me-1" />{t("Import advances", "استيراد الدفعات المقدمة")}</Button>}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[[t("Advances", "الدفعات"), String(s.rows)], [t("Customers", "العملاء"), String(s.customers)], [t("Total", "الإجمالي"), <Money key="t" v={s.total} />], [t("VAT position unknown", "موقف ضريبي غير معروف"), String(s.unknown), s.unknown > 0 ? "text-attention" : ""]].map(([l, v, c], i) => (
          <Card key={i}><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-lg font-semibold font-mono ${c ?? ""}`}>{v}</div></CardContent></Card>
        ))}
      </div>
      {all.length === 0 ? (
        <EmptyState icon={Banknote} title={t("No advances staged", "لا توجد دفعات مقدمة مجهّزة")} hint={t("Only needed when the old chart carries a customer-deposits balance. Leave empty otherwise.", "مطلوبة فقط عندما يحمل الدليل السابق رصيد دفعات عملاء. اتركها فارغة خلاف ذلك.")}
          action={can ? <Button size="sm" onClick={() => setImporting(true)}><Upload className="w-3.5 h-3.5 me-1" />{t("Import advances", "استيراد الدفعات المقدمة")}</Button> : undefined} />
      ) : (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm text-muted-foreground">{t(`${rows.length} advance(s)`, `${rows.length} دفعة`)}</CardTitle>
            <Button variant={onlyBlocked ? "default" : "ghost"} size="sm" className="h-7 text-xs" onClick={() => setOnlyBlocked((v) => !v)} data-testid="advances-only-blocked">{t(`Problems only (${s.blocked})`, `المشاكل فقط (${s.blocked})`)}</Button>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    {[t("Source", "المصدر"), t("Customer", "العميل"), t("Bank (old code)", "البنك (الرمز القديم)"), t("Received", "الاستلام"), t("Amount", "المبلغ"), t("VAT position", "الموقف الضريبي"), t("Advance invoice", "فاتورة الدفعة المقدمة"), t("State", "الحالة"), ""].map((h, i) => <th key={i} className="text-start pb-2 pe-3 font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} id={`staged-${r.id}`} className={`border-b border-border/50 align-top ${focusClass(r.id, focus)}`} data-testid={`advance-row-${r.sourceId}`}>
                      <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{r.sourceId}{r.reference && <span className="block text-[11px] text-muted-foreground">{r.reference}</span>}{r.resolvedPaymentId != null && <span className="block text-[11px] text-muted-foreground">→ RCPT-{r.resolvedPaymentId}</span>}</td>
                      <td className="py-2 pe-3 max-w-[12rem] break-words">{r.partyName ?? <span className="text-negative">{r.partySourceId}</span>}<span className="block text-[11px] text-muted-foreground" dir="ltr">{r.partySourceId}</span></td>
                      <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{r.bankSourceCode}</td>
                      <td className="py-2 pe-3 text-xs text-muted-foreground"><DualDate date={r.receivedAt} inline /></td>
                      <td className="py-2 pe-3 text-end"><Money v={r.amount} className="font-semibold" /></td>
                      <td className="py-2 pe-3"><Badge variant="outline" className={`text-xs ${r.vatPosition === "unknown" ? "text-attention" : ""}`}>{r.vatPosition === "invoiced" ? t("Advance invoice issued", "صدرت فاتورة الدفعة") : t("Unknown — fails closed", "غير معروف — يُرفض لاحقًا")}</Badge></td>
                      <td className="py-2 pe-3 text-xs" dir="ltr">{r.advanceInvoiceNumber ? <>{r.advanceInvoiceNumber}<span className="block text-muted-foreground">{r.advanceInvoiceDate} {r.advanceInvoiceTime ?? ""}{r.vatCategory ? ` · ${r.vatCategory} ${r.vatRate ?? ""}%` : ""}{r.vatAmount != null ? <> · <Money v={r.vatAmount} /></> : ""}</span></> : "—"}</td>
                      <td className="py-2 pe-3"><Problems list={r.problems} id={r.id} /></td>
                      <td className="py-2">{can && <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditingRow(all.indexOf(r))} data-testid={`edit-advance-${r.id}`}><Pencil className="w-3 h-3 me-1" />{t("Correct", "تصحيح")}</Button>}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="font-semibold border-t border-border"><td className="py-2 pe-3" colSpan={4}>{t("Total", "الإجمالي")}</td><td className="py-2 pe-3 text-end"><Money v={rows.reduce((a, r) => a + r.amount, 0)} /></td><td colSpan={4} /></tr></tfoot>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
      {importing && <ImportDialog batchId={batchId} kind="advances" hasRows={all.length > 0} onClose={() => setImporting(false)} />}
      {editingRow != null && <RowEditorDialog batchId={batchId} kind="advances" rows={all as unknown as Record<string, unknown>[]} index={editingRow} onClose={() => setEditingRow(null)} />}
    </div>
  );
}
