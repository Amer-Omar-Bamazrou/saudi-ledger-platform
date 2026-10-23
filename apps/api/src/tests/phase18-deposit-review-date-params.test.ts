/**
 * 🔴 PROOF (Phase 18, owner approval 2026-10-22 item 3b; proof first): the
 * deposit review's date parameters accept a real `period_to` / `as_of`.
 *
 * The mechanism (main at `ed0bc424`): `payments.controller.ts:90-91` tests
 * `period_to` against `/^d{4}-d{2}$/` and `as_of` against
 * `/^d{4}-d{2}-d{2}$/`. The backslashes are gone, so `d{4}` means "the letter
 * d, four times": every real month and day is refused with 400, and only the
 * literal strings `dddd-dd` / `dddd-dd-dd` get through to the service.
 *
 * What this file asserts, fix-neutral:
 *  1. a real `as_of` and a real `period_to` are ANSWERED (200), with the frame
 *     they name (`asOf`), and the frame MOVES the answer: a receipt dated
 *     2026-08-15 is in the August frame and absent from the 2026-08-14 one —
 *     so a 200 that ignored the parameter would fail;
 *  2. a malformed value is refused 400, including the literal `dddd-dd` that
 *     the broken pattern admits.
 *
 * Everything is the PRODUCT's own HTTP path on rows it created itself; the
 * database is only READ. DB-backed (sl_test / CI); skips on the DB-free
 * placeholder.
 */
process.env.PORT ??= "3217";
process.env.SESSION_SECRET ??= "phase18-deposit-review-date-params-proof-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __resetRateLimitsForTests } from "../routes/auth";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "DepositReviewDatesPw123!";
const RECEIPT_DATE = "2026-08-15";

describeMaybe("Deposit review — a real period_to / as_of is answered, a malformed one refused", () => {
  const h = g04Harness("p18drd");
  let customerId = 0;
  let receiptId = 0;

  const ok = (r: { status: number; body: unknown }, status: number) => expect(r.status, JSON.stringify(r.body)).toBe(status);
  const review = (query: string) => h.api("admin", "GET", `/payments/deposit-review?${query}`);
  const holds = (body: any) => (body.items as Array<{ paymentId: number }>).some((i) => i.paymentId === receiptId);

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    const orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "Deposit Review Dates Co", "318181818181897");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    const cust = await h.api("admin", "POST", "/customers", { name: "Deposit Review Buyer", taxNumber: "300000000000003" });
    ok(cust, 201);
    customerId = cust.body.id;
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "Deposit Review Ops", bankName: "Riyad", currency: "SAR" });
    ok(bank, 201);
    // A receipt on account, held as a deposit: what the review lists.
    const rcpt = await h.api("admin", "POST", "/payments", { customerId, amount: 500, paidAt: RECEIPT_DATE, bankAccountId: bank.body.id, classification: "unknown" });
    ok(rcpt, 201);
    receiptId = rcpt.body.id;
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("🔴 a real as_of is answered with its own frame, and the frame moves the answer", async () => {
    const inFrame = await review("as_of=2026-08-31");
    ok(inFrame, 200);
    const before = await review("as_of=2026-08-14");
    ok(before, 200);
    expect([inFrame.body.asOf, holds(inFrame.body)], "as_of 2026-08-31 frames the 15 August receipt in").toEqual(["2026-08-31", true]);
    expect([before.body.asOf, holds(before.body)], "as_of 2026-08-14 frames it out").toEqual(["2026-08-14", false]);
  });

  it("🔴 a real period_to is answered as the end of that month, and the frame moves the answer", async () => {
    const august = await review("period_to=2026-08");
    ok(august, 200);
    const july = await review("period_to=2026-07");
    ok(july, 200);
    expect([august.body.asOf, holds(august.body)], "period_to 2026-08 → 2026-08-31, receipt in").toEqual(["2026-08-31", true]);
    expect([july.body.asOf, holds(july.body)], "period_to 2026-07 → 2026-07-31, receipt out").toEqual(["2026-07-31", false]);
  });

  it("a malformed value is refused 400 — including the literal the broken pattern admits", async () => {
    const statuses = {
      asOfWord: (await review("as_of=banana")).status,
      asOfLiteral: (await review("as_of=dddd-dd-dd")).status,
      asOfShort: (await review("as_of=2026-8-31")).status,
      periodWord: (await review("period_to=banana")).status,
      periodLiteral: (await review("period_to=dddd-dd")).status,
      periodShort: (await review("period_to=2026-8")).status,
    };
    expect(statuses).toEqual({ asOfWord: 400, asOfLiteral: 400, asOfShort: 400, periodWord: 400, periodLiteral: 400, periodShort: 400 });
  });
});
