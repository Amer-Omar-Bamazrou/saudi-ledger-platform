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
 * Everything else `@playwright/test` exports is re-exported unchanged.
 */
import { test as base, expect } from "@playwright/test";

export * from "@playwright/test";

export const test = base.extend<{ failOnUncaughtPageErrors: void }>({
  failOnUncaughtPageErrors: [
    async ({ context }, use) => {
      const errors: string[] = [];
      context.on("weberror", (e) => errors.push(`uncaught: ${e.error().message}`));
      await context.exposeBinding("__e2eWindowErrorWithoutError", (_source, message: string) => {
        errors.push(`window error without an Error object: ${message}`);
      });
      await context.addInitScript(() => {
        window.addEventListener("error", (evt) => {
          if (evt.error != null) return; // an Error object: `weberror` reports it
          const report = (window as unknown as { __e2eWindowErrorWithoutError?: (m: string) => void }).__e2eWindowErrorWithoutError;
          report?.(evt.message || "(no message)");
        });
      });
      await use();
      expect(errors, "no uncaught page error during the test").toEqual([]);
    },
    { auto: true },
  ],
});
