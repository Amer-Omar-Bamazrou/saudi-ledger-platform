/**
 * 🔴 G16 GATE (owner decisions 2026-10-23 afternoon, item 3, decision 4): before
 * the freeze is built to refuse AT COMMIT, prove through a real API request
 * that a refusal raised at COMMIT is answered as an ERROR and never as a 2xx —
 * the O-6 class ("a 2xx after a rollback") must not be reachable this way.
 *
 * The mechanism under test is the request pipeline, not any one trigger:
 * `lib/tenant.ts` + `lib/responseCommit.ts` settle the request's transaction
 * BEFORE the first byte of the response. A deferred constraint trigger's
 * refusal makes the COMMIT itself raise, and that is answered with the
 * refusal's own 4xx (or a 500 `commit_failed`) — never the handler's status.
 * O-6 is the other shape: a STATEMENT error caught by application code, after
 * which COMMIT answers ROLLBACK without raising. A deferred refusal raises no
 * statement error, so there is nothing for a catch to swallow.
 *
 * The instrument: `wht_payable_line_owned` (0113/0117), today's deferred
 * constraint trigger that a product request can reach — a manual journal line
 * on WHT_PAYABLE that no WHT record owns. The handler (`journalEntries.controller`
 * `create`) has already chosen 201 when the refusal arrives, so a 2xx here would
 * be exactly the defect. G16's own triggers cannot be reached by a legitimate
 * request (no product path updates or deletes a posted entry), so the pipeline
 * is proven with the one that can. G16's names are deliberately NOT in
 * `lib/dbRefusals.ts` (PR C's freeze names are not either): reaching one is a
 * defect, so it is answered 500 `commit_failed` and paged, never a 2xx.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder. The database is
 * only READ by the test itself.
 */
process.env.PORT ??= "3221";
process.env.SESSION_SECRET ??= "phase18-g16-commit-refusal-gate-proof-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "G16CommitRefusalGatePw123!";
const DATE = "2026-10-01";

describeMaybe("G16 gate — a refusal raised AT COMMIT is an error response, never a 2xx", () => {
  const h = g04Harness("p18g16gate");
  let orgId = "";
  let bankLeaf = 0;

  const account = async (code: string) => Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id);
  const footprint = async () => {
    const n = async (sql: string) => Number((await pool.query(sql, [orgId])).rows[0].n);
    return {
      entries: await n(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`),
      lines: await n(`SELECT count(*)::int AS n FROM journal_entry_lines WHERE organization_id = $1`),
      audit: await n(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND entity_type = 'journal_entry'`),
    };
  };

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "G16 Gate Co", "318181818181894");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "Gate Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    bankLeaf = Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND bank_account_id = $2`, [orgId, bank.body.id])).rows[0].id);
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("🔴 the instrument refuses AT COMMIT: wht_payable_line_owned is a deferred constraint trigger", async () => {
    const { rows } = await pool.query(`SELECT tgdeferrable, tginitdeferred FROM pg_trigger WHERE tgname = 'wht_payable_line_owned'`);
    expect(rows, "one trigger, deferrable and initially deferred").toEqual([{ tgdeferrable: true, tginitdeferred: true }]);
  });

  it("🔴 a request whose COMMIT is refused is answered with the refusal (4xx), never a 2xx, and leaves no entry, line or audit row", async () => {
    const before = await footprint();
    const refused = await h.api("admin", "POST", "/journal-entries", { date: DATE, description: "G16 gate: refused at COMMIT", lines: [
      { accountId: await account("WHT_PAYABLE"), accountName: "WHT payable", debitAmount: 100, creditAmount: 0 },
      { accountId: bankLeaf, accountName: "Gate Ops", debitAmount: 0, creditAmount: 100 },
    ] });
    console.warn("[G16 GATE] refused", JSON.stringify({ status: refused.status, body: refused.body }));
    expect(refused.status >= 200 && refused.status < 300, `never a 2xx: ${JSON.stringify(refused.body)}`).toBe(false);
    expect([refused.status, refused.body?.code], "the refusal's own answer, not the handler's 201").toEqual([422, "wht_payable_unowned"]);
    expect(await footprint(), "nothing written").toEqual(before);
  });

  it("the instrument sees a success: the same request on an ordinary account is a 201 and writes", async () => {
    const before = await footprint();
    const ok = await h.api("admin", "POST", "/journal-entries", { date: DATE, description: "G16 gate: control", lines: [
      { accountId: await account("OFFICE_SUPPLIES"), accountName: "Office", debitAmount: 100, creditAmount: 0 },
      { accountId: bankLeaf, accountName: "Gate Ops", debitAmount: 0, creditAmount: 100 },
    ] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const after = await footprint();
    // Each part of the footprint MOVES here, so its absence above is not vacuous.
    expect([after.entries - before.entries, after.lines - before.lines, after.audit - before.audit]).toEqual([1, 2, 1]);
  });
});
