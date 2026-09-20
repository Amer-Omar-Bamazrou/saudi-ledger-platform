/**
 * Batch 1C — the historical open items (AR and AP). These are the previous
 * system's documents still open at the opening date: accounting records
 * inherited as balances, NOT tax invoices issued here. After commit an AR
 * item is an opening receivable (collectible through D-4, provenance kept,
 * no hash / ICV / QR ever) and an AP item an opening bill.
 *
 * The Art. 40(9) bad-debt-relief flag is shown as three words, Yes / No /
 * Unknown, under "Historical VAT" — information only; nothing acts on it.
 */
import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "wouter";
import { FileText, FileInput, Upload, Pencil, Plus, ExternalLink } from "lucide-react";
import { DualDate } from "@/components/DualDate";
import { ageingBucket, reliefLabel } from "@/lib/migrationImport";
import { EmptyState, Money, Problems, focusClass, useCanRunMigration, useFocusRow, useOpenItems, useWorkspaceNav } from "./shared";
import { ImportDialog, RowEditorDialog } from "./StagingEditors";
import type { MigrationOpenItem } from "@workspace/api-client-react";

export function OpenItemsSection({ batchId, editable, side, openingDate, committed }: { batchId: number; editable: boolean; side: "ar" | "ap"; openingDate: string; committed: boolean }) {
  const { t, lang } = useLanguage();
  const canRun = useCanRunMigration();
  const { focus, blockedOnly } = useWorkspaceNav();
  const { data, isLoading, error } = useOpenItems(batchId);
  const [importing, setImporting] = useState(false);
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [onlyBlocked, setOnlyBlocked] = useState(blockedOnly);
  useFocusRow(focus, !!data);
  const can = editable && canRun;
  const all = data?.rows ?? [];
  const rows = useMemo(() => all.filter((r) => r.itemType === side && (!onlyBlocked || r.problems.length > 0)), [all, side, onlyBlocked]);
  const isAr = side === "ar";
  // Walk defect 2026-09-20: with "problems only" on, correcting the last problem left an EMPTY table with a 0.00
  // total. The filter switches itself off once nothing is blocked, so the corrected row is what the operator sees.
  const blockedNow = all.filter((r) => r.itemType === side && r.problems.length > 0).length;
  useEffect(() => { if (onlyBlocked && data && blockedNow === 0) setOnlyBlocked(false); }, [onlyBlocked, data, blockedNow]);

  if (isLoading) return <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (error || !data) return <p className="text-sm text-destructive p-4">{t("The open items could not be loaded.", "تعذر تحميل البنود المفتوحة.")} {(error as Error)?.message}</p>;
  const s = isAr ? data.summary.ar : data.summary.ap;
  const blocked = all.filter((r) => r.itemType === side && r.problems.length > 0).length;
  const bucketLabel = (b: ReturnType<typeof ageingBucket>["bucket"]) => ({ current: t("current", "جارٍ"), "1-30": t("1–30 days", "١–٣٠ يوم"), "31-60": t("31–60 days", "٣١–٦٠ يوم"), "61-90": t("61–90 days", "٦١–٩٠ يوم"), "90+": t("90+ days", "أكثر من ٩٠ يوم") })[b];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{isAr ? t("AR open items — historical receivables", "الذمم المدينة المفتوحة — ذمم تاريخية") : t("AP open items — historical payables", "الذمم الدائنة المفتوحة — ذمم تاريخية")}</h2>
          <p className="text-sm text-muted-foreground">
            {isAr
              ? t("Documents the previous system issued and the customer still owes at the opening date. Migrated as opening receivables: collectible, allocatable, aged and on the statement — and never a tax invoice issued by Saudi Ledger (no hash, ICV, QR, VAT event or ZATCA submission).",
                  "مستندات أصدرها النظام السابق ولا يزال العميل مدينًا بها في تاريخ الافتتاح. تُرحَّل كذمم مدينة افتتاحية: قابلة للتحصيل والتخصيص والتقادم وتظهر في كشف الحساب — وليست أبدًا فاتورة ضريبية صادرة من Saudi Ledger (بلا تجزئة أو ICV أو QR أو حدث ضريبي أو إرسال إلى الهيئة).")
              : t("Supplier documents still unpaid at the opening date, migrated as opening bills with their provenance. Paid through the ordinary bill payment path.",
                  "مستندات موردين لم تُسدَّد بعد في تاريخ الافتتاح، تُرحَّل كفواتير موردين افتتاحية مع مصدرها. تُسدَّد عبر مسار دفع الفواتير المعتاد.")}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {can && <Button size="sm" variant="outline" onClick={() => setEditingRow(-1)} data-testid={`${side}-add-row`}><Plus className="w-3.5 h-3.5 me-1" />{t("Add item", "إضافة بند")}</Button>}
          {can && <Button size="sm" onClick={() => setImporting(true)} data-testid={`${side}-import`}><Upload className="w-3.5 h-3.5 me-1" />{t("Import open items", "استيراد البنود المفتوحة")}</Button>}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[[t("Items", "البنود"), String(s.items)], [t("Parties", "الأطراف"), String(s.parties)], [t("Total outstanding", "إجمالي المتبقي"), <Money key="t" v={s.total} />], [t("Composition unknown", "التكوين غير معروف"), String(s.compositionUnknown)]].map(([l, v], i) => (
          <Card key={i}><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className="text-lg font-semibold font-mono" data-testid={`${side}-kpi-${i}`}>{v}</div></CardContent></Card>
        ))}
      </div>
      {rows.length === 0 && all.filter((r) => r.itemType === side).length === 0 ? (
        <EmptyState icon={isAr ? FileText : FileInput} title={isAr ? t("No AR open items staged", "لا توجد ذمم مدينة مجهّزة") : t("No AP open items staged", "لا توجد ذمم دائنة مجهّزة")}
          hint={t("Import AR and AP together in one file (itemType ar / ap), or add items one by one. The sum per side must equal the control account's balance in the staged chart.", "استورد الذمم المدينة والدائنة معًا في ملف واحد (itemType ar / ap)، أو أضف البنود واحدًا واحدًا. يجب أن يساوي المجموع لكل جانب رصيد حساب المراقبة في الدليل المجهّز.")}
          action={can ? <Button size="sm" onClick={() => setImporting(true)}><Upload className="w-3.5 h-3.5 me-1" />{t("Import open items", "استيراد البنود المفتوحة")}</Button> : undefined} />
      ) : (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm text-muted-foreground">{t(`${rows.length} item(s)`, `${rows.length} بندًا`)}</CardTitle>
            <Button variant={onlyBlocked ? "default" : "ghost"} size="sm" className="h-7 text-xs" onClick={() => setOnlyBlocked((v) => !v)} data-testid={`${side}-only-blocked`}>{t(`Problems only (${blocked})`, `المشاكل فقط (${blocked})`)}</Button>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    {[t("Source document", "المستند المصدري"), t("Party", "الطرف"), t("Issued", "الإصدار"), t("Due", "الاستحقاق"), t("Ageing", "التقادم"), t("Original", "الأصلي"), t("Outstanding", "المتبقي"), t("Historical VAT", "الضريبة التاريخية"), t("State", "الحالة"), ""].map((h, i) => <th key={i} className="text-start pb-2 pe-3 font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const age = ageingBucket(r.dueDate, openingDate);
                    return (
                      <tr key={r.id} id={`staged-${r.id}`} className={`border-b border-border/50 align-top ${focusClass(r.id, focus)}`} data-testid={`item-row-${r.documentNumber}`}>
                        <td className="py-2 pe-3">
                          <span className="font-mono text-xs break-all" dir="ltr">{r.documentNumber}</span>
                          <span className="block text-[11px] text-muted-foreground" dir="ltr">{t("source", "المصدر")}: {r.sourceId}</span>
                          {r.ledgerDocumentNumber && r.ledgerDocumentNumber !== r.documentNumber && <span className="block text-[11px] text-muted-foreground" dir="ltr">{t("ledger number", "رقم الدفتر")}: {r.ledgerDocumentNumber}</span>}
                          {r.compositionUnknown && <Badge variant="outline" className="text-[10px] mt-1">{t("balance only", "رصيد فقط")}</Badge>}
                          <Badge variant="outline" className="text-[10px] mt-1 ms-1">{t("historical record", "سجل تاريخي")}</Badge>
                        </td>
                        <td className="py-2 pe-3 max-w-[12rem] break-words">{r.partyName ?? <span className="text-negative">{r.partySourceId}</span>}<span className="block text-[11px] text-muted-foreground" dir="ltr">{r.partySourceId}</span></td>
                        <td className="py-2 pe-3 text-xs text-muted-foreground"><DualDate date={r.issueDate} inline /></td>
                        <td className="py-2 pe-3 text-xs text-muted-foreground"><DualDate date={r.dueDate} inline /></td>
                        <td className="py-2 pe-3 text-xs">{bucketLabel(age.bucket)}{age.days > 0 && <span className="block text-[11px] text-muted-foreground">{t(`${age.days} days at opening`, `${age.days} يومًا عند الافتتاح`)}</span>}</td>
                        <td className="py-2 pe-3 text-end"><Money v={r.originalAmount} /></td>
                        <td className="py-2 pe-3 text-end"><Money v={r.outstandingAmount} className="font-semibold" /></td>
                        <td className="py-2 pe-3 text-xs">
                          {r.historicalVat ? (
                            <span>{r.historicalVat.category ?? "—"}{r.historicalVat.rate != null ? ` ${r.historicalVat.rate}%` : ""}{r.historicalVat.amount != null ? <> · <Money v={r.historicalVat.amount} /></> : ""}{r.historicalVat.reportedPeriod && <span className="block text-muted-foreground">{t("reported", "مبلَّغ")}: {r.historicalVat.reportedPeriod}</span>}</span>
                          ) : <span className="text-muted-foreground">{t("none recorded", "لا شيء مسجَّل")}</span>}
                          {isAr && (
                            <span className="block mt-1" data-testid={`relief-${r.documentNumber}`}>
                              <span className="text-muted-foreground">{t("Bad-debt relief claimed", "المطالبة بإعفاء الديون المعدومة")}:</span> <Badge variant="outline" className="text-[10px]">{reliefLabel(r.historicalVat?.badDebtReliefClaimed, lang)}</Badge>
                            </span>
                          )}
                        </td>
                        <td className="py-2 pe-3"><Problems list={r.problems} id={r.id} /></td>
                        <td className="py-2">
                          {can && <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditingRow(all.indexOf(r))} data-testid={`edit-item-${r.id}`}><Pencil className="w-3 h-3 me-1" />{t("Correct", "تصحيح")}</Button>}
                          {committed && r.resolvedId != null && (
                            <Link href={isAr ? `/invoices` : `/bills`} className="inline-flex items-center gap-1 text-xs text-primary h-7 px-2" data-testid={`open-record-${r.documentNumber}`}>
                              <ExternalLink className="w-3 h-3" />{isAr ? t("Opening receivable", "الذمة الافتتاحية") : t("Opening bill", "الفاتورة الافتتاحية")} #{r.resolvedId}
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="font-semibold border-t border-border">
                    <td className="py-2 pe-3" colSpan={5}>{t("Total", "الإجمالي")}</td>
                    <td className="py-2 pe-3 text-end"><Money v={rows.reduce((a, r) => a + r.originalAmount, 0)} /></td>
                    <td className="py-2 pe-3 text-end"><Money v={rows.reduce((a, r) => a + r.outstandingAmount, 0)} /></td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            </div>
            {isAr && <p className="text-[11px] text-muted-foreground mt-2">{t("The bad-debt relief answer is historical migration information for the accountant. Nothing in Saudi Ledger computes, warns, blocks, invoices, submits or restricts a payment because of it; the treatment after collection is an accountant / VAT decision.", "إجابة إعفاء الديون المعدومة معلومة ترحيل تاريخية للمحاسب. لا يحتسب Saudi Ledger أو يحذّر أو يمنع أو يُصدر فاتورة أو يُرسل أو يقيّد دفعة بسببها؛ والمعالجة بعد التحصيل قرار محاسبي / ضريبي.")}</p>}
          </CardContent>
        </Card>
      )}
      {importing && <ImportDialog batchId={batchId} kind="openItems" hasRows={all.length > 0} onClose={() => setImporting(false)} />}
      {editingRow != null && <RowEditorDialog batchId={batchId} kind="openItems" rows={all as unknown as Record<string, unknown>[]} index={editingRow} onClose={() => setEditingRow(null)} />}
    </div>
  );
}

export type { MigrationOpenItem };
