/**
 * Phase 15 — one budget: its versions, its lines, and budget vs actual
 * (decision pack §5).
 *
 * - A line is EITHER twelve fiscal-period amounts OR one annual amount; an
 *   annual amount is never divided (D15-03), and budget vs actual shows "—"
 *   where a divided figure would otherwise appear.
 * - Lines are editable only on a DRAFT version. Submit / approve / send back /
 *   reject run the platform's one approval engine; the database refuses an edit
 *   to an approved version even if this page did not (D15-04).
 * - Variance is judged in WORDS with neutral ink — never the status palette
 *   (CLAUDE.md §4: a variance is a judgment, not a state).
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBudget, useListBudgetAccounts, useGetBudgetVsActual,
  useReplaceBudgetLines, useSubmitBudgetVersion, useApproveBudgetVersion, useSendBackBudgetVersion,
  useRejectBudgetVersion, useReviseBudget, useDeleteBudget, getGetBudgetVsActualQueryKey,
  type BudgetDetail as BudgetDetailT, type BudgetVsActualLine,
} from "@workspace/api-client-react";
import { fmtDate, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { ReportExportButtons } from "@/components/reports/ReportExport";
import { judgementLabel, periodLabel, scenarioLabel, versionStatusLabel } from "@/lib/budgetLabels";

type EditLine = { accountId: number; mode: "periods" | "annual"; periods: string[]; annual: string };
const blankPeriods = () => Array(12).fill("") as string[];
const toEdit = (d: BudgetDetailT): EditLine[] =>
  d.lines.map((l) => ({
    accountId: l.accountId,
    mode: l.mode,
    periods: l.periods ? l.periods.map((x) => String(x)) : blankPeriods(),
    annual: l.annualAmount != null ? String(l.annualAmount) : "",
  }));
const amount = (s: string) => (s.trim() === "" ? 0 : Number(s));
const money = (x: number | null | undefined) => (x == null ? "—" : fmtNum(x));
const pct = (x: number | null | undefined) => (x == null ? "—" : `${x.toFixed(2)}%`);

export default function BudgetDetail() {
  const { id: idParam } = useParams<{ id: string }>();
  const id = Number(idParam);
  const { t, n, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [versionId, setVersionId] = useState<number | undefined>(undefined);
  const [tab, setTab] = useState("lines");
  const [through, setThrough] = useState<string>("");
  const [lines, setLines] = useState<EditLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState<"reject" | "delete" | "send-back" | null>(null);
  const [note, setNote] = useState("");

  const { data, isLoading, isError } = useGetBudget(id, versionId != null ? { version_id: versionId } : undefined);
  const { data: accounts = [] } = useListBudgetAccounts();
  const v = data?.version ?? null;
  const editable = v?.status === "draft";
  const vsParams = { ...(v ? { version_id: v.id } : {}), ...(through !== "" ? { through_period: Number(through) } : {}) };
  const vs = useGetBudgetVsActual(id, vsParams, { query: { enabled: tab === "vs" && !!v, queryKey: getGetBudgetVsActualQueryKey(id, vsParams) } });

  // the editor follows the version shown; an unsaved edit is not overwritten by a refetch
  useEffect(() => {
    if (data && !dirty) setLines(toEdit(data));
  }, [data, dirty]);

  const refresh = () => qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/api/budgets") });
  const onDone = (msg: [string, string]) => () => { setDirty(false); setConfirm(null); setNote(""); refresh(); toast({ title: t(...msg) }); };
  const save = useReplaceBudgetLines({ mutation: { onSuccess: onDone(["Lines saved", "تم حفظ البنود"]) } });
  const submit = useSubmitBudgetVersion({ mutation: { onSuccess: onDone(["Submitted for approval", "قُدِّمت للاعتماد"]) } });
  const approve = useApproveBudgetVersion({ mutation: { onSuccess: onDone(["Approved", "تم الاعتماد"]) } });
  const sendBack = useSendBackBudgetVersion({ mutation: { onSuccess: onDone(["Sent back for correction", "أُعيدت للتصحيح"]) } });
  const reject = useRejectBudgetVersion({ mutation: { onSuccess: () => { setConfirm(null); setVersionId(undefined); refresh(); toast({ title: t("Version rejected", "رُفض الإصدار") }); } } });
  const revise = useReviseBudget({ mutation: { onSuccess: (d) => { setVersionId(d.version?.id); setDirty(false); refresh(); toast({ title: t("Revision started — a new draft", "بدأت مراجعة — مسودة جديدة") }); } } });
  const remove = useDeleteBudget({ mutation: { onSuccess: () => { refresh(); navigate("/budgets"); toast({ title: t("Budget deleted", "حُذفت الميزانية") }); } } });

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const unused = accounts.filter((a) => !lines.some((l) => l.accountId === a.id));
  const [toAdd, setToAdd] = useState<string>("");
  const edit = (i: number, patch: Partial<EditLine>) => { setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l))); setDirty(true); };

  if (isLoading) return <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>;
  if (isError || !data) return <div className="text-sm text-muted-foreground p-4" data-testid="budget-not-found">{t("This budget does not exist, or belongs to another company.", "هذه الميزانية غير موجودة أو تخص شركة أخرى.")}</div>;

  const neverApproved = !data.versions.some((x) => x.status === "approved" || x.status === "superseded");
  const lineTotal = (l: EditLine) => (l.mode === "annual" ? amount(l.annual) : l.periods.reduce((s, x) => s + amount(x), 0));
  const busy = save.isPending || submit.isPending || approve.isPending || sendBack.isPending || reject.isPending || revise.isPending || remove.isPending;

  return (
    <div className="space-y-6" data-testid="budget-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/budgets" className="text-xs text-muted-foreground hover:underline inline-flex items-center gap-1"><ArrowLeft className="w-3 h-3 rtl:rotate-180" />{t("Budgets", "الميزانيات")}</Link>
          <h1 className="text-2xl font-bold text-foreground break-words">{n(data.name, data.nameAr)}</h1>
          <p className="text-muted-foreground text-sm mt-1" data-testid="budget-fiscal-year">
            {t("Fiscal year", "السنة المالية")} {data.fiscalYear.label} · {fmtDate(data.fiscalYear.startDate)} – {fmtDate(data.fiscalYear.endDate)}
            {data.fiscalYear.calendar === "hijri" ? ` · ${t("Hijri (Umm al-Qura)", "هجري (أم القرى)")}` : ""} · {scenarioLabel(data.scenario, t)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={v ? String(v.id) : ""} onValueChange={(x) => { setVersionId(Number(x)); setDirty(false); setConfirm(null); }}>
            <SelectTrigger className="h-8 w-56 text-sm" data-testid="budget-version-select"><SelectValue /></SelectTrigger>
            <SelectContent>
              {data.versions.map((x) => <SelectItem key={x.id} value={String(x.id)}>v{x.versionNo} · {versionStatusLabel(x.status, t)}</SelectItem>)}
            </SelectContent>
          </Select>
          {v && <span className="text-xs rounded-md border border-border px-2 py-1" data-testid="budget-version-status">v{v.versionNo} · {versionStatusLabel(v.status, t)}</span>}
        </div>
      </div>

      {v?.sendBackNote && v.status === "draft" && (
        <p className="text-sm rounded-md border border-border px-3 py-2" data-testid="budget-send-back-note-shown">{t("Sent back: ", "أُعيدت: ")}{v.sendBackNote}</p>
      )}

      {/* ── actions: every control visible; the server refuses what a role may not do, and says why ── */}
      {v && (
        <div className="flex flex-wrap gap-2" data-testid="budget-actions">
          {v.status === "draft" && <Button size="sm" disabled={busy || dirty} onClick={() => submit.mutate({ id, versionId: v.id })} data-testid="budget-submit">{t("Submit for approval", "تقديم للاعتماد")}</Button>}
          {(v.status === "draft" || v.status === "submitted") && <Button size="sm" variant="secondary" disabled={busy || dirty} onClick={() => approve.mutate({ id, versionId: v.id })} data-testid="budget-approve">{t("Approve", "اعتماد")}</Button>}
          {v.status === "submitted" && <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm("send-back")} data-testid="budget-send-back">{t("Send back", "إعادة للتصحيح")}</Button>}
          {(v.status === "draft" || v.status === "submitted") && <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm("reject")} data-testid="budget-reject">{t("Reject", "رفض")}</Button>}
          {v.status === "approved" && !data.openVersionId && <Button size="sm" variant="outline" disabled={busy} onClick={() => revise.mutate({ id })} data-testid="budget-revise">{t("Start a revision", "بدء مراجعة")}</Button>}
          {neverApproved && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm("delete")} data-testid="budget-delete"><Trash2 className="w-4 h-4 me-1" />{t("Delete budget", "حذف الميزانية")}</Button>}
        </div>
      )}
      {confirm && v && (
        <Card className="border-border">
          <CardContent className="pt-4 space-y-3">
            {confirm === "send-back" && (
              <>
                <Label className="text-xs text-muted-foreground">{t("What should be corrected?", "ما الذي يجب تصحيحه؟")}</Label>
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} data-testid="budget-send-back-text" />
              </>
            )}
            <p className="text-sm">
              {confirm === "reject" && t(`Reject version ${v.versionNo}? It is deleted — the approved version, if any, is untouched.`, `رفض الإصدار ${v.versionNo}؟ سيُحذف — ويبقى الإصدار المعتمد، إن وجد، كما هو.`)}
              {confirm === "delete" && t("Delete this budget? It has never been approved, so nothing of record is lost.", "حذف هذه الميزانية؟ لم تُعتمد قط، فلا يضيع أي سجل.")}
              {confirm === "send-back" && t("The author can then edit and resubmit it.", "يمكن لمُعدّها بعد ذلك تعديلها وإعادة تقديمها.")}
            </p>
            <div className="flex gap-2">
              <Button size="sm" data-testid="budget-confirm" disabled={busy} onClick={() => {
                if (confirm === "reject") reject.mutate({ id, versionId: v.id });
                else if (confirm === "delete") remove.mutate({ id });
                else sendBack.mutate({ id, versionId: v.id, data: { note: note.trim() || null } });
              }}>{t("Confirm", "تأكيد")}</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>{t("Cancel", "إلغاء")}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Radix Tabs writes its own dir="ltr" unless told otherwise — without this the whole
          tab body (both tables) read left-to-right inside an Arabic page (pre-merge audit, 2026-10-02) */}
      <Tabs value={tab} onValueChange={setTab} dir={lang === "ar" ? "rtl" : "ltr"}>
        <TabsList>
          <TabsTrigger value="lines" data-testid="budget-tab-lines">{t("Lines", "البنود")}</TabsTrigger>
          <TabsTrigger value="vs" data-testid="budget-tab-vs">{t("Budget vs actual", "الميزانية مقابل الفعلي")}</TabsTrigger>
        </TabsList>

        {/* ── lines ─────────────────────────────────────────────────────── */}
        <TabsContent value="lines">
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">
                {editable
                  ? t("Each account: twelve period amounts, or one annual amount (never divided across periods).", "لكل حساب: اثنا عشر مبلغاً للفترات، أو مبلغ سنوي واحد (لا يُقسَّم على الفترات).")
                  : t("This version is locked — start a revision to change an approved budget.", "هذا الإصدار مقفل — ابدأ مراجعة لتغيير ميزانية معتمدة.")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="overflow-x-auto">
                <table className="text-sm min-w-full">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-xs">
                      <th className="text-start pb-2 pe-3 font-medium min-w-40">{t("Account", "الحساب")}</th>
                      <th className="text-start pb-2 pe-3 font-medium">{t("Basis", "الأساس")}</th>
                      {data.periods.map((p) => <th key={p.no} className="text-end pb-2 pe-2 font-medium whitespace-nowrap">{periodLabel(p, data.fiscalYear.calendar, lang)}</th>)}
                      <th className="text-end pb-2 pe-2 font-medium">{t("Year", "السنة")}</th>
                      {editable && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => {
                      const a = accountById.get(l.accountId);
                      return (
                        <tr key={l.accountId} className="border-b border-border/50" data-testid={`budget-line-${l.accountId}`}>
                          <td className="py-2 pe-3">{a ? n(a.name, a.nameAr) : `#${l.accountId}`}<span className="ms-1 text-[10px] text-muted-foreground">{a?.type === "income" ? t("income", "إيراد") : t("expense", "مصروف")}</span></td>
                          <td className="py-2 pe-3">
                            {editable ? (
                              <Select value={l.mode} onValueChange={(m) => edit(i, { mode: m as EditLine["mode"] })}>
                                <SelectTrigger className="h-7 w-32 text-xs" data-testid={`budget-line-mode-${l.accountId}`}><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="periods">{t("By period", "حسب الفترة")}</SelectItem>
                                  <SelectItem value="annual">{t("Annual only", "سنوي فقط")}</SelectItem>
                                </SelectContent>
                              </Select>
                            ) : <span className="text-xs">{l.mode === "annual" ? t("Annual only", "سنوي فقط") : t("By period", "حسب الفترة")}</span>}
                          </td>
                          {data.periods.map((p, k) => (
                            <td key={p.no} className="py-2 pe-2 text-end">
                              {l.mode === "annual" ? <span className="text-muted-foreground">—</span>
                                : editable ? <Input dir="ltr" inputMode="decimal" className="h-7 w-24 text-end font-mono text-xs" value={l.periods[k]} onChange={(e) => edit(i, { periods: l.periods.map((x, j) => (j === k ? e.target.value : x)) })} data-testid={`budget-line-period-${l.accountId}-${p.no}`} />
                                : <span className="font-mono text-xs" dir="ltr">{fmtNum(amount(l.periods[k] ?? ""))}</span>}
                            </td>
                          ))}
                          <td className="py-2 pe-2 text-end">
                            {l.mode === "annual" && editable
                              ? <Input dir="ltr" inputMode="decimal" className="h-7 w-28 text-end font-mono text-xs" value={l.annual} onChange={(e) => edit(i, { annual: e.target.value })} data-testid={`budget-line-annual-${l.accountId}`} />
                              : <span className="font-mono text-xs font-semibold" dir="ltr" data-testid={`budget-line-total-${l.accountId}`}>{fmtNum(lineTotal(l))}</span>}
                          </td>
                          {editable && <td><Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => { setLines((ls) => ls.filter((_, j) => j !== i)); setDirty(true); }} aria-label={t("Remove", "إزالة")}><Trash2 className="w-3.5 h-3.5" /></Button></td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {lines.length === 0 && <p className="text-sm text-muted-foreground" data-testid="budget-no-lines">{t("No lines yet. Add an income or expense account.", "لا بنود بعد. أضف حساب إيراد أو مصروف.")}</p>}
              {editable && (
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={toAdd} onValueChange={setToAdd}>
                    <SelectTrigger className="h-8 w-64 text-sm" data-testid="budget-add-account"><SelectValue placeholder={t("Add an account…", "أضف حساباً…")} /></SelectTrigger>
                    <SelectContent>{unused.map((a) => <SelectItem key={a.id} value={String(a.id)}>{n(a.name, a.nameAr)}</SelectItem>)}</SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" disabled={!toAdd} data-testid="budget-add-line" onClick={() => { setLines((ls) => [...ls, { accountId: Number(toAdd), mode: "periods", periods: blankPeriods(), annual: "" }]); setToAdd(""); setDirty(true); }}><Plus className="w-4 h-4 me-1" />{t("Add line", "إضافة بند")}</Button>
                  <Button size="sm" disabled={!dirty || busy} data-testid="budget-save-lines" onClick={() => save.mutate({ id, versionId: v!.id, data: { lines: lines.map((l) => (l.mode === "annual" ? { accountId: l.accountId, annualAmount: amount(l.annual) } : { accountId: l.accountId, periods: l.periods.map(amount) })) } })}>
                    {save.isPending ? t("Saving…", "جارٍ الحفظ…") : t("Save lines", "حفظ البنود")}
                  </Button>
                  {dirty && <span className="text-xs text-muted-foreground">{t("Unsaved — save before submitting.", "غير محفوظ — احفظ قبل التقديم.")}</span>}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── budget vs actual ───────────────────────────────────────────── */}
        <TabsContent value="vs">
          <Card className="border-border bg-card">
            <CardHeader className="pb-2 space-y-2">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Year to date through period", "منذ بداية السنة حتى الفترة")}</Label>
                  <Select value={through !== "" ? through : String(vs.data?.throughPeriod ?? "")} onValueChange={setThrough}>
                    <SelectTrigger className="mt-1 h-8 w-56 text-sm" data-testid="bva-through"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">{t("None yet", "لا شيء بعد")}</SelectItem>
                      {data.periods.map((p) => <SelectItem key={p.no} value={String(p.no)}>{periodLabel(p, data.fiscalYear.calendar, lang)} · {fmtDate(p.endDate)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                {v && <ReportExportButtons report="budget-vs-actual" params={{ budget_id: String(id), version_id: String(v.id), ...(vs.data ? { through_period: String(vs.data.throughPeriod) } : {}) }} />}
              </div>
              <p className="text-xs text-muted-foreground" data-testid="bva-notes">
                {t("Actuals are the posted ledger (accrual), in each account's natural direction; variance = actual − budget. Year to date runs through a COMPLETED period. An annual-only amount is never divided (“—”). Forecast = actuals through the period + the budget for the rest — a projection, not a budget.",
                  "الفعلي من الدفتر المرحَّل (أساس الاستحقاق) باتجاه كل حساب؛ الانحراف = الفعلي − الميزانية. يمتد «منذ بداية السنة» حتى فترة مكتملة. المبلغ السنوي لا يُقسَّم («—»). التوقع = الفعلي حتى الفترة + ميزانية المتبقي — إسقاط وليس ميزانية.")}
              </p>
            </CardHeader>
            <CardContent>
              {vs.isLoading || !vs.data ? (
                <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="bva-table">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground text-xs">
                        {[t("Account", "الحساب"), t("YTD budget", "الميزانية حتى تاريخه"), t("YTD actual", "الفعلي حتى تاريخه"), t("Variance", "الانحراف"), "%", t("Judgement", "التقييم"), t("Year budget", "ميزانية السنة"), t("Actual to date", "الفعلي حتى الآن"), t("Forecast", "التوقع")].map((h) => <th key={h} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {(["income", "expense"] as const).map((type) => {
                        const rows = [...vs.data!.lines, ...vs.data!.unbudgeted].filter((l) => l.accountType === type);
                        const tot = vs.data!.totals[type];
                        return [
                          <tr key={`${type}-h`}><td colSpan={9} className="pt-3 pb-1 text-xs font-semibold uppercase text-muted-foreground">{type === "income" ? t("Income", "الإيرادات") : t("Expenses", "المصروفات")}</td></tr>,
                          ...rows.map((l: BudgetVsActualLine) => (
                            <tr key={l.accountId} className="border-b border-border/50" data-testid={`bva-line-${l.accountId}`}>
                              <td className="py-2 pe-3">
                                {n(l.accountName, l.accountNameAr)}
                                {l.mode !== "periods" && <span className="ms-1 text-[10px] text-muted-foreground">({l.mode === "annual" ? t("annual only", "سنوي فقط") : t("not budgeted", "غير مُدرج")})</span>}
                                {l.migrated && <span className="ms-1 text-[10px] text-muted-foreground" data-testid={`bva-migrated-${l.accountId}`}>({t("incl. migrated", "يشمل المُرحَّل")} <span dir="ltr">{fmtNum(l.migrated.amount)}</span> · {fmtDate(l.migrated.date)})</span>}
                              </td>
                              <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(l.ytd.budget)}</td>
                              <td className="py-2 pe-3 font-mono text-xs" dir="ltr" data-testid={`bva-ytd-actual-${l.accountId}`}>{money(l.ytd.actual)}</td>
                              <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(l.ytd.variance)}</td>
                              <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{pct(l.ytd.variancePct)}</td>
                              <td className="py-2 pe-3 text-xs">{judgementLabel(l.ytd.favourable, t)}</td>
                              <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(l.fullYear.budget)}</td>
                              <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(l.fullYear.actualToDate)}</td>
                              <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(l.forecast.amount)}</td>
                            </tr>
                          )),
                          <tr key={`${type}-t`} className="border-b border-border font-semibold" data-testid={`bva-total-${type}`}>
                            <td className="py-2 pe-3">{type === "income" ? t("Total income", "إجمالي الإيرادات") : t("Total expenses", "إجمالي المصروفات")}</td>
                            <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(tot.ytd.budget)}</td>
                            <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(tot.ytd.actual)}</td>
                            <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(tot.ytd.variance)}</td>
                            <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{pct(tot.ytd.variancePct)}</td>
                            <td className="py-2 pe-3 text-xs">{judgementLabel(tot.ytd.favourable, t)}</td>
                            <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(tot.fullYear.budget)}</td>
                            <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(tot.fullYear.actualToDate)}</td>
                            <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(tot.forecast.amount)}</td>
                          </tr>,
                        ];
                      })}
                      <tr className="font-bold" data-testid="bva-total-net">
                        <td className="py-2 pe-3">{t("Net", "الصافي")}</td>
                        <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(vs.data.totals.net.ytd.budget)}</td>
                        <td className="py-2 pe-3 font-mono text-xs" dir="ltr" data-testid="bva-total-net-actual">{money(vs.data.totals.net.ytd.actual)}</td>
                        <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(vs.data.totals.net.ytd.variance)}</td>
                        <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{pct(vs.data.totals.net.ytd.variancePct)}</td>
                        <td className="py-2 pe-3 text-xs">{judgementLabel(vs.data.totals.net.ytd.favourable, t)}</td>
                        <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(vs.data.totals.net.fullYear.budget)}</td>
                        <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(vs.data.totals.net.fullYear.actualToDate)}</td>
                        <td className="py-2 pe-3 font-mono text-xs" dir="ltr">{money(vs.data.totals.net.forecast.amount)}</td>
                      </tr>
                    </tbody>
                  </table>
                  {[...vs.data.lines, ...vs.data.unbudgeted].some((l) => l.migrated) && (
                    <p className="text-xs text-muted-foreground mt-2" data-testid="bva-migrated-note">
                      {t("A migration brought in the previous system's year to date as ONE amount on its date: it is never split across the periods it covers, and it counts in the year to date once the period reaches that date.", "أدخل الترحيل ما سبق من السنة في النظام السابق كمبلغ واحد في تاريخه: لا يُقسَّم على الفترات التي يغطيها، ويُحتسب منذ بداية السنة متى بلغت الفترة ذلك التاريخ.")}
                    </p>
                  )}
                  {(vs.data.totals.income.annualOnlyLines + vs.data.totals.expense.annualOnlyLines) > 0 && (
                    <p className="text-xs text-muted-foreground mt-2" data-testid="bva-annual-note">
                      {t("A total with an annual-only line has no year-to-date budget or forecast — showing part of it would read as the whole.", "الإجمالي الذي فيه بند سنوي فقط لا ميزانية له حتى تاريخه ولا توقع — فعرض جزء منه سيُقرأ كأنه الكل.")}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
