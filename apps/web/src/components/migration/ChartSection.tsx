/**
 * Batch 1C — the chart of accounts section: every old account, its closing
 * balance, and the operator's mapping decision. The decisions are the
 * server's five (map_to_system, map_to_bank, create, merge_into, skip); the
 * target lists come from the org's own chart and bank accounts. There is no
 * balancing option: OPENING_BALANCE_EQUITY does not exist (accountant A5)
 * and `systemTargets` refuses the code by name.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tags, Upload, Pencil, Plus, Wand2 } from "lucide-react";
import { useBankOptions } from "@/components/payments/shared";
import { headerTargets, mergeTargets, systemTargets } from "@/lib/migrationImport";
import { EmptyState, Money, Problems, focusClass, invalidateMigration, useCanRunMigration, useChart, useFocusRow, useWorkspaceNav } from "./shared";
import { ImportDialog, RowEditorDialog } from "./StagingEditors";
import type { Category, MigrationChartDecisionInput, MigrationChartRow } from "@workspace/api-client-react";

const DECISIONS = ["map_to_system", "map_to_bank", "create", "merge_into", "skip"] as const;
type Decision = (typeof DECISIONS)[number];

export function decisionLabel(d: string | null, lang: "en" | "ar"): string {
  const L: Record<string, [string, string]> = {
    map_to_system: ["Map to system account", "ربط بحساب نظام"],
    map_to_bank: ["Map to bank account", "ربط بحساب بنكي"],
    create: ["Create as new account", "إنشاء حساب جديد"],
    merge_into: ["Merge into existing account", "دمج في حساب قائم"],
    skip: ["Skip (zero balance only)", "تخطٍّ (رصيد صفري فقط)"],
  };
  if (!d) return lang === "ar" ? "لم يُقرَّر" : "Undecided";
  return (L[d] ?? [d, d])[lang === "ar" ? 1 : 0];
}

function DecisionEditor({ batchId, row, categories, onDone }: { batchId: number; row: MigrationChartRow; categories: Category[]; onDone: () => void }) {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { active: banks } = useBankOptions();
  const [decision, setDecision] = useState<Decision>((row.decision as Decision | null) ?? (row.suggestion?.decision as Decision | undefined) ?? "map_to_system");
  const [systemCode, setSystemCode] = useState(row.targetSystemCode ?? row.suggestion?.targetSystemCode ?? "");
  const [bankId, setBankId] = useState(row.targetBankAccountId != null ? String(row.targetBankAccountId) : "");
  const [categoryId, setCategoryId] = useState(row.targetCategoryId != null ? String(row.targetCategoryId) : "");
  const [skipReason, setSkipReason] = useState(row.skipReason ?? "");
  const [error, setError] = useState("");

  const systems = useMemo(() => systemTargets(categories, row.sourceType), [categories, row.sourceType]);
  const merges = useMemo(() => mergeTargets(categories, row.sourceType), [categories, row.sourceType]);
  const headers = useMemo(() => headerTargets(categories, row.sourceType), [categories, row.sourceType]);

  const mut = useMutation({
    mutationFn: (body: MigrationChartDecisionInput) => apiFetch(`/migration/batches/${batchId}/chart/${row.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => { invalidateMigration(qc, batchId); toast({ title: t(`${row.sourceCode} mapped`, `تم ربط ${row.sourceCode}`) }); onDone(); },
    onError: (e: Error) => setError(e.message),
  });

  const body: MigrationChartDecisionInput = {
    decision,
    targetSystemCode: decision === "map_to_system" ? systemCode || null : null,
    targetBankAccountId: decision === "map_to_bank" ? Number(bankId) || null : null,
    targetCategoryId: decision === "merge_into" || decision === "create" ? (categoryId ? Number(categoryId) : null) : null,
    skipReason: decision === "skip" ? skipReason.trim() || null : null,
  };
  const valid =
    (decision === "map_to_system" && !!systemCode) || (decision === "map_to_bank" && !!bankId) || (decision === "merge_into" && !!categoryId) || decision === "create" || (decision === "skip" && skipReason.trim().length > 0);

  return (
    <div className="rounded-md border border-border bg-secondary/20 p-3 space-y-2" data-testid={`decision-editor-${row.id}`}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Select value={decision} onValueChange={(v) => setDecision(v as Decision)}>
          <SelectTrigger className="h-9 text-sm" data-testid={`decision-${row.id}`}><SelectValue /></SelectTrigger>
          <SelectContent>{DECISIONS.map((d) => <SelectItem key={d} value={d}>{decisionLabel(d, lang)}</SelectItem>)}</SelectContent>
        </Select>
        {decision === "map_to_system" && (
          <Select value={systemCode} onValueChange={setSystemCode}>
            <SelectTrigger className="h-9 text-sm" data-testid={`target-system-${row.id}`}><SelectValue placeholder={t("System account", "حساب النظام")} /></SelectTrigger>
            <SelectContent>{systems.map((s) => <SelectItem key={s.code} value={s.code}>{s.code} — {lang === "ar" ? s.nameAr || s.name : s.name}</SelectItem>)}</SelectContent>
          </Select>
        )}
        {decision === "map_to_bank" && (
          <Select value={bankId} onValueChange={setBankId}>
            <SelectTrigger className="h-9 text-sm" data-testid={`target-bank-${row.id}`}><SelectValue placeholder={t("Bank account", "الحساب البنكي")} /></SelectTrigger>
            <SelectContent>{banks.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name} — {b.bankName}</SelectItem>)}</SelectContent>
          </Select>
        )}
        {decision === "merge_into" && (
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger className="h-9 text-sm" data-testid={`target-category-${row.id}`}><SelectValue placeholder={t("Existing account", "حساب قائم")} /></SelectTrigger>
            <SelectContent>{merges.map((c) => <SelectItem key={c.id} value={String(c.id)}>{lang === "ar" ? c.nameAr || c.name : c.name}</SelectItem>)}</SelectContent>
          </Select>
        )}
        {decision === "create" && (
          <Select value={categoryId || "__none"} onValueChange={(v) => setCategoryId(v === "__none" ? "" : v)}>
            <SelectTrigger className="h-9 text-sm" data-testid={`target-parent-${row.id}`}><SelectValue placeholder={t("Parent header (optional)", "الحساب الرئيسي (اختياري)")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">{t("No parent header", "بدون حساب رئيسي")}</SelectItem>
              {headers.map((c) => <SelectItem key={c.id} value={String(c.id)}>{lang === "ar" ? c.nameAr || c.name : c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        {decision === "skip" && <Input value={skipReason} onChange={(e) => setSkipReason(e.target.value)} placeholder={t("Why this zero-balance row is skipped", "سبب تخطي هذا الصف الصفري")} className="h-9 text-sm" data-testid={`skip-reason-${row.id}`} />}
      </div>
      {error && <p className="text-xs text-negative" data-testid={`decision-error-${row.id}`}>{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>{t("Cancel", "إلغاء")}</Button>
        <Button size="sm" disabled={!valid || mut.isPending} onClick={() => mut.mutate(body)} data-testid={`decision-save-${row.id}`}>{mut.isPending ? t("Saving…", "جارٍ الحفظ…") : t("Apply mapping", "تطبيق الربط")}</Button>
      </div>
    </div>
  );
}

export function ChartSection({ batchId, editable }: { batchId: number; editable: boolean }) {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const canRun = useCanRunMigration();
  const { focus, blockedOnly, go } = useWorkspaceNav();
  const { data, isLoading, error } = useChart(batchId);
  const { data: categories = [] } = useQuery<Category[]>({ queryKey: ["categories"], queryFn: () => apiFetch("/categories") });
  const { byId: bankById } = useBankOptions();
  const [importing, setImporting] = useState(false);
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [deciding, setDeciding] = useState<number | null>(null);
  const [onlyBlocked, setOnlyBlocked] = useState(blockedOnly);
  useFocusRow(focus, !!data);
  const can = editable && canRun;

  const applySuggestion = useMutation({
    mutationFn: (row: MigrationChartRow) => apiFetch(`/migration/batches/${batchId}/chart/${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({ decision: row.suggestion!.decision as MigrationChartDecisionInput["decision"], targetSystemCode: row.suggestion!.targetSystemCode ?? null } satisfies MigrationChartDecisionInput),
    }),
    onSuccess: () => { invalidateMigration(qc, batchId); toast({ title: t("Suggestion applied", "تم تطبيق الاقتراح") }); },
  });

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => !onlyBlocked || r.problems.length > 0), [data, onlyBlocked]);
  // Walk defect 2026-09-20: with "problems only" on, correcting the last problem left an EMPTY table with a 0.00
  // total. The filter switches itself off once nothing is blocked, so the corrected row is what the operator sees.
  useEffect(() => { if (onlyBlocked && data && data.summary.blocked === 0) setOnlyBlocked(false); }, [onlyBlocked, data]);
  const catName = (id: number | null) => { const c = categories.find((x) => x.id === id); return c ? (lang === "ar" ? c.nameAr || c.name : c.name) : `#${id}`; };
  const target = (r: MigrationChartRow) => {
    if (r.decision === "map_to_system") return r.targetSystemCode;
    if (r.decision === "map_to_bank") { const b = bankById(r.targetBankAccountId); return b ? `${b.name} — ${b.bankName}` : `#${r.targetBankAccountId}`; }
    if (r.decision === "merge_into") return catName(r.targetCategoryId);
    if (r.decision === "create") return r.targetCategoryId != null ? t(`New, under ${catName(r.targetCategoryId)}`, `جديد، تحت ${catName(r.targetCategoryId)}`) : t("New account", "حساب جديد");
    if (r.decision === "skip") return r.skipReason ?? "";
    return null;
  };

  if (isLoading) return <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (error || !data) return <p className="text-sm text-destructive p-4">{t("The chart could not be loaded.", "تعذر تحميل الدليل.")} {(error as Error)?.message}</p>;
  const s = data.summary;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("Chart of accounts — closing balances of the previous system", "دليل الحسابات — الأرصدة الختامية للنظام السابق")}</h2>
          <p className="text-sm text-muted-foreground">{t("Every old account lands on a NAMED account here. There is no balancing account and no automatic balancing: a difference blocks the migration.", "كل حساب قديم يستقر على حساب مُسمّى هنا. لا يوجد حساب موازنة ولا موازنة تلقائية: أي فرق يوقف الترحيل.")}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {can && <Button size="sm" variant="outline" onClick={() => setEditingRow(-1)} data-testid="chart-add-row"><Plus className="w-3.5 h-3.5 me-1" />{t("Add row", "إضافة صف")}</Button>}
          {can && <Button size="sm" onClick={() => setImporting(true)} data-testid="chart-import"><Upload className="w-3.5 h-3.5 me-1" />{t("Import chart", "استيراد الدليل")}</Button>}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          [t("Rows", "الصفوف"), String(s.rows)],
          [t("Unmapped", "غير مربوطة"), String(s.unmapped), s.unmapped > 0 ? "text-negative" : "text-positive"],
          [t("Total debits", "إجمالي المدين"), <Money key="d" v={s.totalDebit} />],
          [t("Total credits", "إجمالي الدائن"), <Money key="c" v={s.totalCredit} />],
        ].map(([l, v, c], i) => (
          <Card key={i}><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-lg font-semibold font-mono ${c ?? ""}`} data-testid={`chart-kpi-${i}`}>{v}</div></CardContent></Card>
        ))}
      </div>
      {data.rows.length > 0 && (
        <p className={`text-sm ${s.balanced ? "text-positive" : "text-negative"}`} data-testid="chart-balance-line">
          {s.balanced ? t("The staged chart balances: Σ debits = Σ credits.", "الدليل المجهّز متوازن: مجموع المدين = مجموع الدائن.") : t(`The staged chart does NOT balance — the file itself is off by ${Math.abs(s.totalDebit - s.totalCredit).toFixed(2)}. Correct the source; nothing here invents a balancing amount.`, `الدليل المجهّز غير متوازن — الملف نفسه يختلف بمقدار ${Math.abs(s.totalDebit - s.totalCredit).toFixed(2)}. صحّح المصدر؛ لا شيء هنا يختلق مبلغ موازنة.`)}
        </p>
      )}

      {data.rows.length === 0 ? (
        <EmptyState icon={Tags} title={t("No chart staged yet", "لم يُجهَّز أي دليل بعد")} hint={t("Import the previous system's chart of accounts with its closing balances at the opening date. Each row states its own type; nothing is inferred from a name.", "استورد دليل حسابات النظام السابق بأرصدته الختامية في تاريخ الافتتاح. كل صف يذكر نوعه؛ لا يُستنتج شيء من الاسم.")}
          action={can ? <Button size="sm" onClick={() => setImporting(true)}><Upload className="w-3.5 h-3.5 me-1" />{t("Import chart", "استيراد الدليل")}</Button> : undefined} />
      ) : (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm text-muted-foreground">{t(`${rows.length} of ${data.rows.length} rows`, `${rows.length} من ${data.rows.length} صفًا`)}</CardTitle>
            <Button variant={onlyBlocked ? "default" : "ghost"} size="sm" className="h-7 text-xs" onClick={() => setOnlyBlocked((v) => !v)} data-testid="chart-only-blocked">{t(`Problems only (${s.blocked})`, `المشاكل فقط (${s.blocked})`)}</Button>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    {[t("Code", "الرمز"), t("Name", "الاسم"), t("Type", "النوع"), t("Debit", "مدين"), t("Credit", "دائن"), t("Decision", "القرار"), t("Target", "الهدف"), t("State", "الحالة"), ""].map((h, i) => <th key={i} className="text-start pb-2 pe-3 font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Fragment key={r.id}>
                      <tr id={`staged-${r.id}`} className={`border-b border-border/50 align-top ${focusClass(r.id, focus)}`} data-testid={`chart-row-${r.sourceCode}`}>
                        <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{r.sourceCode}{r.sourceIsGroup && <Badge variant="outline" className="ms-1 text-[10px]">{t("group", "تجميعي")}</Badge>}</td>
                        <td className="py-2 pe-3 max-w-[14rem] break-words">{lang === "ar" && r.sourceNameAr ? r.sourceNameAr : r.sourceName}{r.sourceRole && <span className="block text-[11px] text-muted-foreground">{t("role", "الدور")}: {r.sourceRole}</span>}</td>
                        <td className="py-2 pe-3 text-xs">{r.sourceType}</td>
                        <td className="py-2 pe-3 text-end"><Money v={r.openingDebit} /></td>
                        <td className="py-2 pe-3 text-end"><Money v={r.openingCredit} /></td>
                        <td className="py-2 pe-3 text-xs">{decisionLabel(r.decision, lang)}</td>
                        <td className="py-2 pe-3 text-xs max-w-[12rem] break-words">{target(r) ?? (r.suggestion ? <span className="text-muted-foreground">{t("suggested", "مقترح")}: {decisionLabel(r.suggestion.decision, lang)}{r.suggestion.targetSystemCode ? ` → ${r.suggestion.targetSystemCode}` : ""}</span> : "—")}</td>
                        <td className="py-2 pe-3"><Problems list={r.problems} id={r.id} /></td>
                        <td className="py-2">
                          {can && (
                            <div className="flex flex-col gap-1 items-start">
                              {/* Walk defect 2026-09-20: a map_to_bank suggestion has no target (the bank is the operator's choice), so applying it blindly was a 400. It opens the editor pre-set instead. */}
                              {!r.decision && r.suggestion && (r.suggestion.decision === "map_to_bank"
                                ? <Button variant="ghost" size="sm" className="h-7 text-xs text-primary" onClick={() => setDeciding(r.id)} data-testid={`apply-suggestion-${r.id}`}><Wand2 className="w-3 h-3 me-1" />{t("Choose the bank…", "اختر البنك…")}</Button>
                                : <Button variant="ghost" size="sm" className="h-7 text-xs text-primary" disabled={applySuggestion.isPending} onClick={() => applySuggestion.mutate(r)} data-testid={`apply-suggestion-${r.id}`}><Wand2 className="w-3 h-3 me-1" />{t("Apply suggestion", "تطبيق الاقتراح")}</Button>)}
                              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setDeciding(deciding === r.id ? null : r.id)} data-testid={`map-${r.id}`}>{r.decision ? t("Change mapping", "تغيير الربط") : t("Map…", "ربط…")}</Button>
                              <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => setEditingRow(data.rows.indexOf(r))} data-testid={`edit-chart-${r.id}`}><Pencil className="w-3 h-3 me-1" />{t("Edit row", "تعديل الصف")}</Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    </Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold border-t border-border">
                    <td className="py-2 pe-3" colSpan={3}>{t("Total", "الإجمالي")}</td>
                    <td className="py-2 pe-3 text-end"><Money v={s.totalDebit} /></td>
                    <td className="py-2 pe-3 text-end"><Money v={s.totalCredit} /></td>
                    <td colSpan={4} />
                  </tr>
                </tfoot>
              </table>
            </div>
            {s.unmapped > 0 && <p className="text-xs text-negative mt-2">{t(`${s.unmapped} row(s) still need a decision.`, `${s.unmapped} صفًا ما زال بحاجة إلى قرار.`)} <button className="underline" onClick={() => go("validation")}>{t("See validation", "عرض التحقق")}</button></p>}
          </CardContent>
        </Card>
      )}

      {/* Walk defect 2026-09-20: the editor was a row inside the (horizontally scrolling) table, so on a phone its selects were clipped off-screen. A dialog fits every width. */}
      {deciding != null && data.rows.find((r) => r.id === deciding) && (
        <Dialog open onOpenChange={(o) => { if (!o) setDeciding(null); }}>
          <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-lg" data-testid="decision-dialog">
            <DialogHeader>
              <DialogTitle>{t(`Map ${data.rows.find((r) => r.id === deciding)!.sourceCode} — ${data.rows.find((r) => r.id === deciding)!.sourceName}`, `ربط ${data.rows.find((r) => r.id === deciding)!.sourceCode} — ${data.rows.find((r) => r.id === deciding)!.sourceName}`)}</DialogTitle>
              <DialogDescription>{t("Where this old account's balance lands. A control-role account maps to its system account; a bank to one of this company's bank accounts; anything else to an existing posting account or a new one.", "أين يستقر رصيد هذا الحساب القديم. حساب المراقبة يُربط بحساب النظام المقابل؛ والبنك بأحد الحسابات البنكية للشركة؛ وغير ذلك بحساب ترحيل قائم أو جديد.")}</DialogDescription>
            </DialogHeader>
            <DecisionEditor batchId={batchId} row={data.rows.find((r) => r.id === deciding)!} categories={categories} onDone={() => setDeciding(null)} />
          </DialogContent>
        </Dialog>
      )}
      {importing && <ImportDialog batchId={batchId} kind="chart" hasRows={data.rows.length > 0} onClose={() => setImporting(false)} />}
      {editingRow != null && <RowEditorDialog batchId={batchId} kind="chart" rows={data.rows as unknown as Record<string, unknown>[]} index={editingRow} onClose={() => setEditingRow(null)} />}
    </div>
  );
}
