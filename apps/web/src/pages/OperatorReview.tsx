import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { FileText, RefreshCw } from "lucide-react";

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
  pending_review: "bg-amber-500/20 text-amber-500 border-amber-500/30",
  needs_info: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  rejected: "bg-red-500/20 text-red-400 border-red-500/30",
  approved: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
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
      <div className="p-6">
        <Alert variant="destructive"><AlertDescription>{(listError as Error).message}</AlertDescription></Alert>
      </div>
    );
  }

  return (
    // Standalone page (rendered outside Layout — an operator has no org
    // membership, so the sidebar's tenant-scoped queries would 403).
    <div className="min-h-screen bg-background p-6 space-y-6">
      <div className="flex items-center justify-between max-w-5xl">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Verification review", "مراجعة التوثيق")}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t("Organizations awaiting platform approval", "المؤسسات في انتظار موافقة المنصة")}
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1" onClick={() => qc.invalidateQueries({ queryKey: ["operator-applications"] })}>
          <RefreshCw className="w-3.5 h-3.5" /> {t("Refresh", "تحديث")}
        </Button>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      <Card className="border-border bg-card max-w-5xl">
        <CardHeader className="pb-3"><CardTitle className="text-base">{t("Applications", "الطلبات")}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <p className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : (data?.applications ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">{t("No applications awaiting review.", "لا توجد طلبات في انتظار المراجعة.")}</p>
          ) : (
            <div className="divide-y divide-border">
              {data!.applications.map((a) => (
                <button
                  key={a.organizationId}
                  onClick={() => { setSelected(a.organizationId === selected ? null : a.organizationId); setReason(""); setError(""); }}
                  className={`w-full text-left flex items-center gap-3 px-6 py-3 hover:bg-muted/40 ${selected === a.organizationId ? "bg-muted/40" : ""}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{a.name}</p>
                    <p className="text-xs text-muted-foreground">{a.slug}</p>
                  </div>
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${STATUS_COLOR[a.status] ?? ""}`}>
                    {a.status.replace(/_/g, " ").toUpperCase()}
                  </span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {selected && detail && (
        <Card className="border-border bg-card max-w-5xl">
          <CardHeader className="pb-3"><CardTitle className="text-base">{detail.name}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {/* Registration identity */}
            <div>
              <h3 className="text-sm font-medium mb-1">{t("Registration", "التسجيل")}</h3>
              {detail.companies.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("No company on file.", "لا توجد شركة مسجلة.")}</p>
              ) : detail.companies.map((c) => (
                <div key={c.id} className="text-xs text-muted-foreground space-x-4">
                  <span className="text-foreground">{c.name}</span>
                  <span>CR: <span className="font-mono">{c.crNumber ?? "—"}</span></span>
                  <span>VAT: <span className="font-mono">{c.vatNumber ?? "—"}</span></span>
                </div>
              ))}
            </div>

            {/* Documents */}
            <div>
              <h3 className="text-sm font-medium mb-1">{t("Documents", "المستندات")}</h3>
              {detail.documents.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("No documents uploaded.", "لم يتم رفع مستندات.")}</p>
              ) : (
                <ul className="space-y-1">
                  {detail.documents.map((d) => (
                    <li key={d.id} className="flex items-center gap-2 text-xs">
                      <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <button onClick={() => downloadDoc(detail.organizationId, d.id)} className="text-primary hover:underline">
                        {d.fileName}
                      </button>
                      <span className="uppercase text-[10px] border border-border rounded px-1 text-muted-foreground">{d.type.replace(/_/g, " ")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* History */}
            <div>
              <h3 className="text-sm font-medium mb-1">{t("Review history", "سجل المراجعة")}</h3>
              {detail.reviews.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("No decisions yet.", "لا توجد قرارات بعد.")}</p>
              ) : (
                <ul className="space-y-1">
                  {detail.reviews.map((r) => (
                    <li key={r.id} className="text-xs text-muted-foreground">
                      <span className="font-mono">{new Date(r.createdAt).toLocaleString()}</span>{" · "}
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
                className="h-8 text-sm"
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
          </CardContent>
        </Card>
      )}
    </div>
  );
}
