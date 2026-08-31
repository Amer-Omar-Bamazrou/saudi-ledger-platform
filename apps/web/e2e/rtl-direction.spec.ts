import { test, expect } from "@playwright/test";
import { E2E } from "./global-setup";

/**
 * B-8 — DOES `<html dir>` SURVIVE? The first test able to ask.
 *
 * ── 🔴 WHY THIS COULD NOT BE WRITTEN BEFORE ────────────────────────────────
 * B-8 sat open and UNREPRODUCED for weeks, and the reason was structural, not
 * neglect: `document.documentElement.dir` is set imperatively by
 * `LanguageContext`, on an element React does not own. Whether it is still
 * "rtl" after a user walks around the app is a RUNTIME fact about a live DOM.
 * No static check reaches it, no service test renders anything, and reading
 * the code proves only that something writes it once. One candidate mechanism
 * was eliminated by reading (the login page does have a provider); the
 * question itself stayed open because nothing in the repository could execute
 * it. P5 changed that, so this is the first thing that can settle B-8 either
 * way — and a negative result is a real result, which is why the test is
 * written to be informative when it PASSES.
 *
 * ── 🔴 THE CLASS, WHICH OUTLIVES THIS PARTICULAR BUG ───────────────────────
 * *A value React does not own can be silently reverted by something inside its
 * tree.* A single imperative write is a hope, not a guarantee: nothing
 * re-asserts it and nothing notices when it is lost. The recorded countermeasure
 * is literally "test that it survives a route change", so that is what this
 * does — and it does it by CLICKING, because a `goto` reloads the document and
 * re-runs the provider's mount effect, which would repair the very loss the
 * test is hunting. **A test that navigates the wrong way cannot see this
 * defect at all.**
 */

test.use({ storageState: E2E.storageState });

/** The one fact under test, read from the live document. */
async function direction(page: import("@playwright/test").Page) {
  return page.evaluate(() => ({
    dir: document.documentElement.getAttribute("dir"),
    lang: document.documentElement.getAttribute("lang"),
  }));
}

async function switchToArabic(page: import("@playwright/test").Page) {
  const toggle = page.getByRole("button", { name: /^ع$/ });
  await expect(toggle, "the Arabic toggle is not on the page").toBeVisible();
  await toggle.click();
  await expect
    .poll(async () => (await direction(page)).dir, {
      message: "the toggle did not set dir=rtl at all",
    })
    .toBe("rtl");
}

/** Opens every collapsed sidebar section, using the app's own controls. */
async function expandAllSections(page: import("@playwright/test").Page) {
  const collapsed = page.locator('button[data-nav-section][aria-expanded="false"]');
  // Bounded: click what is closed, re-read, stop when nothing is left. A
  // `while (count > 0)` without a bound would spin forever if a click failed.
  for (let pass = 0; pass < 20; pass++) {
    const n = await collapsed.count();
    if (n === 0) return;
    await collapsed.first().click();
  }
}

