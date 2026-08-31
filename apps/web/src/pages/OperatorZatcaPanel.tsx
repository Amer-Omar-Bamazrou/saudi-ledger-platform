import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtDate } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Archive, Clock, PlayCircle, ShieldCheck } from "lucide-react";

/**
 * Operator-side ZATCA visibility (M12.8).
 *
 * Three panels, each for a failure that is QUIET rather than loud — the kind
 * nobody notices until it is a legal problem:
 *
 *   1. **Outbox age.** A rejected document is visible and someone acts on it. A
 *      simplified invoice silently missing ZATCA's 24-hour reporting deadline
 *      looks like nothing is wrong, and is exposure for the tenant from
 *      SAR 5,000. AGE matters more than count.
 *   2. **Certificate expiry.** At expiry signing stops dead and the tenant
 *      cannot legally invoice. Renewal needs an OTP only THEY can obtain, so a
 *      late warning cannot be fixed by us — the panel shows which reminder
 *      windows have already passed unannounced.
 *   3. **Onboarding.** Derived from the credential vault, never from
 *      `companies.zatca_onboarding_status` (dropped in M12.8 — nothing ever
 *      wrote it, so every row read 'not_started' forever).
 *
 * 🔴 This is VISIBILITY, not alerting. Nothing here pages a human; wiring these
 * numbers to real alerting is still a pre-production requirement.
 */
interface Health {
  overdueMinutes: number;
  overdue: { total: number; oldestAgeMinutes: number | null; byFlow: Record<string, number> };
  needsReview: number;
  archive: { archived: number; pendingArchive: number };
  workerEnabled: boolean;
}

interface Certificate {
  credentialId: string;
  companyId: string;
  companyName: string | null;
  environment: string;
  notAfter: string | null;
  daysRemaining: number | null;
  expired: boolean;
  remindersRaised: number[];
  remindersMissing: number[];
}

interface Onboarding {
  companyId: string;
  companyName: string;
  organizationName: string | null;
  vatNumber: string | null;
  environment: string;
  credentialStatus: string;
  notAfter: string | null;
  readyToOnboard: boolean;
}

const CRED_COLOR: Record<string, string> = {
  active: "bg-positive-surface/20 text-positive border-positive-surface/30",
  pending_csr: "bg-attention-surface/20 text-attention-surface border-attention-surface/30",
  not_onboarded: "bg-muted text-muted-foreground border-border",
  superseded: "bg-info-surface/20 text-info border-info-surface/30",
  revoked: "bg-negative-surface/20 text-negative border-negative-surface/30",
};

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: "warn" | "danger" }) {
  const color = tone === "danger" ? "text-negative" : tone === "warn" ? "text-attention-surface" : "text-foreground";
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}

