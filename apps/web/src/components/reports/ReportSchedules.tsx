/**
 * 🔴 19B S6 — scheduling a saved report, and the member's schedules (scope 19.14; v4 §6.2).
 *
 * Recipients are picked from the organization's active members by NAME and ROLE only — the list the server gives every
 * role. A role that may schedule but not deliver (a viewer) sees the others disabled and is told why; the server
 * decides either way and its refusal is shown in its own words. Each recipient receives only what their own role
 * allows, checked when the report is delivered and again whenever they open it — said on the form, because the person
 * choosing recipients should know that choosing someone grants them nothing.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListReportSchedulesQueryKey, useCreateReportSchedule, useEndReportSchedule, useListReportRecipients, useListReportSchedules,
  type ReportDefinition, type ReportSchedule, type ReportScheduleInputCadence,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";

const SELECT = "w-full mt-1 h-8 text-sm rounded-md border border-input bg-background px-3 py-1";
export const ROLE_WORDS: Record<string, [string, string]> = {
  admin: ["Admin", "مسؤول"], accountant: ["Accountant", "محاسب"], bookkeeper: ["Bookkeeper", "ماسك دفاتر"], viewer: ["Viewer", "مشاهد"],
};
const CADENCES: [ReportScheduleInputCadence, string, string][] = [
  ["daily", "Every business day", "كل يوم عمل"], ["weekly", "Every week (from Sunday)", "كل أسبوع (من الأحد)"], ["monthly", "Every calendar month", "كل شهر ميلادي"],
];
const RUN_WORDS: Record<string, [string, string]> = {
  claimed: ["running", "قيد التشغيل"], delivered: ["delivered", "تم التسليم"], refused: ["refused", "مرفوض"], failed: ["failed", "فشل"],
};

/** The form that schedules one saved report. `canDeliver`: the role holds the dataset's deliver act. */
export function ScheduleForm({ definition, canDeliver, onDone }: { definition: ReportDefinition; canDeliver: boolean; onDone: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const members = useListReportRecipients().data?.items ?? [];
  const create = useCreateReportSchedule();
  const [cadence, setCadence] = useState<ReportScheduleInputCadence>("monthly");
  const [chosen, setChosen] = useState<number[]>(user ? [user.id] : []);

  const submit = async () => {
    try {
      await create.mutateAsync({ data: { definitionId: definition.id, cadence, recipientUserIds: chosen } });
      await qc.invalidateQueries({ queryKey: getListReportSchedulesQueryKey() });
      toast({ title: t("Report scheduled", "تمت جدولة التقرير"), description: definition.name });
      onDone();
    } catch (e) {
      toast({ title: t("The report was not scheduled", "لم تتم جدولة التقرير"), description: (e as Error).message, variant: "destructive" });
    }
  };

  return (
    <div className="mt-3 rounded-md border border-border p-3 space-y-3" data-testid={`schedule-form-${definition.id}`}>
      <div className="max-w-xs">
        <Label className="text-xs text-muted-foreground" htmlFor={`schedule-cadence-${definition.id}`}>{t("How often", "التكرار")}</Label>
        <select id={`schedule-cadence-${definition.id}`} className={SELECT} value={cadence} onChange={(e) => setCadence(e.target.value as ReportScheduleInputCadence)} data-testid={`schedule-cadence-${definition.id}`}>
          {CADENCES.map(([k, en, ar]) => <option key={k} value={k}>{t(en, ar)}</option>)}
        </select>
      </div>
      <fieldset>
        <legend className="text-xs text-muted-foreground">{t("Deliver to", "يُرسل إلى")}</legend>
        <ul className="mt-1 grid gap-1 sm:grid-cols-2" data-testid={`schedule-recipients-${definition.id}`}>
          {members.map((m) => {
            const self = m.userId === user?.id;
            return (
              <li key={m.userId}>
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={chosen.includes(m.userId)} disabled={!self && !canDeliver} data-testid={`schedule-recipient-${m.userId}`}
                    onChange={(e) => setChosen(e.target.checked ? [...chosen, m.userId] : chosen.filter((u) => u !== m.userId))} />
                  <span>{m.name}{self ? ` (${t("you", "أنت")})` : ""} · <span className="text-muted-foreground">{t(ROLE_WORDS[m.role]?.[0] ?? m.role, ROLE_WORDS[m.role]?.[1] ?? m.role)}</span></span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      {!canDeliver && <p className="text-[11px] text-muted-foreground" data-testid={`schedule-self-only-${definition.id}`}>{t("Your role can schedule this report to yourself only.", "دورك يسمح بجدولة هذا التقرير لنفسك فقط.")}</p>}
      <p className="text-[11px] text-muted-foreground">{t("Each person receives only what their own role allows — checked when the report is delivered and every time they open it. Choosing someone gives them no access.", "يستلم كل شخص فقط ما يسمح به دوره — يُفحص ذلك عند التسليم وفي كل مرة يفتح التقرير. اختيار شخص لا يمنحه أي صلاحية.")}</p>
      <div className="flex gap-2">
        <Button size="sm" className="h-8" disabled={create.isPending || chosen.length === 0} onClick={() => void submit()} data-testid={`schedule-submit-${definition.id}`}>{t("Schedule", "جدولة")}</Button>
        <Button size="sm" variant="outline" className="h-8" onClick={onDone}>{t("Cancel", "إلغاء")}</Button>
      </div>
    </div>
  );
}

/** The member's schedules, each with its recipients and its last run; the owner can stop one. */
export function ScheduleList() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useListReportSchedules();
  const end = useEndReportSchedule();
  const items = data?.items ?? [];

  const stop = async (s: ReportSchedule) => {
    try {
      await end.mutateAsync({ id: s.id });
      await qc.invalidateQueries({ queryKey: getListReportSchedulesQueryKey() });
      toast({ title: t("Schedule stopped", "تم إيقاف الجدولة"), description: s.reportName });
    } catch (e) {
      toast({ title: t("The schedule was not stopped", "لم تتوقف الجدولة"), description: (e as Error).message, variant: "destructive" });
    }
  };
  const cadenceWords = (c: string) => { const w = CADENCES.find(([k]) => k === c); return w ? t(w[1], w[2]) : c; };

  if (isLoading) return <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (items.length === 0) return <p className="text-sm text-muted-foreground" data-testid="schedules-empty">{t("No schedules yet. Schedule a saved report above.", "لا توجد جدولة بعد. جدوِل تقريراً محفوظاً من الأعلى.")}</p>;
  return (
    <ul className="divide-y divide-border" data-testid="schedules-list">
      {items.map((s) => (
        <li key={s.id} className="py-3 flex flex-wrap items-center gap-3" data-testid={`schedule-item-${s.id}`}>
          <div className="flex-1 min-w-[12rem]">
            <p className="text-sm font-medium text-foreground">{s.reportName} · <span className="font-normal text-muted-foreground">{cadenceWords(s.cadence)}</span></p>
            <p className="text-xs text-muted-foreground mt-0.5" data-testid={`schedule-to-${s.id}`}>
              {t("To", "إلى")}: {s.recipients.map((r) => `${r.name} (${t(ROLE_WORDS[r.role]?.[0] ?? r.role, ROLE_WORDS[r.role]?.[1] ?? r.role)})`).join(t(", ", "، "))}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5" data-testid={`schedule-last-${s.id}`}>
              {s.lastRun
                ? t(`Last run ${s.lastRun.periodKey}: ${RUN_WORDS[s.lastRun.status]?.[0] ?? s.lastRun.status} — ${s.lastRun.deliveredCount} delivered, ${s.lastRun.skippedCount} skipped`, `آخر تشغيل ${s.lastRun.periodKey}: ${RUN_WORDS[s.lastRun.status]?.[1] ?? s.lastRun.status} — سُلّم ${s.lastRun.deliveredCount}، وتُخطّي ${s.lastRun.skippedCount}`)
                : t("Not run yet.", "لم يُشغَّل بعد.")}
            </p>
          </div>
          <Button size="sm" variant="outline" className="h-8" disabled={end.isPending} onClick={() => void stop(s)} data-testid={`schedule-stop-${s.id}`}>{t("Stop", "إيقاف")}</Button>
        </li>
      ))}
    </ul>
  );
}
