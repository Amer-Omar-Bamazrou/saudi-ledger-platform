import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPeriodLocks,
  useLockPeriod,
  useUnlockPeriod,
  useGetLiquidity,
  useGetBooksStatus,
  useGetTaxCompliance,
  getListPeriodLocksQueryKey,
} from "@workspace/api-client-react";
import { Link } from "wouter";
import { formatCurrency } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Lock, LockOpen, ShieldCheck, Loader2, Wallet, TriangleAlert, ListChecks, ChevronRight, Receipt } from "lucide-react";

/**
 * Finance Hub — the control surface (design Q2).
 *
 * It STATES CONDITIONS rather than listing links, and stays owner-legible
 * throughout (Q4) — anything needing accounting vocabulary is a report, not the
 * hub. Where something is wrong, it names the problem and links to where that
 * problem is FIXED; it never becomes a second place to do the work (Q7).
 *
 * Four blocks, in the order a reader needs them:
 *   1. Can you pay what you owe?   (M18.3) — and when NOT to answer.
 *   2. Are your books current?     (M18.3) — the review count, mirrored.
 *   3. Tax & compliance            (M18.5) — VAT position and ZATCA state.
 *   4. Closing the books           (M18.4) — the first UI period locks ever had.
 *
 * Block 4 shipped first, deliberately: closing a period is a core accounting
 * function a tenant could not perform at all. The API, the company-scoped route
 * fix (M14) and the posting-path guard had been real and tested since M13 —
 * with no UI, so period locks existed only for tests and manual API calls.
 */

/**
 * Gated on `isOrgAdmin` — the caller's role in the ACTIVE organization,
 * resolved server-side and delivered by `/auth/me` (M18.4.1).
 *
 * 🔴 NOT on `user.role`: that is the global `users.role`, which CLAUDE.md §4
 * states is vestigial and must never gate anything. A self-signup org owner is
 * a global "viewer" and an admin of their own org, so gating on it would hide
 * this control from the very person who created the tenant.
 *
 * ⚠️ RENDERING ONLY. The server authorizes independently
 * (`requirePermission("period_locks")` — read for every role, create/delete
 * admin-only), so a 403 is still handled below rather than assumed away: the
 * session's view of the role can go stale between page load and click.
 */
function permissionMessage(t: (en: string, ar: string) => string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/403|forbidden|permission/i.test(message)) {
    return t(
      "Only an organization admin can close or reopen a period.",
      "يمكن لمسؤول المؤسسة فقط إقفال فترة أو إعادة فتحها.",
    );
  }
  return message;
}

