/**
 * Batch 1C — the commit, the committed state, and the reversal.
 *
 * The commit button is enabled only when the SERVER says validated (status),
 * the difference is zero and no control fails — and the server re-asserts
 * all three at the commit boundary anyway (a boundary that trusts an
 * earlier check is a convention). The confirmation names what the commit
 * creates and that editing staging cannot undo it.
 *
 * Reversal (Policy C, accountant A4): the existing backend preview + reverse
 * only, admin-only, with the blockers shown verbatim and the consequences
 * listed before the confirmation. Nothing is deleted by a reversal — the
 * opening rows are MARKED and mirrored; the UI says so.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CheckCircle2, ExternalLink, History, Lock, Undo2, Trash2 } from "lucide-react";
import { summariseChecks } from "@/lib/migrationImport";
import { Facts, Money, VerdictBadge, invalidateMigration, migrationKeys, storedReconciliation, storedValidation, useAdvances, useCanRunMigration, useOpenItems, useOpeningPosition, useParties, useWorkspaceNav, MigrationPermissionHint } from "./shared";
import type { MigrationBatchDetail, MigrationReversalPreview, MigrationReversed, ReverseMigrationBatchInput } from "@workspace/api-client-react";

export function CommitSection({ batch, companyName }: { batch: MigrationBatchDetail; companyName: string }) {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const canRun = useCanRunMigration();
  const { go } = useWorkspaceNav();
  const { data: parties } = useParties(batch.id);
  const { data: items } = useOpenItems(batch.id);
  const { data: advances } = useAdvances(batch.id);
  const { data: position } = useOpeningPosition(batch.id, batch.status === "draft" || batch.status === "validated");
  const validation = storedValidation(batch);
  const rec = storedReconciliation(batch);
  const [ack, setAck] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [reason, setReason] = useState("");
  const fmtTs = (s: string | null) => (s ? new Date(s).toLocaleString(lang === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-SA") : "—");

  const commit = useMutation({
    mutationFn: () => apiFetch<MigrationBatchDetail>(`/migration/batches/${batch.id}/commit`, { method: "POST" }),
    onSuccess: () => {
      invalidateMigration(qc, batch.id);
      qc.invalidateQueries();
      setConfirm(false);
      toast({ title: t("Migration committed", "تم اعتماد الترحيل"), description: t("The opening journal is posted and the opening month is locked.", "تم ترحيل قيد الافتتاح وقُفل شهر الافتتاح.") });
    },
    onError: () => setConfirm(false),
  });
  const discard = useMutation({
    mutationFn: () => apiFetch(`/migration/batches/${batch.id}/discard`, { method: "POST" }),
    onSuccess: () => { invalidateMigration(qc, batch.id); setDiscarding(false); toast({ title: t("Batch discarded", "تم إهمال الدفعة") }); },
  });
  const { data: preview } = useQuery<MigrationReversalPreview>({ queryKey: migrationKeys.reversal(batch.id), queryFn: () => apiFetch(`/migration/batches/${batch.id}/reversal-preview`), enabled: batch.status === "committed" });
  const reverse = useMutation({
    mutationFn: (body: ReverseMigrationBatchInput) => apiFetch<MigrationReversed>(`/migration/batches/${batch.id}/reverse`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { invalidateMigration(qc, batch.id); qc.invalidateQueries(); setReversing(false); toast({ title: t("Migration reversed", "تم عكس الترحيل"), description: t("The mirror journal is posted; the opening rows are marked reversed, never deleted.", "رُحّل القيد العاكس؛ ووُسمت الصفوف الافتتاحية بأنها معكوسة، ولم يُحذف شيء.") }); },
  });

  const s = validation ? summariseChecks(validation.checks) : null;
  const balanced = position ? Math.abs(position.totals.difference) < 0.005 : false;
  const committable = batch.status === "validated" && !!validation?.ok && balanced && (s?.blocking ?? 1) === 0;
  const counts = {
    customers: parties?.summary.customers ?? batch.counts.parties, vendors: parties?.summary.vendors ?? 0,
    ar: items?.summary.ar.items ?? 0, ap: items?.summary.ap.items ?? 0, advances: advances?.summary.rows ?? batch.counts.advances,
    banks: position?.banks.length ?? 0,
  };

  // ── committed / reversed ──
  if (batch.status === "committed" || batch.status === "reversed") {
    const recS = rec ? summariseChecks(rec.checks) : null;
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-positive/40 bg-positive-surface/10 p-3 text-sm flex items-start gap-2" data-testid="post-commit">
          <CheckCircle2 className="w-4 h-4 mt-0.5 text-positive shrink-0" />
          <div>
            <p className="font-medium">{batch.status === "committed" ? t("This migration is committed.", "هذا الترحيل معتمد.") : t("This migration was committed and then REVERSED.", "اعتُمد هذا الترحيل ثم عُكس.")}</p>
            <p className="text-xs text-muted-foreground">{t("Staging is frozen. A committed migration is corrected by reversal and a corrected re-run — never by editing.", "التجهيز مجمَّد. يُصحَّح الترحيل المعتمد بالعكس وإعادة تشغيل مصحَّحة — لا بالتعديل أبدًا.")}</p>
          </div>
        </div>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><History className="w-4 h-4" />{t("Committed state", "الحالة المعتمدة")}</CardTitle></CardHeader>
          <CardContent>
            <Facts items={[
              [t("Migration batch", "دفعة الترحيل"), <span key="id" className="font-mono">#{batch.id}</span>],
              [t("Company", "الشركة"), companyName],
              [t("Committed at", "وقت الاعتماد"), <span key="ca" data-testid="committed-at">{fmtTs(batch.committedAt)}</span>],
              [t("Committed by", "اعتمده"), batch.committedBy != null ? `#${batch.committedBy}` : "—"],
              [t("Opening date", "تاريخ الافتتاح"), <span key="od" dir="ltr">{batch.openingDate}</span>],
              [t("Opening journal", "قيد الافتتاح"), batch.openingJournalEntryId != null ? <Link key="je" href={`/journal-entries?entry=${batch.openingJournalEntryId}`} className="text-primary inline-flex items-center gap-1" data-testid="link-opening-journal">MIG-{batch.id}-OPEN · #{batch.openingJournalEntryId}<ExternalLink className="w-3 h-3" /></Link> : "—"],
              [t("Period lock", "قفل الفترة"), batch.periodLockId != null ? <span key="pl" className="inline-flex items-center gap-1"><Lock className="w-3 h-3" />{t(`opening month locked (lock #${batch.periodLockId})`, `شهر الافتتاح مقفل (قفل #${batch.periodLockId})`)}</span> : batch.status === "reversed" ? t("lifted by the reversal", "رُفع بالعكس") : "—"],
              [t("Source", "المصدر"), `${batch.sourceSystem}${batch.sourceVersion ? ` ${batch.sourceVersion}` : ""} · ${t("cut-over", "القطع")} ${batch.cutoverDate}`],
              [t("Content hash", "تجزئة المحتوى"), <span key="h" className="font-mono text-[11px] break-all" dir="ltr">{batch.contentHash ?? "—"}</span>],
              [t("Replaces batch", "يستبدل الدفعة"), batch.replacesBatchId != null ? `#${batch.replacesBatchId}` : t("no (first migration)", "لا (ترحيل أول)")],
              ...(batch.status === "reversed" ? [[t("Reversed at", "وقت العكس"), fmtTs(batch.reversedAt)] as [string, React.ReactNode], [t("Reversal journal", "قيد العكس"), batch.reversalJournalEntryId != null ? <Link key="rj" href={`/journal-entries?entry=${batch.reversalJournalEntryId}`} className="text-primary">#{batch.reversalJournalEntryId}</Link> : "—"] as [string, React.ReactNode], [t("Reason", "السبب"), batch.reversalReason ?? "—"] as [string, React.ReactNode]] : []),
            ]} />
          </CardContent>
        </Card>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" data-testid="created-counts">
          {[[t("Customers", "العملاء"), counts.customers, "/customers"], [t("Suppliers", "الموردون"), counts.vendors, "/vendors"], [t("Opening receivables", "الذمم المدينة الافتتاحية"), counts.ar, "/invoices"], [t("Opening bills", "الفواتير الافتتاحية"), counts.ap, "/bills"], [t("Deposits", "الدفعات المقدمة"), counts.advances, "/payments"], [t("Bank accounts", "الحسابات البنكية"), counts.banks, "/bank-accounts"]].map(([l, v, href], i) => (
            <Card key={i}><CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className="text-lg font-semibold font-mono">{v}</div><Link href={String(href)} className="text-xs text-primary">{t("Open →", "فتح ←")}</Link></CardContent></Card>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {[["/journal-entries", t("Journal", "اليومية")], ["/ar-aging", t("AR aging", "أعمار الذمم المدينة")], ["/ap-aging", t("AP aging", "أعمار الذمم الدائنة")], ["/balance-sheet", t("Balance sheet", "الميزانية")], ["/trial-balance", t("Trial balance", "ميزان المراجعة")], ["/reports", t("Reports", "التقارير")]].map(([href, l]) => (
            <Link key={href} href={href} className="inline-flex items-center gap-1 text-xs h-8 px-3 rounded-md border border-border hover:bg-secondary/60">{l}<ExternalLink className="w-3 h-3" /></Link>
          ))}
        </div>
        {rec && (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">{t("Reconciliation at commit", "المطابقة عند الاعتماد")} · {recS?.passed}/{rec.checks.length} {t("passed", "ناجح")}</CardTitle></CardHeader>
            <CardContent><div className="flex flex-wrap gap-2">{rec.checks.map((c) => <span key={c.id} className="inline-flex items-center gap-1 text-xs"><VerdictBadge check={c} /><span className="font-mono">{c.id}</span></span>)}</div><Button variant="link" size="sm" className="px-0 text-xs" onClick={() => go("reconciliation")}>{t("Read every gate", "قراءة كل بوابة")}</Button></CardContent>
          </Card>
        )}

        {batch.status === "committed" && (
          <Card className="border-attention/40">
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Undo2 className="w-4 h-4" />{t("Reverse this migration (Policy C)", "عكس هذا الترحيل (السياسة C)")}</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-xs text-muted-foreground">{t("A reversal posts a mirror of the opening journal, MARKS every opening receivable, bill and deposit reversed (nothing is deleted; their numbers stay occupied), reopens the opening month and keeps the customers, suppliers and accounts it created. A corrected re-run then creates REPLACEMENT items with new OPEN-<batch>-<n> numbers. It is refused while anything has touched what the commit created.", "يُرحّل العكس قيدًا عاكسًا لقيد الافتتاح، ويسم كل ذمة مدينة وفاتورة ودفعة مقدمة افتتاحية بأنها معكوسة (لا يُحذف شيء؛ وتبقى أرقامها مشغولة)، ويعيد فتح شهر الافتتاح، ويحتفظ بالعملاء والموردين والحسابات التي أنشأها. ثم تُنشئ إعادة التشغيل المصحَّحة بنودًا بديلة بأرقام OPEN-<batch>-<n> جديدة. يُرفض ما دام أي شيء قد مسّ ما أنشأه الاعتماد.")}</p>
              <MigrationPermissionHint />
              {preview && (
                <div data-testid="reversal-preview">
                  {preview.blockers.length > 0 ? (
                    <div className="rounded-md border border-negative/40 bg-negative-surface/10 p-2">
                      <p className="text-xs font-medium text-negative">{t(`Reversal is BLOCKED (${preview.blockers.length}):`, `العكس محظور (${preview.blockers.length}):`)}</p>
                      <ul className="text-xs text-negative list-disc ps-4">{preview.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
                    </div>
                  ) : (
                    <p className="text-xs text-positive">{t("Nothing blocks a reversal today.", "لا شيء يمنع العكس اليوم.")}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-2">{t(`Would reverse: ${preview.wouldReverse.invoices.length} opening receivable(s), ${preview.wouldReverse.bills.length} opening bill(s), ${preview.wouldReverse.deposits.length} deposit(s), ${preview.wouldReverse.banks.length} bank opening(s)${preview.wouldReverse.periodLock ? `, the lock on ${preview.wouldReverse.periodLock.period}` : ""}. Keeps: ${preview.wouldReverse.keeps.customers} customer(s), ${preview.wouldReverse.keeps.vendors} supplier(s), ${preview.wouldReverse.keeps.accountsCreated} created account(s).`,
                    `سيعكس: ${preview.wouldReverse.invoices.length} ذمة مدينة افتتاحية، ${preview.wouldReverse.bills.length} فاتورة افتتاحية، ${preview.wouldReverse.deposits.length} دفعة مقدمة، ${preview.wouldReverse.banks.length} رصيد بنكي افتتاحي${preview.wouldReverse.periodLock ? `، وقفل ${preview.wouldReverse.periodLock.period}` : ""}. يحتفظ بـ: ${preview.wouldReverse.keeps.customers} عميل، ${preview.wouldReverse.keeps.vendors} مورّد، ${preview.wouldReverse.keeps.accountsCreated} حساب منشأ.`)}</p>
                </div>
              )}
              {canRun && <Button variant="outline" size="sm" className="text-attention" disabled={!preview || preview.blockers.length > 0} onClick={() => setReversing(true)} data-testid="open-reverse">{t("Reverse…", "عكس…")}</Button>}
            </CardContent>
          </Card>
        )}

        <Dialog open={reversing} onOpenChange={(o) => !o && setReversing(false)}>
          <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-lg" data-testid="reverse-dialog">
            <DialogHeader>
              <DialogTitle>{t(`Reverse migration #${batch.id}?`, `عكس الترحيل #${batch.id}؟`)}</DialogTitle>
              <DialogDescription>{t("State why the opening position is withdrawn (at least 10 characters). This becomes the audit record of the reversal.", "اذكر سبب سحب المركز الافتتاحي (10 أحرف على الأقل). يصبح هذا سجل تدقيق العكس.")}</DialogDescription>
            </DialogHeader>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} data-testid="reverse-reason" />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setReversing(false)}>{t("Cancel", "إلغاء")}</Button>
              <Button size="sm" variant="destructive" disabled={reason.trim().length < 10 || reverse.isPending} onClick={() => reverse.mutate({ reason: reason.trim() })} data-testid="confirm-reverse">{reverse.isPending ? t("Reversing…", "جارٍ العكس…") : t("Reverse the migration", "عكس الترحيل")}</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  if (batch.status === "discarded") {
    return <p className="text-sm text-muted-foreground" data-testid="discarded-note">{t("This batch was discarded before commit. Nothing was ever posted.", "أُهملت هذه الدفعة قبل الاعتماد. لم يُرحَّل شيء قط.")}</p>;
  }

  // ── draft / validated ──
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t("Commit the migration", "اعتماد الترحيل")}</h2>
        <p className="text-sm text-muted-foreground">{t("One transaction: the opening journal through the posting seam, the opening receivables and bills, the deposits, the bank opening state, the lock on the opening month — then R1–R10 on what was posted, or nothing at all.", "معاملة واحدة: قيد الافتتاح عبر مسار الترحيل، والذمم والفواتير الافتتاحية، والدفعات المقدمة، وحالة البنوك الافتتاحية، وقفل شهر الافتتاح — ثم R1–R10 على ما رُحّل، أو لا شيء على الإطلاق.")}</p>
      </div>
      <MigrationPermissionHint />
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">{t("What will be committed", "ما سيُعتمد")}</CardTitle></CardHeader>
        <CardContent>
          <Facts items={[
            [t("Company", "الشركة"), companyName],
            [t("Opening date", "تاريخ الافتتاح"), <span key="od" dir="ltr">{batch.openingDate}</span>],
            [t("Source system", "النظام المصدر"), `${batch.sourceSystem}${batch.sourceVersion ? ` ${batch.sourceVersion}` : ""}`],
            [t("Customers", "العملاء"), counts.customers], [t("Suppliers", "الموردون"), counts.vendors],
            [t("AR items", "بنود الذمم المدينة"), <span key="ar">{counts.ar} · <Money v={items?.summary.ar.total ?? 0} /></span>],
            [t("AP items", "بنود الذمم الدائنة"), <span key="ap">{counts.ap} · <Money v={items?.summary.ap.total ?? 0} /></span>],
            [t("Advances", "الدفعات المقدمة"), <span key="adv">{counts.advances} · <Money v={advances?.summary.total ?? 0} /></span>],
            [t("Bank accounts", "الحسابات البنكية"), counts.banks],
            [t("VAT balances", "أرصدة الضريبة"), batch.vatPosition ? `${t("return", "الإقرار")} ${batch.vatPosition.returnReference}` : t("none staged", "لا شيء مجهّز")],
            [t("Opening journal totals", "إجماليات قيد الافتتاح"), position ? <span key="tot"><Money v={position.totals.debit} /> Dr / <Money v={position.totals.credit} /> Cr</span> : "—"],
            [t("Difference", "الفرق"), position ? <Money key="d" v={position.totals.difference} className={balanced ? "text-positive" : "text-negative"} /> : "—"],
            [t("R1–R10", "R1–R10"), t("computed at commit on the posted ledger; any failure rolls the commit back", "تُحتسب عند الاعتماد على الدفاتر المرحَّلة؛ وأي فشل يلغي الاعتماد")],
            [t("Validation", "التحقق"), s ? <span key="v" className={s.blocking > 0 ? "text-negative" : "text-positive"}>{t(`${s.blocking} blocking · ${s.warnings} warning(s) · ${s.passed} passed`, `${s.blocking} محظور · ${s.warnings} تحذير · ${s.passed} ناجح`)}</span> : t("not run", "لم يُشغَّل")],
          ]} />
          {s && s.blocking > 0 && <ul className="text-xs text-negative mt-3 list-disc ps-4" data-testid="commit-blockers">{validation!.checks.filter((c) => c.status === "fail").map((c) => <li key={c.id}>{c.id} — {c.detail}</li>)}</ul>}
          {s && s.warnings > 0 && <ul className="text-xs text-attention mt-2 list-disc ps-4">{validation!.checks.filter((c) => c.status === "warn").map((c) => <li key={c.id}>{c.id} — {c.detail}</li>)}</ul>}
        </CardContent>
      </Card>
      <div className="rounded-md border border-attention/40 bg-attention-surface/10 p-3 text-sm" data-testid="commit-statement">
        {t("Committing this migration creates accounting records and cannot be undone by editing the staging data.", "يُنشئ اعتماد هذا الترحيل سجلات محاسبية ولا يمكن التراجع عنه بتعديل بيانات التجهيز.")}
      </div>
      {!committable && (
        <p className="text-sm text-muted-foreground" data-testid="commit-disabled-reason">
          {batch.status !== "validated" ? t("Commit needs a passing validation first.", "يحتاج الاعتماد إلى تحقق ناجح أولًا.") : !balanced ? t("Commit is disabled: the opening position does not balance.", "الاعتماد معطّل: المركز الافتتاحي غير متوازن.") : t("Commit is disabled: a blocking control fails.", "الاعتماد معطّل: ضابط حاجب فاشل.")}
          {" "}<button className="underline" onClick={() => go("validation")}>{t("Open validation", "فتح التحقق")}</button>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={ack} onCheckedChange={(c) => setAck(!!c)} disabled={!committable || !canRun} data-testid="commit-ack" />{t("I have reviewed the opening trial balance and the controls.", "راجعت ميزان المراجعة الافتتاحي والضوابط.")}</label>
        <Button disabled={!committable || !ack || !canRun || commit.isPending} onClick={() => setConfirm(true)} data-testid="commit-button">{t("Commit migration", "اعتماد الترحيل")}</Button>
        {canRun && <Button variant="ghost" size="sm" className="text-negative" onClick={() => setDiscarding(true)} data-testid="discard-button"><Trash2 className="w-3.5 h-3.5 me-1" />{t("Discard batch", "إهمال الدفعة")}</Button>}
      </div>

      <Dialog open={confirm} onOpenChange={(o) => !o && setConfirm(false)}>
        <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-lg" data-testid="commit-dialog">
          <DialogHeader>
            <DialogTitle>{t(`Commit migration #${batch.id} for ${companyName}?`, `اعتماد الترحيل #${batch.id} لـ ${companyName}؟`)}</DialogTitle>
            <DialogDescription>{t(`Posts the opening journal as at ${batch.openingDate} (${position ? fmtNum(position.totals.debit) : "—"} Dr = Cr), creates ${counts.ar} opening receivable(s), ${counts.ap} opening bill(s) and ${counts.advances} deposit(s), and locks the opening month. R1–R10 run on the result; a failure posts nothing.`, `يُرحّل قيد الافتتاح كما في ${batch.openingDate} (${position ? fmtNum(position.totals.debit) : "—"} مدين = دائن)، ويُنشئ ${counts.ar} ذمة مدينة افتتاحية و${counts.ap} فاتورة افتتاحية و${counts.advances} دفعة مقدمة، ويقفل شهر الافتتاح. تُشغَّل R1–R10 على النتيجة؛ وأي فشل لا يُرحّل شيئًا.`)}</DialogDescription>
          </DialogHeader>
          <p className="text-sm">{t("Committing this migration creates accounting records and cannot be undone by editing the staging data.", "يُنشئ اعتماد هذا الترحيل سجلات محاسبية ولا يمكن التراجع عنه بتعديل بيانات التجهيز.")}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>{t("Cancel", "إلغاء")}</Button>
            <Button size="sm" disabled={commit.isPending} onClick={() => commit.mutate()} data-testid="confirm-commit">{commit.isPending ? t("Committing…", "جارٍ الاعتماد…") : t("Commit now", "اعتماد الآن")}</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={discarding} onOpenChange={(o) => !o && setDiscarding(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t(`Discard batch #${batch.id}?`, `إهمال الدفعة #${batch.id}؟`)}</DialogTitle><DialogDescription>{t("The staged data is dropped. Nothing was posted, so nothing in the books changes.", "تُحذف البيانات المجهّزة. لم يُرحَّل شيء، فلا يتغير شيء في الدفاتر.")}</DialogDescription></DialogHeader>
          <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => setDiscarding(false)}>{t("Cancel", "إلغاء")}</Button><Button size="sm" variant="destructive" disabled={discard.isPending} onClick={() => discard.mutate()} data-testid="confirm-discard">{t("Discard", "إهمال")}</Button></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
