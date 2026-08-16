/**
 * GET /deployment — what kind of deployment is this (D7).
 *
 * PUBLIC and unauthenticated, because the banner has to appear on the LOGIN
 * page, before anyone has a session.
 *
 * 🔴 SERVER-DRIVEN, not a build-time constant. A banner compiled into the
 * frontend keeps saying "demo" on a bundle promoted somewhere else, and stops
 * saying it on a demo built from a normal branch — in both directions the claim
 * detaches from the deployment it is about. The server knows which database it
 * is talking to; the bundle does not.
 *
 * 🔴 AND IT REPORTS THE RESET'S REAL STATE. "Wiped weekly" is a promise about
 * data deletion; this returns the last run that actually SUCCEEDED, so the page
 * can say when it last happened rather than assert a schedule. When there has
 * never been one, the message says that instead — a demo that has not reset yet
 * is fine, but claiming otherwise is not.
 */
import { Router, type IRouter } from "express";
import { loadEnv } from "@workspace/config";
import { lastSuccessfulReset } from "../services/demo/demoReset.service";
import { nextResetAt } from "../services/demo/demoSchedule";

const router: IRouter = Router();

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDate(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

router.get("/", async (_req, res) => {
  const env = loadEnv();
  if (!env.DEMO_MODE) {
    res.json({ demoMode: false, messageEn: null, messageAr: null, lastResetAt: null, nextResetAt: null });
    return;
  }

  // A banner is not worth a 500. If the reset table cannot be read we still say
  // "demo, sample data" — the part that is true regardless — and simply omit
  // the reset claim rather than invent one.
  let last: Date | null = null;
  let readable = true;
  try {
    last = await lastSuccessfulReset();
  } catch {
    readable = false;
  }

  const days = env.DEMO_RESET_INTERVAL_DAYS;
  const next = readable ? nextResetAt(last, days, new Date()) : null;
  const overdue = last !== null && Date.now() - last.getTime() > (days + 1) * DAY_MS;

  const base = {
    en: "DEMO — sample data for a fictional company. Nothing here is a real taxpayer record.",
    ar: "نسخة تجريبية — بيانات لشركة وهمية. لا شيء هنا سجل ضريبي حقيقي.",
  };

  let resetEn: string;
  let resetAr: string;
  if (!readable) {
    resetEn = "";
    resetAr = "";
  } else if (last === null) {
    // Deliberately NOT "wiped weekly": it has not been, yet.
    resetEn = ` Data is wiped every ${days} days; the first wipe has not run yet.`;
    resetAr = ` تُمسح البيانات كل ${days} أيام؛ لم يتم المسح الأول بعد.`;
  } else if (overdue) {
    // 🔴 The claim retracts itself. If the wipe stopped happening, the banner
    // stops promising it — the alarm pages us, and meanwhile nobody is told
    // something false.
    resetEn = ` The scheduled wipe is overdue — last completed ${formatDate(last, "en-GB")}.`;
    resetAr = ` تأخّر المسح المجدول — آخر مسح مكتمل في ${formatDate(last, "ar-SA")}.`;
  } else {
    resetEn = ` Data is wiped every ${days} days; last wiped ${formatDate(last, "en-GB")}.`;
    resetAr = ` تُمسح البيانات كل ${days} أيام؛ آخر مسح في ${formatDate(last, "ar-SA")}.`;
  }

  res.json({
    demoMode: true,
    messageEn: base.en + resetEn,
    messageAr: base.ar + resetAr,
    lastResetAt: last?.toISOString() ?? null,
    nextResetAt: next?.toISOString() ?? null,
  });
});

export default router;
