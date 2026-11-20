/**
 * 🔴 Phase 19A (19.1/19.2/19.3) — what a sign-in lands on while the session still owes its second factor: the CODE
 * step (or a recovery code in its place), or ENROLMENT where the role requires a factor and the account has none.
 * Shown on its own, like the owed password change: until the step is done the server answers everything else 403.
 */
import { useState } from "react";
import type { MfaVerified } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { MfaEnrolment } from "@/components/mfa/MfaEnrolment";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SecondFactor({ step }: { step: "code" | "enrol" }) {
  const { t } = useLanguage();
  const { user, refetch, logout } = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      await apiFetch<MfaVerified>(useRecovery ? "/auth/mfa/recovery" : "/auth/mfa/verify", { method: "POST", body: JSON.stringify({ code: code.trim() }) });
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-md space-y-4" data-testid={step === "code" ? "mfa-code-step" : "mfa-enrol-step"}>
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-lg">
            {step === "code" ? t("Two-step verification", "التحقق بخطوتين") : t("Set up two-step verification", "إعداد التحقق بخطوتين")}
          </CardTitle>
          <CardDescription>
            {step === "code"
              ? t("Your password was accepted. Enter the code from your authenticator app to finish signing in.", "قُبلت كلمة مرورك. أدخل الرمز من تطبيق المصادقة لإكمال تسجيل الدخول.")
              : t(
                  "Your role requires two-step verification. Set it up to continue — until then, nothing else opens.",
                  "دورك يتطلب التحقق بخطوتين. أكمل إعداده للمتابعة — لن يُفتح أي شيء آخر قبل ذلك.",
                )}
            {user?.email && <span className="block mt-1" dir="ltr">{user.email}</span>}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === "enrol" ? (
            <MfaEnrolment onDone={refetch} />
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="mfa-code">{useRecovery ? t("Recovery code", "رمز الاسترداد") : t("Six-digit code", "الرمز المكوّن من ستة أرقام")}</Label>
                <Input
                  id="mfa-code" dir="ltr" className="font-mono tracking-widest" autoFocus autoComplete="one-time-code"
                  inputMode={useRecovery ? "text" : "numeric"} maxLength={useRecovery ? 11 : 6} value={code}
                  onChange={(e) => setCode(useRecovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ""))}
                  data-testid="mfa-code"
                />
              </div>
              {error && <Alert variant="destructive"><AlertDescription data-testid="mfa-error">{error}</AlertDescription></Alert>}
              <Button type="submit" className="w-full" disabled={busy || code.trim().length < (useRecovery ? 11 : 6)} data-testid="mfa-submit">
                {t("Verify", "تحقق")}
              </Button>
              <button
                type="button" className="text-sm text-primary underline-offset-2 hover:underline"
                onClick={() => { setUseRecovery(!useRecovery); setCode(""); setError(""); }} data-testid="mfa-toggle-recovery"
              >
                {useRecovery ? t("Use the code from my app instead", "استخدام رمز التطبيق بدلاً من ذلك") : t("I lost my phone: use a recovery code", "فقدتُ هاتفي: استخدام رمز استرداد")}
              </button>
              <p className="text-xs text-muted-foreground">
                {t(
                  "No phone and no recovery code? The platform can reset two-step verification after verifying your identity. Contact support.",
                  "لا هاتف ولا رمز استرداد؟ تستطيع المنصة إعادة تعيين التحقق بخطوتين بعد التحقق من هويتك. تواصل مع الدعم.",
                )}
              </p>
            </form>
          )}
        </CardContent>
      </Card>
      <Button variant="ghost" size="sm" onClick={() => void logout()} data-testid="mfa-sign-out">{t("Sign out", "تسجيل الخروج")}</Button>
    </div>
  );
}
