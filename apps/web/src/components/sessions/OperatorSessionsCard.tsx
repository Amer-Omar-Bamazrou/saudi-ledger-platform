/**
 * 🔴 Phase 19A (19.4/19.5) — the operator surface's sessions: platform operators' own active sessions (any but the
 * current one can be ended), and ending every session of an account by its email — the incident response that sits
 * beside the break-glass reset. Each act writes one security event (services/sessions.service.ts).
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListOperatorSessionsQueryKey, useListOperatorSessions, useOperatorEndSession, useOperatorEndUserSessions,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SessionRows } from "@/components/sessions/SessionRows";
import { useLanguage } from "@/contexts/LanguageContext";
import { fmtCount } from "@/lib/businessTime";

export function OperatorSessionsCard() {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: getListOperatorSessionsQueryKey() });
  const list = useListOperatorSessions();
  const endOne = useOperatorEndSession({ mutation: { onSuccess: refresh } });
  const [email, setEmail] = useState("");
  const endUser = useOperatorEndUserSessions({ mutation: { onSuccess: () => { setEmail(""); refresh(); } } });
  const sessions = list.data?.sessions ?? [];

  return (
    <Card className="border-border bg-card" data-testid="operator-sessions">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          {t("Sessions", "الجلسات")}
          <span className="text-muted-foreground font-normal"> · {fmtCount(sessions.length)}</span>
        </CardTitle>
        <CardDescription>
          {t(
            "Platform operators' active sessions. Ending a session signs that device out at its next request; every ending is recorded.",
            "الجلسات النشطة لمشغّلي المنصة. إنهاء الجلسة يُخرج ذلك الجهاز عند طلبه التالي، وكل إنهاء يُسجَّل.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {list.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
        ) : list.isError ? (
          <p className="text-sm text-destructive">{t("The sessions could not be loaded.", "تعذّر تحميل الجلسات.")}</p>
        ) : (
          <SessionRows sessions={sessions} testIdPrefix="operator-session" ending={endOne.isPending}
            onEnd={(sessionId) => endOne.mutate({ sessionId })} />
        )}
        <form
          className="space-y-2 border-t border-border pt-3"
          onSubmit={(e) => { e.preventDefault(); if (email.trim()) endUser.mutate({ data: { email: email.trim() } }); }}
        >
          <Label htmlFor="end-user-sessions-email">{t("End every session of an account", "إنهاء جميع جلسات حساب")}</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="end-user-sessions-email" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com" data-testid="end-user-sessions-email"
            />
            <Button type="submit" variant="outline" disabled={endUser.isPending || !email.trim()} data-testid="end-user-sessions">
              {t("End their sessions", "إنهاء جلساته")}
            </Button>
          </div>
          {endUser.data && (
            <p className="text-sm text-muted-foreground" data-testid="end-user-sessions-result">
              {t(`${fmtCount(endUser.data.ended)} session(s) ended.`, `أُنهيت ${fmtCount(endUser.data.ended)} جلسة.`)}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
