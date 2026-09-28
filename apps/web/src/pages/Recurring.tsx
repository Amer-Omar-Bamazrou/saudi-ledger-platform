/**
 * A3 — recurring document rules, finally IN the product (audit Tier 3).
 *
 * The backend shipped complete in A3 with zero frontend: no way to create a
 * rule, and — the load-bearing part per finding #10 — the per-rule run history
 * that answers "did my rent invoice go out, and if not, who finds out?" was an
 * endpoint nobody rendered. This page is the consumer: rules with status and
 * next-run date, pause/resume/delete, and the run history with FAILED runs
 * shown loudly. Rules generate DRAFTS only; every generated document still
 * needs an approver.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Repeat, Pause, Play, Trash2, ChevronDown, ChevronUp, AlertCircle, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { PageHeader, Panel, EmptyState } from "@/components/kit";
import { DualDate } from "@/components/DualDate";

import type { RecurringRuleWithHealth, RecurringRun } from "@workspace/api-client-react";

function RuleRuns({ ruleId }: { ruleId: string }) {
  const { t } = useLanguage();
  const { data: runs = [], isLoading } = useQuery<RecurringRun[]>({
    queryKey: ["recurring-runs", ruleId],
    queryFn: () => apiFetch(`/recurring/${ruleId}/runs`),
  });
  if (isLoading) return <p className="pt-3 text-[12px] text-muted-foreground">…</p>;
  if (runs.length === 0)
    return <p className="pt-3 text-[12px] text-muted-foreground">{t("No runs yet.", "لا توجد تشغيلات بعد.")}</p>;
  return (
    <div className="mt-3 space-y-1.5 rounded-md bg-muted/50 px-3 py-2.5">
      {runs.map((r) => (
        <div key={r.id} className="flex items-center gap-2 text-[12px]">
          {r.outcome === "generated" ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-positive" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 text-negative" />
          )}
          <span className="tabular-nums" dir="ltr">{r.scheduledFor}</span>
          {r.outcome === "generated" ? (
            <span className="text-muted-foreground">
              {t("draft created", "تم إنشاء مسودة")} {r.documentId ? `#${r.documentId}` : ""}
            </span>
          ) : (
            <span className="text-negative">
              {t("FAILED", "فشل")} — {r.errorCode ?? "generation_failed"}
              {r.errorDetail ? `: ${r.errorDetail}` : ""}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export default function Recurring() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [openRuns, setOpenRuns] = useState<string | null>(null);

  const { data: rules = [], isLoading } = useQuery<RecurringRuleWithHealth[]>({
    queryKey: ["recurring"],
    queryFn: () => apiFetch("/recurring"),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["recurring"] });

  const pauseMut = useMutation({
    mutationFn: ({ id, resume }: { id: string; resume: boolean }) =>
      apiFetch(`/recurring/${id}/${resume ? "resume" : "pause"}`, { method: "POST" }),
    onSuccess: refresh,
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/recurring/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("Rule deleted — generated documents are untouched", "تم حذف القاعدة — المستندات المُنشأة لم تتأثر") });
      refresh();
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("Recurring Documents", "المستندات المتكررة")}
        description={t(
            "Rules create DRAFTS on schedule — every generated document still needs an approver. Create a rule from an invoice's ↻ button.",
            "تنشئ القواعد مسودات حسب الجدول — كل مستند مُنشأ يحتاج موافقة. أنشئ قاعدة من زر ↻ بجانب الفاتورة.",
          )}
      />

      <Panel flush>
      {isLoading && <p className="p-5 text-sm text-muted-foreground">…</p>}
      {!isLoading && rules.length === 0 && (
        <EmptyState icon={Repeat} title={t("No recurring rules yet.", "لا توجد قواعد متكررة بعد.")} />
      )}

      {rules.map((rule) => (
        <div data-row key={rule.id} className="border-b border-border/70 px-5 py-4 last:border-0">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="outline" className="font-normal">{rule.entity === "invoice" ? t("Invoice", "فاتورة") : t("Bill", "فاتورة مورد")}</Badge>
              <span className="font-medium text-primary">
                {(rule.template as { invoiceNumber?: string; billNumber?: string } | null)?.invoiceNumber ??
                  (rule.template as { billNumber?: string } | null)?.billNumber ??
                  rule.id.slice(0, 8)}
              </span>
              <span className="text-[13px] text-muted-foreground">
                {({ monthly: t("Monthly", "شهري"), quarterly: t("Quarterly", "ربع سنوي"), yearly: t("Yearly", "سنوي") } as Record<string, string>)[rule.frequency] ?? rule.frequency} · {t("day", "يوم")} {rule.dayOfMonth} · {t("next", "التالي")} <DualDate date={rule.nextRunOn} inline />
              </span>
              {rule.status === "paused" ? (
                <Badge variant="secondary" className="font-normal">{t("Paused", "متوقفة")}</Badge>
              ) : (
                <Badge className="bg-positive-surface/20 text-positive border-transparent font-normal">{t("Active", "نشطة")}</Badge>
              )}
              {/* A failed run is a real STATE (the status palette is allowed
                  here); the streak is the load-bearing signal — visible on the
                  card face, never only inside the collapsed run history. */}
              {rule.consecutiveFailures >= 2 ? (
                <Badge variant="destructive" className="gap-1">
                  <AlertCircle className="h-3 w-3" />
                  {t(
                    `${rule.consecutiveFailures} consecutive failures`,
                    `${rule.consecutiveFailures} إخفاقات متتالية`,
                  )}
                </Badge>
              ) : rule.lastOutcome === "failed" ? (
                <Badge className="border-transparent bg-attention-surface/20 text-attention gap-1">
                  <AlertCircle className="h-3 w-3" />
                  {t("Last run failed", "فشل آخر تشغيل")}
                </Badge>
              ) : null}
              <span className="ms-auto flex gap-0.5">
                <Button size="sm" variant="ghost" onClick={() => setOpenRuns(openRuns === rule.id ? null : rule.id)} className="h-7 gap-1 text-xs">
                  {openRuns === rule.id ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  {t("Runs", "التشغيلات")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={() => pauseMut.mutate({ id: rule.id, resume: rule.status === "paused" })}
                  disabled={pauseMut.isPending}
                >
                  {rule.status === "paused" ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-destructive"
                  onClick={() => { if (window.confirm(t("Delete this rule? Documents it generated are untouched.", "حذف هذه القاعدة؟ المستندات المُنشأة لن تتأثر."))) deleteMut.mutate(rule.id); }}
                  disabled={deleteMut.isPending}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </span>
            </div>
            {(rule.template as { total?: number } | null)?.total != null && (
              <p className="mt-1.5 text-[12px] text-muted-foreground">
                {t("Amount", "المبلغ")}: {fmtNum((rule.template as { total: number }).total)}
              </p>
            )}
            {rule.consecutiveFailures >= 1 && (
              <p className="mt-1.5 text-[12px] text-negative">
                {t("Last failure", "آخر إخفاق")} <DualDate date={rule.lastScheduledFor ?? rule.nextRunOn} inline />
                {rule.lastErrorCode ? ` — ${rule.lastErrorCode}` : ""}
                {rule.lastErrorDetail ? `: ${rule.lastErrorDetail}` : ""}
                {" · "}
                {rule.lastSuccessOn
                  ? <>{t("last success", "آخر نجاح")} <DualDate date={rule.lastSuccessOn} inline /></>
                  : t("no successful run yet", "لا يوجد تشغيل ناجح بعد")}
              </p>
            )}
            {openRuns === rule.id && <RuleRuns ruleId={rule.id} />}
        </div>
      ))}
      </Panel>
    </div>
  );
}
