/**
 * 🔴 CERTIFICATE RENEWAL — the tenant's own OTP (carry-over Batch 3, F-2; the owner, 2026-11-07).
 *
 * `POST /zatca/onboarding/renew` existed with no screen (the AC-13 standing check, F-2), so a certificate could only
 * be renewed by calling the API by hand — and a ZATCA certificate has NO grace period: at expiry, invoicing stops.
 * This card calls the EXISTING route through the generated client (`renewZatcaCertificate`).
 *
 * 🔴 The OTP is the TENANT's: they generate it in their own Fatoora portal. The platform cannot renew unattended,
 * and the OTP is never stored — it is sent once and cleared from the form.
 *
 * 🔴 The screen states what is verified: renewal is exercised only against ZATCA's SANDBOX (CLAUDE.md §2: the
 * production path has never been called). It says so on the card, not only in a record.
 *
 * Refusals are explained by their CODE (missing company details, a role that is not admin), with the server's own
 * sentence beneath.
 */
import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useRenewZatcaCertificate, type ZatcaRenewResult } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { RefreshCw, FlaskConical, CheckCircle2, XCircle } from "lucide-react";
import { fmtDate } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { refusalOf } from "@/lib/openingVatRefusals";

type T = (en: string, ar: string) => string;
type Refusal = { code: string | undefined; words: string; missing: string[] };

/** A refused renewal, explained by its code. */
export function renewalRefusalTitle(code: string | undefined, t: T): { title: string; next: string } {
  switch (code) {
    case "zatca_prerequisites_missing":
      return { title: t("Complete the company details first", "أكمل بيانات الشركة أولًا"), next: t("ZATCA needs them on every invoice. Nothing was sent, and the current certificate stays active.", "تشترطها الهيئة في كل فاتورة. لم يُرسَل شيء، وتبقى الشهادة الحالية سارية.") };
    case "zatca_otp_required":
      return { title: t("Paste the one-time password from your Fatoora portal", "الصق كلمة المرور المؤقتة من بوابة فاتورة"), next: "" };
    case "requires_approval_authority":
      return { title: t("Only an admin can renew the certificate", "تجديد الشهادة لمدير النظام فقط"), next: t("Ask an admin of this organization to renew it. The current certificate stays active.", "اطلب من مدير هذه المنشأة تجديدها. وتبقى الشهادة الحالية سارية.") };
    default:
      return { title: t("The renewal could not be completed", "تعذّر إتمام التجديد"), next: t("The current certificate stays active.", "تبقى الشهادة الحالية سارية.") };
  }
}

