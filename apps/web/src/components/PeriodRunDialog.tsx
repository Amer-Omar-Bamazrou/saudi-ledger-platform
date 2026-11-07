/**
 * 🔴 THE MONTH-END RUNS — depreciation and recognition (carry-over Batch 3, F-1; the owner, 2026-11-07).
 *
 * Both runs existed as API routes with no screen (the AC-13 standing check, F-1). This dialog calls the EXISTING
 * generated operations (`runAssetDepreciation`, `runRecognitionPeriod`); it adds no endpoint and no posting path.
 *
 * 🔴 NO PREVIEW EXISTS. Nothing on the server says, before a run, what it will post, so the dialog does not pretend
 * to: it shows the MONTH and the COUNT the page already has (assets in service; active schedules), says that count
 * is what the run looks at, not what it will post, and asks the person to confirm naming both. The result then
 * lists every item posted and every item skipped, with its reason.
 *
 * 🔴 REFUSALS ARE EXPLAINED BY THEIR CODE, never their wording: a closed month (`period_closed`), a role without the
 * grant (`requires_approval_authority`), and per item each skip's own code. The server's sentence is shown beneath,
 * as it is elsewhere in the app, so nothing the server said is hidden.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRunAssetDepreciation, useRunRecognitionPeriod } from "@workspace/api-client-react";
import { businessToday } from "@workspace/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CalendarCheck } from "lucide-react";
import { fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { refusalOf } from "@/lib/openingVatRefusals";

type T = (en: string, ar: string) => string;
type Outcome = {
  period: string;
  total: number;
  posted: Array<{ key: string; label: string; amount: number; journalEntryId: number }>;
  skipped: Array<{ key: string; label: string; code: string; reason: string }>;
};
type Refusal = { code: string | undefined; words: string };

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A skipped item, explained by its code in the reader's language. An unknown code says "not posted"; the server's sentence follows it. */
export function skipTitle(code: string, t: T): string {
  switch (code) {
    case "period_closed": return t("The month is closed", "الشهر مُقفل");
    case "recognition_period_not_scheduled": return t("Nothing of this schedule falls in this month", "لا قسط لهذا الجدول في هذا الشهر");
    case "recognition_period_already_recognised": return t("Already recognised for this month", "سبق الاعتراف به لهذا الشهر");
    case "recognition_out_of_order": return t("An earlier month is not recognised yet", "شهر سابق لم يُعترف به بعد");
    case "depreciation_out_of_order": return t("An earlier month is not depreciated yet", "شهر سابق لم يُهلَك بعد");
    case "approver_required": return t("Needs an approver", "يحتاج إلى معتمِد");
    case "entry_number_taken": return t("Its entry number is already used", "رقم قيده مستخدم من قبل");
    default: return t("Not posted", "لم يُرحَّل");
  }
}

/** The whole run refused, explained by its code. */
export function refusalTitle(code: string | undefined, period: string, what: string, t: T): { title: string; next: string } {
  if (code === "period_closed") {
    return {
      title: t(`${period} is closed — nothing was posted`, `شهر ${period} مُقفل — لم يُرحَّل شيء`),
      next: t("Run an open month, or an admin can reopen this one from Closed months.", "شغّله لشهر مفتوح، أو يمكن لمدير النظام إعادة فتح هذا الشهر من الأشهر المُقفلة."),
    };
  }
  if (code === "requires_approval_authority") {
    return {
      title: t(`Your role cannot run ${what}`, `دورك لا يسمح بتشغيل ${what}`),
      next: t("An admin can grant it in User Management, or ask someone who holds it to run the month.", "يمكن لمدير النظام منح الصلاحية من إدارة المستخدمين، أو اطلب ممن يملكها تشغيل الشهر."),
    };
  }
  if (code === "recognition_period_invalid") {
    return { title: t("The month is not valid", "الشهر غير صالح"), next: t("Choose a month as year and month.", "اختر شهرًا بالسنة والشهر.") };
  }
  return { title: t("The run could not be completed — nothing was posted", "تعذّر إتمام التشغيل — لم يُرحَّل شيء"), next: "" };
}

