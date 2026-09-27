/**
 * PHASE 11 PART 2 — THE AP SUBLEDGER, WALKED BY CLICKING (2026-09-22).
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §9–§15.
 *
 * What only a browser can show:
 *   · the whole AP workflow works FROM THE PAGE — pay a supplier on account,
 *     say what the money is, apply it to a bill, undo the application, record
 *     a supplier credit note, post it and apply it;
 *   · 🔴 a refusal the server states BY NAME REACHES THE USER. "A refundable
 *     security deposit is not consideration for a supply" is the sentence that
 *     teaches the workflow, and a server refusal nobody surfaces is
 *     indistinguishable from a frozen screen;
 *   · 🔴 the ageing shows what the supplier HOLDS beside the buckets, never
 *     inside them, and the statement's reconciliation is visible;
 *   · Arabic under dir=rtl and a phone at 390 px, on every page this batch
 *     added — both languages, both widths, by clicking.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };
const DESKTOP = 1280;
const STAMP = Date.now();
const BILL_NO = `E2E-APB-${STAMP}`;
const NOTE_NO = `E2E-APCN-${STAMP}`;
const PAY_REF = `E2E-APPAY-${STAMP}`;

let api: APIRequestContext;
let vendorId = 0, bankId = 0, billId = 0, paymentId = 0, noteId = 0;

/** The page formats money as "SAR 1,234.00"; compare on the grouped absolute figure. */
const shown = (v: number) => Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};

/** Walk one page in all four modes: EN desktop, EN phone, AR desktop, AR phone. */
const inFourModes = async (page: Page, path: string, testId: string, arabicHeading: RegExp) => {
  for (const [lang, viewport, label] of [
    ["en", null, "EN desktop"],
    ["en", PHONE, "EN phone"],
    ["ar", null, "AR desktop"],
    ["ar", PHONE, "AR phone"],
  ] as [string, typeof PHONE | null, string][]) {
    await page.setViewportSize(viewport ?? { width: DESKTOP, height: 900 });
    await page.goto(path);
    await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
    await page.reload();
    await expect(page.locator("html"), `${path} ${label}`).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
    await expect(page.getByTestId(testId), `${path} ${label}`).toBeVisible();
    if (lang === "ar") {
      // 🔴 The Arabic heading is ASSERTED, not assumed from `dir` alone: a page
      // can be right-to-left and still be showing English.
      await expect(page.getByRole("heading", { name: arabicHeading }).first(), `${path} ${label} heading`).toBeVisible();
    }
    await noSidewaysScroll(page, viewport?.width ?? DESKTOP, `${path} ${label}`);
  }
  await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
  await page.setViewportSize({ width: DESKTOP, height: 900 });
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const ids = JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds;
  vendorId = ids.vendorId;
  bankId = ids.bankId;

  // One approved bill for this walk: 4,000 net, no VAT, so every figure the
  // walk asserts is a number a reader can check in their head.
  const draft = await (await api.post("/api/bills", {
    data: {
      billNumber: BILL_NO, date: "2026-06-01", dueDate: "2026-06-30", vendorId,
      items: [{ description: "E2E supply", quantity: 1, unitPrice: 4000, vatRate: 0 }],
    },
  })).json();
  const posted = await (await api.post(`/api/bills/${draft.id}/approve`, { data: {} })).json();
  billId = posted.id;
  expect(Number(posted.total)).toBe(4000);
});
test.afterAll(async () => { await api.dispose(); });

