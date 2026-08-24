/**
 * AI-6a — grounded answers: the model selects and renders, never authors or
 * advises; every exchange is a stored, auditable row.
 *
 * The properties that matter:
 *   1. 🔴 The assumption rule is a REJECTION, not a style preference — a
 *      projection answer without its assumption sentence (either language)
 *      is refused, and the rejected text is NOT stored.
 *   2. 🔴 The opinion register does not exist: judged advice refuses.
 *   3. 🔴 The liquidity-claim rule carries over: a runway projection on
 *      blocked cash is WITHHELD with the blockers named, not computed
 *      anyway.
 *   4. Refusal is a feature and a row; unavailability is an honest 503 and
 *      NOT a row (no exchange happened).
 *   5. The record is append-only at the grants.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool, PERMISSION_MATRIX } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { askService, ASK_TOOLS, RUNWAY_ASSUMPTION_EN, RUNWAY_ASSUMPTION_AR } from "../services/ask.service";
import { transactionPostingService } from "../services/transactionPosting.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[ask] no real DATABASE_URL — skipping.");

const SLUG = "ai6a-ask";

describeMaybe("AI-6a — grounded answers", () => {
  let orgId = "";
  let companyId = "";

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId: null, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(`DELETE FROM grounded_answers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM transactions WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Ask Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'ASK','1010101024','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
  });

  afterAll(cleanup);

  const seq = (...replies: string[]) => {
    let i = 0;
    return async () => replies[Math.min(i++, replies.length - 1)];
  };

  const SEL_RUNWAY = JSON.stringify({ tool: "runway_projection", args: { addedMonthlyCost: 8000 } });
  const CLEAN_JUDGE = JSON.stringify({ violations: [] });
  const GOOD_RUNWAY_ANSWER = JSON.stringify({
    en: `Your GL cash is 0 and the trailing 6-month average net movement is 0; an added cost of 8,000 per month reaches zero cash in 0 months, ${RUNWAY_ASSUMPTION_EN}.`,
    ar: `النقد لديك 0 ومتوسط صافي الحركة عبر 6 أشهر هو 0؛ تكلفة إضافية قدرها ٨٠٠٠ شهريًا تصل بالنقد إلى الصفر خلال 0 شهر، ${RUNWAY_ASSUMPTION_AR}.`,
  });

  it("a verified projection answer is returned and STORED, assumption inline", async () => {
    const r = await inTenant(() =>
      askService.ask("what would hiring at 8000/month do to my cash?", null, {
        chat: seq(SEL_RUNWAY, GOOD_RUNWAY_ANSWER, CLEAN_JUDGE),
      }),
    );
    expect(r.refused).toBe(false);
    expect(r.toolUsed).toBe("runway_projection");
    expect(r.answer!.en).toContain(RUNWAY_ASSUMPTION_EN);
    expect(r.answer!.ar).toContain(RUNWAY_ASSUMPTION_AR);
    const { rows } = await pool.query(
      `SELECT tool, refused, answer FROM grounded_answers WHERE organization_id = $1 ORDER BY id DESC LIMIT 1`,
      [orgId],
    );
    expect(rows[0]).toMatchObject({ tool: "runway_projection", refused: false });
    expect(rows[0].answer.en).toContain("8,000");
  });

  it("🔴 the assumption rule: the SAME numbers without the assumption sentence are REJECTED, and the rejected text is NOT stored", async () => {
    const NO_ASSUMPTION = JSON.stringify({
      en: "Your cash is 0; an added 8,000 per month reaches zero in 0 months.",
      ar: "نقدك 0؛ تكلفة ٨٠٠٠ شهريًا تصل بالنقد إلى الصفر خلال 0 شهر.",
    });
    const r = await inTenant(() =>
      askService.ask("can I afford 8000/month?", null, { chat: seq(SEL_RUNWAY, NO_ASSUMPTION, CLEAN_JUDGE) }),
    );
    expect(r.refused).toBe(true);
    expect(r.refusalReason).toBe("answer_rejected:assumption_missing");
    const { rows } = await pool.query(
      `SELECT refused, refusal_reason, answer FROM grounded_answers WHERE organization_id = $1 ORDER BY id DESC LIMIT 1`,
      [orgId],
    );
    expect(rows[0]).toMatchObject({ refused: true, refusal_reason: "answer_rejected:assumption_missing", answer: null });
  });

  it("🔴 an invented number refuses with the distinguishable reason", async () => {
    const INVENTED = JSON.stringify({
      en: `Your cash is 123456 and an added 8,000 reaches zero in 0 months, ${RUNWAY_ASSUMPTION_EN}.`,
      ar: `نقدك 123456، ${RUNWAY_ASSUMPTION_AR}.`,
    });
    const r = await inTenant(() =>
      askService.ask("runway?", null, { chat: seq(SEL_RUNWAY, INVENTED, CLEAN_JUDGE) }),
    );
    expect(r.refusalReason).toBe("answer_rejected:invented_number");
  });

  it("🔴 the opinion register does not exist: judged advice refuses", async () => {
    const OPINION_JUDGE = JSON.stringify({ violations: ['"you can comfortably afford this" is advice'] });
    const r = await inTenant(() =>
      askService.ask("should I hire?", null, { chat: seq(SEL_RUNWAY, GOOD_RUNWAY_ANSWER, OPINION_JUDGE) }),
    );
    expect(r.refused).toBe(true);
    expect(r.refusalReason).toBe("answer_rejected:opinion_or_invention");
  });

  it("a model refusal is an honest, STORED answer", async () => {
    const r = await inTenant(() =>
      askService.ask("what will the oil price be next year?", null, {
        chat: seq(JSON.stringify({ refuse: true, reason: "not answerable from the books" })),
      }),
    );
    expect(r).toMatchObject({ refused: true, refusalReason: "your_books_cannot_answer", answer: null });
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM grounded_answers WHERE organization_id = $1 AND refusal_reason = 'your_books_cannot_answer'`,
      [orgId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("🔴 the liquidity-claim rule carries over: runway on BLOCKED cash is withheld with the blockers named", async () => {
    // An accepted, undeclared transfer posts to Transfers awaiting
    // declaration (A) — exactly the blocked-cash state the hub withholds on.
    const { rows } = await pool.query(
      `INSERT INTO transactions (organization_id, company_id, date, description, amount, type, kind, review_status)
       VALUES ($1,$2,'2026-08-01','ASK MYSTERY TRANSFER','5000.00','debit','transfer','accepted') RETURNING id`,
      [orgId, companyId],
    );
    await inTenant(() => transactionPostingService.postMany([Number(rows[0].id)]));

    const out = await inTenant(() => ASK_TOOLS.runway_projection.run({ addedMonthlyCost: 8000 }));
    expect(out.blocked).toBe(true);
    expect((out.blockers as Array<{ code: string }>).map((b) => b.code)).toContain("undeclared_transfers");
    expect(out).not.toHaveProperty("monthsToZero");
  });

  it("grants: the record is append-only, and asking is write-level", async () => {
    const { rows } = await pool.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'grounded_answers' AND grantee = 'authenticated' ORDER BY privilege_type`,
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT"]);

    const has = (role: string, action: string) =>
      PERMISSION_MATRIX.some((p) => p.role === role && p.resource === "ask" && p.action === action);
    for (const role of ["admin", "accountant", "bookkeeper", "viewer"]) expect(has(role, "read"), `${role} read`).toBe(true);
    for (const role of ["admin", "accountant", "bookkeeper"]) expect(has(role, "create"), `${role} create`).toBe(true);
    expect(has("viewer", "create")).toBe(false);
  });
});
