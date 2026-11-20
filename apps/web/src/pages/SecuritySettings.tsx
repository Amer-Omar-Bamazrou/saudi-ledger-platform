/**
 * 🔴 Phase 19A (19.7, owner approval 2026-11-17) — Security Settings, for an organization's admins: two-step
 * verification for everyone, the session lifetime and the idle timeout, each inside the platform's limits. A change
 * that makes the organization stricter applies at once; one that makes it looser, where a second admin exists, is held
 * for that admin — the card below shows it, and the server (and the database) decide who may approve. The page names
 * this as the platform's own internal control, never as a regulator's requirement.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetOrgSecuritySettingsQueryKey, useGetOrgSecuritySettings, type OrgSecuritySettings, type OrgSecuritySettingsChangeResult,
} from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DualDate } from "@/components/DualDate";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { businessInstant, fmtCount } from "@/lib/businessTime";

function Summary({ s }: { s: OrgSecuritySettings }) {
  const { t } = useLanguage();
  return (
    <ul className="text-sm text-foreground space-y-0.5">
      <li>{t("Two-step verification", "التحقق بخطوتين")}: {s.mfaRequiredForAll ? t("everyone", "للجميع") : t("admins only", "للمسؤولين فقط")}</li>
      <li>{t(`Session lifetime: ${fmtCount(s.sessionLifetimeHours)} hours`, `مدة الجلسة: ${fmtCount(s.sessionLifetimeHours)} ساعة`)}</li>
      <li>{t(`Idle timeout: ${fmtCount(s.idleTimeoutMinutes)} minutes`, `مهلة الخمول: ${fmtCount(s.idleTimeoutMinutes)} دقيقة`)}</li>
    </ul>
  );
}

export default function SecuritySettings() {
  const { t } = useLanguage();
  const { user, isOrgAdmin } = useAuth();
  const orgId = user?.organizationId ?? "";
  const qc = useQueryClient();
  const view = useGetOrgSecuritySettings(orgId, { query: { enabled: isOrgAdmin && !!orgId, queryKey: getGetOrgSecuritySettingsQueryKey(orgId) } });
  const [form, setForm] = useState<OrgSecuritySettings | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (view.data) setForm(view.data.settings); }, [view.data]);

  const send = async (path: string, body: unknown, done: (r: OrgSecuritySettingsChangeResult) => string) => {
    setError(""); setNotice(""); setBusy(true);
    try {
      const r = await apiFetch<OrgSecuritySettingsChangeResult>(path, { method: "PUT", body: JSON.stringify(body) });
      setNotice(done(r));
      await qc.invalidateQueries({ queryKey: getGetOrgSecuritySettingsQueryKey(orgId) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const save = () => form && send(`/orgs/${orgId}/security-settings`, form, (r) =>
    r.held
      ? t("This change makes the settings weaker, so it waits for a second admin's approval. Nothing has changed yet.", "هذا التغيير يُضعف الإعدادات، لذا ينتظر اعتماد مسؤول ثانٍ. لم يتغير شيء بعد.")
      : r.applied ? t("Saved.", "تم الحفظ.") : t("Nothing to change.", "لا يوجد ما يتغير."));
  const decide = (changeId: string, decision: "approve" | "reject") =>
    send(`/orgs/${orgId}/security-settings/changes/${changeId}/decision`, { decision }, () =>
      decision === "approve" ? t("Approved. The settings changed.", "تم الاعتماد. تغيّرت الإعدادات.") : t("Rejected. Nothing changed.", "تم الرفض. لم يتغير شيء."));

  if (!isOrgAdmin) {
    return (
      <div className="max-w-2xl space-y-3">
        <h1 className="text-2xl font-semibold text-foreground">{t("Security Settings", "إعدادات الأمان")}</h1>
        <Alert><AlertDescription data-testid="security-settings-admin-only">{t("Only an admin of this organization sees or changes its security settings.", "لا يطّلع على إعدادات أمان هذه المنشأة أو يغيّرها إلا مسؤول فيها.")}</AlertDescription></Alert>
      </div>
    );
  }

  const bounds = view.data?.bounds;
  const pending = view.data?.pendingChange ?? null;
  const mine = pending?.requestedBy.id === user?.id;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t("Security Settings", "إعدادات الأمان")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "Your organization can be stricter than the platform, never looser. Making a setting weaker needs a second admin where there is one. These are internal controls of this platform, not ZATCA, SOCPA or IFRS requirements.",
            "يمكن لمنشأتك أن تكون أكثر تشدداً من المنصة لا أقل. إضعاف أي إعداد يحتاج إلى مسؤول ثانٍ إن وُجد. هذه ضوابط رقابة داخلية في المنصة وليست من متطلبات هيئة الزكاة أو SOCPA أو IFRS.",
          )}
        </p>
      </div>

      {pending && (
        <Card className="border-border bg-card" data-testid="security-settings-pending">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("A change is waiting for a second admin", "تغيير بانتظار مسؤول ثانٍ")}</CardTitle>
            <CardDescription>
              {t("Asked for by", "طلبه")} <span dir="auto">{pending.requestedBy.name}</span> · <DualDate date={businessInstant(pending.requestedAt).date} />
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div><div className="text-xs text-muted-foreground mb-1">{t("Now", "الآن")}</div><Summary s={pending.before} /></div>
              <div data-testid="security-settings-pending-after"><div className="text-xs text-muted-foreground mb-1">{t("Asked for", "المطلوب")}</div><Summary s={pending.after} /></div>
            </div>
            <div className="flex flex-wrap gap-2">
              {!mine && (
                <Button disabled={busy} onClick={() => decide(pending.id, "approve")} data-testid="security-settings-approve">{t("Approve", "اعتماد")}</Button>
              )}
              <Button variant="outline" disabled={busy} onClick={() => decide(pending.id, "reject")} data-testid="security-settings-reject">
                {mine ? t("Withdraw my request", "سحب طلبي") : t("Reject", "رفض")}
              </Button>
            </div>
            {mine && (
              <p className="text-sm text-muted-foreground" data-testid="security-settings-own-request">
                {t("You asked for this change, so another admin approves it.", "أنت من طلب هذا التغيير، فيعتمده مسؤول آخر.")}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="border-border bg-card" data-testid="security-settings-form">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("This organization", "هذه المنشأة")}</CardTitle>
          <CardDescription>
            {view.data && t(`Admins who can decide: ${fmtCount(view.data.usableAdmins)}`, `المسؤولون القادرون على البت: ${fmtCount(view.data.usableAdmins)}`)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {view.isLoading || !form ? (
            <p className="text-sm text-muted-foreground">{view.isError ? t("The settings could not be loaded.", "تعذّر تحميل الإعدادات.") : t("Loading…", "جارٍ التحميل…")}</p>
          ) : (
            <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input type="checkbox" className="mt-1" checked={form.mfaRequiredForAll} data-testid="setting-mfa-all"
                  onChange={(e) => setForm({ ...form, mfaRequiredForAll: e.target.checked })} />
                <span>
                  {t("Require two-step verification for everyone", "اشتراط التحقق بخطوتين للجميع")}
                  <span className="block text-xs text-muted-foreground">
                    {t("Admins always need it. With this on, every member sets it up at their next sign-in.", "المسؤولون يحتاجون إليه دائماً. عند تفعيله يُعِدّه كل عضو عند دخوله التالي.")}
                  </span>
                </span>
              </label>
              <div className="space-y-1">
                <Label htmlFor="setting-lifetime">{t("Session lifetime (hours)", "مدة الجلسة (بالساعات)")}</Label>
                <Input id="setting-lifetime" type="number" dir="ltr" className="max-w-[8rem]" data-testid="setting-lifetime"
                  min={bounds?.sessionLifetimeHours.min} max={bounds?.sessionLifetimeHours.max} value={form.sessionLifetimeHours}
                  onChange={(e) => setForm({ ...form, sessionLifetimeHours: Number(e.target.value) })} />
                <p className="text-xs text-muted-foreground">
                  {bounds && t(
                    `From sign-in, whatever the activity. ${fmtCount(bounds.sessionLifetimeHours.min)} to ${fmtCount(bounds.sessionLifetimeHours.max)}; ${fmtCount(bounds.sessionLifetimeHours.max)} is the platform's limit.`,
                    `من تسجيل الدخول أياً كان النشاط. من ${fmtCount(bounds.sessionLifetimeHours.min)} إلى ${fmtCount(bounds.sessionLifetimeHours.max)}؛ و${fmtCount(bounds.sessionLifetimeHours.max)} حدّ المنصة.`,
                  )}
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="setting-idle">{t("Idle timeout (minutes)", "مهلة الخمول (بالدقائق)")}</Label>
                <Input id="setting-idle" type="number" dir="ltr" className="max-w-[8rem]" data-testid="setting-idle"
                  min={bounds?.idleTimeoutMinutes.min} max={bounds?.idleTimeoutMinutes.max} value={form.idleTimeoutMinutes}
                  onChange={(e) => setForm({ ...form, idleTimeoutMinutes: Number(e.target.value) })} />
                <p className="text-xs text-muted-foreground">
                  {bounds && t(
                    `Without a request. ${fmtCount(bounds.idleTimeoutMinutes.min)} to ${fmtCount(bounds.idleTimeoutMinutes.max)}; ${fmtCount(bounds.idleTimeoutMinutes.max)} is the platform's limit.`,
                    `دون أي طلب. من ${fmtCount(bounds.idleTimeoutMinutes.min)} إلى ${fmtCount(bounds.idleTimeoutMinutes.max)}؛ و${fmtCount(bounds.idleTimeoutMinutes.max)} حدّ المنصة.`,
                  )}
                </p>
              </div>
              {error && <Alert variant="destructive"><AlertDescription data-testid="security-settings-error">{error}</AlertDescription></Alert>}
              {notice && <Alert><AlertDescription data-testid="security-settings-notice">{notice}</AlertDescription></Alert>}
              <Button type="submit" disabled={busy || !!pending} data-testid="security-settings-save">{t("Save", "حفظ")}</Button>
              {pending && <p className="text-xs text-muted-foreground">{t("Decide the waiting change first.", "ابتّ في التغيير المنتظر أولاً.")}</p>}
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
