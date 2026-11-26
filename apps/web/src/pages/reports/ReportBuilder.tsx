/**
 * 🔴 19B S6 — THE REPORT BUILDER (scope 19.9–19.13; v4 §4, §6.2).
 *
 * A report is built from ONE vetted dataset: which of its columns, in which order, for which period, with which of the
 * filters and the sort the dataset declares, and (19.12) grouped by one of the columns it offers for that — the
 * subtotals are the server's, never added up here. The screen offers only what the server lists (`GET /reports/datasets`) and
 * decides nothing: the rows come from the dataset's own endpoint through the generated client, so every run is checked
 * by `decide()` for the reader's own role — a saved or shared report included. A column the role may not read is
 * marked withheld with the permission it needs, never shown blank; a refusal is shown in the server's words.
 *
 * A named period ("last calendar month") is resolved at each run by `@workspace/shared`'s one resolver from the
 * business day — the same function the server's schedules use.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Download, Play, Save } from "lucide-react";
import {
  getListReportDefinitionsQueryKey, useCreateReportDefinition, useGetReportDefinition, useListReportDatasets, useRunCashMovementsDataset,
  useRunJournalLinesDataset, useRunPurchaseDocumentsDataset, useRunSalesDocumentsDataset, useRunVatLinesDataset, useShareReportDefinition,
  useUpdateReportDefinition, type ReportDatasetColumn, type ReportDatasetGroup, type ReportDatasetSummary, type ReportDatasetTotals, type ReportDatasetWithheld, type ReportDefinition, type ReportDefinitionInput,
} from "@workspace/api-client-react";
import { REPORT_PERIOD_KINDS, REPORT_PERIOD_LABELS, businessToday, resolveReportPeriod, type ReportPeriod, type ReportPeriodKind } from "@workspace/shared";
import { apiDownload, fmtNum } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { GroupTotals } from "@/components/reports/GroupTotals";

const PAGE = 100;
const ROLES: [key: string, en: string, ar: string][] = [
  ["admin", "Admins", "المسؤولون"], ["accountant", "Accountants", "المحاسبون"], ["bookkeeper", "Bookkeepers", "ماسكو الدفاتر"], ["viewer", "Viewers", "المشاهدون"],
];
const CLASS_WORDS: Record<string, [string, string]> = {
  bank_narrative: ["the bank text permission", "صلاحية نص كشف البنك"],
  contact: ["the contact details permission", "صلاحية بيانات الاتصال"],
  identity: ["the identity permission", "صلاحية بيانات الهوية"],
  compensation: ["the pay permission", "صلاحية الرواتب"],
  bank_account: ["the bank account permission", "صلاحية الحسابات البنكية"],
};
const SELECT = "w-full mt-1 h-8 text-sm rounded-md border border-input bg-background px-3 py-1";

interface RunParams { columns?: string; date_from: string; date_to: string; sort?: string; group?: string; limit: number; offset: number; account_id?: number; source_type?: string }
interface RowsResult { data?: { columns: ReportDatasetColumn[]; rows: object[]; total: number; withheld: ReportDatasetWithheld[]; groupedBy?: string | null; groups?: ReportDatasetGroup[] | null; grandTotal?: ReportDatasetTotals | null }; isLoading: boolean; error: unknown }
/** Each dataset's rows through its own generated hook, and its export route as a literal path. */
const RUNNERS: Record<string, { useRows: (p: RunParams) => RowsResult; exportPath: string }> = {
  journal_lines: { useRows: (p) => useRunJournalLinesDataset(p), exportPath: "/reports/datasets/journal_lines/export" },
  sales_documents: { useRows: (p) => useRunSalesDocumentsDataset(p), exportPath: "/reports/datasets/sales_documents/export" },
  purchase_documents: { useRows: (p) => useRunPurchaseDocumentsDataset(p), exportPath: "/reports/datasets/purchase_documents/export" },
  cash_movements: { useRows: (p) => useRunCashMovementsDataset(p), exportPath: "/reports/datasets/cash_movements/export" },
  vat_lines: { useRows: (p) => useRunVatLinesDataset(p), exportPath: "/reports/datasets/vat_lines/export" },
};