/** `YYYY-MM` for the month before today — the usual thing to close. */
function previousMonth(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function FinanceHub() {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isOrgAdmin } = useAuth();

  const [period, setPeriod] = useState(previousMonth());
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [reopening, setReopening] = useState<string | null>(null);

  const { data: locks, isLoading } = useListPeriodLocks();
  const { data: liq } = useGetLiquidity();
  const { data: books } = useGetBooksStatus();
  const { data: tax } = useGetTaxCompliance();

  const invalidate = () => qc.invalidateQueries({ queryKey: getListPeriodLocksQueryKey() });

  const lock = useLockPeriod({
    mutation: {
      onSuccess: () => {
        setError("");
        setNotes("");
        invalidate();
        toast({ title: t("Period closed", "تم إقفال الفترة") });
      },
      onError: (e) => setError(permissionMessage(t, e)),
    },
  });

  const unlock = useUnlockPeriod({
    mutation: {
      onSuccess: () => {
        setError("");
        setReopening(null);
        invalidate();
        toast({ title: t("Period reopened", "تم إعادة فتح الفترة") });
      },
      onError: (e) => {
        setError(permissionMessage(t, e));
        setReopening(null);
      },
    },
  });

  const closed = [...(locks ?? [])].sort((a, b) => b.period.localeCompare(a.period));

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("Finance Hub", "لوحة المالية")}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {t(
            "Whether your books are right, current, and closed.",
            "ما إذا كانت دفاترك صحيحة ومحدَّثة ومقفلة.",
          )}
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* ── Block 1 (M18.3): can I pay what I owe? ───────────────────────── */}
      {liq && (
        <Card className="border-border bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Wallet className="w-4 h-4 text-muted-foreground" />
              {t("Can you pay what you owe?", "هل تستطيع سداد ما عليك؟")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/*
              🔴 The claim is WITHHELD, not caveated. When the platform cannot
              stand behind the ratios it says so instead of printing them with
              a footnote — a plain-language sentence removes the reader's
              ability to sanity-check, so publishing one over bad inputs is
              worse than publishing nothing (design §2, §5.1).
            */}
            {liq.claimable ? (
              <p className="text-sm">
                {liq.quickRatio === null
                  ? t(
                      "You have no short-term obligations right now.",
                      "ليس عليك التزامات قصيرة الأجل حالياً.",
                    )
                  : liq.quickRatio >= 1
                    ? t(
                        `Your liquid assets cover your short-term debts ${liq.quickRatio}× over.`,
                        `أصولك السائلة تغطي التزاماتك قصيرة الأجل ${liq.quickRatio} مرة.`,
                      )
                    : t(
                        `Your short-term obligations are larger than your liquid assets — you hold about ${liq.quickRatio} of what you owe within the year.`,
                        `التزاماتك قصيرة الأجل أكبر من أصولك السائلة — لديك نحو ${liq.quickRatio} مما عليك خلال السنة.`,
                      )}
              </p>
            ) : (
              <Alert>
                <TriangleAlert className="h-4 w-4" />
                <AlertDescription className="space-y-1">
                  <p className="font-medium">
                    {t(
                      "These figures are not reliable yet, so we are not drawing a conclusion from them.",
                      "هذه الأرقام غير موثوقة بعد، لذلك لا نستخلص منها نتيجة.",
                    )}
                  </p>
                  {liq.blockers.map((b) => (
                    <p key={b.code} className="text-xs">
                      {b.code === "suspense_balance"
                        ? t(
                            `${formatCurrency(Math.abs(b.amount))} of money we could not identify is sitting unclassified. Money you cannot identify is not money you can pay with.`,
                            `${formatCurrency(Math.abs(b.amount))} من المبالغ التي تعذّر تحديدها ما زالت غير مصنفة. والمال الذي لا تعرف مصدره ليس مالاً يمكنك السداد به.`,
                          )
                        : t(
                            `${b.count} account(s) have no "turns into cash" setting, so ${formatCurrency(Math.abs(b.amount))} is excluded from these figures.`,
                            `${b.count} حساب/حسابات بدون إعداد "يتحول إلى نقد"، لذا استُبعد ${formatCurrency(Math.abs(b.amount))} من هذه الأرقام.`,
                          )}
                    </p>
                  ))}
                  <Link
                    href={liq.blockers.some((b) => b.code === "suspense_balance") ? "/review" : "/categories"}
                    className="text-xs underline inline-flex items-center gap-1"
                  >
                    {t("Fix this", "إصلاح ذلك")} <ChevronRight className="w-3 h-3" />
                  </Link>
                </AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: t("Current assets", "الأصول المتداولة"), value: liq.currentAssets },
                { label: t("Liquid assets", "الأصول السائلة"), value: liq.quickAssets },
                { label: t("Due within a year", "المستحق خلال سنة"), value: liq.currentLiabilities },
                { label: t("Working capital", "رأس المال العامل"), value: liq.workingCapital },
              ].map((s) => (
                <div key={s.label} className="rounded-md border border-border bg-secondary/20 p-3">
                  <p className="text-[11px] text-muted-foreground">{s.label}</p>
                  <p className="text-sm font-mono mt-0.5">{formatCurrency(s.value)}</p>
                </div>
              ))}
            </div>

            {/*
              Rules of thumb, rendered as observations. No FAIL styling and no
              language implying a rule was broken — no standard sets these
              numbers (design §5.2).
            */}
            {liq.observations.length > 0 && (
              <p className="text-xs text-amber-500">
                {t(
                  "As a rule of thumb a ratio below 1 is worth watching — it varies a lot by industry, so treat it as a prompt to look, not a verdict.",
                  "كقاعدة عامة، النسبة الأقل من 1 تستحق المتابعة — وهي تختلف كثيراً حسب القطاع، فاعتبرها دعوة للمراجعة لا حكماً نهائياً.",
                )}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Block 2: are my books current? (Q7 — mirror the signal) ──────── */}
      {books && books.unreviewedCount > 0 && (
        <Card className="border-border bg-card">
          <CardContent className="p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <ListChecks className="w-4 h-4 text-muted-foreground shrink-0" />
              <p className="text-sm">
                {t(
                  `${books.unreviewedCount} imported transaction(s) are waiting for review, ${books.needsAttentionCount} of which need a decision. Until they are accepted they change none of the figures above.`,
                  `${books.unreviewedCount} معاملة مستوردة بانتظار المراجعة، منها ${books.needsAttentionCount} تحتاج قراراً. ولا تؤثر على الأرقام أعلاه حتى تُقبل.`,
                )}
              </p>
            </div>
            <Link href="/review">
              <Button variant="outline" size="sm">{t("Review", "مراجعة")}</Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {/* ── Block 3 (M18.5): Tax & Compliance ────────────────────────────── */}
      {tax && (
        <Card className="border-border bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Receipt className="w-4 h-4 text-muted-foreground" />
              {t("Tax & compliance", "الضريبة والامتثال")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/*
              🔴 The PERIOD IS STATED, never implied. KSA VAT is filed monthly
              or quarterly by turnover and the platform does not model which
              applies to this company — so this says "for Jan–Mar" and links to
              the return where the user picks their own period. It must never
              read as "your VAT return" or name a due date.
            */}
            <p className="text-sm">
              {tax.vat.payable > 0
                ? t(
                    `For ${tax.vat.periodFrom} to ${tax.vat.periodTo} you have collected ${formatCurrency(tax.vat.payable)} more VAT than you have paid.`,
                    `للفترة من ${tax.vat.periodFrom} إلى ${tax.vat.periodTo} حصّلت ضريبة قيمة مضافة تزيد بمقدار ${formatCurrency(tax.vat.payable)} عمّا دفعت.`,
                  )
                : tax.vat.refund > 0
                  ? t(
                      `For ${tax.vat.periodFrom} to ${tax.vat.periodTo} you have paid ${formatCurrency(tax.vat.refund)} more VAT than you have collected.`,
                      `للفترة من ${tax.vat.periodFrom} إلى ${tax.vat.periodTo} دفعت ضريبة قيمة مضافة تزيد بمقدار ${formatCurrency(tax.vat.refund)} عمّا حصّلت.`,
                    )
                  : t(
                      `For ${tax.vat.periodFrom} to ${tax.vat.periodTo} your VAT collected and paid are level.`,
                      `للفترة من ${tax.vat.periodFrom} إلى ${tax.vat.periodTo} تتساوى الضريبة المحصّلة مع المدفوعة.`,
                    )}
            </p>
            {!tax.vat.filingFrequencyKnown && (
              <p className="text-[11px] text-muted-foreground">
                {t(
                  "This is the calendar quarter. Your filing period may differ — open the VAT return to choose it.",
                  "هذه هي الفترة الربعية الميلادية. قد تختلف فترة إقرارك — افتح إقرار ضريبة القيمة المضافة لاختيارها.",
                )}
              </p>
            )}

            <p className="text-sm">
              {tax.zatca?.connected
                ? t(
                    `ZATCA e-invoicing is connected${tax.zatca.daysUntilExpiry != null ? `; your certificate expires in ${tax.zatca.daysUntilExpiry} days` : ""}.`,
                    `الفوترة الإلكترونية متصلة بهيئة الزكاة والضريبة${tax.zatca.daysUntilExpiry != null ? `؛ تنتهي شهادتك خلال ${tax.zatca.daysUntilExpiry} يوماً` : ""}.`,
                  )
                : t(
                    "ZATCA e-invoicing is not connected. Invoices are issued without being reported to ZATCA.",
                    "الفوترة الإلكترونية غير متصلة بهيئة الزكاة والضريبة. تصدر الفواتير دون إبلاغ الهيئة.",
                  )}
            </p>

            <div className="flex gap-3 pt-1">
              <Link href="/vat" className="text-xs underline inline-flex items-center gap-1">
                {t("VAT return", "إقرار ضريبة القيمة المضافة")} <ChevronRight className="w-3 h-3" />
              </Link>
              <Link href="/zakat" className="text-xs underline inline-flex items-center gap-1">
                {t("Zakat", "الزكاة")} <ChevronRight className="w-3 h-3" />
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-muted-foreground" />
            {t("Closing the books", "إقفال الدفاتر")}
          </CardTitle>
          <CardDescription>
            {t(
              "Closing a month means nothing new can be recorded in it. A later correction is recorded in the current open month instead — your closed figures never change behind you.",
              "إقفال الشهر يعني أنه لا يمكن تسجيل أي شيء جديد فيه. ويُسجَّل أي تصحيح لاحق في الشهر المفتوح الحالي بدلاً من ذلك — فلا تتغير أرقامك المقفلة من خلفك.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {!isOrgAdmin && (
            <p className="text-xs text-muted-foreground">
              {t(
                "Only an organization admin can close or reopen a month. You can see which months are closed.",
                "يمكن لمسؤول المؤسسة فقط إقفال شهر أو إعادة فتحه. ويمكنك الاطلاع على الأشهر المقفلة.",
              )}
            </p>
          )}
          {isOrgAdmin && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="period">{t("Month to close", "الشهر المراد إقفاله")}</Label>
              <Input
                id="period"
                type="month"
                className="w-[170px]"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
              />
            </div>
            <div className="space-y-1.5 flex-1 min-w-[200px]">
              <Label htmlFor="notes">{t("Note (optional)", "ملاحظة (اختياري)")}</Label>
              <Input
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("e.g. reviewed with accountant", "مثال: تمت المراجعة مع المحاسب")}
              />
            </div>
            <Button
              onClick={() => lock.mutate({ data: { period, notes: notes || null } })}
              disabled={lock.isPending || !/^\d{4}-\d{2}$/.test(period)}
            >
              {lock.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Lock className="w-4 h-4 mr-2" />}
              {t("Close month", "إقفال الشهر")}
            </Button>
          </div>
          )}

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t("Closed months", "الأشهر المقفلة")}
            </p>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
            ) : closed.length === 0 ? (
              /*
                An empty state that says what it MEANS. "No periods locked" is a
                database fact; "every month is still open, so anything can still
                be changed" is the condition the reader needs — the hub states
                conditions (design §2).
              */
              <p className="text-sm text-muted-foreground">
                {t(
                  "No months are closed yet — every month is still open, so any of your figures can still change.",
                  "لا توجد أشهر مقفلة بعد — جميع الأشهر مفتوحة، لذا لا تزال أرقامك قابلة للتغيير.",
                )}
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {closed.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="font-mono text-[11px]">{l.period}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {t("closed", "أُقفل")} {String(l.lockedAt).slice(0, 10)}
                        </span>
                      </div>
                      {l.notes && <p className="text-xs text-muted-foreground mt-1 truncate">{l.notes}</p>}
                    </div>
                    {isOrgAdmin && (
                      <Button variant="ghost" size="sm" onClick={() => setReopening(l.period)}>
                        <LockOpen className="w-3.5 h-3.5 mr-1.5" />
                        {t("Reopen", "إعادة فتح")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      {/*
        Reopening is confirmed, not one-click. It is the one action here that
        makes previously-frozen figures editable again, and it is recorded in
        the audit log either way.
      */}
      <AlertDialog open={reopening !== null} onOpenChange={(o) => !o && setReopening(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Reopen", "إعادة فتح")} {reopening}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Entries can be recorded in this month again, so figures you have already reported may change. This is recorded in the audit trail.",
                "سيصبح بالإمكان تسجيل قيود في هذا الشهر مجدداً، وقد تتغير أرقام سبق أن أبلغت عنها. ويُسجَّل هذا الإجراء في سجل التدقيق.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel", "إلغاء")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => reopening && unlock.mutate({ period: reopening })}
              disabled={unlock.isPending}
            >
              {t("Reopen month", "إعادة فتح الشهر")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
