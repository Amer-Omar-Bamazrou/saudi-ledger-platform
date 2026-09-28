import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { PageHeader, Panel, EmptyState } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { FileText, RefreshCw, Inbox } from "lucide-react";
import OperatorZatcaPanel from "./OperatorZatcaPanel";

/**
 * Platform-operator review surface (M11.5) — list pending applications, inspect
 * one (CR/VAT + documents + history), and approve / request-info / reject /
 * reopen. Server-side authorization is `requirePlatformOperator`; a non-operator
 * simply gets 403 from every call here.
 */
interface AppRow { organizationId: string; name: string; slug: string; status: string; reason: string | null; submittedAt: string | null; createdAt: string }
interface Company { id: string; name: string; crNumber: string | null; vatNumber: string | null }
interface Doc { id: string; type: string; fileName: string; sizeBytes: number }
interface Review { id: string; fromStatus: string | null; toStatus: string; reason: string | null; operatorUserId: number | null; createdAt: string }
interface Detail extends AppRow { companies: Company[]; documents: Doc[]; reviews: Review[] }

const STATUS_COLOR: Record<string, string> = {
  pending_review: "bg-attention-surface/20 text-attention border-attention-surface/30",
  needs_info: "bg-info-surface/20 text-info border-info-surface/30",
  rejected: "bg-negative-surface/20 text-negative border-negative-surface/30",
  approved: "bg-positive-surface/20 text-positive border-positive-surface/30",
};

