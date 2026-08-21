/**
 * The closed-month explanation (M22, decision D3).
 *
 * Mounted ONCE in App. Whenever any write anywhere is refused with 423
 * `period_closed`, this renders the refusal as an explanation rather than an
 * error string: which month, when it was closed, what that means, and the two
 * ways forward. The per-page code that made the request needs no handling at
 * all — its mutation simply fails, and this dialog says why.
 *
 * Copy rule (owner): no accounting vocabulary. "The books for August 2026 are
 * closed" — never "period 2026-08 is locked", and never "post a reversing
 * entry".
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Lock } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { onPeriodClosed, type PeriodClosedEvent } from "@/lib/periodClosed";
import { DualDate } from "@/components/DualDate";

/** "2026-08" → a human month name in the active language. */
function monthLabel(period: string, lang: "en" | "ar"): string {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-SA" : "en-US", {
    month: "long",
    year: "numeric",
    // Explicit Gregorian: ar-SA would otherwise default to the Islamic
    // calendar, and closed months are CALENDAR months (M20.2's filing-rhythm
    // decision). The Hijri rendering is DualDate's job, alongside, never
    // instead (F3-dual).
    calendar: "gregory",
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

export function PeriodClosedDialog() {
  const { t, lang } = useLanguage();
  const [event, setEvent] = useState<PeriodClosedEvent | null>(null);

  useEffect(() => onPeriodClosed(setEvent), []);

  if (!event) return null;
  const month = monthLabel(event.period, lang);

  return (
    <Dialog open onOpenChange={(o) => !o && setEvent(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="w-4 h-4" />
            {t(`${month} is closed`, `${month} مُقفل`)}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p>
            {t(
              `The books for ${month} were closed`,
              `أُقفلت دفاتر ${month}`,
            )}
            {event.lockedAt && (
              <>
                {" "}({t("on", "بتاريخ")} <DualDate date={event.lockedAt} />)
              </>
            )}
            {t(
              ", so its figures can't change. Nothing can be added to that month — no invoice, bill, journal entry, or bank transaction.",
              "، لذا لا يمكن أن تتغير أرقامه. لا يمكن إضافة أي شيء إلى ذلك الشهر — لا فاتورة ولا فاتورة مورد ولا قيد يومية ولا حركة بنكية.",
            )}
          </p>
          <p className="text-muted-foreground">
            {t("Two ways forward:", "طريقتان للمتابعة:")}
          </p>
          <ul className="list-disc ms-5 space-y-1 text-muted-foreground">
            <li>
              {t(
                "Change this document's date to an open month, and it will go through.",
                "غيّر تاريخ هذا المستند إلى شهر مفتوح وسيمرّ.",
              )}
            </li>
            <li>
              {t("An admin can reopen the month from ", "يمكن لمدير النظام إعادة فتح الشهر من ")}
              <Link href="/closed-months" className="text-primary underline" onClick={() => setEvent(null)}>
                {t("Closed months", "الأشهر المُقفلة")}
              </Link>
              {t(" — its figures will then be able to change again.", " — وعندها يمكن أن تتغير أرقامه مجددًا.")}
            </li>
          </ul>
          <div className="pt-2 text-end">
            <Button size="sm" onClick={() => setEvent(null)}>
              {t("Got it", "فهمت")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