test.describe("B-8 — the RTL direction attribute", () => {
  test("🔴 dir survives IN-APP navigation across several routes", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await switchToArabic(page);

    /**
     * Click through the sidebar rather than calling `goto`. This is the whole
     * point: a `goto` is a document load, which remounts `LanguageProvider`
     * and re-applies `dir` — repairing the loss before it could be observed.
     * Only client-side navigation keeps the same document alive long enough
     * for something inside the tree to clobber an attribute outside it.
     */
    // Open every sidebar section first, so the walk crosses sections rather
    // than only the three that happen to be expanded by default. Done through
    // the app's own controls — no reload, which would repair the loss.
    await expandAllSections(page);

    const routes = ["/invoices", "/bills", "/customers", "/reports", "/analytics"];
    for (const route of routes) {
      // Re-open after each navigation: section state is component state, and a
      // route change can collapse what was open.
      await expandAllSections(page);
      const link = page.locator(`a[href="${route}"]`).first();
      await expect(link, `no sidebar link to ${route} after expanding every section`).toBeVisible();
      await link.click();
      await page.waitForURL(new RegExp(route.replace("/", "\\/")), { timeout: 10_000 });
      await page.waitForLoadState("networkidle");

      const { dir, lang } = await direction(page);
      expect(
        dir,
        `🔴 <html dir> was lost after navigating to ${route} WITHOUT a document ` +
          `reload. That is B-8: a value React does not own, reverted by something ` +
          `inside its tree, with nothing re-asserting it and nothing noticing.`,
      ).toBe("rtl");
      expect(lang, `<html lang> was lost after navigating to ${route}`).toBe("ar");
    }
  });

  test("🔴 dir survives a full RELOAD — the localStorage half", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await switchToArabic(page);

    await page.reload({ waitUntil: "networkidle" });
    const { dir, lang } = await direction(page);
    // `ksa_lang` is read in the provider's initial state, so a reload must come
    // back Arabic. If this fails, the preference is not persisting at all —
    // a different defect from B-8, and the message says so.
    expect(dir, "the language preference did not survive a reload (ksa_lang)").toBe("rtl");
    expect(lang).toBe("ar");
  });

  test("🔴 dir survives a route change AFTER a reload", async ({ page }) => {
    /**
     * The composition of the two above, and the one most likely to catch a
     * real loss: the provider mounted from persisted state rather than from a
     * click, and THEN the user moves. A mechanism that only re-applies `dir`
     * inside the toggle's own handler would pass both tests above and fail
     * this one.
     */
    await page.goto("/", { waitUntil: "networkidle" });
    await switchToArabic(page);
    await page.reload({ waitUntil: "networkidle" });

    await page.locator('a[href="/invoices"]').first().click();
    await page.waitForURL(/invoices/, { timeout: 10_000 });
    await page.waitForLoadState("networkidle");

    expect((await direction(page)).dir, "dir was lost on the first navigation after a reload").toBe("rtl");
  });

  test("switching back to English restores ltr — the attribute is not write-once", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await switchToArabic(page);

    const back = page.getByRole("button", { name: /^EN$/ });
    await expect(back).toBeVisible();
    await back.click();
    await expect.poll(async () => (await direction(page)).dir).toBe("ltr");

    // 🔴 Assert the value MOVES in both directions. A test that only ever
    // checks for "rtl" would pass against an implementation that hardcoded it,
    // which proves nothing about a mechanism whose job is to change.
    await page.locator('a[href="/invoices"]').first().click();
    await page.waitForURL(/invoices/, { timeout: 10_000 });
    expect((await direction(page)).dir).toBe("ltr");
  });

  test("🔴 dir is RTL on the very first paint, before React runs", async ({ page }) => {
    /**
     * The pre-paint script in `index.html`, asserted at the only moment that
     * proves anything: before the bundle has executed.
     *
     * 🔴 `waitUntil: "commit"` is load-bearing. Any later wait — `load`,
     * `domcontentloaded`, `networkidle` — gives React time to mount, and the
     * provider's effect then sets `dir` correctly, so the test would pass
     * whether or not the inline script existed. That is the same shape as
     * clicking-versus-goto in the test above: **a check taken at the wrong
     * moment reproduces the assertion and not its meaning**, and reports the
     * identical green either way.
     */
    await page.goto("/", { waitUntil: "networkidle" });
    await switchToArabic(page);

    // Fresh document. `commit` resolves as soon as the navigation is committed
    // and the HTML starts arriving — head scripts have run, the module bundle
    // has not.
    await page.goto("/invoices", { waitUntil: "commit" });
    const early = await page.evaluate(() => ({
      dir: document.documentElement.getAttribute("dir"),
      hasRoot: !!document.getElementById("root")?.childElementCount,
    }));

    expect(
      early.dir,
      "🔴 the document painted LTR for an Arabic user. The pre-paint script in " +
        "index.html is missing or broken — direction cannot be fixed from inside " +
        "React, because by the time any component runs the first paint has happened.",
    ).toBe("rtl");
    expect(
      early.hasRoot,
      "React had already rendered, so this assertion proved nothing about first paint",
    ).toBe(false);
  });

  test("🔴 the check is not vacuous — dir is a real attribute with a real writer", async ({ page }) => {
    /**
     * The anti-vacuity guard. Every assertion above compares against a string;
     * if the attribute were simply absent and `getAttribute` returned null,
     * they would all fail loudly — but if some future change made the SELECTOR
     * wrong rather than the value, they could pass by accident. So: the
     * document starts with a direction, and it is one of the two legal values.
     */
    await page.goto("/", { waitUntil: "networkidle" });
    const { dir } = await direction(page);
    expect(["rtl", "ltr"]).toContain(dir);
  });
});
