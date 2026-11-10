/**
 * 🔴 Phase 18 audit A2 — DR-27's "tenant-visible audit", on the Users page: the organization's security events
 * (sign-ins, invitations, membership and role changes, password resets — an operator's break-glass reset with the
 * operator redacted), newest first, a page at a time, with the organization's total.
 *
 * The trail was recorded and served by `GET /orgs/:orgId/security-events` and no screen read it, so no tenant user
 * could see any of it. The server answers only an admin of THIS organization; the page renders this card only for
 * one. The count always names the true total, so a page is never mistaken for the whole trail.
 */
import { useState } from "react";
import { useListOrgSecurityEvents, type SecurityEvent } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DualDate } from "@/components/DualDate";
import { useLanguage } from "@/contexts/LanguageContext";

const PAGE_SIZE = 25;

/** The identity layer's event codes, in both languages. An unknown code is shown as itself, never hidden. */
const ACTION_LABEL: Record<string, [string, string]> = {
  "auth.login": ["Signed in", "تسجيل دخول"],
  "auth.login_failed": ["Failed sign-in", "محاولة دخول فاشلة"],
  "auth.logout": ["Signed out", "تسجيل خروج"],
  "invite.sent": ["Invitation sent", "إرسال دعوة"],
  "invite.resent": ["Invitation sent again", "إعادة إرسال دعوة"],
  "invite.revoked": ["Invitation revoked", "إلغاء دعوة"],
  "invite.accepted": ["Invitation accepted", "قبول دعوة"],
  "membership.assigned": ["Role assigned", "تعيين دور"],
  "membership.role_changed": ["Role changed", "تغيير الدور"],
  "membership.status_changed": ["Membership status changed", "تغيير حالة العضوية"],
  "membership.removed": ["Member removed", "إزالة عضو"],
  "user.created": ["User created", "إنشاء مستخدم"],
  "user.role_changed": ["User role changed", "تغيير دور المستخدم"],
  "user.deactivated": ["User deactivated", "تعطيل مستخدم"],
  "user.reactivated": ["User reactivated", "إعادة تفعيل مستخدم"],
  "user.password_reset": ["Password reset by an admin", "إعادة تعيين كلمة المرور من مسؤول"],
  "user.password_changed": ["Password changed", "تغيير كلمة المرور"],
  "user.password_breakglass_reset": ["Password reset by the platform operator", "إعادة تعيين كلمة المرور من مشغّل المنصة"],
  "signup.completed": ["Sign-up completed", "إتمام التسجيل"],
  "verification.document_uploaded": ["Verification document uploaded", "رفع مستند تحقق"],
  "verification.resubmitted": ["Verification resubmitted", "إعادة تقديم طلب التحقق"],
  "verification.approved": ["Verification approved", "اعتماد التحقق"],
  "verification.rejected": ["Verification rejected", "رفض التحقق"],
  "verification.needs_info": ["More information requested", "طلب معلومات إضافية"],
  "verification.reopened": ["Verification reopened", "إعادة فتح التحقق"],
  "verification.application_viewed": ["Application viewed by the platform operator", "اطلاع مشغّل المنصة على الطلب"],
  "verification.document_viewed": ["Verification document viewed by the platform operator", "اطلاع مشغّل المنصة على مستند التحقق"],
  "account.operator_target_refused": ["Refused: the account is a platform operator", "رُفض: الحساب لمشغّل المنصة"],
  "reference.refused": ["Refused: a reference to another organization", "رُفض: مرجع إلى منشأة أخرى"],
};

export function SecurityEventsCard({ orgId, nameOf }: { orgId: string; nameOf: (userId: number) => string | undefined }) {
  const { t } = useLanguage();
  const [offset, setOffset] = useState(0);
  const page = useListOrgSecurityEvents(orgId, { limit: PAGE_SIZE, offset });
  const events = page.data?.events ?? [];
  const total = page.data?.total ?? 0;

  const label = (e: SecurityEvent) => {
    const known = ACTION_LABEL[e.action];
    return known ? t(known[0], known[1]) : e.action;
  };
  const actor = (e: SecurityEvent) => {
    if (e.actorEmail) return e.actorEmail;
    if (e.metadata && (e.metadata as Record<string, unknown>).by === "platform_operator") return t("Platform operator", "مشغّل المنصة");
    return "—";
  };
  const concerning = (e: SecurityEvent) => {
    if (e.targetUserId != null) return nameOf(e.targetUserId) ?? t(`User #${e.targetUserId}`, `المستخدم رقم ${e.targetUserId}`);
    const email = e.metadata ? (e.metadata as Record<string, unknown>).email : undefined;
    return typeof email === "string" ? email : null;
  };

  return (
    <Card className="border-border bg-card" data-testid="security-events">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          {t("Security events", "سجل الأمان")}
          <span className="text-muted-foreground font-normal" data-testid="security-events-count"> · {total.toLocaleString()}</span>
        </CardTitle>
        <CardDescription>
          {t(
            "Sign-ins, invitations, role changes and password resets in this organization, newest first. A reset by the platform operator is shown without the operator's identity.",
            "عمليات الدخول والدعوات وتغييرات الأدوار وإعادة تعيين كلمات المرور في هذه المنشأة، الأحدث أولاً. تظهر إعادة التعيين من مشغّل المنصة دون هويته.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {page.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
        ) : page.isError ? (
          <p className="text-sm text-destructive">{t("The security events could not be loaded.", "تعذّر تحميل سجل الأمان.")}</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("No security events yet.", "لا توجد أحداث أمان بعد.")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {events.map((e) => {
              const whom = concerning(e);
              return (
                <li key={e.id} className="py-2 space-y-0.5" data-testid={`security-event-${e.id}`} data-action={e.action}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">{label(e)}</span>
                    <span className="text-xs text-muted-foreground">
                      <DualDate date={e.createdAt.slice(0, 10)} />
                      <span className="ms-1" dir="ltr">{e.createdAt.slice(11, 16)}</span>
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground break-all">
                    {t("By", "بواسطة")} <span dir="ltr">{actor(e)}</span>
                    {whom && <> · {t("Concerning", "بشأن")} <span dir="auto">{whom}</span></>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {total > PAGE_SIZE && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <span className="text-xs text-muted-foreground">
              {t("Showing", "عرض")} {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} {t("of", "من")} {total.toLocaleString()}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                {t("Newer", "الأحدث")}
              </Button>
              <Button size="sm" variant="outline" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
                {t("Older", "الأقدم")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
