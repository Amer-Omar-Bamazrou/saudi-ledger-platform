/**
 * 🔴 Phase 19A (19.1/19.3) — Two-Step Verification, in the Security menu: whether it is on, whether the caller's role
 * requires it, how many recovery codes are left, and — where it is off — setting it up. Replacing a factor that is on
 * is a reset, done by the platform after verifying identity; this page says so rather than offering a control.
 */
import { useQueryClient } from "@tanstack/react-query";
import { getGetMfaStatusQueryKey, useGetMfaStatus } from "@workspace/api-client-react";
import { MfaEnrolment } from "@/components/mfa/MfaEnrolment";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DualDate } from "@/components/DualDate";
import { useLanguage } from "@/contexts/LanguageContext";
import { businessInstant, fmtCount } from "@/lib/businessTime";

export default function SecurityTwoStep() {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const status = useGetMfaStatus();
  const s = status.data;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t("Two-Step Verification", "التحقق بخطوتين")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "After your password, a six-digit code from an authenticator app on your phone. A password alone then opens nothing.",
            "بعد كلمة المرور، رمز من ستة أرقام من تطبيق مصادقة على هاتفك. عندها لا تفتح كلمة المرور وحدها شيئاً.",
          )}
        </p>
      </div>

      <Card className="border-border bg-card" data-testid="two-step-status">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex flex-wrap items-center gap-2">
            {t("Status", "الحالة")}
            {s && (
              <Badge variant={s.state === "active" ? "default" : "secondary"} data-testid="two-step-state">
                {s.state === "active" ? t("On", "مفعَّل") : t("Off", "غير مفعَّل")}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {s?.required
              ? t("Required for your role (platform operators and organization admins).", "مطلوب لدورك (مشغّلو المنصة ومسؤولو المنشآت).")
              : t("Optional for your role. Recommended.", "اختياري لدورك. يُنصح به.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {status.isLoading ? (
            <p className="text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : status.isError || !s ? (
            <p className="text-destructive">{t("The status could not be loaded.", "تعذّر تحميل الحالة.")}</p>
          ) : s.state === "active" ? (
            <>
              {s.activatedAt && (
                <p className="text-foreground">
                  {t("Turned on", "فُعِّل في")}: <DualDate date={businessInstant(s.activatedAt).date} />
                </p>
              )}
              <p className="text-foreground" data-testid="two-step-codes-left">
                {t(`Recovery codes left: ${fmtCount(s.recoveryCodesLeft)}`, `رموز الاسترداد المتبقية: ${fmtCount(s.recoveryCodesLeft)}`)}
              </p>
              <p className="text-muted-foreground">
                {t(
                  "To move to a new phone, or if you have no recovery codes left, the platform resets two-step verification after verifying your identity. Contact support.",
                  "للانتقال إلى هاتف جديد، أو إذا لم يبقَ لديك رموز استرداد، تعيد المنصة تعيين التحقق بخطوتين بعد التحقق من هويتك. تواصل مع الدعم.",
                )}
              </p>
            </>
          ) : (
            <MfaEnrolment onDone={() => qc.invalidateQueries({ queryKey: getGetMfaStatusQueryKey() })} />
          )}
          {s?.lastResetAt && (
            <Alert data-testid="two-step-last-reset">
              <AlertDescription>
                {s.lastResetBy === "admin"
                  ? t("An admin of your organization reset two-step verification on this account on", "أعاد مسؤول في منشأتك تعيين التحقق بخطوتين لهذا الحساب في")
                  : t("The platform reset two-step verification on this account on", "أعادت المنصة تعيين التحقق بخطوتين لهذا الحساب في")}{" "}
                <DualDate date={businessInstant(s.lastResetAt).date} />.{" "}
                {t("If you did not ask for it, contact the platform.", "إن لم تطلب ذلك فتواصل مع المنصة.")}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
