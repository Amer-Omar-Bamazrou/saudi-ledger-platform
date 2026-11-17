/**
 * 🔴 The error-handling work package (owner-approved 2026-11-17): the SAFE sentences a response carries when its own text
 * cannot be shown — every 5xx (whatever the exception said stays in the server log, linked by the request id), and an
 * error the platform did not write itself (a library's 4xx, e.g. a malformed JSON body). Keyed by a stable code;
 * English and Arabic always together.
 *
 * A refusal the platform DID write keeps its own sentence (the server's `error` / `errorAr`). Where it has no Arabic
 * yet, the Arabic reader gets this catalogue's sentence for its status class — safe and in their language, if less
 * specific — until the refusal is given its own Arabic (the sweep this package's ratchet tracks).
 */
export interface SafeMessage { en: string; ar: string }

export const SAFE_MESSAGES: Record<string, SafeMessage> = {
  bad_request: { en: "The request could not be read. Check the values entered and try again.", ar: "تعذّرت قراءة الطلب. راجع القيم المدخلة وحاول مرة أخرى." },
  invalid_json: { en: "The request could not be read. Reload the page and try again.", ar: "تعذّرت قراءة الطلب. أعد تحميل الصفحة وحاول مرة أخرى." },
  field_too_long: { en: "A field exceeds its maximum allowed length.", ar: "أحد الحقول يتجاوز الطول المسموح به." },
  unauthorized: { en: "Your session has ended. Sign in again.", ar: "انتهت الجلسة. سجّل الدخول مرة أخرى." },
  forbidden: { en: "Your role does not allow this.", ar: "دورك لا يسمح بهذا الإجراء." },
  not_found: { en: "This record was not found. It may have been removed, or it belongs elsewhere.", ar: "لم يُعثر على هذا السجل. ربما أُزيل، أو أنه يتبع جهة أخرى." },
  method_not_allowed: { en: "This action is not available here.", ar: "هذا الإجراء غير متاح هنا." },
  conflict: { en: "This record changed meanwhile. Reload the page and try again.", ar: "تغيّر هذا السجل في الأثناء. أعد تحميل الصفحة وحاول مرة أخرى." },
  payload_too_large: { en: "The file or request is too large.", ar: "الملف أو الطلب أكبر من المسموح به." },
  unsupported_media_type: { en: "This file type is not accepted.", ar: "نوع الملف هذا غير مقبول." },
  unprocessable: { en: "This was not accepted. Check the values and try again.", ar: "لم يُقبل هذا. راجع القيم وحاول مرة أخرى." },
  locked: { en: "This period is closed, so nothing was changed.", ar: "هذه الفترة مُقفلة، لذا لم يتغيّر شيء." },
  rate_limited: { en: "Too many attempts. Wait a moment and try again.", ar: "محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى." },
  internal_error: { en: "The request could not be completed. If it happens again, quote the reference to support.", ar: "تعذّر إكمال الطلب. إن تكرر ذلك فاذكر الرقم المرجعي للدعم." },
  service_unavailable: { en: "This service is unavailable right now. Try again shortly.", ar: "هذه الخدمة غير متاحة حالياً. حاول بعد قليل." },
  pdf_renderer_unavailable: { en: "The PDF could not be produced right now. Try again later; nothing else was affected.", ar: "تعذّر إنشاء ملف PDF الآن. حاول لاحقاً؛ لم يتأثر شيء آخر." },
};

/** The code a status class answers with when the body names none of its own. */
export function codeForStatus(status: number): string {
  switch (status) {
    case 400: return "bad_request";
    case 401: return "unauthorized";
    case 403: return "forbidden";
    case 404: return "not_found";
    case 405: return "method_not_allowed";
    case 409: return "conflict";
    case 413: return "payload_too_large";
    case 415: return "unsupported_media_type";
    case 422: return "unprocessable";
    case 423: return "locked";
    case 429: return "rate_limited";
    case 503: return "service_unavailable";
    default: return status >= 500 ? "internal_error" : status === 410 ? "not_found" : "bad_request";
  }
}

/** A stable code: lower snake case, letters first. Anything else is not a code the client may key on. */
export const isStableCode = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(v);
