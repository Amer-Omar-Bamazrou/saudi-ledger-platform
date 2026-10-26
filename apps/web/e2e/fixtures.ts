/**
 * 🔴 EVERY SPEC IMPORTS `test` FROM HERE (Phase 18, owner 2026-10-24): a test
 * FAILS when any page of its browser context raises an uncaught error.
 *
 * Until the suite moved to the built app (playwright.config.ts), the Vite dev
 * overlay was the only thing that noticed an uncaught page error — by covering
 * the page and breaking the next click, which looked like a flaky test. The
 * build has no overlay, so without this check the same error would pass in
 * silence. This states the check on purpose:
 *
 *  - `weberror`: an uncaught exception or unhandled promise rejection in any
 *    page of the context (pages a test opens itself included);
 *  - a window `error` event with NO Error object — the shape the overlay showed
 *    as "(unknown runtime error)" (a ResizeObserver-loop notification, a
 *    cross-origin script error), which `weberror` does not report. It is read
 *    through a binding, so it survives navigations.
 *
 * 🔴 ONE EXCEPTION, BY EXACT TEXT (owner, 2026-10-24 night, option b): the
 * browser's own ResizeObserver-loop notification, `ALLOWED_PAGE_ERROR_MESSAGE`.
 * It is COUNTED, not failed, and every test prints its count, so the run output
 * shows where it occurs. Its source is an open UI item (seen in the
 * supplier-credit-note flow, locally on Windows). Any other message — a near
 * miss included — still fails the test; `uncaught-error-check.spec.ts` holds
 * both halves in the real browser.
 *
 * Everything else `@playwright/test` exports is re-exported unchanged.
 */
import { test as base, expect, type BrowserContext } from "@playwright/test";

export * from "@playwright/test";

/** Chromium's exact text, compared with `===`. It ends with a full stop. */
export const ALLOWED_PAGE_ERROR_MESSAGE = "ResizeObserver loop completed with undelivered notifications.";

/** Read-only views of what the check saw; nothing here clears a recorded error. */
export type UncaughtPageErrorCheck = { allowedCount: () => number; failingErrors: () => string[] };

/** The check itself, on one browser context. The fixture below applies it to every test's context. */
export async function watchUncaughtPageErrors(context: BrowserContext): Promise<UncaughtPageErrorCheck> {
  const errors: string[] = [];
  let allowed = 0;
  context.on("weberror", (e) => errors.push(`uncaught: ${e.error().message}`));
  await context.exposeBinding("__e2eWindowErrorWithoutError", (_source, message: string) => {
    if (message === ALLOWED_PAGE_ERROR_MESSAGE) allowed += 1;
    else errors.push(`window error without an Error object: ${message}`);
  });
  await context.addInitScript(() => {
    window.addEventListener("error", (evt) => {
      if (evt.error != null) return; // an Error object: `weberror` reports it
      const report = (window as unknown as { __e2eWindowErrorWithoutError?: (m: string) => void }).__e2eWindowErrorWithoutError;
      report?.(evt.message || "(no message)");
    });
  });
  return { allowedCount: () => allowed, failingErrors: () => [...errors] };
}

export const test = base.extend<{ uncaughtPageErrorCheck: UncaughtPageErrorCheck }>({
  uncaughtPageErrorCheck: [
    async ({ context }, use) => {
      const check = await watchUncaughtPageErrors(context);
      await use(check);
      console.log(`[uncaught-page-error-check] allowed "${ALLOWED_PAGE_ERROR_MESSAGE}": ${check.allowedCount()}`);
      expect(check.failingErrors(), "no uncaught page error during the test").toEqual([]);
    },
    { auto: true },
  ],
});