function RunDialog({ testId, trigger, title, what, countLabel, count, note, confirmLine, run, pending }: {
  testId: string;
  trigger: string;
  title: string;
  what: string;
  countLabel: string;
  count: number | undefined;
  note: string;
  confirmLine: (period: string, count: number) => string;
  run: (period: string) => Promise<Outcome>;
  pending: boolean;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState(businessToday().slice(0, 7));
  const [step, setStep] = useState<"choose" | "confirm" | "done">("choose");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const reset = () => { setStep("choose"); setOutcome(null); setRefusal(null); };
  const go = async () => {
    try {
      setOutcome(await run(period));
      setRefusal(null);
    } catch (e) {
      setOutcome(null);
      setRefusal(refusalOf(e));
    }
    setStep("done");
  };
  const refused = refusal ? refusalTitle(refusal.code, period, what, t) : null;

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2" data-testid={`${testId}-open`}><CalendarCheck className="w-4 h-4" />{trigger}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-lg max-h-[90vh] overflow-y-auto" data-testid={`${testId}-dialog`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{note}</DialogDescription>
        </DialogHeader>

        {step === "choose" && (
          <div className="space-y-3">
            <div>
              <Label htmlFor={`${testId}-period`} className="text-xs text-muted-foreground">{t("Month (year-month)", "الشهر (السنة-الشهر)")}</Label>
              <Input id={`${testId}-period`} type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="mt-1 h-9 font-mono" dir="ltr" data-testid={`${testId}-period`} />
            </div>
            <div className="flex justify-between gap-3 bg-secondary/30 rounded-lg p-3 text-sm" data-testid={`${testId}-count`}>
              <span>{countLabel}</span>
              <span className="font-mono" dir="ltr" data-testid={`${testId}-count-value`}>{count ?? "…"}</span>
            </div>
            <p className="text-xs text-muted-foreground" data-testid={`${testId}-no-preview`}>
              {t("There is no preview: the count is what the run looks at, not what it will post. The result lists every item posted and every item skipped, with the reason.",
                 "لا توجد معاينة: العدد هو ما يفحصه التشغيل، لا ما سيُرحِّله. وتعرض النتيجة كل بند رُحِّل وكل بند تُرك، مع السبب.")}
            </p>
            <Button className="w-full" disabled={!PERIOD.test(period) || count === undefined} onClick={() => setStep("confirm")} data-testid={`${testId}-continue`}>
              {t("Continue", "متابعة")}
            </Button>
          </div>
        )}

        {step === "confirm" && count !== undefined && (
          <div className="space-y-3">
            <p className="text-sm font-medium" data-testid={`${testId}-confirm-line`}>{confirmLine(period, count)}</p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setStep("choose")} disabled={pending} data-testid={`${testId}-back`}>{t("Back", "رجوع")}</Button>
              <Button className="flex-1" onClick={() => void go()} disabled={pending} data-testid={`${testId}-confirm`}>
                {pending ? t("Posting…", "جارٍ الترحيل…") : t("Post", "ترحيل")}
              </Button>
            </div>
          </div>
        )}

        {step === "done" && refused && (
          <div className="space-y-2 rounded-lg border border-border p-3" role="alert" data-testid={`${testId}-refused`} data-code={refusal?.code ?? ""}>
            <p className="font-medium text-sm">{refused.title}</p>
            {refused.next && <p className="text-xs">{refused.next}</p>}
            <p className="text-xs text-muted-foreground" dir="ltr">{refusal?.words}</p>
          </div>
        )}

        {step === "done" && outcome && (
          <div className="space-y-3" data-testid={`${testId}-result`}>
            {outcome.posted.length === 0 && outcome.skipped.length === 0 ? (
              <p className="text-sm" data-testid={`${testId}-nothing-due`}>
                {t(`Nothing was due in ${outcome.period}: nothing posted, and nothing was skipped.`, `لم يكن شيء مستحقًا في ${outcome.period}: لم يُرحَّل شيء ولم يُترك شيء.`)}
              </p>
            ) : (
              <div className="flex justify-between gap-3 bg-secondary/30 rounded-lg p-3 text-sm" data-testid={`${testId}-summary`}>
                <span>{t(`${outcome.period} · posted ${outcome.posted.length} · skipped ${outcome.skipped.length}`, `${outcome.period} · رُحِّل ${outcome.posted.length} · تُرك ${outcome.skipped.length}`)}</span>
                <span className="font-mono" dir="ltr" data-testid={`${testId}-total`}>{fmtNum(outcome.total)}</span>
              </div>
            )}
            {outcome.posted.length > 0 && (
              <ul className="text-sm space-y-1">
                {outcome.posted.map((p) => (
                  <li key={p.key} className="flex justify-between gap-3" data-testid={`${testId}-posted-${p.label}`}>
                    <span className="font-mono" dir="ltr">{p.label}</span>
                    <span className="font-mono" dir="ltr">{fmtNum(p.amount)} · #{p.journalEntryId}</span>
                  </li>
                ))}
              </ul>
            )}
            {outcome.skipped.length > 0 && (
              <ul className="text-sm space-y-2">
                {outcome.skipped.map((s) => (
                  <li key={s.key} className="rounded border border-border p-2" data-testid={`${testId}-skipped-${s.label}`} data-code={s.code}>
                    <div className="flex justify-between gap-3"><span className="font-mono" dir="ltr">{s.label}</span><span>{skipTitle(s.code, t)}</span></div>
                    <p className="text-xs text-muted-foreground mt-1" dir="ltr">{s.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {step === "done" && (
          <Button variant="outline" className="w-full" onClick={reset} data-testid={`${testId}-again`}>{t("Run another month", "تشغيل شهر آخر")}</Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The depreciation run (POST /assets/depreciation-runs). `inService` is the register's own total, every page. */
export function DepreciationRunDialog({ inService }: { inService: number | undefined }) {
  const { t } = useLanguage();
  const qc = useQueryClient();
  // Its own onError: the dialog explains the refusal itself (the shared toast would say it a second time).
  const mut = useRunAssetDepreciation({ mutation: { onError: () => undefined } });
  return (
    <RunDialog
      testId="depreciation-run"
      trigger={t("Run depreciation", "تشغيل الإهلاك")}
      title={t("Run the month's depreciation", "تشغيل إهلاك الشهر")}
      what={t("depreciation", "الإهلاك")}
      countLabel={t("Assets in service", "الأصول في الخدمة")}
      count={inService}
      note={t("Posts, for every asset in service, the depreciation its schedule holds for the month, if it is not posted yet. A fully depreciated asset, or one not yet available for use, posts nothing.",
              "يُرحِّل لكل أصل في الخدمة الإهلاك المقرر له في جدوله لذلك الشهر، إن لم يكن قد رُحِّل. والأصل المُهلَك بالكامل أو غير الجاهز للاستخدام بعد لا يُرحَّل له شيء.")}
      confirmLine={(period, n) => t(`Post depreciation for ${period}? Assets in service: ${n}.`, `ترحيل إهلاك شهر ${period}؟ الأصول في الخدمة: ${n}.`)}
      pending={mut.isPending}
      run={async (period) => {
        const r = await mut.mutateAsync({ data: { period } });
        void qc.invalidateQueries({ queryKey: ["assets"] });
        return {
          period: r.period, total: r.totalAmount,
          posted: r.posted.map((p) => ({ key: String(p.assetId), label: p.assetNumber, amount: p.amount, journalEntryId: p.journalEntryId })),
          skipped: r.skipped.map((s) => ({ key: String(s.assetId), label: s.assetNumber, code: s.code, reason: s.reason })),
        };
      }}
    />
  );
}

/** The recognition run (POST /recognition-schedules/runs). `active` counts the page's whole list, which is not paged. */
export function RecognitionRunDialog({ active }: { active: number | undefined }) {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const mut = useRunRecognitionPeriod({ mutation: { onError: () => undefined } });
  return (
    <RunDialog
      testId="recognition-run"
      trigger={t("Run the month", "تشغيل الشهر")}
      title={t("Run the month's accruals and prepayments", "تشغيل المستحقات والمدفوعات المقدمة للشهر")}
      what={t("recognition", "الاعتراف")}
      countLabel={t("Active schedules", "الجداول النشطة")}
      count={active}
      note={t("Recognises, for every active schedule, its instalment for the month, if it is not recognised yet. A schedule is recognised in order, month by month.",
              "يعترف لكل جدول نشط بقسطه لذلك الشهر، إن لم يكن قد اعتُرف به. ويُعترف بالجدول بالترتيب، شهرًا بشهر.")}
      confirmLine={(period, n) => t(`Recognise ${period}? Active schedules: ${n}.`, `الاعتراف بشهر ${period}؟ الجداول النشطة: ${n}.`)}
      pending={mut.isPending}
      run={async (period) => {
        const r = await mut.mutateAsync({ data: { period } });
        void qc.invalidateQueries({ queryKey: ["recognition-schedules"] });
        return {
          period: r.period, total: r.postedTotal,
          posted: r.posted.map((p) => ({ key: String(p.scheduleId), label: p.reference, amount: p.amount, journalEntryId: p.journalEntryId })),
          skipped: r.skipped.map((s) => ({ key: String(s.scheduleId), label: s.reference, code: s.code, reason: s.reason })),
        };
      }}
    />
  );
}
