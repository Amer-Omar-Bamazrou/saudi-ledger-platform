/**
 * Findings (AI-3a) — the deterministic internal-consistency checks, surfaced.
 *
 * Wording rules carried from the design: a finding is a FACT about the
 * tenant's own records, rendered in words — no severity colors (the status
 * palette is reserved for real states, and "how bad is this" is a judgment
 * the platform does not make); the invoice-number-gap finding says plainly
 * that gaps are lawful (C12) — its value is being able to ANSWER, not a
 * warning; nothing here asserts a tax or compliance position (owner
 * decision 2026-08-24: internal-consistency only until C10 closes).
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SearchCheck, Play, Check, CircleDot } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { DualDate } from "@/components/DualDate";

interface Finding {
  id: number;
  kind: string;
  refKey: string;
  facts: Record<string, unknown>;
  status: "open" | "acknowledged" | "resolved";
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedByName: string | null;
  resolvedAt: string | null;
  /** AI-3b — model phrasing of the facts; null is the deterministic floor. */
  explanation: { en: string; ar: string } | null;
}
interface FindingsPage {
  findings: Finding[];
  counts: { open: number; acknowledged: number; resolved: number };
}

const KIND_LABELS: Record<string, { en: string; ar: string }> = {
  duplicate_bill: { en: "Possible duplicate bill", ar: "فاتورة مورد مكررة محتملة" },
  duplicate_transaction: { en: "Possible duplicate transaction", ar: "معاملة مكررة محتملة" },
  invoice_number_gap: { en: "Invoice numbers absent from the series", ar: "أرقام غائبة من تسلسل الفواتير" },
  overdue_receivable: { en: "Invoice past due, unpaid", ar: "فاتورة متأخرة غير محصلة" },
  overdue_payable: { en: "Bill past due, unpaid", ar: "فاتورة مورد متأخرة غير مسددة" },
  stale_draft: { en: "Draft waiting on a decision", ar: "مسودة بانتظار قرار" },
  undeclared_transfer: { en: "Transfer with no declared destination", ar: "تحويل بدون وجهة معلنة" },
  unposted_transaction: { en: "Accepted row not in the ledger", ar: "معاملة مقبولة غير مرحلة" },
};

function factLine(f: Finding, t: (en: string, ar: string) => string): string {
  const x = f.facts as Record<string, any>;
  switch (f.kind) {
    case "duplicate_bill":
      return t(
        `${x.count} bills from the same vendor, same date (${x.date}), same total ${fmtNum(x.total)}: ${(x.billNumbers ?? []).join(", ")}`,
        `${x.count} فواتير من نفس المورد وبنفس التاريخ (${x.date}) وبنفس الإجمالي ${fmtNum(x.total)}: ${(x.billNumbers ?? []).join("، ")}`,
      );
    case "duplicate_transaction":
      return t(
        `${x.count} accepted rows share date ${x.date}, amount ${fmtNum(x.amount)} and description "${x.description}"`,
        `${x.count} معاملات مقبولة تتطابق في التاريخ ${x.date} والمبلغ ${fmtNum(x.amount)} والوصف «${x.description}»`,
      );
    case "invoice_number_gap":
      return t(
        `${x.missingCount} number(s) absent after ${x.afterNumber} (${x.missingFrom}–${x.missingTo}). Gaps are lawful (sequential + unique is the requirement); this is recorded so the question "why is this number absent?" has an answer.`,
        `${x.missingCount} رقم غائب بعد ${x.afterNumber} (${x.missingFrom}–${x.missingTo}). الفجوات نظامية (المطلوب تسلسل وتفرّد لا غير)؛ يُسجَّل هذا لتكون لديك إجابة إذا سُئلت.`,
      );
    case "overdue_receivable":
      return t(
        `${x.invoiceNumber}: ${fmtNum(x.outstanding)} outstanding, ${x.daysOverdue} day(s) past due`,
        `${x.invoiceNumber}: ${fmtNum(x.outstanding)} مستحق، متأخر ${x.daysOverdue} يومًا`,
      );
    case "overdue_payable":
      return t(
        `${x.billNumber}: ${fmtNum(x.outstanding)} unpaid, ${x.daysOverdue} day(s) past due`,
        `${x.billNumber}: ${fmtNum(x.outstanding)} غير مسدد، متأخر ${x.daysOverdue} يومًا`,
      );
    case "stale_draft":
      return t(
        `${x.entity} ${x.number ?? `#${x.id}`} has been ${x.status} for ${x.ageDays} days (threshold ${x.thresholdDays})`,
        `${x.number ?? `#${x.id}`} في حالة ${x.status} منذ ${x.ageDays} يومًا (الحد ${x.thresholdDays})`,
      );
    case "undeclared_transfer":
      return t(
        `${fmtNum(x.amount)} on ${x.date} — "${x.description}". Until its destination is declared, it blocks the cash reconciliation's claim.`,
        `${fmtNum(x.amount)} بتاريخ ${x.date} — «${x.description}». حتى تُعلَن وجهته يبقى حاجزًا لمطابقة النقد.`,
      );
    case "unposted_transaction":
      return t(
        `${fmtNum(x.amount)} on ${x.date} — "${x.description}" is accepted but has no ledger entry.`,
        `${fmtNum(x.amount)} بتاريخ ${x.date} — «${x.description}» مقبولة لكن بلا قيد في الدفاتر.`,
      );
    default:
      return JSON.stringify(f.facts);
  }
}

