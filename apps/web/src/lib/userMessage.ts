/**
 * 🔴 The error-handling work package (owner-approved 2026-11-17): the ONE sentence a failed request shows its reader.
 *
 * Both error classes build their `message` here — `ApiError` in `lib/api.ts` (apiFetch) and the generated client's
 * `ApiError` (registered through `setErrorMessageResolver` in main.tsx) — so every toast and inline error that prints
 * `e.message` (63 sites, measured 2026-11-17) shows a safe sentence in the reader's language without being edited.
 *
 *  - The server's own sentence in the reader's language: `errorAr` for Arabic, `error` for English (A25's rule).
 *  - A 5xx, or a status-0 network failure, speaks ONLY through a body the server normalised (it carries a `code`):
 *    a proxy's error page or a stray exception text is never shown — the safe sentence is.
 *  - Otherwise the safe sentence for the code or the status class, in the reader's language.
 *  - A 5xx adds the short reference the server logged it under, so support can find it.
 *  - Never a status line ("HTTP 409 Conflict"), never `statusText`, never a stack.
 */
import { tOutside } from "@/contexts/LanguageContext";

type Pair = readonly [en: string, ar: string];

const SAFE: Record<string, Pair> = {
  network_error: ["The server could not be reached. Check the connection and try again.", "تعذّر الوصول إلى الخادم. تحقّق من الاتصال وحاول مرة أخرى."],
  unreadable_response: ["The server's answer could not be read. Reload the page and try again.", "تعذّرت قراءة ردّ الخادم. أعد تحميل الصفحة وحاول مرة أخرى."],
  bad_request: ["The request could not be read. Check the values entered and try again.", "تعذّرت قراءة الطلب. راجع القيم المدخلة وحاول مرة أخرى."],
  unauthorized: ["Your session has ended. Sign in again.", "انتهت الجلسة. سجّل الدخول مرة أخرى."],
  forbidden: ["Your role does not allow this.", "دورك لا يسمح بهذا الإجراء."],
  not_found: ["This record was not found. It may have been removed, or it belongs elsewhere.", "لم يُعثر على هذا السجل. ربما أُزيل، أو أنه يتبع جهة أخرى."],
  conflict: ["This record changed meanwhile. Reload the page and try again.", "تغيّر هذا السجل في الأثناء. أعد تحميل الصفحة وحاول مرة أخرى."],
  payload_too_large: ["The file or request is too large.", "الملف أو الطلب أكبر من المسموح به."],
  unprocessable: ["This was not accepted. Check the values and try again.", "لم يُقبل هذا. راجع القيم وحاول مرة أخرى."],
  locked: ["This period is closed, so nothing was changed.", "هذه الفترة مُقفلة، لذا لم يتغيّر شيء."],
  rate_limited: ["Too many attempts. Wait a moment and try again.", "محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى."],
  service_unavailable: ["This service is unavailable right now. Try again shortly.", "هذه الخدمة غير متاحة حالياً. حاول بعد قليل."],
  internal_error: ["The request could not be completed. If it happens again, quote the reference to support.", "تعذّر إكمال الطلب. إن تكرر ذلك فاذكر الرقم المرجعي للدعم."],
};

function statusCode(status: number): string {
  if (status === 0) return "network_error";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404 || status === 410) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "payload_too_large";
  if (status === 422) return "unprocessable";
  if (status === 423) return "locked";
  if (status === 429) return "rate_limited";
  if (status === 503) return "service_unavailable";
  if (status >= 500) return "internal_error";
  return status >= 200 && status < 300 ? "unreadable_response" : "bad_request";
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

export function userMessage(status: number, body: unknown): string {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const code = text(b.code);
  const trusted = (status > 0 && status < 500) || code !== undefined;
  const [fallbackEn, fallbackAr] = SAFE[code ?? ""] ?? SAFE[statusCode(status)] ?? SAFE.internal_error;
  const en = trusted ? text(b.error) ?? fallbackEn : fallbackEn;
  const ar = trusted ? text(b.errorAr) ?? fallbackAr : fallbackAr;
  const words = tOutside(en, ar);
  const ref = text(b.requestId);
  return status >= 500 && ref ? `${words} (${tOutside("reference", "المرجع")}: ${ref.slice(0, 8)})` : words;
}
