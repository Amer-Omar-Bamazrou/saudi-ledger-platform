/**
 * The API's rate limit, as the user reads it (rate limiting, 2026-10-05).
 *
 * The server refuses with `429 { code: "rate_limited", retryAfterSeconds }`
 * (`apps/api/src/lib/rateLimit.ts`). 🔴 Keyed on the CODE, never the English
 * sentence beside it: the server's words are English only, and rewording them
 * must not be able to break what an Arabic reader sees.
 *
 * One reading for both data paths — `apiFetch`'s `ApiError` (`body`) and the
 * generated client's (`data`) — so no surface has to know which client it
 * was handed.
 */
import { tOutside } from "@/contexts/LanguageContext";
import { toast } from "@/hooks/use-toast";

type T = (en: string, ar: string) => string;

/** Seconds to wait when this response is the rate limit; `null` when it is anything else. */
export function rateLimitedSeconds(status: number, body: unknown): number | null {
  if (status !== 429) return null;
  const b = body as { code?: unknown; retryAfterSeconds?: unknown } | null | undefined;
  if (b?.code !== "rate_limited") return null;
  const s = Number(b.retryAfterSeconds);
  return Number.isFinite(s) && s > 0 ? Math.ceil(s) : 60;
}

/**
 * The limiter could not count (503 `rate_limit_unavailable`): the request was
 * refused and did nothing. The server's sentence is English only.
 */
export function limiterUnavailableMessage(status: number, body: unknown, t: T = tOutside): string | null {
  if (status !== 503 || (body as { code?: unknown } | null | undefined)?.code !== "rate_limit_unavailable") return null;
  return t(
    "The service is temporarily unavailable. Please try again shortly.",
    "الخدمة غير متاحة مؤقتًا. يُرجى المحاولة مرة أخرى بعد قليل.",
  );
}

/** The same question asked of a thrown error from either client. */
export function rateLimitedSecondsOf(e: unknown): number | null {
  const err = e as { status?: unknown; body?: unknown; data?: unknown } | null | undefined;
  if (typeof err?.status !== "number") return null;
  return rateLimitedSeconds(err.status, err.body ?? err.data);
}

/**
 * "30 seconds" / "بعد 30 ثانية" — with Arabic's number agreement (1, 2, 3–10,
 * 11+ take different forms), because a wrong form reads as machine text.
 * Minutes from 90 seconds up, rounded UP: telling someone to come back early
 * only earns them a second refusal.
 */
export function rateLimitWait(seconds: number, t: T = tOutside): string {
  const useMinutes = seconds >= 90;
  const n = useMinutes ? Math.ceil(seconds / 60) : seconds;
  if (useMinutes) {
    const ar = n === 1 ? "دقيقة واحدة" : n === 2 ? "دقيقتين" : n <= 10 ? `${n} دقائق` : `${n} دقيقة`;
    return t(n === 1 ? "1 minute" : `${n} minutes`, ar);
  }
  const ar = n === 1 ? "ثانية واحدة" : n === 2 ? "ثانيتين" : n <= 10 ? `${n} ثوانٍ` : `${n} ثانية`;
  return t(n === 1 ? "1 second" : `${n} seconds`, ar);
}

export function rateLimitTitle(t: T = tOutside): string {
  return t("Too many requests", "عدد الطلبات كبير جدًا");
}

export function rateLimitMessage(seconds: number, t: T = tOutside): string {
  return t(
    `Too many requests. Please try again in ${rateLimitWait(seconds, t)}.`,
    `عدد الطلبات كبير جدًا. يُرجى المحاولة مرة أخرى بعد ${rateLimitWait(seconds, t)}.`,
  );
}

/**
 * One toast per burst. A refused page fails several queries at once; five
 * identical toasts would bury the one sentence the user needs.
 */
const TOAST_GAP_MS = 5_000;
let lastToastAt = 0;

export function notifyRateLimited(seconds: number): void {
  const now = Date.now();
  if (now - lastToastAt < TOAST_GAP_MS) return;
  lastToastAt = now;
  toast({ variant: "destructive", title: rateLimitTitle(), description: rateLimitMessage(seconds) });
}