export default function OperatorZatcaPanel() {
  const { t } = useLanguage();
  const qc = useQueryClient();

  const { data: health } = useQuery<Health>({
    queryKey: ["operator-zatca-health"],
    queryFn: () => apiFetch("/operator/zatca/health"),
    retry: false,
  });

  const { data: certificates } = useQuery<Certificate[]>({
    queryKey: ["operator-zatca-certificates"],
    queryFn: () => apiFetch("/operator/zatca/certificates?days=120"),
    retry: false,
  });

  const { data: onboarding } = useQuery<Onboarding[]>({
    queryKey: ["operator-zatca-onboarding"],
    queryFn: () => apiFetch("/operator/zatca/onboarding"),
    retry: false,
  });

  const runJob = useMutation({
    mutationFn: (name: string) => apiFetch(`/operator/zatca/jobs/${name}/run`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operator-zatca-health"] });
      qc.invalidateQueries({ queryKey: ["operator-zatca-certificates"] });
    },
  });

  const oldest = health?.overdue.oldestAgeMinutes ?? null;
  // 24h is ZATCA's reporting deadline for simplified invoices; 12h is the point
  // at which there is still time to act.
  const oldestTone = oldest === null ? undefined : oldest > 1440 ? "danger" : oldest > 720 ? "warn" : undefined;

  return (
    <div className="space-y-6">
      {/* ── Outbox health ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            {t("E-invoice transmission", "إرسال الفواتير الإلكترونية")}
          </CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => runJob.mutate("einvoice-outbox")} disabled={runJob.isPending}>
              <PlayCircle className="me-1 h-3 w-3" />
              {t("Drain outbox", "تفريغ الطابور")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => runJob.mutate("einvoice-archive")} disabled={runJob.isPending}>
              <Archive className="me-1 h-3 w-3" />
              {t("Sweep archive", "أرشفة")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {health && !health.workerEnabled && (
            <Alert>
              <AlertDescription>
                {t(
                  "The background worker is OFF (ZATCA_WORKER_ENABLED=false). Documents queue but are not transmitted until it is enabled or a job is run manually.",
                  "عامل الخلفية متوقف. تُدرج المستندات في الطابور ولا تُرسل حتى يتم تفعيله.",
                )}
              </AlertDescription>
            </Alert>
          )}

          {oldest !== null && oldest > 1440 && (
            <Alert variant="destructive">
              <AlertDescription>
                {t(
                  `A document has been awaiting transmission for ${Math.floor(oldest / 60)} hours. Simplified invoices must be reported to ZATCA within 24 hours.`,
                  `مستند ينتظر الإرسال منذ ${Math.floor(oldest / 60)} ساعة. يجب إبلاغ الفواتير المبسطة خلال ٢٤ ساعة.`,
                )}
              </AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat
              label={t(`Overdue (>${health?.overdueMinutes ?? 60}m)`, `متأخرة`)}
              value={health?.overdue.total ?? "—"}
              tone={health?.overdue.total ? "warn" : undefined}
            />
            <Stat
              label={t("Oldest waiting", "أقدم انتظار")}
              value={oldest === null ? "—" : oldest > 90 ? `${Math.floor(oldest / 60)}h` : `${oldest}m`}
              tone={oldestTone}
            />
            <Stat
              label={t("Needs review", "تحتاج مراجعة")}
              value={health?.needsReview ?? "—"}
              tone={health?.needsReview ? "danger" : undefined}
            />
            <Stat label={t("Archived", "مؤرشفة")} value={health?.archive.archived ?? "—"} />
            <Stat
              label={t("Awaiting archive", "بانتظار الأرشفة")}
              value={health?.archive.pendingArchive ?? "—"}
              tone={health?.archive.pendingArchive ? "warn" : undefined}
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Certificate expiry ────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            {t("Certificate expiry", "انتهاء الشهادات")}
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => runJob.mutate("zatca-renewal-reminders")} disabled={runJob.isPending}>
            <PlayCircle className="me-1 h-3 w-3" />
            {t("Check now", "تحقق الآن")}
          </Button>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">
            {t(
              "Renewal requires an OTP the TENANT generates in their own Fatoora portal — a late reminder cannot be resolved by the platform.",
              "يتطلب التجديد رمزاً يولّده المكلّف في بوابة فاتورة الخاصة به — لا يمكن للمنصة معالجة تذكير متأخر.",
            )}
          </p>
          {!certificates?.length ? (
            <p className="text-sm text-muted-foreground">{t("No certificates expiring within 120 days.", "لا توجد شهادات تنتهي خلال ١٢٠ يوماً.")}</p>
          ) : (
            <div className="space-y-2">
              {certificates.map((c) => (
                <div key={c.credentialId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
                  <div>
                    <div className="text-sm font-medium">{c.companyName ?? c.companyId}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.environment} · {c.notAfter ? fmtDate(c.notAfter) : "—"}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* A window that passed with no reminder recorded is the gap
                        an operator can act on by contacting the tenant. */}
                    {c.remindersMissing.length > 0 && (
                      <span className="flex items-center gap-1 rounded border border-attention-surface/30 bg-attention-surface/20 px-2 py-0.5 text-xs text-attention-surface">
                        <AlertTriangle className="h-3 w-3" />
                        {t(`T-${c.remindersMissing.join("/T-")} not sent`, `لم تُرسل`)}
                      </span>
                    )}
                    <span
                      className={`rounded border px-2 py-0.5 text-xs ${
                        c.expired
                          ? "border-negative-surface/30 bg-negative-surface/20 text-negative"
                          : (c.daysRemaining ?? 999) <= 30
                            ? "border-attention-surface/30 bg-attention-surface/20 text-attention-surface"
                            : "border-border bg-muted text-muted-foreground"
                      }`}
                    >
                      {c.expired
                        ? t("EXPIRED — cannot invoice", "منتهية — لا يمكن إصدار فواتير")
                        : t(`${c.daysRemaining} days left`, `${c.daysRemaining} يوماً`)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Onboarding status ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{t("ZATCA onboarding", "التسجيل في هيئة الزكاة")}</CardTitle>
        </CardHeader>
        <CardContent>
          {!onboarding?.length ? (
            <p className="text-sm text-muted-foreground">{t("No companies.", "لا توجد شركات.")}</p>
          ) : (
            <div className="space-y-2">
              {onboarding.map((c) => (
                <div key={c.companyId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
                  <div>
                    <div className="text-sm font-medium">{c.companyName}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.organizationName ?? "—"} · VAT {c.vatNumber ?? t("not set", "غير محدد")}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!c.readyToOnboard && (
                      <span className="rounded border border-attention-surface/30 bg-attention-surface/20 px-2 py-0.5 text-xs text-attention-surface">
                        {t("No VAT number", "لا يوجد رقم ضريبي")}
                      </span>
                    )}
                    <span className={`rounded border px-2 py-0.5 text-xs ${CRED_COLOR[c.credentialStatus] ?? CRED_COLOR.not_onboarded}`}>
                      {c.credentialStatus}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
