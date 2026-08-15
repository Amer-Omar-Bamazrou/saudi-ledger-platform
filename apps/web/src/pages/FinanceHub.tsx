import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPeriodLocks,
  useLockPeriod,
  useUnlockPeriod,
  getListPeriodLocksQueryKey,
} from "@workspace/api-client-react";
import { useLanguage } from "@/contexts/LanguageContext";
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
import { Lock, LockOpen, ShieldCheck, Loader2 } from "lucide-react";

/**
 * Finance Hub (M18.4 — the first block).
 *
 * The hub is a CONTROL SURFACE (design Q2): it states conditions rather than
 * listing links, and stays owner-legible throughout (Q4) — anything needing
 * accounting vocabulary is a report, not the hub.
 *
 * 🔴 Today it holds ONE block: closing an accounting period. M18.3 adds the
 * liquidity block ("can I pay what I owe?") and the books-current signals above
 * it. The page exists now rather than later because the lock control belongs
 * here (design §4.3) and building it as a standalone page would mean moving it
 * a milestone later.
 *
 * Why this block first: closing a period is a CORE accounting function that a
 * tenant could not perform at all. The API, the company-scoped route fix (M14)
 * and the posting-path guard have been real and tested since M13 — with no UI,
 * so period locks existed only for tests and manual API calls.
 */

/**
 * 🔴 DELIBERATELY NOT GATED ON THE CLIENT'S ROLE.
 *
 * `AuthContext.user.role` is `users.role`, which CLAUDE.md §4 states is
 * VESTIGIAL and must never gate access — the `organization_memberships` role
 * governs, and `GET /auth/me` does not return it. So the frontend cannot know
 * the governing role today, and gating on the field it does have would be
 * wrong in both directions: hiding the control from a real org admin, or
 * offering it to someone the server will refuse.
 *
 * The server is the authority (`requirePermission("period_locks")` — read for
 * every role, create/delete admin-only). The control is shown, and a 403 is
 * surfaced as a plain sentence instead of being pre-empted by a guess.
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

  const [period, setPeriod] = useState(previousMonth());
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [reopening, setReopening] = useState<string | null>(null);

  const { data: locks, isLoading } = useListPeriodLocks();

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
                    <Button variant="ghost" size="sm" onClick={() => setReopening(l.period)}>
                      <LockOpen className="w-3.5 h-3.5 mr-1.5" />
                      {t("Reopen", "إعادة فتح")}
                    </Button>
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
