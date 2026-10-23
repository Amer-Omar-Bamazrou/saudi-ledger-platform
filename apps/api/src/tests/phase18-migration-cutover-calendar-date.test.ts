/**
 * 🔴 PROOF (Phase 18, owner approval 2026-10-22 item 3c; proof first): a
 * migration batch's cutover date must be a REAL calendar day.
 *
 * The mechanism (main at `ed0bc424`): `migration.service.ts` `createBatch` checks
 * `cutoverDate` with `ISO_DATE.test(..) && !Number.isNaN(Date.parse(..))`.
 * `Date.parse` does not refuse an impossible day — it rolls it over
 * (`2026-02-31` → 3 March), so the check admits it. Measured on main: the
 * INSERT into `migration_batches` then fails in Postgres ("date/time field
 * value out of range"), and the client gets a bare 500 instead of the 400 that
 * names the field. G18 defined "a real calendar day" once (`isCalendarDate`,
 * `@workspace/shared`); this check never asked it.
 *
 * What this file asserts, fix-neutral:
 *  1. a shape-valid but impossible cutover (31 February, 29 February in a
 *     common year, 31 April) is refused 400, and NO batch row is written;
 *  2. the instrument sees a success: a real cutover (28 February) is created
 *     201 with the opening date the day before — so the refusals above are not
 *     an endpoint that refuses everything.
 *
 * Everything is the PRODUCT's own HTTP path; the database is only READ.
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3218";
process.env.SESSION_SECRET ??= "phase18-migration-cutover-calendar-proof-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "MigrationCutoverDatePw123!";

describeMaybe("Migration cutover — a calendar-invalid cutover date is refused", () => {
  const h = g04Harness("p18mcd");
  let orgId = "";

  const batches = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM migration_batches WHERE organization_id = $1`, [orgId])).rows[0].n);

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "Migration Cutover Date Co", "318181818181898");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("🔴 31 February, 29 February 2026 and 31 April are refused 400, and no batch is written", async () => {
    const before = await batches();
    const attempts: Record<string, { status: number; body: unknown }> = {};
    for (const cutoverDate of ["2026-02-31", "2026-02-29", "2026-04-31"]) {
      attempts[cutoverDate] = await h.api("admin", "POST", "/migration/batches", { sourceSystem: "PreviousERP", cutoverDate });
    }
    console.warn("[MIGRATION CUTOVER DATE]", JSON.stringify(attempts));
    expect(Object.fromEntries(Object.entries(attempts).map(([d, r]) => [d, r.status]))).toEqual({ "2026-02-31": 400, "2026-02-29": 400, "2026-04-31": 400 });
    expect(await batches(), "no batch row for a day that does not exist").toBe(before);
  });

  it("the instrument sees a success: a real cutover (28 February) is created, opening the day before", async () => {
    const before = await batches();
    const created = await h.api("admin", "POST", "/migration/batches", { sourceSystem: "PreviousERP", cutoverDate: "2026-02-28" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect([created.body.cutoverDate, created.body.openingDate]).toEqual(["2026-02-28", "2026-02-27"]);
    expect(await batches()).toBe(before + 1);
  });
});
