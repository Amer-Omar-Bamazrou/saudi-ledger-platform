/**
 * 🔴 G03 (owner D-4, 2026-10-20) — the last-admin refusal, in the reader's
 * language and keyed on the structured CODE (CLAUDE.md §3: "explain a refusal;
 * key the UI on the structured CODE, so rewording copy cannot break it").
 *
 * The server refuses (409 `last_admin_required`) any act that would leave an
 * organisation with no admin who can sign in. On the Users screen that is a
 * role change, a removal or an account deactivation that meets another admin's
 * change made at the same moment — the screen itself never offers an admin
 * their own row. The title says what happened, the description the next step;
 * nothing was changed.
 *
 * Both error classes are read, like `refusalOf`: `apiFetch`'s (`.body`) and the
 * generated client's (`.data`).
 */
import { refusalOf } from "./openingVatRefusals";

type T = (en: string, ar: string) => string;

/** The toast for a last-admin refusal, or null when the error is something else. */
export function lastAdminRefusalToast(e: unknown, t: T) {
  if (refusalOf(e).code !== "last_admin_required") return null;
  return {
    title: t("Not changed — the organization would have no admin", "لم يتغيّر شيء — كانت المنظمة ستبقى بلا مسؤول"),
    description: t(
      "An organization must keep at least one admin who can sign in. Make another member an admin first, then try again.",
      "يجب أن يبقى للمنظمة مسؤول واحد على الأقل يستطيع تسجيل الدخول. اجعل عضوًا آخر مسؤولًا أولًا، ثم حاول مرة أخرى.",
    ),
    variant: "destructive" as const,
  };
}