test.describe.serial("the AP subledger, end to end", () => {
  test("🔴 pay a supplier ON ACCOUNT by clicking: it is an ASSET, and the page says so", async ({ page }) => {
    await page.goto("/supplier-payments");
    await expect(page.getByTestId("page-supplier-payments")).toBeVisible();
    // the page states the DIRECTION — the whole accounting difference from the customer side
    await expect(page.getByTestId("page-supplier-payments")).toContainText("ASSET");

    await page.getByTestId("new-supplier-payment").click();
    await expect(page.getByTestId("new-supplier-payment-dialog")).toBeVisible();

    await page.getByTestId("sp-vendor").click();
    await page.getByRole("option").first().click();
    await page.getByTestId("sp-bank").click();
    await page.getByRole("option").first().click();
    await page.getByTestId("sp-amount").fill("3000");
    await page.getByTestId("sp-paid-at").fill("2026-06-10");
    await page.getByTestId("sp-reference").fill(PAY_REF);
    // left as "not yet identified" on purpose: the next test proves such money
    // cannot settle a bill until somebody says what it is.
    await page.getByTestId("sp-submit").click();
    await expect(page.getByTestId("new-supplier-payment-dialog")).toHaveCount(0);

    const list = await (await api.get("/api/supplier-payments")).json();
    const mine = (list.items as Array<{ id: number; reference: string | null; availableAmount: number; classification: string }>)
      .find((p) => p.reference === PAY_REF)!;
    paymentId = mine.id;
    expect(mine.classification).toBe("unknown");
    expect(mine.availableAmount).toBe(3000);

    // the row shows the SERVER's derived remaining balance
    await expect(page.getByTestId(`available-${paymentId}`)).toContainText("3,000.00");
  });

  test("🔴 the refusal REACHES THE USER: unidentified money cannot settle a bill, and the reason is the sentence that teaches the workflow", async ({ page }) => {
    await page.goto("/supplier-payments");
    await page.getByTestId(`open-supplier-payment-${paymentId}`).click();
    await expect(page.getByTestId("supplier-payment-detail")).toBeVisible();

    await page.getByTestId(`detail-allocate-${BILL_NO}`).fill("1000");
    await page.getByTestId("detail-allocate-submit").click();

    // 🔴 the server's words, on screen — not a silent failure and not a generic "error"
    // `.first()`: the toast and its aria-live mirror both carry the text, which
    // is correct — a screen reader announces it too. Either one proves the point.
    await expect(page.getByText(/has not been identified as an advance/i).first()).toBeVisible();

    // and nothing moved
    const detail = await (await api.get(`/api/supplier-payments/${paymentId}`)).json();
    expect(detail.availableAmount).toBe(3000);
    expect(detail.allocations).toEqual([]);
  });

  test("🔴 say what the money IS, then apply it: the balance moves between assets, then into the payable", async ({ page }) => {
    await page.goto("/supplier-payments");
    await page.getByTestId(`open-supplier-payment-${paymentId}`).click();

    await page.getByTestId("detail-classify-select").click();
    await page.getByRole("option", { name: /Advance/i }).click();
    await page.getByTestId("detail-classify").click();
    await expect(page.getByTestId("supplier-payment-detail")).toHaveCount(0);

    await expect(page.getByTestId(`classification-${paymentId}`)).toContainText("Advance");

    // now it may settle the bill
    await page.getByTestId(`open-supplier-payment-${paymentId}`).click();
    await page.getByTestId(`detail-allocate-${BILL_NO}`).fill("1000");
    await page.getByTestId("detail-allocate-submit").click();
    await expect(page.getByTestId("supplier-payment-detail")).toHaveCount(0);

    await expect(page.getByTestId(`available-${paymentId}`)).toContainText("2,000.00");

    // the bill owes 1,000 less — the SERVER's derived figure, not the page's arithmetic
    const aging = await (await api.get("/api/reports/ap-aging")).json();
    const row = (aging.items as Array<{ billNumber: string; outstanding: number }>).find((i) => i.billNumber === BILL_NO)!;
    expect(Number(row.outstanding)).toBe(3000);
  });

  test("🔴 undoing an application keeps the original row and puts the money back", async ({ page }) => {
    await page.goto("/supplier-payments");
    await page.getByTestId(`open-supplier-payment-${paymentId}`).click();

    const detail = await (await api.get(`/api/supplier-payments/${paymentId}`)).json();
    const alloc = (detail.allocations as Array<{ id: number; reversed: boolean }>).find((a) => !a.reversed)!;

    // 🔴 Phase 11 hardening: the page used to type "Applied to the wrong bill"
    // in for the user when the box was empty — a reason nobody gave, satisfying
    // a check that exists so somebody gives one. Now an empty reason is sent as
    // empty, and the SERVER's refusal is what the user sees.
    await page.getByTestId(`reverse-allocation-${alloc.id}`).click();
    await expect(page.getByText(/Say why the allocation is being undone/i).first()).toBeVisible();
    const unchanged = await (await api.get(`/api/supplier-payments/${paymentId}`)).json();
    expect(unchanged.availableAmount, "a refused undo moves nothing").toBe(2000);

    await page.getByTestId("reverse-reason").fill("Applied to the wrong bill");
    await page.getByTestId(`reverse-allocation-${alloc.id}`).click();
    await expect(page.getByTestId("supplier-payment-detail")).toHaveCount(0);

    await expect(page.getByTestId(`available-${paymentId}`)).toContainText("3,000.00");

    // 🔴 the ORIGINAL row is still there, marked — the correction sits beside it
    await page.getByTestId(`open-supplier-payment-${paymentId}`).click();
    await expect(page.getByTestId(`allocation-reversed-${alloc.id}`)).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("🔴 a refund names the bank it came INTO — chosen by the user, never the first bank in the list", async ({ page }) => {
    await page.goto("/supplier-payments");
    await page.getByTestId(`open-supplier-payment-${paymentId}`).click();
    await expect(page.getByTestId("supplier-payment-detail")).toBeVisible();

    await page.getByTestId("refund-amount").fill("250");
    await page.getByTestId("refund-reason").fill("Supplier returned part of the advance");
    // D-3: the picker is visible and is what decides the account.
    await page.getByTestId("refund-bank").click();
    await page.getByRole("option").first().click();
    const chosen = (await page.getByTestId("refund-bank").textContent())?.trim() ?? "";
    await page.getByTestId("refund-submit").click();
    await expect(page.getByTestId("supplier-payment-detail")).toHaveCount(0);

    await expect(page.getByTestId(`available-${paymentId}`)).toContainText("2,750.00");
    const detail = await (await api.get(`/api/supplier-payments/${paymentId}`)).json();
    expect(detail.refunds).toHaveLength(1);
    expect(detail.refunds[0].amount).toBe(250);
    expect(chosen.length, "a bank was visibly chosen").toBeGreaterThan(0);
  });

  test("🔴 a SUPPLIER credit note: recorded, posted, and applied — and applying it posts nothing", async ({ page }) => {
    await page.goto("/supplier-credit-notes");
    await expect(page.getByTestId("page-supplier-credit-notes")).toBeVisible();
    // 🔴 the page says we do not ISSUE this document. It is the screen where
    // somebody would otherwise assume an e-invoice goes out.
    await expect(page.getByTestId("page-supplier-credit-notes")).toContainText(/no invoice number is minted/i);

    await page.getByTestId("new-supplier-note").click();
    await page.getByTestId("note-against-bill").click();
    await page.getByRole("option", { name: new RegExp(BILL_NO) }).click();
    await page.getByTestId("note-number").fill(NOTE_NO);
    // the SUPPLIER'S issue date — a different month from the bill's, which is
    // the period Art. 40(6) corrects the input tax in.
    await page.getByTestId("note-date").fill("2026-07-05");
    await page.getByTestId("note-subtotal").fill("500");
    await page.getByTestId("note-vat").fill("0");
    await expect(page.getByTestId("note-total")).toContainText("500.00");
    await page.getByTestId("note-submit").click();
    await expect(page.getByTestId("new-supplier-note-dialog")).toHaveCount(0);

    const notes = await (await api.get("/api/supplier-credit-notes")).json();
    const mine = (notes.items as Array<{ id: number; billNumber: string; status: string }>).find((n) => n.billNumber === NOTE_NO)!;
    noteId = mine.id;
    expect(mine.status).toBe("draft");

    // a DRAFT moves nothing in the ageing
    const before = await (await api.get("/api/reports/ap-aging")).json();
    expect(Number((before.items as Array<{ billNumber: string; outstanding: number }>).find((i) => i.billNumber === BILL_NO)!.outstanding)).toBe(4000);

    // post it by clicking
    await page.getByTestId(`approve-note-${noteId}`).click();
    await expect(page.getByTestId(`note-status-${noteId}`)).not.toHaveText("draft");

    // apply it, and count the journal entries either side
    const entriesBefore = ((await (await api.get("/api/journal-entries?limit=1")).json()).page?.total) as number;
    await page.getByTestId(`apply-note-${noteId}`).click();
    await expect(page.getByTestId("apply-note-dialog")).toBeVisible();
    await page.getByTestId(`apply-to-${BILL_NO}`).fill("500");
    await page.getByTestId("apply-submit").click();
    await expect(page.getByTestId("apply-note-dialog")).toHaveCount(0);

    // 🔴 NOT ONE new entry: the note's debit was already in AP when it posted
    const entriesAfter = ((await (await api.get("/api/journal-entries?limit=1")).json()).page?.total) as number;
    expect(entriesAfter).toBe(entriesBefore);

    await expect(page.getByTestId(`note-available-${noteId}`)).toContainText("0.00");

    // 🔴 UNDO the application — and it too posts nothing. (The first build
    // routed this through the payment reversal, which posted a phantom
    // supplier ADVANCE.) The note has its 500 to give again; the bill owes it.
    const note = await (await api.get(`/api/supplier-credit-notes/${noteId}`)).json();
    const app = (note.applications as Array<{ id: number; reversed: boolean }>).find((a) => !a.reversed)!;
    await page.getByTestId(`apply-note-${noteId}`).click();
    await page.getByTestId("undo-application-reason").fill("Applied before the supplier confirmed");
    await page.getByTestId(`undo-application-${app.id}`).click();
    await expect(page.getByTestId("apply-note-dialog")).toHaveCount(0);
    await expect(page.getByTestId(`note-available-${noteId}`)).toContainText("500.00");
    const entriesAfterUndo = ((await (await api.get("/api/journal-entries?limit=1")).json()).page?.total) as number;
    expect(entriesAfterUndo, "undoing an application posts nothing either").toBe(entriesBefore);

    // …and apply it again, so the rest of the walk sees the note in force
    await page.getByTestId(`apply-note-${noteId}`).click();
    await page.getByTestId(`apply-to-${BILL_NO}`).fill("500");
    await page.getByTestId("apply-submit").click();
    await expect(page.getByTestId("apply-note-dialog")).toHaveCount(0);
    await expect(page.getByTestId(`note-available-${noteId}`)).toContainText("0.00");
  });

  test("🔴 the Bills list says which rows are NOTES, offers no Pay on a credit note, and pays what a bill OWES", async ({ page }) => {
    await page.goto("/bills");
    // (the testids carry the note's own id, so they address its row uniquely)
    await expect(page.getByTestId(`bill-kind-${noteId}`)).toContainText(/Credit note/i);
    await expect(page.getByTestId(`pay-bill-${noteId}`)).toHaveCount(0);
    await expect(page.getByTestId(`apply-note-link-${noteId}`)).toBeVisible();
    // the bill it adjusts IS payable, and is not labelled a note
    await expect(page.getByTestId(`pay-bill-${billId}`)).toBeVisible();
    await expect(page.getByTestId(`bill-kind-${billId}`)).toHaveCount(0);

    // The bill owes 4,000 − 500 credited = 3,500 (the advance was undone, part refunded).
    // The Pay dialog opens with THAT, not with total − paid (4,000).
    await page.getByTestId(`pay-bill-${billId}`).click();
    await expect(page.getByTestId("pay-amount")).toHaveValue("3500");
    await page.keyboard.press("Escape");
  });

  test("🔴 the ageing shows what the SUPPLIER holds BESIDE the buckets, never inside one", async ({ page }) => {
    await page.goto("/ap-aging");
    await expect(page.getByTestId("ap-recon-total")).toBeVisible();

    const aging = await (await api.get("/api/reports/ap-aging")).json();
    // the bill ages at 4,000 − 500 credited (the advance was un-applied above)
    const row = (aging.items as Array<{ billNumber: string; outstanding: number }>).find((i) => i.billNumber === BILL_NO)!;
    expect(Number(row.outstanding)).toBe(3500);

    // 🔴 the advance is an ASSET on the page, and the buckets do not contain it
    // 3,000 on account, less the 250 the supplier refunded
    await expect(page.getByTestId("ap-recon-advances")).toContainText("2,750.00");
    const bucketSum = (Object.values(aging.buckets) as unknown[]).reduce((s: number, v) => s + Number(v), 0);
    expect(bucketSum).toBe(Number(aging.total));
    expect(Number(aging.netSupplierPosition)).toBe(Number(aging.total) - Number(aging.assets.supplierAdvances)
      - Number(aging.assets.supplierCredits) - Number(aging.assets.supplierDeposits) - Number(aging.assets.unidentifiedPayments));
  });

  test("🔴 the statement reconciles, visibly — and the page shows both figures, not a bare verdict", async ({ page }) => {
    await page.goto("/supplier-statements");
    await expect(page.getByTestId("page-supplier-statements")).toBeVisible();
    await page.getByTestId(`open-statement-${vendorId}`).click();

    await expect(page.getByTestId("page-supplier-statement")).toBeVisible();
    await expect(page.getByTestId("stmt-agrees")).toContainText(/They agree/i);
    await expect(page.getByTestId("stmt-difference")).toContainText("0.00");
    // 🔴 non-vacuous: there really is a position behind the tick
    await expect(page.getByTestId("stmt-payable")).not.toContainText(/^0\.00$/);
    await expect(page.getByTestId("statement-line-0")).toBeVisible();

    const st = await (await api.get(`/api/supplier-statements/${vendorId}`)).json();
    expect(st.reconciliation.agrees, JSON.stringify(st.reconciliation)).toBe(true);
    expect(st.position.advanceBalance).toBe(2750);

    // 🔴 the GL tie is on the page and says what the API says — agreeing or not
    await expect(page.getByTestId("stmt-gl-agrees")).toContainText(st.gl.agrees ? /They agree/i : /They disagree/i);
    await expect(page.getByTestId("stmt-gl-advances")).toContainText(shown(st.gl.components.advances.fromGl));

    // 🔴 the WINDOW: what is brought forward at a date is exactly what was
    // carried the day before (computed by the server over the whole stream),
    // and the page prints that figure rather than adding anything up.
    const before = await (await api.get(`/api/supplier-statements/${vendorId}?to=2026-06-04`)).json();
    const after = await (await api.get(`/api/supplier-statements/${vendorId}?from=2026-06-05`)).json();
    expect(after.opening).toEqual(before.closing);
    await page.getByTestId("stmt-from").fill("2026-06-05");
    await expect(page.getByTestId("stmt-opening-net")).toContainText(shown(after.opening.net));
    await expect(page.getByTestId("stmt-closing-net")).toContainText(shown(after.closing.net));
    await page.getByTestId("stmt-clear-window").click();
    await expect(page.getByTestId("stmt-from")).toHaveValue("");
  });

  test("Arabic / RTL and a phone: every page this batch added, in all four modes", async ({ page }) => {
    // Four pages x four modes is sixteen loads plus their reloads; the default
    // 30s is a budget for one page, not for a sweep.
    test.setTimeout(240_000);
    await inFourModes(page, "/supplier-payments", "page-supplier-payments", /مدفوعات الموردين/);
    await inFourModes(page, "/supplier-credit-notes", "page-supplier-credit-notes", /إشعارات الدائن من الموردين/);
    await inFourModes(page, "/supplier-statements", "page-supplier-statements", /كشوف حساب الموردين/);
    await inFourModes(page, "/ap-aging", "ap-recon-total", /أعمار الذمم الدائنة/);
    // the statement itself (its heading is the supplier's name, so the Arabic
    // assertion is on the GL-tie card's own words)
    await inFourModes(page, `/supplier-statements/${vendorId}`, "page-supplier-statement", /.+/);
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.goto(`/supplier-statements/${vendorId}`);
    await expect(page.getByText("هل يتفق دفتر الموردين مع دفتر الأستاذ العام؟")).toBeVisible();
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));

    // 🔴 and the DIALOGS too — a page that fits and a dialog that does not is a
    // phone bug nobody sees from the list view.
    await page.setViewportSize(PHONE);
    await page.goto("/supplier-payments");
    await page.getByTestId("new-supplier-payment").click();
    await expect(page.getByTestId("new-supplier-payment-dialog")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "phone new-supplier-payment dialog");
    await page.keyboard.press("Escape");

    // the payment DETAIL dialog, which now carries a bank picker for refunds
    await page.getByTestId(`open-supplier-payment-${paymentId}`).click();
    await expect(page.getByTestId("supplier-payment-detail")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "phone supplier-payment detail dialog");
    await page.keyboard.press("Escape");

    await page.goto("/supplier-credit-notes");
    await page.getByTestId("new-supplier-note").click();
    await expect(page.getByTestId("new-supplier-note-dialog")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "phone new-supplier-note dialog");
  });
});
