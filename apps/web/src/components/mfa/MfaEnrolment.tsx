/**
 * 🔴 Phase 19A (19.1/19.3) — setting up two-step verification: the QR and the key to type (shown ONCE — the server
 * never serves the secret again), one code to turn it on, then the recovery codes (shown ONCE) and a confirmation
 * that they were saved. Used by the sign-in gate (a role that requires a factor) and by the Security page.
 */
import { useState } from "react";
import type { MfaEnrolment as Enrolment, MfaRecoveryCodes } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/contexts/LanguageContext";

export function MfaEnrolment({ onDone }: { onDone: () => void | Promise<void> }) {
  const { t } = useLanguage();
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setError(""); setBusy(true);
    try { await fn(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  };
  const begin = () => run(async () => {
    setEnrolment(await apiFetch<Enrolment>("/auth/mfa/enrol", { method: "POST" }));
  });
  const activate = () => run(async () => {
    const out = await apiFetch<MfaRecoveryCodes>("/auth/mfa/activate", { method: "POST", body: JSON.stringify({ code: code.trim() }) });
    setCodes(out.recoveryCodes);
  });

  if (codes) {
    return (
      <div className="space-y-4" data-testid="mfa-recovery-codes">
        <Alert>
          <AlertDescription>
            {t(
              "Two-step verification is on. Save these recovery codes now: each works once, in place of a code, if you lose your phone. They are not shown again.",
              "تم تفعيل التحقق بخطوتين. احفظ رموز الاسترداد هذه الآن: كل رمز يعمل مرة واحدة بدلاً من الرمز إذا فقدت هاتفك. لن تُعرض مرة أخرى.",
            )}
          </AlertDescription>
        </Alert>
        <ul className="grid grid-cols-2 gap-2 font-mono text-sm" dir="ltr">
          {codes.map((c) => <li key={c} className="rounded border border-border bg-background px-2 py-1 text-center" data-testid="mfa-recovery-code">{c}</li>)}
        </ul>
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input type="checkbox" className="mt-1" checked={saved} onChange={(e) => setSaved(e.target.checked)} data-testid="mfa-codes-saved" />
          <span>{t("I have saved these codes somewhere safe.", "حفظتُ هذه الرموز في مكان آمن.")}</span>
        </label>
        <Button disabled={!saved} onClick={() => void onDone()} data-testid="mfa-enrol-done">{t("Continue", "متابعة")}</Button>
      </div>
    );
  }

  if (!enrolment) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t(
            "You need an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, or any app that reads a one-time-code QR).",
            "تحتاج إلى تطبيق مصادقة على هاتفك (Google Authenticator أو Microsoft Authenticator أو أي تطبيق يقرأ رمز QR للرموز المؤقتة).",
          )}
        </p>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <Button onClick={begin} disabled={busy} data-testid="mfa-enrol-begin">{t("Start set-up", "بدء الإعداد")}</Button>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void activate(); }}>
      <ol className="space-y-3 text-sm text-foreground list-decimal ps-5">
        <li>
          {t("Scan this code with your authenticator app, or type the key.", "امسح هذا الرمز بتطبيق المصادقة، أو اكتب المفتاح.")}
          <div className="mt-2 flex flex-col items-start gap-2">
            <img
              className="h-44 w-44 rounded bg-white p-1" alt={t("Set-up QR code", "رمز QR للإعداد")} data-testid="mfa-qr"
              src={`data:image/svg+xml;utf8,${encodeURIComponent(enrolment.qrSvg)}`}
            />
            <code className="block break-all rounded border border-border bg-background px-2 py-1 font-mono text-xs" dir="ltr" data-testid="mfa-secret">
              {enrolment.secret.replace(/(.{4})/g, "$1 ").trim()}
            </code>
          </div>
        </li>
        <li>
          <Label htmlFor="mfa-activate-code">{t("Enter the six-digit code the app shows.", "أدخل الرمز المكوّن من ستة أرقام الذي يعرضه التطبيق.")}</Label>
          <Input
            id="mfa-activate-code" className="mt-2 max-w-[12rem] font-mono tracking-widest" dir="ltr" inputMode="numeric" autoComplete="one-time-code"
            maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} data-testid="mfa-activate-code"
          />
        </li>
      </ol>
      {error && <Alert variant="destructive"><AlertDescription data-testid="mfa-error">{error}</AlertDescription></Alert>}
      <Button type="submit" disabled={busy || code.length !== 6} data-testid="mfa-activate">{t("Turn on two-step verification", "تفعيل التحقق بخطوتين")}</Button>
    </form>
  );
}
