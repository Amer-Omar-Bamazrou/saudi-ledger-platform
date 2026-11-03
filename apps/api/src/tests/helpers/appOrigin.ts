/**
 * 🔴 Phase 18 R-7 (G45; register §11.102): the test helpers send the header a
 * request from the application's own pages carries — the memo's allowance
 * ("test helpers may send correct headers"). The value is read from the SAME
 * configuration the server reads (`CORS_ALLOWED_ORIGINS`, its first entry), so
 * the two cannot drift. A test that is ABOUT the CSRF check sends its own
 * headers instead (`phase18-r7-g45-csrf.test.ts`).
 */
import { loadEnv } from "@workspace/config";

export function appOrigin(): string {
  return loadEnv().CORS_ALLOWED_ORIGINS[0]!;
}

export function appOriginHeader(): { origin: string } {
  return { origin: appOrigin() };
}