interface Draft { name: string; dataset: string; columns: string[]; period: ReportPeriod; filters: Record<string, string>; sortKey: string; sortDesc: boolean; groupBy: string }
const blank = (dataset: string): Draft => ({ name: "", dataset, columns: [], period: { kind: "this_month", from: null, to: null }, filters: {}, sortKey: "", sortDesc: false, groupBy: "" });
const fromDefinition = (d: ReportDefinition): Draft => ({
  name: d.name, dataset: d.dataset, columns: d.columns, period: { kind: d.period.kind, from: d.period.from ?? null, to: d.period.to ?? null },
  filters: d.filters, sortKey: (d.sort ?? "").replace(/^-/, ""), sortDesc: (d.sort ?? "").startsWith("-"), groupBy: d.groupBy ?? "",
});
const sortOf = (d: Draft) => (d.sortKey ? `${d.sortDesc ? "-" : ""}${d.sortKey}` : null);
const inputOf = (d: Draft): ReportDefinitionInput => ({ name: d.name, dataset: d.dataset, columns: d.columns, period: d.period, filters: d.filters, sort: sortOf(d), groupBy: d.groupBy || null });

export default function ReportBuilder() {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const idParam = Number(new URLSearchParams(useSearch()).get("id"));
  const definitionId = Number.isInteger(idParam) && idParam > 0 ? idParam : null;

  const datasets = useListReportDatasets();
  const saved = useGetReportDefinition(definitionId ?? 0, { query: { enabled: definitionId != null, queryKey: ["report-definition", definitionId] } });
  const create = useCreateReportDefinition();
  const update = useUpdateReportDefinition();
  const share = useShareReportDefinition();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [applied, setApplied] = useState<{ dataset: string; params: Omit<RunParams, "limit" | "offset"> } | null>(null);
  const [offset, setOffset] = useState(0);
  const [sharedRoles, setSharedRoles] = useState<string[]>([]);
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);

  const items = datasets.data?.items ?? [];
  // a new report starts on the first dataset the role may run; a saved one loads as it was saved
  useEffect(() => {
    if (definitionId == null && draft == null && items.length) setDraft(blank(items[0]!.name));
  }, [definitionId, draft, items]);
  useEffect(() => {
    if (saved.data) { setDraft(fromDefinition(saved.data)); setSharedRoles(saved.data.sharedRoles); setApplied(null); setOffset(0); }
  }, [saved.data]);

  const ds: ReportDatasetSummary | undefined = items.find((i) => i.name === draft?.dataset);
  const window = useMemo(() => (draft ? resolveReportPeriod(draft.period, businessToday()) : null), [draft]);
  const mine = saved.data?.mine === true;
  const can = (act: "export" | "save" | "share") => ds?.acts.includes(act) === true;
  const label = (c: ReportDatasetColumn) => (lang === "ar" ? c.labelAr : c.label);
  const needs = (c: ReportDatasetColumn) => {
    const [en, ar] = CLASS_WORDS[c.class] ?? [c.class, c.class];
    return t(`Withheld — needs ${en}`, `محجوب — يحتاج ${ar}`);
  };
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const paramsOf = (d: Draft, w: { from: string; to: string }) => ({
    ...(d.columns.length ? { columns: d.columns.join(",") } : {}),
    date_from: w.from, date_to: w.to,
    ...(sortOf(d) ? { sort: sortOf(d)! } : {}),
    ...(d.groupBy ? { group: d.groupBy } : {}),
    ...(d.filters.account_id ? { account_id: Number(d.filters.account_id) } : {}),
    ...(d.filters.source_type ? { source_type: d.filters.source_type } : {}),
  });
  const run = () => { if (draft && window) { setApplied({ dataset: draft.dataset, params: paramsOf(draft, window) }); setOffset(0); } };
  // a saved report opens already run: what was saved is what is shown
  useEffect(() => {
    if (saved.data && draft && applied == null && window && draft.name === saved.data.name && draft.dataset === saved.data.dataset) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.data, draft]);

  const toggle = (key: string) => draft && set({ columns: draft.columns.includes(key) ? draft.columns.filter((k) => k !== key) : [...draft.columns, key] });
  const move = (key: string, by: -1 | 1) => {
    if (!draft) return;
    const i = draft.columns.indexOf(key); const j = i + by;
    if (i < 0 || j < 0 || j >= draft.columns.length) return;
    const next = [...draft.columns]; [next[i], next[j]] = [next[j]!, next[i]!];
    set({ columns: next });
  };

  const saveAs = async (asNew: boolean) => {
    if (!draft) return;
    try {
      const out = !asNew && mine && definitionId != null
        ? await update.mutateAsync({ id: definitionId, data: inputOf(draft) })
        : await create.mutateAsync({ data: inputOf(draft) });
      await qc.invalidateQueries({ queryKey: getListReportDefinitionsQueryKey() });
      toast({ title: t("Report saved", "تم حفظ التقرير"), description: out.name });
      if (out.id !== definitionId) navigate(`/reports/builder?id=${out.id}`); else await saved.refetch();
    } catch (e) {
      toast({ title: t("The report was not saved", "لم يُحفظ التقرير"), description: (e as Error).message, variant: "destructive" });
    }
  };
  const saveSharing = async () => {
    if (definitionId == null) return;
    try {
      const out = await share.mutateAsync({ id: definitionId, data: { roles: sharedRoles as ("admin" | "accountant" | "bookkeeper" | "viewer")[] } });
      setSharedRoles(out.sharedRoles);
      await qc.invalidateQueries({ queryKey: getListReportDefinitionsQueryKey() });
      toast({ title: t("Sharing updated", "تم تحديث المشاركة"), description: out.sharedRoles.length ? t("Each person still sees only what their own role allows.", "كل شخص يرى فقط ما يسمح به دوره.") : t("This report is no longer shared.", "لم يعد هذا التقرير مشتركاً.") });
    } catch (e) {
      toast({ title: t("Sharing was not changed", "لم تتغير المشاركة"), description: (e as Error).message, variant: "destructive" });
    }
  };
  // 19.15 — the same report as a file, CSV or PDF: the same rows, the same withholding, the same subtotals
  const exportAs = async (format: "csv" | "pdf") => {
    if (!applied) return;
    const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(applied.params).map(([k, v]) => [k, String(v)])), lang, format });
    setExporting(format);
    try {
      await apiDownload(`${RUNNERS[applied.dataset]!.exportPath}?${qs.toString()}`, `${applied.dataset.replace(/_/g, "-")}.${format}`);
    } catch (e) {
      toast({ title: t("The export was not produced", "لم يتم إنشاء الملف"), description: (e as Error).message, variant: "destructive" });
    } finally { setExporting(null); }
  };

  if (definitionId != null && saved.error) {
    return (
      <div className="space-y-3" data-testid="report-builder-page">
        <h1 className="text-2xl font-bold text-foreground">{t("Report builder", "منشئ التقارير")}</h1>
        <p className="text-sm text-attention" data-testid="builder-not-found">{t("This saved report was not found. It may have been removed, or it is not shared with your role.", "لم يُعثر على هذا التقرير المحفوظ. ربما أُزيل أو أنه غير مشترك مع دورك.")}</p>
        <Link href="/reports/saved" className="text-sm underline">{t("Saved reports", "التقارير المحفوظة")}</Link>
      </div>
    );
  }
  if (!draft || !ds) {
    return <p className="text-sm text-muted-foreground" data-testid="report-builder-page">{datasets.isLoading || saved.isLoading ? t("Loading…", "جارٍ التحميل…") : t("Your role cannot run any report data.", "دورك لا يسمح بتشغيل أي بيانات تقارير.")}</p>;
  }

  const chosen = draft.columns.map((k) => ds.columns.find((c) => c.key === k)).filter((c): c is ReportDatasetColumn => !!c);
  const unchosen = ds.columns.filter((c) => !draft.columns.includes(c.key));
  const otherFilters = ds.filters.filter((f) => f.param !== "date_from" && f.param !== "date_to");
  const sortable = ds.columns.filter((c) => c.sortable && c.level === "read");
  const groupable = ds.groupBy.map((k) => ds.columns.find((c) => c.key === k)).filter((c): c is ReportDatasetColumn => !!c);
  const busy = create.isPending || update.isPending;

  return (
    <div className="space-y-6" data-testid="report-builder-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Report builder", "منشئ التقارير")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Choose report data, its columns and a period. Every run is checked against your own role.", "اختر بيانات التقرير وأعمدته وفترته. يُفحص كل تشغيل وفق دورك أنت.")}</p>
        </div>
        <Link href="/reports/saved" className="text-sm underline text-foreground" data-testid="builder-saved-link">{t("Saved reports", "التقارير المحفوظة")}</Link>
      </div>

      {saved.data && !mine && (
        <p className="text-xs text-muted-foreground" data-testid="builder-shared-note">
          {t(`Shared by ${saved.data.ownerName}. You can run it and save your own copy; only they can change it.`, `مشترك من ${saved.data.ownerName}. يمكنك تشغيله وحفظ نسختك؛ التغيير لصاحبه فقط.`)}
        </p>
      )}

      <Card className="border-border bg-card">
        <CardContent className="pt-4 grid gap-4 md:grid-cols-3">
          <div>
            <Label className="text-xs text-muted-foreground" htmlFor="builder-dataset">{t("Report data", "بيانات التقرير")}</Label>
            <select id="builder-dataset" className={SELECT} value={draft.dataset} data-testid="builder-dataset"
              onChange={(e) => { setDraft({ ...blank(e.target.value), name: draft.name, period: draft.period }); setApplied(null); }}>
              {items.map((i) => <option key={i.name} value={i.name}>{lang === "ar" ? i.titleAr : i.title}</option>)}
            </select>
            {ds.caveat && <p className="text-[11px] text-attention mt-1" data-testid="builder-caveat">{lang === "ar" ? ds.caveatAr ?? ds.caveat : ds.caveat}</p>}
          </div>
          <div>
            <Label className="text-xs text-muted-foreground" htmlFor="builder-period">{t("Period", "الفترة")}</Label>
            <select id="builder-period" className={SELECT} value={draft.period.kind} data-testid="builder-period"
              onChange={(e) => { const kind = e.target.value as ReportPeriodKind; set({ period: kind === "fixed" ? { kind, from: window?.from ?? null, to: window?.to ?? null } : { kind, from: null, to: null } }); }}>
              {REPORT_PERIOD_KINDS.map((k) => <option key={k} value={k}>{t(REPORT_PERIOD_LABELS[k][0], REPORT_PERIOD_LABELS[k][1])}</option>)}
            </select>
            <p className="text-[11px] text-muted-foreground mt-1" data-testid="builder-window">
              {window ? <span dir="ltr">{window.from} – {window.to}</span> : t("Enter a start and an end date.", "أدخل تاريخ البداية والنهاية.")}
            </p>
          </div>
          {draft.period.kind === "fixed" && (
            <div className="flex gap-2">
              <div className="flex-1"><Label className="text-xs text-muted-foreground" htmlFor="builder-from">{t("From", "من")}</Label><Input id="builder-from" type="date" className="mt-1 h-8 text-sm" value={draft.period.from ?? ""} onChange={(e) => set({ period: { ...draft.period, from: e.target.value || null } })} data-testid="builder-from" /></div>
              <div className="flex-1"><Label className="text-xs text-muted-foreground" htmlFor="builder-to">{t("To", "إلى")}</Label><Input id="builder-to" type="date" className="mt-1 h-8 text-sm" value={draft.period.to ?? ""} onChange={(e) => set({ period: { ...draft.period, to: e.target.value || null } })} data-testid="builder-to" /></div>
            </div>
          )}
          {otherFilters.map((f) => {
            const col = ds.columns.find((c) => c.key === f.column);
            return (
              <div key={f.param}>
                <Label className="text-xs text-muted-foreground" htmlFor={`builder-filter-${f.param}`}>{t("Only where", "فقط حيث")} {col ? label(col) : f.column}</Label>
                <Input id={`builder-filter-${f.param}`} className="mt-1 h-8 text-sm" inputMode={col?.kind === "int" ? "numeric" : undefined} value={draft.filters[f.param] ?? ""} data-testid={`builder-filter-${f.param}`}
                  onChange={(e) => { const next = { ...draft.filters }; if (e.target.value) next[f.param] = e.target.value; else delete next[f.param]; set({ filters: next }); }} />
              </div>
            );
          })}
          <div>
            <Label className="text-xs text-muted-foreground" htmlFor="builder-sort">{t("Sort by", "الترتيب حسب")}</Label>
            <div className="flex gap-2">
              <select id="builder-sort" className={SELECT} value={draft.sortKey} onChange={(e) => set({ sortKey: e.target.value })} data-testid="builder-sort">
                <option value="">{t("The report's own order", "ترتيب التقرير نفسه")}</option>
                {sortable.map((c) => <option key={c.key} value={c.key}>{label(c)}</option>)}
              </select>
              {draft.sortKey && (
                <select className={`${SELECT} w-36`} value={draft.sortDesc ? "desc" : "asc"} onChange={(e) => set({ sortDesc: e.target.value === "desc" })} aria-label={t("Direction", "الاتجاه")} data-testid="builder-sort-direction">
                  <option value="asc">{t("Ascending", "تصاعدي")}</option>
                  <option value="desc">{t("Descending", "تنازلي")}</option>
                </select>
              )}
            </div>
          </div>
          {groupable.length > 0 && (
            <div>
              <Label className="text-xs text-muted-foreground" htmlFor="builder-group">{t("Group and subtotal by", "التجميع والمجاميع الفرعية حسب")}</Label>
              <select id="builder-group" className={SELECT} value={draft.groupBy} onChange={(e) => set({ groupBy: e.target.value })} data-testid="builder-group">
                <option value="">{t("Not grouped", "بدون تجميع")}</option>
                {groupable.map((c) => <option key={c.key} value={c.key}>{label(c)}{c.kind === "date" ? t(" (month)", " (الشهر)") : ""}</option>)}
              </select>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border bg-card">
        <CardContent className="pt-4 grid gap-4 md:grid-cols-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{t("Columns shown, in order", "الأعمدة المعروضة بالترتيب")}</h2>
            {chosen.length === 0 ? (
              <p className="text-xs text-muted-foreground mt-2" data-testid="builder-all-columns">{t("None chosen: every column is shown.", "لم يُختر شيء: تُعرض كل الأعمدة.")}</p>
            ) : (
              <ol className="mt-2 space-y-1" data-testid="builder-chosen">
                {chosen.map((c, i) => (
                  <li key={c.key} className="flex items-center gap-2 text-sm" data-testid={`builder-chosen-${c.key}`}>
                    <span className="flex-1 min-w-0 truncate">{i + 1}. {label(c)}{c.level !== "read" && <span className="block text-[10px] text-attention">{needs(c)}</span>}</span>
                    <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={i === 0} onClick={() => move(c.key, -1)} aria-label={t(`Move ${c.label} up`, `تحريك ${c.labelAr} لأعلى`)} data-testid={`builder-up-${c.key}`}><ArrowUp className="w-3.5 h-3.5" /></Button>
                    <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={i === chosen.length - 1} onClick={() => move(c.key, 1)} aria-label={t(`Move ${c.label} down`, `تحريك ${c.labelAr} لأسفل`)} data-testid={`builder-down-${c.key}`}><ArrowDown className="w-3.5 h-3.5" /></Button>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => toggle(c.key)} data-testid={`builder-remove-${c.key}`}>{t("Remove", "إزالة")}</Button>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">{t("Other columns", "أعمدة أخرى")}</h2>
            <ul className="mt-2 flex flex-wrap gap-2" data-testid="builder-available">
              {unchosen.map((c) => (
                <li key={c.key}>
                  <Button size="sm" variant="outline" className="h-auto min-h-7 py-1 flex-col items-start" onClick={() => toggle(c.key)} data-testid={`builder-add-${c.key}`} data-level={c.level}>
                    <span>+ {label(c)}</span>
                    {c.level !== "read" && <span className="text-[10px] text-attention font-normal">{needs(c)}</span>}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border bg-card">
        <CardContent className="pt-4 flex flex-wrap items-end gap-3">
          <Button size="sm" className="h-8" disabled={!window} onClick={run} data-testid="builder-run"><Play className="w-3.5 h-3.5 me-1" />{t("Run", "تشغيل")}</Button>
          <Button size="sm" variant="outline" className="h-8" disabled={!applied || exporting != null} onClick={() => void exportAs("csv")} data-testid="builder-export"><Download className="w-3.5 h-3.5 me-1" />{exporting === "csv" ? t("Preparing…", "جارٍ التحضير…") : t("Export CSV", "تصدير CSV")}</Button>
          <Button size="sm" variant="outline" className="h-8" disabled={!applied || exporting != null} onClick={() => void exportAs("pdf")} data-testid="builder-export-pdf"><Download className="w-3.5 h-3.5 me-1" />{exporting === "pdf" ? t("Preparing…", "جارٍ التحضير…") : t("Export PDF", "تصدير PDF")}</Button>
          {!can("export") && <span className="text-[11px] text-muted-foreground">{t("Your role cannot export this report.", "دورك لا يسمح بتصدير هذا التقرير.")}</span>}
          <div className="flex-1 min-w-[12rem]">
            <Label className="text-xs text-muted-foreground" htmlFor="builder-name">{t("Name, to save it", "الاسم، لحفظه")}</Label>
            <Input id="builder-name" className="mt-1 h-8 text-sm" maxLength={120} value={draft.name} onChange={(e) => set({ name: e.target.value })} data-testid="builder-name" />
          </div>
          {mine && <Button size="sm" className="h-8" disabled={busy || !draft.name.trim() || !window} onClick={() => void saveAs(false)} data-testid="builder-save"><Save className="w-3.5 h-3.5 me-1" />{t("Save changes", "حفظ التغييرات")}</Button>}
          <Button size="sm" variant={mine ? "outline" : "default"} className="h-8" disabled={busy || !draft.name.trim() || !window} onClick={() => void saveAs(true)} data-testid="builder-save-new"><Save className="w-3.5 h-3.5 me-1" />{mine || saved.data ? t("Save as a new report", "حفظ كتقرير جديد") : t("Save", "حفظ")}</Button>
          {!can("save") && <span className="text-[11px] text-muted-foreground">{t("Your role cannot save this report.", "دورك لا يسمح بحفظ هذا التقرير.")}</span>}
        </CardContent>
      </Card>

      {mine && (
        <Card className="border-border bg-card">
          <CardContent className="pt-4 space-y-2" data-testid="builder-sharing">
            <h2 className="text-sm font-semibold text-foreground">{t("Share with roles", "المشاركة مع الأدوار")}</h2>
            <p className="text-xs text-muted-foreground">{t("Sharing shows this report to those roles. It gives no one access: each person sees only what their own role allows, checked every time they run it.", "المشاركة تُظهر هذا التقرير لتلك الأدوار ولا تمنح أحداً صلاحية: كل شخص يرى فقط ما يسمح به دوره، ويُفحص ذلك في كل تشغيل.")}</p>
            <div className="flex flex-wrap items-center gap-4">
              {ROLES.map(([key, en, ar]) => (
                <label key={key} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={sharedRoles.includes(key)} disabled={!can("share")} onChange={(e) => setSharedRoles(e.target.checked ? [...sharedRoles, key] : sharedRoles.filter((r) => r !== key))} data-testid={`builder-share-${key}`} />
                  {t(en, ar)}
                </label>
              ))}
              <Button size="sm" variant="outline" className="h-8" disabled={!can("share") || share.isPending} onClick={() => void saveSharing()} data-testid="builder-share-save">{t("Update sharing", "تحديث المشاركة")}</Button>
            </div>
            {!can("share") && <p className="text-[11px] text-muted-foreground" data-testid="builder-share-refused">{t("Your role cannot share reports.", "دورك لا يسمح بمشاركة التقارير.")}</p>}
          </CardContent>
        </Card>
      )}

      {applied && <Results key={`${applied.dataset}:${JSON.stringify(applied.params)}:${offset}`} applied={applied} offset={offset} setOffset={setOffset} needs={needs} names={ds.columns} />}
    </div>
  );
}

function Results({ applied, offset, setOffset, needs, names }: { applied: { dataset: string; params: Omit<RunParams, "limit" | "offset"> }; offset: number; setOffset: (n: number) => void; needs: (c: ReportDatasetColumn) => string; names: ReportDatasetColumn[] }) {
  const { t, lang } = useLanguage();
  const { data, isLoading, error } = RUNNERS[applied.dataset]!.useRows({ ...applied.params, limit: PAGE, offset });
  const refusal = (error as { data?: { error?: string; errorAr?: string } } | null)?.data;
  const cell = (c: ReportDatasetColumn, row: Record<string, unknown>) => {
    if (!(c.key in row)) return <span className="text-[11px] text-muted-foreground italic" data-testid="builder-cell-withheld">{t("withheld", "محجوب")}</span>;
    const v = row[c.key];
    if (v == null || v === "") return "—";
    if (typeof v === "boolean") return v ? t("yes", "نعم") : t("no", "لا");
    if (c.kind === "money") return fmtNum(Number(v));
    return String(v);
  };
  return (
    <Card className="border-border bg-card">
      <CardContent className="pt-4 overflow-x-auto" data-testid="builder-results">
        {refusal && <p className="text-sm text-attention" data-testid="builder-refusal">{lang === "ar" ? refusal.errorAr ?? refusal.error : refusal.error}</p>}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
        ) : data && data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="builder-empty">{t("Nothing in this period.", "لا توجد بيانات في هذه الفترة.")}</p>
        ) : data ? (
          <>
            {data.withheld.length > 0 && <p className="text-xs text-muted-foreground pb-2" data-testid="builder-withheld-note">{t("Some values are withheld for your role; each is marked where it would be.", "بعض القيم محجوبة لدورك، وكل منها مُعلَّم في مكانه.")}</p>}
            {data.groupedBy && data.groups && <GroupTotals groupedBy={data.groupedBy} groups={data.groups} grandTotal={data.grandTotal} columns={data.columns} withheld={data.withheld} names={names} testId="builder-groups" />}
            <table className="w-full text-sm" data-testid="builder-table">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  {data.columns.map((c) => (
                    <th key={c.key} className="text-start py-2 pe-3 font-medium align-bottom" data-testid={`builder-col-${c.key}`} data-level={c.level}>
                      {lang === "ar" ? c.labelAr : c.label}
                      {c.level !== "read" && <span className="block text-[10px] font-normal text-attention">{needs(c)}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={i} className="border-b border-border/50" data-testid="builder-row">
                    {data.columns.map((c) => <td key={c.key} className={`py-2 pe-3 ${c.kind === "money" ? "font-mono" : ""}`}>{cell(c, r as Record<string, unknown>)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between pt-3 text-xs text-muted-foreground">
              <span data-testid="builder-count">{t(`${offset + 1}–${offset + data.rows.length} of ${data.total}`, `${offset + 1}–${offset + data.rows.length} من ${data.total}`)}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-7" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t("Previous", "السابق")}</Button>
                <Button size="sm" variant="outline" className="h-7" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>{t("Next", "التالي")}</Button>
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