export function CertificateRenewal({ cert, labelOf }: {
  cert: { notAfter: string | null; egsSerialNumber: string | null };
  /** The page's own Arabic/English label for a prerequisite key. */
  labelOf: (key: string) => string;
}) {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"enter" | "confirm" | "done">("enter");
  const [result, setResult] = useState<ZatcaRenewResult | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Its own onError: the card explains the refusal itself (the shared toast would say it a second time).
  const renew = useRenewZatcaCertificate({ mutation: { onError: () => undefined } });

  const unit = cert.egsSerialNumber ?? t("this unit", "هذه الوحدة");
  const expires = cert.notAfter ? fmtDate(cert.notAfter) : t("an unknown date", "تاريخ غير معروف");
  const go = async () => {
    try {
      const r = await renew.mutateAsync({ data: { otp: otp.trim() } });
      setResult(r);
      setRefusal(null);
      void qc.invalidateQueries({ queryKey: ["zatca-onboarding"] });
    } catch (e) {
      const { code, words } = refusalOf(e);
      const missing = (e as { data?: { missing?: unknown } })?.data?.missing;
      setResult(null);
      setRefusal({ code, words, missing: Array.isArray(missing) ? missing.map(String) : [] });
    }
    setOtp(""); // the OTP is used once and never kept
    setStep("done");
  };
  const refused = refusal ? renewalRefusalTitle(refusal.code, t) : null;

  return (
    <Card data-testid="renewal-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><RefreshCw className="h-5 w-5" />{t("Renew the certificate", "تجديد الشهادة")}</CardTitle>
        <CardDescription>
          {t("Renewal needs a NEW one-time password that you generate in your own Fatoora portal — the platform cannot renew for you. The current certificate keeps signing until ZATCA issues the new one; the old one is kept, so invoices it signed stay verifiable.",
             "يتطلب التجديد كلمة مرور مؤقتة جديدة تُنشئها أنت من بوابة فاتورة الخاصة بك — لا تستطيع المنصة التجديد نيابة عنك. وتستمر الشهادة الحالية في التوقيع حتى تُصدر الهيئة الجديدة، ويُحتفظ بالقديمة لتبقى الفواتير الموقعة بها قابلة للتحقق.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert data-testid="renewal-sandbox-only">
          <FlaskConical className="h-4 w-4" />
          <AlertDescription>
            {t("Renewal is exercised only against ZATCA's sandbox. It has never been run against the simulation or production environment.",
               "التجديد مُختبَر على البيئة التجريبية للهيئة فقط، ولم يُشغَّل قط على بيئة المحاكاة أو بيئة الإنتاج.")}
          </AlertDescription>
        </Alert>

        {step === "enter" && (
          <div className="space-y-3">
            <div>
              <Label htmlFor="renewal-otp">{t("New OTP from Fatoora", "كلمة المرور المؤقتة الجديدة من فاتورة")}</Label>
              <Input id="renewal-otp" value={otp} onChange={(e) => setOtp(e.target.value)} autoComplete="off" inputMode="numeric" dir="ltr" data-testid="renewal-otp" />
            </div>
            <Button onClick={() => setStep("confirm")} disabled={!otp.trim()} data-testid="renewal-continue">{t("Continue", "متابعة")}</Button>
          </div>
        )}

        {step === "confirm" && (
          <div className="space-y-3">
            <p className="text-sm font-medium" data-testid="renewal-confirm-line">
              {t(`Renew the certificate of unit ${unit}, which expires ${expires}? It is replaced only if ZATCA issues the new one.`,
                 `تجديد شهادة الوحدة ${unit} التي تنتهي في ${expires}؟ لا تُستبدل إلا إذا أصدرت الهيئة الشهادة الجديدة.`)}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setStep("enter")} disabled={renew.isPending} data-testid="renewal-back">{t("Back", "رجوع")}</Button>
              <Button className="flex-1" onClick={() => void go()} disabled={renew.isPending} data-testid="renewal-confirm">
                {renew.isPending ? t("Renewing…", "جارٍ التجديد…") : t("Renew", "تجديد")}
              </Button>
            </div>
          </div>
        )}

        {step === "done" && refused && (
          <div className="space-y-2 rounded-lg border border-border p-3" role="alert" data-testid="renewal-refused" data-code={refusal?.code ?? ""}>
            <p className="font-medium text-sm">{refused.title}</p>
            {refusal && refusal.missing.length > 0 && (
              <ul className="text-sm list-disc ps-5" data-testid="renewal-missing">
                {refusal.missing.map((k) => <li key={k}>{labelOf(k)}</li>)}
              </ul>
            )}
            {refusal?.code === "zatca_prerequisites_missing" && (
              <p className="text-xs"><Link href="/company" className="underline">{t("Company Settings", "إعدادات الشركة")}</Link></p>
            )}
            {refused.next && <p className="text-xs">{refused.next}</p>}
            <p className="text-xs text-muted-foreground" dir="ltr">{refusal?.words}</p>
          </div>
        )}

        {step === "done" && result && (
          <div className="space-y-2 text-sm" data-testid="renewal-result" data-activated={String(result.activated)}>
            <p className="font-medium">
              {result.activated
                ? t(`Renewed. The new certificate expires ${result.certificateExpiresAt ? fmtDate(result.certificateExpiresAt) : "—"}.`, `جُدِّدت الشهادة. تنتهي الشهادة الجديدة في ${result.certificateExpiresAt ? fmtDate(result.certificateExpiresAt) : "—"}.`)
                : t("Not renewed: the compliance checks failed, so no new certificate was stored. The current one stays active.", "لم تُجدَّد: فشلت فحوص الامتثال، فلم تُحفظ شهادة جديدة. وتبقى الحالية سارية.")}
            </p>
            {result.complianceDocuments.map((d) => (
              <div key={d.label}>
                <div className="flex items-center gap-2">
                  {d.passed ? <CheckCircle2 className="h-4 w-4 text-positive" /> : <XCircle className="h-4 w-4 text-destructive" />}
                  <span>{d.label}</span>
                </div>
                {d.errors.map((e, i) => <div key={i} className="ms-6 text-destructive" dir="ltr">{e.code}: {e.message}</div>)}
              </div>
            ))}
          </div>
        )}

        {step === "done" && (
          <Button variant="outline" onClick={() => { setStep("enter"); setResult(null); setRefusal(null); }} data-testid="renewal-again">{t("Start again", "البدء من جديد")}</Button>
        )}
      </CardContent>
    </Card>
  );
}
