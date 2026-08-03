import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Clock, AlertTriangle, XCircle, CheckCircle2, FileText, Upload } from "lucide-react";

/**
 * Applicant verification status page (M11.5) — what a not-yet-approved
 * organization sees. The verification gate's 403 body ({status, reason}) routes
 * users here (see lib/api.ts), including the multi-org case where the user
 * switched to a pending org.
 */
interface Status { organizationId: string; name: string; status: string; reason: string | null }
interface Doc { id: string; type: string; fileName: string; sizeBytes: number; createdAt: string }

const DOC_TYPES = ["cr_certificate", "vat_certificate", "other"] as const;

export default function VerificationStatus() {
  const { t } = useLanguage();
  const { logout } = useAuth();
  const qc = useQueryClient();
  const [docType, setDocType] = useState<string>("cr_certificate");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");

  const { data: status, isLoading } = useQuery<Status>({
    queryKey: ["onboarding-status"],
    queryFn: () => apiFetch("/onboarding/status"),
  });
  const { data: docsData } = useQuery<{ documents: Doc[] }>({
    queryKey: ["onboarding-documents"],
    queryFn: () => apiFetch("/onboarding/documents"),
  });

  const uploadMut = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error(t("Choose a file first.", "اختر ملفاً أولاً."));
      const fd = new FormData();
      fd.append("type", docType);
      fd.append("file", file);
      return apiFetch("/onboarding/documents", { method: "POST", body: fd });
    },
    onSuccess: () => {
      setFile(null);
      setError("");
      qc.invalidateQueries({ queryKey: ["onboarding-documents"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const resubmitMut = useMutation({
    mutationFn: () => apiFetch("/onboarding/resubmit", { method: "POST" }),
    onSuccess: () => {
      setError("");
      qc.invalidateQueries({ queryKey: ["onboarding-status"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  if (isLoading || !status) {
    return <div className="min-h-screen bg-background flex items-center justify-center text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</div>;
  }

  // Approved orgs shouldn't be here — offer the way back in.
  if (status.status === "approved") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-lg border-border/50">
          <CardHeader>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
              <CardTitle>{t("Your organization is verified", "تم توثيق مؤسستك")}</CardTitle>
            </div>
            <CardDescription>{status.name}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={() => (window.location.href = import.meta.env.BASE_URL)}>
              {t("Go to the dashboard", "الانتقال إلى لوحة التحكم")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isPending = status.status === "pending_review";
  const isNeedsInfo = status.status === "needs_info";
  const isRejected = status.status === "rejected";
  const canUpload = isPending || isNeedsInfo;

  const Icon = isPending ? Clock : isNeedsInfo ? AlertTriangle : XCircle;
  const heading = isPending
    ? t("Your application is under review", "طلبك قيد المراجعة")
    : isNeedsInfo
      ? t("We need more information", "نحتاج إلى مزيد من المعلومات")
      : t("Your application was not approved", "لم تتم الموافقة على طلبك");

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-2xl space-y-4 py-8">
        <Card className="border-border/50">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Icon className={`w-5 h-5 ${isPending ? "text-amber-500" : isNeedsInfo ? "text-amber-500" : "text-red-500"}`} />
              <CardTitle>{heading}</CardTitle>
            </div>
            <CardDescription>{status.name}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isPending && (
              <p className="text-sm text-muted-foreground">
                {t(
                  "Our team reviews new organizations, usually within 24–48 hours. You'll get access as soon as it's approved.",
                  "يقوم فريقنا بمراجعة المؤسسات الجديدة، عادةً خلال 24-48 ساعة. ستحصل على الوصول فور الموافقة.",
                )}
              </p>
            )}

            {(isNeedsInfo || isRejected) && status.reason && (
              <Alert variant={isRejected ? "destructive" : "default"}>
                <AlertDescription>
                  <span className="font-medium">{t("Reason:", "السبب:")}</span> {status.reason}
                </AlertDescription>
              </Alert>
            )}

            {isRejected && (
              <p className="text-sm text-muted-foreground">
                {t(
                  "If you believe this is a mistake, contact support to have your application reopened.",
                  "إذا كنت تعتقد أن هذا خطأ، تواصل مع الدعم لإعادة فتح طلبك.",
                )}
              </p>
            )}

            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

            {/* Documents */}
            <div className="border-t border-border pt-4 space-y-3">
              <h3 className="text-sm font-medium text-foreground">{t("Your documents", "مستنداتك")}</h3>
              {(docsData?.documents ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("No documents uploaded yet.", "لم يتم رفع أي مستندات بعد.")}</p>
              ) : (
                <ul className="space-y-1">
                  {docsData!.documents.map((d) => (
                    <li key={d.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <FileText className="w-3.5 h-3.5 shrink-0" />
                      <span className="text-foreground">{d.fileName}</span>
                      <span className="uppercase text-[10px] border border-border rounded px-1">{d.type.replace(/_/g, " ")}</span>
                      <span>{Math.ceil(d.sizeBytes / 1024)} KB</span>
                    </li>
                  ))}
                </ul>
              )}

              {canUpload && (
                <div className="space-y-2 pt-2">
                  <Label className="text-xs text-muted-foreground">{t("Upload a document (PDF, JPEG or PNG — max 10 MB)", "ارفع مستنداً (PDF أو JPEG أو PNG — 10 ميجابايت كحد أقصى)")}</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className="h-8 text-sm rounded-md border border-input bg-background px-2"
                      value={docType}
                      onChange={(e) => setDocType(e.target.value)}
                    >
                      {DOC_TYPES.map((ty) => (
                        <option key={ty} value={ty}>{ty.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                    <input
                      type="file"
                      accept="application/pdf,image/jpeg,image/png"
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                      className="text-xs"
                    />
                    <Button size="sm" className="gap-1" disabled={!file || uploadMut.isPending} onClick={() => uploadMut.mutate()}>
                      <Upload className="w-3.5 h-3.5" />
                      {uploadMut.isPending ? t("Uploading…", "جارٍ الرفع…") : t("Upload", "رفع")}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {isNeedsInfo && (
              <div className="border-t border-border pt-4">
                <Button className="w-full" disabled={resubmitMut.isPending} onClick={() => resubmitMut.mutate()}>
                  {resubmitMut.isPending ? t("Resubmitting…", "جارٍ إعادة الإرسال…") : t("Resubmit for review", "إعادة الإرسال للمراجعة")}
                </Button>
                <p className="text-[11px] text-muted-foreground mt-2 text-center">
                  {t("Upload the requested documents first, then resubmit.", "ارفع المستندات المطلوبة أولاً، ثم أعد الإرسال.")}
                </p>
              </div>
            )}

            <div className="border-t border-border pt-4 text-center">
              <button onClick={() => logout().then(() => (window.location.href = `${import.meta.env.BASE_URL}login`))} className="text-xs text-muted-foreground hover:text-foreground">
                {t("Sign out", "تسجيل الخروج")}
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
