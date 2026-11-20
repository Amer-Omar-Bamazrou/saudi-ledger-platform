/**
 * 🔴 Phase 19A (19.3; owner, 2026-11-20) — the platform's reset of a person's two-step verification, the break-glass:
 * only when no admin of the person's organization can do it (the server refuses by name otherwise). The operator
 * confirms that the person's identity was verified and states the basis; both are recorded. The reset ends every
 * session of the account and its recovery codes, and the person sets a factor up again.
 */
import { useState } from "react";
import type { MfaResetResult } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/contexts/LanguageContext";
import { fmtCount } from "@/lib/businessTime";
import { refusalOf } from "@/lib/openingVatRefusals";

export function OperatorMfaResetCard() {
  const { t } = useLanguage();
  const [email, setEmail] = useState("");
  const [verified, setVerified] = useState(false);
  const [basis, setBasis] = useState("");
  const [result, setResult] = useState<MfaResetResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setResult(null); setBusy(true);
    try {
      setResult(await apiFetch<MfaResetResult>("/operator/users/mfa-reset", {
        method: "POST", body: JSON.stringify({ email: email.trim(), identityVerified: verified, basis: basis.trim() }),
      }));
      setEmail(""); setVerified(false); setBasis("");
    } catch (err) {
      setError(refusalOf(err).words);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-border bg-card" data-testid="operator-mfa-reset">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("Reset a person's two-step verification", "إعادة تعيين التحقق بخطوتين لشخص")}</CardTitle>
        <CardDescription>
          {t(
            "Only when no admin of the person's organization can do it (a sole admin, an account that also belongs to another organization, an organization not yet verified), and only after verifying the person's identity. It removes their factor and recovery codes and signs them out everywhere; they set it up again afterwards. For 30 days they cannot approve a held bank-detail change. Recorded with your name and the basis you state.",
            "فقط إذا لم يستطع ذلك أي مسؤول في منشأة الشخص (مسؤول وحيد، أو حساب ينتمي إلى منشأة أخرى أيضاً، أو منشأة لم تُوثَّق بعد)، وبعد التحقق من هوية الشخص فقط. تزيل عامل التحقق ورموز الاسترداد وتنهي جلساته كلها، ثم يُعِدّه من جديد. لا يستطيع اعتماد تغيير بيانات بنكية معلّق لمدة 30 يوماً. تُسجَّل باسمك وبالأساس الذي تذكره.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="mfa-reset-email">{t("Account email", "بريد الحساب")}</Label>
            <Input id="mfa-reset-email" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="mfa-reset-email" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mfa-reset-basis">{t("How the identity was verified", "كيف جرى التحقق من الهوية")}</Label>
            <Textarea id="mfa-reset-basis" rows={2} maxLength={500} value={basis} onChange={(e) => setBasis(e.target.value)} data-testid="mfa-reset-basis" />
          </div>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input type="checkbox" className="mt-1" checked={verified} onChange={(e) => setVerified(e.target.checked)} data-testid="mfa-reset-verified" />
            <span>{t("I verified this person's identity before this reset.", "تحققتُ من هوية هذا الشخص قبل إعادة التعيين.")}</span>
          </label>
          {error && <Alert variant="destructive"><AlertDescription data-testid="mfa-reset-error">{error}</AlertDescription></Alert>}
          {result && (
            <Alert data-testid="mfa-reset-result">
              <AlertDescription>
                {t(
                  `Reset. ${fmtCount(result.sessionsEnded)} session(s) ended, ${fmtCount(result.recoveryCodesInvalidated)} recovery code(s) invalidated.`,
                  `تمت إعادة التعيين. أُنهيت ${fmtCount(result.sessionsEnded)} جلسة وأُبطل ${fmtCount(result.recoveryCodesInvalidated)} رمز استرداد.`,
                )}{" "}
                {result.notified === "email_and_next_sign_in"
                  ? t("The person was told by email, and will see it at their next sign-in.", "أُبلغ الشخص بالبريد، وسيراه عند دخوله التالي.")
                  : t("No mail provider is configured: the person will see it at their next sign-in. Tell them yourself as well.", "لا يوجد مزوّد بريد: سيراه الشخص عند دخوله التالي. أبلغه بنفسك أيضاً.")}
              </AlertDescription>
            </Alert>
          )}
          <Button type="submit" variant="outline" disabled={busy || !verified || basis.trim().length < 10 || !email.trim()} data-testid="mfa-reset-submit">
            {t("Reset two-step verification", "إعادة تعيين التحقق بخطوتين")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
