/**
 * 🔴 Phase 18 R-7 — G45 (memo §2d; register §11.102): a CSRF check on every
 * POST, PUT, PATCH and DELETE, before anything else reads the request.
 *
 * The session cookie is `SameSite=Lax`, which a same-site page and a top-level
 * cross-site form POST can both ride. So an unsafe request must SHOW it comes
 * from the application itself, in this order:
 *
 *   1. Sec-Fetch-Site present → only `same-origin` passes; `same-site`,
 *      `cross-site`, `none` and any other value are refused.
 *   2. absent → the Origin must equal a configured application origin EXACTLY
 *      (scheme, host, port). An Origin that is not exactly an origin — a path,
 *      `null`, garbage — is malformed and refused, never treated as absent.
 *   3. Origin absent too → the Referer's origin must equal one exactly.
 *   4. none of the three → refused.
 *
 * The application origins are `CORS_ALLOWED_ORIGINS` (one definition: the
 * origins that may cause a credentialed write; the config makes each an exact
 * origin). Comparison is string equality, so a suffix, a subdomain, another
 * port or another scheme is refused. GET, HEAD and OPTIONS are not checked.
 */
import type { NextFunction, Request, Response } from "express";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The refusal, in both languages; `reason` says which step refused (for the log and for diagnosis). */
export const CSRF_REFUSAL = {
  code: "csrf_refused",
  error: "This change was refused because the request did not come from this application's own pages. Reload the page and try again.",
  errorAr: "رُفض هذا التغيير لأن الطلب لم يصدر من صفحات هذا التطبيق نفسه. أعد تحميل الصفحة وحاول مرة أخرى.",
} as const;

export type CsrfVerdict = { ok: true } | { ok: false; reason: string };

/** The value as an origin when it IS exactly one (an Origin header's form); otherwise null. */
function exactOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin !== "null" && url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}

/** A URL's origin (a Referer's), or null when it has none. */
function originOf(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export function csrfVerdict(
  method: string,
  headers: { secFetchSite?: string; origin?: string; referer?: string },
  appOrigins: readonly string[],
): CsrfVerdict {
  if (!UNSAFE.has(method.toUpperCase())) return { ok: true };
  if (headers.secFetchSite !== undefined) {
    return headers.secFetchSite === "same-origin" ? { ok: true } : { ok: false, reason: "sec_fetch_site_not_same_origin" };
  }
  if (headers.origin !== undefined) {
    const origin = exactOrigin(headers.origin);
    if (origin === null) return { ok: false, reason: "origin_malformed" };
    return appOrigins.includes(origin) ? { ok: true } : { ok: false, reason: "origin_not_application" };
  }
  if (headers.referer !== undefined) {
    const origin = originOf(headers.referer);
    if (origin === null) return { ok: false, reason: "referer_malformed" };
    return appOrigins.includes(origin) ? { ok: true } : { ok: false, reason: "referer_not_application" };
  }
  return { ok: false, reason: "no_origin_evidence" };
}

/** The middleware: a refused request is answered 403 here and nothing behind it runs. */
export function refuseCrossSiteWrites(appOrigins: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const verdict = csrfVerdict(
      req.method,
      { secFetchSite: req.get("sec-fetch-site"), origin: req.get("origin"), referer: req.get("referer") },
      appOrigins,
    );
    if (verdict.ok) return next();
    req.log?.warn({ csrf: verdict.reason, method: req.method, path: req.path }, "CSRF check refused an unsafe request");
    res.status(403).json({ ...CSRF_REFUSAL, reason: verdict.reason });
  };
}
