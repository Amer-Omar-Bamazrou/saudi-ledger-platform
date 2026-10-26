/**
 * The uncaught-page-error check (`fixtures.ts`) tested in the real browser, both
 * halves of its one exception (owner, 2026-10-24 night, option b).
 *
 * CI's runs have not raised the ResizeObserver-loop notification anywhere (it was
 * seen locally on Windows), so without the first test the exception would never
 * run in CI, and a Chromium text that differed from the constant would go
 * unnoticed while the exception did nothing. The page raises the real
 * notification; the browser supplies the text.
 *
 * The second test watches a context of its OWN with the same function the
 * fixture uses, so it can assert what the check recorded without the test's own
 * teardown failing on it — a `test.fail()` would pass for any failure at all,
 * including the check wrongly letting the message through.
 */
import { test, expect, ALLOWED_PAGE_ERROR_MESSAGE, watchUncaughtPageErrors } from "./fixtures";

test("the browser's own ResizeObserver-loop notification is counted, not failed", async ({ page, uncaughtPageErrorCheck }) => {
  await page.goto("/");
  // An observer that resizes its own target inside its callback: the browser
  // cannot deliver the second observation in the same frame and reports the loop.
  await page.evaluate(() => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    let resized = false;
    new ResizeObserver(() => {
      if (resized) return;
      resized = true;
      el.style.width = "10px";
      el.style.height = "10px";
    }).observe(el);
  });
  await expect.poll(() => uncaughtPageErrorCheck.allowedCount(), { message: `"${ALLOWED_PAGE_ERROR_MESSAGE}" counted` }).toBeGreaterThan(0);
  expect(uncaughtPageErrorCheck.failingErrors()).toEqual([]);
});

test("any other message, a near miss included, and a thrown error are recorded as failures", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  try {
    const check = await watchUncaughtPageErrors(context);
    const page = await context.newPage();
    await page.goto(`${baseURL}/`);
    await page.evaluate(() => {
      window.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop limit exceeded" }));
      setTimeout(() => {
        throw new Error("uncaught-error-check self-test");
      });
    });
    await expect
      .poll(() => [...check.failingErrors()].sort())
      .toEqual([
        "uncaught: uncaught-error-check self-test",
        "window error without an Error object: ResizeObserver loop limit exceeded",
      ]);
    expect(check.allowedCount()).toBe(0);
  } finally {
    await context.close();
  }
});