export default function OperatorReview() {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const { data, isLoading, error: listError } = useQuery<{ applications: AppRow[] }>({
    queryKey: ["operator-applications"],
    queryFn: () => apiFetch("/operator/applications"),
    retry: false,
  });

  const { data: detail } = useQuery<Detail>({
    queryKey: ["operator-application", selected],
    queryFn: () => apiFetch(`/operator/applications/${selected}`),
    enabled: !!selected,
  });

  const decide = useMutation({
    mutationFn: ({ verb, orgId }: { verb: string; orgId: string }) =>
      apiFetch(`/operator/applications/${orgId}/${verb}`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      setReason("");
      setError("");
      qc.invalidateQueries({ queryKey: ["operator-applications"] });
      qc.invalidateQueries({ queryKey: ["operator-application", selected] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const downloadDoc = (orgId: string, docId: string) => {
    // Brokered through the API (served as an attachment); open in a new tab so the
    // session cookie is sent and the browser handles the download.
    window.open(`${import.meta.env.BASE_URL}api/operator/applications/${orgId}/documents/${docId}`, "_blank");
  };

  if (listError) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Alert variant="destructive"><AlertDescription>{(listError as Error).message}</AlertDescription></Alert>
      </div>
    );
  }

  return (
    // Standalone page (rendered outside Layout — an operator has no org
    // membership, so the sidebar's tenant-scoped queries would 403).
    <div className="min-h-screen bg-background">
      <div className="border-b border-border bg-sidebar text-sidebar-foreground">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-2.5 px-4 sm:px-6">
          <div className="w-8 h-8 rounded-md bg-sidebar-foreground flex items-center justify-center">
            <span className="font-display text-base font-bold leading-none text-sidebar -mt-0.5">ك</span>
          </div>
          <span className="font-display font-semibold">{t("KSA Ledger", "دفتر المملكة")}</span>
          <span className="ms-2 text-[13px] text-sidebar-foreground/70">{t("Platform operator", "مشغّل المنصة")}</span>
        </div>
      </div>
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
      <PageHeader
        title={t("Verification review", "مراجعة التوثيق")}
        description={t("Organizations awaiting platform approval", "المؤسسات في انتظار موافقة المنصة")}
        actions={
        <Button variant="outline" size="sm" className="gap-1" onClick={() => qc.invalidateQueries({ queryKey: ["operator-applications"] })}>
          <RefreshCw className="w-3.5 h-3.5" /> {t("Refresh", "تحديث")}
        </Button>
        }
      />

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      <Panel flush title={t("Applications", "الطلبات")}>
          {isLoading ? (
            <p className="text-sm text-muted-foreground p-5">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : (data?.applications ?? []).length === 0 ? (
            <EmptyState icon={Inbox} title={t("No applications awaiting review.", "لا توجد طلبات في انتظار المراجعة.")} />
          ) : (
            <div className="divide-y divide-border">
              {data!.applications.map((a) => (
                <button
                  key={a.organizationId}
                  onClick={() => { setSelected(a.organizationId === selected ? null : a.organizationId); setReason(""); setError(""); }}
                  className={`w-full text-start flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/40 ${selected === a.organizationId ? "bg-muted/40" : ""}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{a.name}</p>
                    <p className="text-[12px] text-muted-foreground">{a.slug}</p>
                  </div>
                  <span className={`text-[12px] font-medium px-1.5 py-0.5 rounded border capitalize ${STATUS_COLOR[a.status] ?? ""}`}>
                    {a.status.replace(/_/g, " ")}
                  </span>
                </button>
              ))}
            </div>
          )}
      </Panel>

      {selected && detail && (
        <Panel title={detail.name} bodyClassName="space-y-5">
            {/* Registration identity */}
            <div>
              <h3 className="text-[13px] font-semibold mb-1.5">{t("Registration", "التسجيل")}</h3>
              {detail.companies.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("No company on file.", "لا توجد شركة مسجلة.")}</p>
              ) : detail.companies.map((c) => (
                <div key={c.id} className="flex flex-wrap gap-x-4 text-[13px] text-muted-foreground">
                  <span className="text-foreground">{c.name}</span>
                  <span>CR: <span className="font-mono">{c.crNumber ?? "—"}</span></span>
                  <span>VAT: <span className="font-mono">{c.vatNumber ?? "—"}</span></span>
                </div>
              ))}
            </div>

            {/* Documents */}
            <div>
              <h3 className="text-[13px] font-semibold mb-1.5">{t("Documents", "المستندات")}</h3>
              {detail.documents.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("No documents uploaded.", "لم يتم رفع مستندات.")}</p>
              ) : (
                <ul className="space-y-1">
                  {detail.documents.map((d) => (
                    <li key={d.id} className="flex items-center gap-2 text-[13px]">
                      <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <button onClick={() => downloadDoc(detail.organizationId, d.id)} className="text-primary hover:underline">
                        {d.fileName}
                      </button>
                      <span className="text-[12px] border border-border rounded px-1 text-muted-foreground capitalize">{d.type.replace(/_/g, " ")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* History */}
            <div>
              <h3 className="text-[13px] font-semibold mb-1.5">{t("Review history", "سجل المراجعة")}</h3>
              {detail.reviews.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("No decisions yet.", "لا توجد قرارات بعد.")}</p>
              ) : (
                <ul className="space-y-1">
                  {detail.reviews.map((r) => (
                    <li key={r.id} className="text-[13px] text-muted-foreground">
                      <span className="tabular-nums">{new Date(r.createdAt).toLocaleString()}</span>{" · "}
                      {r.fromStatus} → <span className="text-foreground">{r.toStatus}</span>
                      {r.reason ? ` — ${r.reason}` : ""}
                      {r.operatorUserId == null ? ` (${t("applicant", "مقدم الطلب")})` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Decisions */}
            <div className="border-t border-border pt-4 space-y-2">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("Reason (required for request-info / reject / reopen)", "السبب (مطلوب لطلب معلومات / الرفض / إعادة الفتح)")}
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ verb: "approve", orgId: detail.organizationId })}>
                  {t("Approve", "موافقة")}
                </Button>
                <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ verb: "request-info", orgId: detail.organizationId })}>
                  {t("Request info", "طلب معلومات")}
                </Button>
                <Button size="sm" variant="destructive" disabled={decide.isPending} onClick={() => decide.mutate({ verb: "reject", orgId: detail.organizationId })}>
                  {t("Reject", "رفض")}
                </Button>
                {detail.status === "rejected" && (
                  <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ verb: "reopen", orgId: detail.organizationId })}>
                    {t("Reopen (fix mistake)", "إعادة الفتح (تصحيح خطأ)")}
                  </Button>
                )}
              </div>
            </div>
        </Panel>
      )}

      {/* M12.8 — ZATCA e-invoicing visibility: outbox age, certificate expiry,
          onboarding. Separate component because it is a different concern from
          verification review, and its queries are independent. */}
      <OperatorZatcaPanel />

      {/* §5 rank 1 (owner, 2026-09-04): the break-glass. The temporary
          password is shown ONCE and stored nowhere — the operator hands it
          over on a verified channel. Self-service email reset replaces this
          as the primary path when the mail provider lands. */}
      <BreakGlassResetCard />
      </div>
    </div>
  );
}

function BreakGlassResetCard() {
  const { t } = useLanguage();
  const [email, setEmail] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ email: string; temporaryPassword: string; sessionsRevoked: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const resetMut = useMutation({
    mutationFn: () =>
      apiFetch<{ email: string; temporaryPassword: string; sessionsRevoked: number }>(
        "/operator/users/reset-password",
        { method: "POST", body: JSON.stringify({ email: email.trim() }) },
      ),
    onSuccess: (r) => { setResult(r); setErr(null); setConfirming(false); setEmail(""); },
    onError: (e: Error) => { setErr(e.message); setConfirming(false); },
  });

  return (
    <Panel
      className="border-attention-surface/40"
      title={t("Break-glass password reset", "إعادة تعيين كلمة المرور (طوارئ)")}
      bodyClassName="space-y-3"
    >
        <p className="text-[13px] text-muted-foreground max-w-2xl">
          {t(
            "For a locked-out user with no other route back. Generates a temporary password shown ONCE, revokes every live session, and records the act. Operator accounts cannot be reset here.",
            "لمستخدم فَقَد الوصول ولا طريق أخرى له. تُنشأ كلمة مرور مؤقتة تُعرض مرة واحدة، وتُلغى كل الجلسات، ويُسجّل الإجراء. حسابات المشغّلين لا تُعاد من هنا.",
          )}
        </p>
        <div className="flex items-center gap-2 max-w-md">
          <Input
            type="email"
            placeholder={t("User email", "بريد المستخدم")}
            value={email}
            onChange={(e) => { setEmail(e.target.value); setConfirming(false); }}
            className="h-8 text-sm"
            data-testid="breakglass-email"
          />
          {!confirming ? (
            <Button size="sm" variant="outline" className="h-8" disabled={!email.trim()} onClick={() => setConfirming(true)}>
              {t("Reset…", "إعادة تعيين…")}
            </Button>
          ) : (
            /* The destructive act names its true scope BEFORE the act: the
               password changes AND every session dies. */
            <Button size="sm" variant="destructive" className="h-8 whitespace-nowrap" disabled={resetMut.isPending} onClick={() => resetMut.mutate()} data-testid="breakglass-confirm">
              {t("Confirm: new password + all sessions revoked", "تأكيد: كلمة جديدة + إلغاء الجلسات")}
            </Button>
          )}
        </div>
        {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
        {result && (
          <Alert>
            <AlertDescription className="space-y-1">
              <div className="text-xs">{t("Temporary password for", "كلمة المرور المؤقتة لـ")} <b>{result.email}</b> — {t("shown once, stored nowhere", "تُعرض مرة واحدة ولا تُحفظ")}:</div>
              <code className="font-mono text-sm select-all" data-testid="breakglass-temp-password">{result.temporaryPassword}</code>
              <div className="text-xs text-muted-foreground">
                {t(`Sessions revoked: ${result.sessionsRevoked}. Hand it over on a verified channel and ask the user to change it after signing in.`,
                   `الجلسات الملغاة: ${result.sessionsRevoked}. سلّمها عبر قناة موثوقة واطلب تغييرها بعد الدخول.`)}
              </div>
            </AlertDescription>
          </Alert>
        )}
    </Panel>
  );
}
