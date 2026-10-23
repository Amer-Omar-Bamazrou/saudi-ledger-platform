/**
 * 🔴 PROOF (Phase 18, owner decisions 2026-10-23 afternoon, item 2; proof first):
 * a shape-valid date that names no real day is REFUSED with 400 wherever a
 * request names one, by G18's one definition (`isCalendarDate`,
 * `@workspace/shared`).
 *
 * The mechanism (main at `eafe7ded`): four checks test the SHAPE
 * (`\d{4}-\d{2}-\d{2}` / `\d{4}-\d{2}`) and then `Date.parse`, which rolls
 * `2026-02-31` into March instead of refusing it:
 *  - `payments.controller.ts` deposit review: `as_of`, `period_to` (fix 3b
 *    restored the pattern; an impossible day or month still passed it);
 *  - `migration.service.ts` `updateBatch`: `vatPosition.periodStart/periodEnd`;
 *  - `migrationStaging.service.ts` `isIsoDate`: the staged rows' dates (open
 *    items `issueDate`/`dueDate`, advances `receivedAt`, ...);
 *  - `tax/zakatClassification.service.ts` `list`: `asOf`.
 *
 * What this file asserts, fix-neutral: each impossible value is a 400 whose
 * message names the field, and nothing is staged for it; each area's CONTROL —
 * a real date through the same request — succeeds, so the refusals are not an
 * endpoint that refuses everything.
 *
 * Everything is the PRODUCT's own HTTP path; the database is only READ.
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3220";
process.env.SESSION_SECRET ??= "phase18-calendar-date-followup-proof-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "CalendarDateFollowupPw123!";

describeMaybe("Calendar-date follow-up — an impossible day or month is a 400 that names the field", () => {
  const h = g04Harness("p18cdf");
  let orgId = "";
  let batchId = 0;

  const status = (r: { status: number; body: any }) => ({ status: r.status, error: r.body?.error ?? null });
  const staged = async (table: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE batch_id = $1`, [batchId])).rows[0].n);

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "Calendar Date Followup Co", "318181818181895");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    const batch = await h.api("admin", "POST", "/migration/batches", { sourceSystem: "PreviousERP", cutoverDate: "2026-07-01" });
    expect(batch.status, JSON.stringify(batch.body)).toBe(201);
    batchId = batch.body.id;
    const parties = await h.api("admin", "PUT", `/migration/batches/${batchId}/parties`, { rows: [{ partyType: "customer", sourceId: "C1", name: "Alpha" }] });
    expect(parties.status, JSON.stringify(parties.body)).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("🔴 deposit review: an impossible as_of day or period_to month is a 400; real ones are answered", async () => {
    const review = (q: string) => h.api("admin", "GET", `/payments/deposit-review?${q}`);
    const out = {
      asOfFeb31: status(await review("as_of=2026-02-31")),
      asOfMonth13: status(await review("as_of=2026-13-01")),
      periodMonth13: status(await review("period_to=2026-13")),
      periodMonth00: status(await review("period_to=2026-00")),
    };
    console.warn("[CALENDAR FOLLOWUP] deposit review", JSON.stringify(out));
    expect(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.status]))).toEqual({ asOfFeb31: 400, asOfMonth13: 400, periodMonth13: 400, periodMonth00: 400 });
    expect([out.asOfFeb31.error, out.asOfMonth13.error]).toEqual(["as_of must be YYYY-MM-DD", "as_of must be YYYY-MM-DD"]);
    expect([out.periodMonth13.error, out.periodMonth00.error]).toEqual(["period_to must be YYYY-MM", "period_to must be YYYY-MM"]);
    const real = await review("as_of=2026-02-28");
    const month = await review("period_to=2026-02");
    expect([real.status, real.body.asOf, month.status, month.body.asOf]).toEqual([200, "2026-02-28", 200, "2026-02-28"]);
  });

  it("🔴 migration VAT position: an impossible period start or end is a 400; real dates are recorded", async () => {
    const vat = (periodStart: string, periodEnd: string) =>
      h.api("admin", "PATCH", `/migration/batches/${batchId}`, { vatPosition: { returnReference: "VAT-2026-Q2", periodStart, periodEnd, outputVatPayable: 0, inputVatReceivable: 0 } });
    const out = { start: status(await vat("2026-02-31", "2026-06-30")), end: status(await vat("2026-04-01", "2026-04-31")) };
    console.warn("[CALENDAR FOLLOWUP] vat position", JSON.stringify(out));
    expect(out).toEqual({
      start: { status: 400, error: "vatPosition.periodStart must be YYYY-MM-DD." },
      end: { status: 400, error: "vatPosition.periodEnd must be YYYY-MM-DD." },
    });
    expect((await pool.query(`SELECT vat_position FROM migration_batches WHERE id = $1`, [batchId])).rows[0].vat_position, "nothing recorded").toBeNull();
    const real = await vat("2026-04-01", "2026-06-30");
    expect(real.status, JSON.stringify(real.body)).toBe(200);
  });

  it("🔴 staged rows: an impossible issue, due or received date is a 400 and nothing is staged; a real one stages", async () => {
    const item = (issueDate: string, dueDate: string) =>
      h.api("admin", "PUT", `/migration/batches/${batchId}/open-items`, { rows: [
        { itemType: "ar", sourceId: "SI-1", partySourceId: "C1", documentNumber: "INV-1", issueDate, dueDate, originalAmount: 1000, outstandingAmount: 1000 },
      ] });
    const advance = (receivedAt: string) =>
      h.api("admin", "PUT", `/migration/batches/${batchId}/advances`, { rows: [
        { sourceId: "ADV-1", partySourceId: "C1", bankSourceCode: "1100", amount: 150, receivedAt, vatPosition: "unknown" },
      ] });
    const out = {
      issue: status(await item("2026-02-31", "2026-03-31")),
      due: status(await item("2026-06-01", "2026-06-31")),
      received: status(await advance("2026-02-30")),
    };
    console.warn("[CALENDAR FOLLOWUP] staged rows", JSON.stringify(out));
    expect(out).toEqual({
      issue: { status: 400, error: "rows[0].issueDate must be YYYY-MM-DD." },
      due: { status: 400, error: "rows[0].dueDate must be YYYY-MM-DD." },
      received: { status: 400, error: "rows[0].receivedAt must be YYYY-MM-DD." },
    });
    expect([await staged("migration_open_items"), await staged("migration_advances")], "nothing staged for a day that does not exist").toEqual([0, 0]);
    const real = await item("2026-06-01", "2026-06-30");
    expect(real.status, JSON.stringify(real.body)).toBe(200);
    expect(await staged("migration_open_items")).toBe(1);
  });

  it("🔴 zakat classifications: an impossible asOf is a 400; a real one is answered", async () => {
    const out = {
      feb31: status(await h.api("admin", "GET", "/tax/zakat/classifications?asOf=2025-02-31")),
      month13: status(await h.api("admin", "GET", "/tax/zakat/classifications?asOf=2025-13-01")),
    };
    console.warn("[CALENDAR FOLLOWUP] zakat asOf", JSON.stringify(out));
    expect(out).toEqual({
      feb31: { status: 400, error: "asOf must be a YYYY-MM-DD date." },
      month13: { status: 400, error: "asOf must be a YYYY-MM-DD date." },
    });
    expect((await h.api("admin", "GET", "/tax/zakat/classifications?asOf=2025-12-31")).status).toBe(200);
  });
});
