import { expect, type Page } from "./fixtures";

/**
 * 🔴 NOTHING IS CLIPPED SIDEWAYS AT PHONE WIDTH — one check for the 19A screens (2026-11-20).
 *
 * The 19A walk asserted `documentElement.scrollWidth <= clientWidth`. That is true on every page by construction: the
 * app's content area is `overflow-x-hidden` (Layout.tsx), so a row wider than the phone is CLIPPED inside it — its last
 * controls simply are not on screen, and nothing scrolls. Found on the Users page (a member's row, 2026-11-20): the
 * document check said "fits" while the reset, password and deactivate controls were cut off. So this asserts three
 * things, each of which that check could not see:
 *   1. the document does not scroll sideways (the old check, kept);
 *   2. the content area holds nothing wider than itself (a table that scrolls inside its OWN container does not count:
 *      its overflow stays inside it). A screen outside the app shell (sign-in, the code step) is measured at <body>;
 *   3. an open dialog lies inside the viewport;
 *   4. NO AMOUNT IS SPLIT BETWEEN ITS DIGITS (owner, 2026-11-21): a figure broken across two lines can be read as two
 *      numbers. An amount may wrap only as a whole (between the amount and its currency); a card that cannot hold it
 *      stacks or shrinks instead. Checked for every amount on the page, inside scrolling tables too.
 * A failure names the widest offenders, so the report says WHAT does not fit.
 */
export async function fitsAtPhoneWidth(page: Page, where = "page"): Promise<void> {
  await page.waitForTimeout(300); // let a dialog's opening animation settle
  const report = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const shell = document.querySelector("main > div.overflow-x-hidden") as HTMLElement | null;
    const content = shell ?? document.body;
    const describe = (el: Element) => {
      const r = el.getBoundingClientRect();
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      const test = el.getAttribute("data-testid");
      return `<${el.tagName.toLowerCase()}${test ? ` data-testid=${test}` : ""}> ${Math.round(r.width)}px "${text}"`;
    };
    const offenders: string[] = [];
    if (content.scrollWidth > content.clientWidth) {
      // a clipping container can still be scrolled by a script (scrollIntoView did it): measure it as a person sees it
      content.scrollLeft = 0;
      // the CONTENT box (inside the padding): a child reaching into the padding already makes the area scroll
      const outer = content.getBoundingClientRect();
      const pad = getComputedStyle(content);
      const box = { left: outer.left + parseFloat(pad.paddingLeft), right: outer.right - parseFloat(pad.paddingRight) };
      for (const el of Array.from(content.querySelectorAll("*"))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || (r.left >= box.left - 0.5 && r.right <= box.right + 0.5)) continue;
        // inside a container that really scrolls sideways: its overflow is its own
        let scroller = false;
        for (let n = el.parentElement; n && n !== content; n = n.parentElement) {
          if (/(auto|scroll)/.test(getComputedStyle(n).overflowX) && n.scrollWidth > n.clientWidth + 1) { scroller = true; break; }
        }
        if (!scroller) offenders.push(describe(el));
        if (offenders.length >= 4) break;
      }
    }
    const dialogs = Array.from(document.querySelectorAll("[role=dialog]")).filter((d) => {
      const r = d.getBoundingClientRect();
      return r.width > 0 && (r.left < -1 || r.right > vw + 1);
    }).map(describe);
    // 4. every amount (digits with group separators and two decimals) sits on ONE line
    const splitAmounts: string[] = [];
    const AMOUNT = /\d[\d,٬]*[.٫]\d{2}/g;
    const texts = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node = texts.nextNode(); node && splitAmounts.length < 4; node = texts.nextNode()) {
      const text = node.nodeValue ?? "";
      for (const m of text.matchAll(AMOUNT)) {
        const range = document.createRange();
        range.setStart(node, m.index!);
        range.setEnd(node, m.index! + m[0].length);
        const tops = new Set(Array.from(range.getClientRects()).filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        if (tops.size > 1) splitAmounts.push(`"${m[0]}" on ${tops.size} lines`);
      }
    }
    return {
      splitAmounts,
      measuredAt: shell ? "the app's content area" : "<body>",
      document: document.documentElement.scrollWidth - vw,
      content: content.scrollWidth - content.clientWidth,
      offenders,
      dialogs,
    };
  });
  expect(report.document, `${where}: the document scrolls sideways at phone width`).toBeLessThanOrEqual(0);
  expect(report.content, `${where}: content wider than the phone is clipped (${report.measuredAt}): ${report.offenders.join(" | ")}`).toBeLessThanOrEqual(0);
  expect(report.dialogs, `${where}: a dialog runs past the screen`).toEqual([]);
  expect(report.splitAmounts, `${where}: an amount is split between its digits`).toEqual([]);
}
