/**
 * AI-3b — explanations: generate-then-verify, with the verifier itself
 * proven to FAIL (the owner's requirement — a verifier that never rejects
 * anything is the vacuous-green pattern in the safety check itself, which
 * has bitten twice).
 *
 * The proofs demanded:
 *   - an explanation containing a number ABSENT from the facts is rejected,
 *     in both scripts, and the rejection telemetry distinguishes the token,
 *     its script and its normalized form (invention vs normalisation bug);
 *   - a REAL number in a different format than emitted is ACCEPTED, in both
 *     directions (Arabic-Indic token ↔ Western fact; Western token ↔
 *     Arabic-Indic digits inside a fact string) — a false rejection here is
 *     a normalisation bug wearing a safety catch's clothes;
 *   - normalizeDigits stays behaviorally equivalent to receiptParser's
 *     canonical copy (pinned against its cases);
 *   - the deterministic floor: a throwing provider, a rejected output, a
 *     low-context refusal and a stale facts-hash all leave the finding
 *     rendering WITHOUT an explanation — never failing anything.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import {
  normalizeDigits,
  verifyExplanation,
  allowedNumberForms,
} from "../services/findings.explanationVerifier";
import { findingsExplainService, factsHash, substantiveFactCount } from "../services/findings.explain.service";
import { findingsService } from "../services/findings.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[findings-explain] no real DATABASE_URL — skipping DB half.");

// ── The verifier, pure ───────────────────────────────────────────────────────

describe("normalizeDigits — behavioral equivalence with receiptParser's canonical copy", () => {
  it("Arabic-Indic digits map to Western; U+066B maps to a dot", () => {
    expect(normalizeDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(normalizeDigits("١١٥٠٫٥٠")).toBe("1150.50");
    expect(normalizeDigits("SAR 115")).toBe("SAR 115");
  });
});

describe("the verifier — proven to fail, and proven not to false-fail", () => {
  const facts = {
    billIds: [12, 13],
    billNumbers: ["A5-1", "INV-2026-000044"],
    vendorId: 7,
    date: "2026-08-01",
    total: 1150,
    count: 2,
    descriptionAr: "فاتورة رقم ١١٢",
  };

  it("🔴 rejects an invented WESTERN number, with distinguishing telemetry", () => {
    const v = verifyExplanation("Two bills of 9999 were found.", facts);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("invented_number");
    expect(v.token).toBe("9999");
    expect(v.script).toBe("western");
    expect(v.normalized).toBe("9999");
  });

  it("🔴 rejects an invented ARABIC-INDIC number, script recorded", () => {
    const v = verifyExplanation("وُجدت فاتورتان بمبلغ ٩٩٩٩ ريال.", facts);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("invented_number");
    expect(v.script).toBe("arabic-indic");
    expect(v.normalized).toBe("9999");
  });

  it("🔴 ACCEPTS a real number in a different format — Arabic-Indic token against a Western fact", () => {
    expect(verifyExplanation("المبلغ ١١٥٠ ريال مكرر مرتين.", facts).ok).toBe(true);
    expect(verifyExplanation("المبلغ ١٬١٥٠٫٠٠ ريال.", facts).ok).toBe(true);
  });

  it("🔴 ACCEPTS the reverse — a Western token against Arabic-Indic digits inside a fact string", () => {
    expect(verifyExplanation("Refers to invoice 112 as stated.", facts).ok).toBe(true);
  });

  it("accepts separator/decimal variants and date components of real facts", () => {
    expect(verifyExplanation("Two bills of 1,150.00 dated 1 August 2026.", facts).ok).toBe(true);
    expect(verifyExplanation("On 01.08.2026 there were 2 bills.", facts).ok).toBe(true);
  });

  it("entities: a real identifier passes; an invented one or an invented quoted name is rejected", () => {
    expect(verifyExplanation('Bill "INV-2026-000044" appears twice.', facts).ok).toBe(true);
    const forgedId = verifyExplanation("See INV-2026-000099 for details.", facts);
    expect(forgedId).toMatchObject({ ok: false, reason: "invented_number" });
    const forgedName = verifyExplanation('Vendor «شركة الوهم» billed twice.', { ...facts, total: 99 });
    expect(forgedName).toMatchObject({ ok: false, reason: "invented_entity" });
  });

  it("allowedNumberForms licenses 2dp variants of numeric facts", () => {
    const allowed = allowedNumberForms({ total: 115 });
    expect(allowed.has("115")).toBe(true); // both 115 and 115.00 canonicalize here
  });
});

describe("eligibility and hashing", () => {
  it("substantiveFactCount counts non-null values", () => {
    expect(substantiveFactCount({ a: 1, b: "x", c: null })).toBe(2);
  });
  it("factsHash is stable under key order and changes with values", () => {
    expect(factsHash({ a: 1, b: 2 })).toBe(factsHash({ b: 2, a: 1 }));
    expect(factsHash({ a: 1 })).not.toBe(factsHash({ a: 2 }));
  });
});

// ── The service, with an injected model ─────────────────────────────────────

const SLUG = "ai3b-explain";

describeMaybe("AI-3b — generation, rejection, and the deterministic floor", () => {
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
    await pool.query(`DELETE FROM finding_runs WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM findings WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  const FACTS = { transactionId: 42, date: "2026-08-02", amount: 250, description: "FN SAME ROW", count: 2 };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('E Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'E','1010101023','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO findings (organization_id, kind, ref_key, facts) VALUES ($1,'duplicate_transaction','t:42',$2)`,
      [orgId, JSON.stringify(FACTS)],
    );
  });

  afterAll(cleanup);

  const VALID = JSON.stringify({
    en: "2 accepted rows share the date 2026-08-02, the amount 250 and the description FN SAME ROW.",
    ar: "معاملتان مقبولتان تتطابقان في التاريخ 2026-08-02 والمبلغ ٢٥٠ والوصف FN SAME ROW.",
  });
  const CLEAN_JUDGE = JSON.stringify({ invented: [] });

  it("a valid, judged-clean explanation is stored and returned by the list API", async () => {
    let calls = 0;
    const r = await inTenant(() =>
      findingsExplainService.explainOpenFindings({
        chat: async () => (++calls === 1 ? VALID : CLEAN_JUDGE),
      }),
    );
    expect(r).toMatchObject({ attempted: 1, generated: 1, unavailable: 0 });
    const { findings } = await inTenant(() => findingsService.list({}, orgId));
    expect(findings[0].explanation).toMatchObject({ en: expect.stringContaining("250") });
  });

  it("🔴 stale facts WITHHOLD the explanation — invention by aging is barred at the API", async () => {
    await pool.query(`UPDATE findings SET facts = $2 WHERE organization_id = $1`, [
      orgId,
      JSON.stringify({ ...FACTS, amount: 300 }),
    ]);
    const { findings } = await inTenant(() => findingsService.list({}, orgId));
    expect(findings[0].explanation).toBeNull(); // stored but not current → floor
    await pool.query(`UPDATE findings SET facts = $2, explanation = NULL WHERE organization_id = $1`, [
      orgId,
      JSON.stringify(FACTS),
    ]);
  });

  it("🔴 a model output with an invented number is DISCARDED and counted by reason", async () => {
    const r = await inTenant(() =>
      findingsExplainService.explainOpenFindings({
        chat: async () => JSON.stringify({ en: "About 9,999 was involved on 2026-08-02.", ar: "المبلغ ٩٩٩٩ تقريبًا." }),
      }),
    );
    expect(r.generated).toBe(0);
    expect(r.rejected.invented_number).toBe(1);
    const { rows } = await pool.query(`SELECT explanation FROM findings WHERE organization_id = $1`, [orgId]);
    expect(rows[0].explanation).toBeNull();
  });

  it("🔴 a judge-flagged output is discarded (the argued class)", async () => {
    let calls = 0;
    const r = await inTenant(() =>
      findingsExplainService.explainOpenFindings({
        chat: async () => (++calls === 1 ? VALID : JSON.stringify({ invented: ["implies a double payment risk"] })),
      }),
    );
    expect(r.generated).toBe(0);
    expect(r.rejected.judge_flagged).toBe(1);
  });

  it("missing Arabic is a rejection — both languages or neither (the Arabic gate at feature level)", async () => {
    const r = await inTenant(() =>
      findingsExplainService.explainOpenFindings({
        chat: async () => JSON.stringify({ en: "2 rows share 250 on 2026-08-02." }),
      }),
    );
    expect(r.rejected.parse_failed).toBe(1);
  });

  it("🔴 the deterministic floor: a THROWING provider is counted, nothing fails, the finding still lists", async () => {
    const r = await inTenant(() =>
      findingsExplainService.explainOpenFindings({
        chat: async () => {
          throw new Error("provider down");
        },
      }),
    );
    expect(r.unavailable).toBe(1);
    const { findings } = await inTenant(() => findingsService.list({}, orgId));
    expect(findings).toHaveLength(1);
    expect(findings[0].explanation).toBeNull();
  });

  it("🔴 low-context refusal: a two-fact finding gets NO attempt — the chat is never called", async () => {
    await pool.query(
      `INSERT INTO findings (organization_id, kind, ref_key, facts) VALUES ($1,'stale_draft','thin:1',$2)`,
      [orgId, JSON.stringify({ id: 9, ageDays: 20 })],
    );
    let calls = 0;
    const r = await inTenant(() =>
      findingsExplainService.explainOpenFindings({
        chat: async () => {
          calls += 1;
          throw new Error("should not be called for the thin finding");
        },
      }),
    );
    expect(r.refusedLowContext).toBe(1);
    // Exactly one call-attempt pair belongs to the RICH finding; the thin one made none.
    expect(r.attempted).toBe(1);
    await pool.query(`DELETE FROM findings WHERE organization_id = $1 AND ref_key = 'thin:1'`, [orgId]);
  });
});