interface FindingsStatus {
  cadence: "quarterly" | "monthly";
  lastScheduledRun: { periodKey: string | null; ranAt: string; openAfter: number; viewedAt: string | null } | null;
  escalated: boolean;
}

export default function Findings() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"open" | "acknowledged" | "resolved" | "">("open");
  const isApprover = user?.organizationRole === "admin" || user?.organizationRole === "accountant";

  const { data, isLoading } = useQuery<FindingsPage>({
    queryKey: ["findings", statusFilter],
    queryFn: async () => {
      const page = (await apiFetch(`/findings${statusFilter ? `?status=${statusFilter}` : ""}`)) as FindingsPage;
      // Listing stamped any unviewed scheduled run server-side (viewing IS
      // the dismissal) — the Dashboard marker must learn it went away.
      qc.invalidateQueries({ queryKey: ["findings-status"] });
      return page;
    },
  });

  const { data: schedStatus } = useQuery<FindingsStatus>({
    queryKey: ["findings-status"],
    queryFn: () => apiFetch("/findings/status"),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["findings"] });

  const cadenceMut = useMutation({
    mutationFn: (cadence: string) => apiFetch("/findings/schedule", { method: "PUT", body: JSON.stringify({ cadence }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["findings-status"] }),
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const runMut = useMutation({
    mutationFn: () => apiFetch("/findings/run", { method: "POST" }),
    onSuccess: (r: any) => {
      toast({
        title: t(
          `Checks ran: ${r.created} new, ${r.reopened} reopened, ${r.resolved} resolved — ${r.open} open`,
          `اكتمل الفحص: ${r.created} جديد، ${r.reopened} أعيد فتحه، ${r.resolved} انتهى — ${r.open} مفتوح`,
        ),
      });
      refresh();
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const ackMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/findings/${id}/acknowledge`, { method: "POST" }),
    onSuccess: refresh,
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const counts = data?.counts;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <SearchCheck className="h-5 w-5" /> {t("Findings", "الملاحظات")}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {t(
              "Deterministic checks over your own records — duplicates, overdue documents, waiting drafts, undeclared transfers. Observations, not verdicts: nothing here asserts a tax or compliance position.",
              "فحوص حتمية على سجلاتك — التكرارات، والمستندات المتأخرة، والمسودات المعلقة، والتحويلات غير المعلنة. ملاحظات لا أحكام: لا شيء هنا يقرر موقفًا ضريبيًا أو نظاميًا.",
            )}
          </p>
        </div>
        <Button onClick={() => runMut.mutate()} disabled={runMut.isPending} className="gap-1">
          <Play className="h-4 w-4" /> {t("Run checks", "تشغيل الفحوص")}
        </Button>
      </div>

      {schedStatus && (
        <p className="text-xs text-muted-foreground">
          {schedStatus.lastScheduledRun
            ? t(
                `Scheduled review runs ${schedStatus.cadence === "monthly" ? "monthly" : "quarterly"} — last ran ${schedStatus.lastScheduledRun.ranAt.slice(0, 10)} (${schedStatus.lastScheduledRun.openAfter} open after).`,
                `يعمل الفحص المجدول ${schedStatus.cadence === "monthly" ? "شهريًا" : "ربع سنويًا"} — آخر تشغيل ${schedStatus.lastScheduledRun.ranAt.slice(0, 10)} (${schedStatus.lastScheduledRun.openAfter} مفتوحة بعده).`,
              )
            : t(
                `Scheduled review runs ${schedStatus.cadence === "monthly" ? "monthly" : "quarterly"} — no scheduled run has happened yet.`,
                `يعمل الفحص المجدول ${schedStatus.cadence === "monthly" ? "شهريًا" : "ربع سنويًا"} — لم يجرِ أي تشغيل مجدول بعد.`,
              )}
          {isApprover && (
            <Button
              size="sm"
              variant="link"
              className="h-auto px-1 py-0 text-xs"
              disabled={cadenceMut.isPending}
              onClick={() => cadenceMut.mutate(schedStatus.cadence === "monthly" ? "quarterly" : "monthly")}
            >
              {schedStatus.cadence === "monthly"
                ? t("switch to quarterly", "التحويل إلى ربع سنوي")
                : t("switch to monthly", "التحويل إلى شهري")}
            </Button>
          )}
        </p>
      )}

      <div className="flex gap-2">
        {(["open", "acknowledged", "resolved"] as const).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={statusFilter === s ? "default" : "outline"}
            onClick={() => setStatusFilter(statusFilter === s ? "" : s)}
          >
            {s === "open" && t("Open", "مفتوحة")}
            {s === "acknowledged" && t("Acknowledged", "مُقرّة")}
            {s === "resolved" && t("Resolved", "منتهية")}
            {counts ? ` (${counts[s]})` : ""}
          </Button>
        ))}
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">…</p>}
      {!isLoading && (data?.findings.length ?? 0) === 0 && (
        <p className="text-sm text-muted-foreground">
          {statusFilter === "open"
            ? t("No open findings. Run the checks to look again.", "لا توجد ملاحظات مفتوحة. شغّل الفحوص لإعادة النظر.")
            : t("Nothing here.", "لا شيء هنا.")}
        </p>
      )}

      {data?.findings.map((f) => (
        <Card key={f.id}>
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <CircleDot className="h-4 w-4 text-muted-foreground" />
              {t(KIND_LABELS[f.kind]?.en ?? f.kind, KIND_LABELS[f.kind]?.ar ?? f.kind)}
              {f.status === "acknowledged" && (
                <Badge variant="secondary">
                  {t("Acknowledged", "مُقرّة")}
                  {f.acknowledgedByName ? ` — ${f.acknowledgedByName}` : ""}
                </Badge>
              )}
              {f.status === "resolved" && <Badge variant="outline">{t("No longer detected", "لم تعد مرصودة")}</Badge>}
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                {t("last seen", "آخر رصد")} <DualDate date={f.lastSeenAt.slice(0, 10)} inline />
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-start justify-between gap-3 pt-0">
            <div className="min-w-0">
              {/* The deterministic facts are the FLOOR and always render;
                  the AI phrasing sits BESIDE them, labeled, never instead —
                  the reader can always compare it against the facts. */}
              <p className="text-sm">{factLine(f, t)}</p>
              {f.explanation && (
                <p className="mt-1 text-sm text-muted-foreground italic">
                  {t(f.explanation.en, f.explanation.ar)}{" "}
                  <span className="not-italic text-[10px] uppercase tracking-wide">
                    {t("AI phrasing of the facts above", "صياغة آلية للوقائع أعلاه")}
                  </span>
                </p>
              )}
            </div>
            {f.status === "open" && (
              <Button size="sm" variant="outline" className="gap-1 shrink-0" onClick={() => ackMut.mutate(f.id)} disabled={ackMut.isPending}>
                <Check className="h-3.5 w-3.5" /> {t("Acknowledge", "إقرار")}
              </Button>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
