/**
 * 🔴 Phase 19A (19.4) — one person's sessions as a list: the device (a coarse "browser · system", never the
 * user-agent), the sign-in IP, when it was opened and last seen (the business clock, Asia/Riyadh), and the session
 * making the request marked. Laid out to stack at 390 px. Used by the Session Management page and the operator panel.
 */
import type { SessionRecord } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DualDate } from "@/components/DualDate";
import { businessInstant } from "@/lib/businessTime";
import { useLanguage } from "@/contexts/LanguageContext";

const KIND: Record<string, [string, string]> = {
  sign_in: ["Signed in", "تسجيل دخول"],
  signup: ["Signed up", "إنشاء حساب"],
  invitation: ["Accepted an invitation", "قبول دعوة"],
};

function When({ iso }: { iso: string }) {
  const at = businessInstant(iso);
  return (
    <span className="whitespace-nowrap">
      <DualDate date={at.date} /> · <span dir="ltr">{at.time}</span>
    </span>
  );
}

export function SessionRows({
  sessions, onEnd, ending, testIdPrefix,
}: {
  sessions: SessionRecord[];
  /** Offered for every session but the current one; omitted where nothing may be ended one by one. */
  onEnd?: (id: string) => void;
  ending?: boolean;
  testIdPrefix: string;
}) {
  const { t } = useLanguage();
  return (
    <ul className="divide-y divide-border">
      {sessions.map((s) => {
        const kind = KIND[s.kind];
        return (
          <li key={s.id} className="py-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between" data-testid={`${testIdPrefix}-${s.id}`}>
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground" dir="ltr">{s.client ?? t("Unknown device", "جهاز غير معروف")}</span>
                {s.current && (
                  <Badge variant="secondary" data-testid={`${testIdPrefix}-current`}>{t("This session", "هذه الجلسة")}</Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
                <span>{kind ? t(kind[0], kind[1]) : s.kind}: <When iso={s.createdAt} /></span>
                <span>{t("Last seen", "آخر نشاط")}: <When iso={s.lastSeenAt} /></span>
                {s.ipAddress && <span>{t("IP", "عنوان IP")}: <span dir="ltr" className="wrap-anywhere" data-testid="session-ip">{s.ipAddress}</span></span>}
              </div>
            </div>
            {onEnd && !s.current && (
              <Button
                variant="outline" size="sm" className="self-start sm:self-center shrink-0"
                disabled={ending} onClick={() => onEnd(s.id)} data-testid={`${testIdPrefix}-end-${s.id}`}
              >
                {t("End this session", "إنهاء هذه الجلسة")}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
