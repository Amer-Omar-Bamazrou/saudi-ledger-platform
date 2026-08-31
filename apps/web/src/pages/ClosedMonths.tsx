/**
 * Closed months (M22) — the first UI for /period-locks, which had been a
 * mounted API with no reader since M14 (a tenant literally could not close a
 * month from the product).
 *
 * Vocabulary rule (owner, decision D1): "close the books", never "lock a
 * period". The page states what closing MEANS before offering any control,
 * because the reader may be the bookkeeper whose invoice was just refused —
 * this page is the explanation the 423 dialog links to.
 *
 * D4: closing the CURRENT month is allowed (the API allows it; the UI must
 * not secretly forbid what the API permits) but the confirm names the
 * consequence — all ongoing entry stops. Future months likewise.
 *
 * D5: months may be closed in any order — deliberately, because the BACKEND
 * enforces no order and a UI-only rule would lie about what the system
 * enforces. If sequential closing is ever wanted as a real rule, that is a
 * backend change and its own decision (recorded as a candidate in the design
 * notes, not a gap).
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Lock, LockOpen, CalendarX2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { DualDate } from "@/components/DualDate";

interface PeriodLock {
  id: number;
  period: string; // YYYY-MM
  lockedAt: string;
  lockedBy: number | null;
  notes: string | null;
}

function monthLabel(period: string, lang: string): string {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-SA" : "en-US", {
    month: "long",
    year: "numeric",
    calendar: "gregory", // calendar months — the filing rhythm (M20.2)
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function ClosedMonths() {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();

  // Actions are admin-only server-side (create/delete on `period_locks`);
  // hiding them for other roles is honesty, not security — the API is the guard.
  const isAdmin = user?.organizationRole === "admin";

  const { data: locks = [], isLoading } = useQuery<PeriodLock[]>({
    queryKey: ["period-locks"],
    queryFn: () => apiFetch("/period-locks"),
  });

  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [confirmReopen, setConfirmReopen] = useState<string | null>(null);
  const [pickedMonth, setPickedMonth] = useState("");
  const [notes, setNotes] = useState("");

  const fail = (e: unknown) =>
    toast({ title: t("Failed", "فشل"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });

  const closeMut = useMutation({
    mutationFn: (period: string) =>
      apiFetch("/period-locks", { method: "POST", body: JSON.stringify({ period, notes: notes.trim() || undefined }) }),
    onSuccess: (_d, period) => {
      setConfirmClose(null);
      setPickedMonth("");
      setNotes("");
      qc.invalidateQueries({ queryKey: ["period-locks"] });
      toast({
        title: t("Books closed", "أُقفلت الدفاتر"),
        description: t(
          `${monthLabel(period, lang)} is now closed — its figures can no longer change.`,
          `${monthLabel(period, lang)} مُقفل الآن — لم يعد بالإمكان تغيير أرقامه.`,
        ),
      });
    },
    onError: fail,
  });

  const reopenMut = useMutation({
    mutationFn: (period: string) => apiFetch(`/period-locks/${period}`, { method: "DELETE" }),
    onSuccess: (_d, period) => {
      setConfirmReopen(null);
      qc.invalidateQueries({ queryKey: ["period-locks"] });
      toast({
        title: t("Month reopened", "أُعيد فتح الشهر"),
        description: t(
          `Figures for ${monthLabel(period, lang)} can change again.`,
          `يمكن أن تتغير أرقام ${monthLabel(period, lang)} مجددًا.`,
        ),
      });
    },
    onError: fail,
  });

  const closedSet = new Set(locks.map((l) => l.period));
  const sorted = [...locks].sort((a, b) => b.period.localeCompare(a.period));
  const isCurrentOrFuture = confirmClose != null && confirmClose >= thisMonth();

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">{t("Closed months", "الأشهر المُقفلة")}</h1>
        {/* What closing MEANS, before any control — this page is where the
            refusal dialog sends people for the explanation. */}
        <p className="text-sm text-muted-foreground mt-2">
          {t(
            "When a month is closed, its figures stop changing: no invoice, bill, journal entry, or bank transaction can be added to it, and anyone who tries is told why. Reports for a closed month always show the same numbers.",
            "عند إقفال شهر تتوقف أرقامه عن التغيّر: لا يمكن إضافة فاتورة أو فاتورة مورد أو قيد يومية أو حركة بنكية إليه، ومن يحاول يُخبر بالسبب. تقارير الشهر المُقفل تعرض الأرقام نفسها دائمًا.",
          )}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {t(
            "Closing does not touch quotations or purchase orders (they are commitments, not bookkeeping), and it never hides anything — closed months stay fully visible in every report.",
            "الإقفال لا يمس عروض الأسعار أو أوامر الشراء (فهي التزامات لا قيود)، ولا يخفي شيئًا — تبقى الأشهر المُقفلة ظاهرة بالكامل في كل التقارير.",
          )}
        </p>
      </div>

      {isAdmin && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("Close the books for a month", "إقفال دفاتر شهر")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-end gap-3 flex-wrap">
              <div>
                <Label className="text-xs text-muted-foreground">{t("Month", "الشهر")}</Label>
                {/* No `max`: the API allows closing any month, incl. current
                    and future, and the UI must not secretly forbid what the
                    API permits (D4). The consequence is named in the confirm
                    instead — loudly, for current-or-later. */}
                <Input
                  type="month"
                  value={pickedMonth}
                  onChange={(e) => setPickedMonth(e.target.value)}
                  className="mt-1 h-9 w-48"
                />
              </div>
              <div className="grow min-w-48">
                <Label className="text-xs text-muted-foreground">{t("Note (optional)", "ملاحظة (اختياري)")}</Label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t("e.g. VAT return filed", "مثال: تم تقديم إقرار ضريبة القيمة المضافة")}
                  className="mt-1 h-9"
                />
              </div>
              <Button
                disabled={!pickedMonth || closedSet.has(pickedMonth)}
                onClick={() => setConfirmClose(pickedMonth)}
              >
                <Lock className="w-4 h-4 me-1" />
                {t("Close the books", "إقفال الدفاتر")}
              </Button>
            </div>
            {pickedMonth && closedSet.has(pickedMonth) && (
              <p className="text-xs text-muted-foreground">
                {t("That month is already closed.", "هذا الشهر مُقفل بالفعل.")}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {t("Currently closed", "المُقفلة حاليًا")}
            {locks.length > 0 && <span className="text-muted-foreground font-normal"> · {locks.length}</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-4 text-center">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : sorted.length === 0 ? (
            <div className="py-6 text-center space-y-1">
              <CalendarX2 className="w-6 h-6 mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {t("No months are closed. Every month is open to new entries.", "لا توجد أشهر مُقفلة. كل الأشهر مفتوحة للقيود الجديدة.")}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {sorted.map((l) => (
                <li data-row key={l.id} className="py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <p className="font-medium flex items-center gap-2">
                      <Lock className="w-3.5 h-3.5 text-muted-foreground" />
                      {monthLabel(l.period, lang)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t("Closed on", "أُقفل بتاريخ")} <DualDate date={l.lockedAt.slice(0, 10)} />
                      {l.notes && <> · {l.notes}</>}
                    </p>
                  </div>
                  {isAdmin && (
                    <Button size="sm" variant="outline" onClick={() => setConfirmReopen(l.period)}>
                      <LockOpen className="w-3.5 h-3.5 me-1" />
                      {t("Reopen", "إعادة فتح")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Close confirm — names the consequence, louder for current/future ── */}
      <Dialog open={!!confirmClose} onOpenChange={(o) => !o && setConfirmClose(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t(
                `Close the books for ${confirmClose ? monthLabel(confirmClose, lang) : ""}?`,
                `إقفال دفاتر ${confirmClose ? monthLabel(confirmClose, lang) : ""}؟`,
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              {t(
                "Its figures will stop changing: nothing can be added to that month until an admin reopens it.",
                "ستتوقف أرقامه عن التغيّر: لا يمكن إضافة أي شيء إلى ذلك الشهر حتى يعيد مدير النظام فتحه.",
              )}
            </p>
            {isCurrentOrFuture && (
              <p className="font-medium">
                {t(
                  "⚠ This is the current month (or later). Closing it stops ALL ongoing entry — every new invoice, bill, and bank transaction dated in it will be refused until it is reopened.",
                  "⚠ هذا هو الشهر الحالي (أو لاحق). إقفاله يوقف كل الإدخالات الجارية — سترفض كل فاتورة وقيد وحركة بنكية مؤرخة فيه حتى يُعاد فتحه.",
                )}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setConfirmClose(null)}>
                {t("Cancel", "إلغاء")}
              </Button>
              <Button size="sm" onClick={() => confirmClose && closeMut.mutate(confirmClose)} disabled={closeMut.isPending}>
                {closeMut.isPending ? t("Closing…", "جارٍ الإقفال…") : t("Close the books", "إقفال الدفاتر")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Reopen confirm ── */}
      <Dialog open={!!confirmReopen} onOpenChange={(o) => !o && setConfirmReopen(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t(
                `Reopen ${confirmReopen ? monthLabel(confirmReopen, lang) : ""}?`,
                `إعادة فتح ${confirmReopen ? monthLabel(confirmReopen, lang) : ""}؟`,
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              {t(
                "Figures for this month will be able to change again — new entries dated in it will go through. This is recorded in the audit trail.",
                "سيصبح بالإمكان تغيير أرقام هذا الشهر مجددًا — وستمرّ القيود الجديدة المؤرخة فيه. يُسجّل هذا في سجل التدقيق.",
              )}
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setConfirmReopen(null)}>
                {t("Cancel", "إلغاء")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => confirmReopen && reopenMut.mutate(confirmReopen)} disabled={reopenMut.isPending}>
                {reopenMut.isPending ? t("Reopening…", "جارٍ إعادة الفتح…") : t("Reopen", "إعادة فتح")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
