/**
 * 🔴 Phase 19A (19.7) — the platform's own security limits, on the operator surface: what no organization can loosen.
 * READ-ONLY by design: these are the platform's floor, set in code and in the database's CHECKs (0167) and by
 * `MFA_ENFORCEMENT` at boot — changing one is a reviewed deployment change, not a control on a page. An organization's
 * own settings (which can only be stricter) are on its Security Settings page.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";

export function PlatformSecurityCard() {
  const { t } = useLanguage();
  const rows: [string, string][] = [
    [t("Two-step verification", "التحقق بخطوتين"), t("Required for platform operators and every organization admin", "مطلوب لمشغّلي المنصة ولكل مسؤول منشأة")],
    [t("Session lifetime", "مدة الجلسة"), t("At most 12 hours from sign-in", "12 ساعة على الأكثر من تسجيل الدخول")],
    [t("Idle timeout", "مهلة الخمول"), t("At most 8 hours without a request", "8 ساعات على الأكثر دون أي طلب")],
    [t("Code attempts", "محاولات الرمز"), t("5 wrong codes per account in 15 minutes", "5 رموز خاطئة لكل حساب خلال 15 دقيقة")],
    [t("Factor reset", "إعادة تعيين العامل"), t("Platform operators only, after verifying identity", "مشغّلو المنصة فقط، بعد التحقق من الهوية")],
  ];
  return (
    <Card className="border-border bg-card" data-testid="platform-security">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("Platform security limits", "حدود أمان المنصة")}</CardTitle>
        <CardDescription>
          {t(
            "What no organization can loosen. An organization can only be stricter. Read-only here: changing a limit is a deployment change.",
            "ما لا تستطيع أي منشأة تخفيفه؛ للمنشأة أن تكون أكثر تشدداً فقط. للقراءة فقط هنا: تغيير أي حدّ تغيير في النشر.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="py-2 flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
