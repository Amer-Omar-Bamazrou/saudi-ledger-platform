/**
 * 🔴 Phase 19A (19.4/19.5, owner approval 2026-11-17) — Session Management: the user's own active sessions, ending one
 * or all the others; and, for an admin, the sessions of the accounts they administer, ending all of one member's.
 * The server authorizes every list and act (services/sessions.service.ts); this page only decides what to show. An
 * ended session's next request is refused, so it is gone from every device at once.
 */
import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListMemberSessionsQueryKey, getListMySessionsQueryKey, useEndMemberSessions, useEndMyOtherSessions, useEndMySession,
  useListMemberSessions, useListMySessions, type MemberSessionRecord,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SessionRows } from "@/components/sessions/SessionRows";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { fmtCount } from "@/lib/businessTime";

export default function SecuritySessions() {
  const { t } = useLanguage();
  const { isOrgAdmin, user } = useAuth();
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: getListMySessionsQueryKey() });
    qc.invalidateQueries({ queryKey: getListMemberSessionsQueryKey() });
  };

  const mine = useListMySessions();
  const endOne = useEndMySession({ mutation: { onSuccess: refresh } });
  const endOthers = useEndMyOtherSessions({ mutation: { onSuccess: refresh } });
  const members = useListMemberSessions({ query: { enabled: isOrgAdmin, queryKey: getListMemberSessionsQueryKey() } });
  const endMember = useEndMemberSessions({ mutation: { onSuccess: refresh } });

  const own = mine.data?.sessions ?? [];
  const others = own.filter((s) => !s.current).length;
  const byMember = useMemo(() => {
    const groups = new Map<number, MemberSessionRecord[]>();
    // the admin's own sessions are listed (and ended one by one) above, never here as "all their sessions"
    for (const s of (members.data?.sessions ?? []).filter((x) => x.user.id !== user?.id)) groups.set(s.user.id, [...(groups.get(s.user.id) ?? []), s]);
    return [...groups.values()];
  }, [members.data, user?.id]);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t("Session Management", "إدارة الجلسات")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "Every place you are signed in. Ending a session signs that device out at its next request.",
            "كل مكان سجّلت الدخول منه. إنهاء الجلسة يُخرج ذلك الجهاز عند طلبه التالي.",
          )}
        </p>
      </div>

      <Card className="border-border bg-card" data-testid="my-sessions">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {t("Your sessions", "جلساتك")}
            <span className="text-muted-foreground font-normal" data-testid="my-sessions-count"> · {fmtCount(own.length)}</span>
          </CardTitle>
          <CardDescription>
            {t("To end the session you are using now, sign out.", "لإنهاء الجلسة التي تستخدمها الآن، سجّل الخروج.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {mine.isLoading ? (
            <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : mine.isError ? (
            <p className="text-sm text-destructive">{t("Your sessions could not be loaded.", "تعذّر تحميل جلساتك.")}</p>
          ) : (
            <SessionRows sessions={own} testIdPrefix="my-session" ending={endOne.isPending}
              onEnd={(sessionId) => endOne.mutate({ sessionId })} />
          )}
          {others > 0 && (
            <Button variant="outline" disabled={endOthers.isPending} onClick={() => endOthers.mutate()} data-testid="end-other-sessions">
              {t(`End all other sessions (${fmtCount(others)})`, `إنهاء جميع الجلسات الأخرى (${fmtCount(others)})`)}
            </Button>
          )}
        </CardContent>
      </Card>

      {isOrgAdmin && (
        <Card className="border-border bg-card" data-testid="member-sessions">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("Members' sessions", "جلسات الأعضاء")}</CardTitle>
            <CardDescription>
              {t(
                "The active sessions of the people whose accounts you administer. An account that also belongs to another organization is not listed: its sessions are not yours to end.",
                "الجلسات النشطة للأشخاص الذين تدير حساباتهم. لا يظهر الحساب المنتمي أيضاً إلى منشأة أخرى، فإنهاء جلساته ليس من صلاحيتك.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {members.isLoading ? (
              <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
            ) : members.isError ? (
              <p className="text-sm text-destructive">{t("The members' sessions could not be loaded.", "تعذّر تحميل جلسات الأعضاء.")}</p>
            ) : byMember.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("No active sessions.", "لا توجد جلسات نشطة.")}</p>
            ) : (
              byMember.map((group) => {
                const who = group[0]!.user;
                return (
                  <div key={who.id} className="rounded-md border border-border p-3 space-y-2" data-testid={`member-${who.id}`}>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground" dir="auto">{who.name}</div>
                        <div className="text-xs text-muted-foreground wrap-anywhere" dir="ltr" data-testid="member-email">{who.email}</div>
                      </div>
                      <Button
                        variant="outline" size="sm" className="self-start sm:self-center shrink-0"
                        disabled={endMember.isPending} onClick={() => endMember.mutate({ userId: who.id })}
                        data-testid={`end-member-sessions-${who.id}`}
                      >
                        {t(`End all their sessions (${fmtCount(group.length)})`, `إنهاء جميع جلساته (${fmtCount(group.length)})`)}
                      </Button>
                    </div>
                    <SessionRows sessions={group} testIdPrefix={`member-session-${who.id}`} />
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
