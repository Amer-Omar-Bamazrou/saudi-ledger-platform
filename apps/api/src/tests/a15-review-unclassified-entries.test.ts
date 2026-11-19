/**
 * 🔴 A15 REVIEW (owner decisions 2026-11-17 and 2026-11-19; migration 0164) — THE UNCLASSIFIED-ENTRIES REVIEW.
 *
 *  - The list: every entry of THIS organisation the 0163 back-fill left `legacy_unclassified`, with the back-fill's
 *    evidence, the candidates 0163's rules find today and the review status — read by an admin or an accountant only,
 *    and never another organisation's (presence, absence, and the other organisation seeing its own).
 *  - The act: an admin classifies an entry ONLY as a candidate the rules confirm at that moment; never `manual` (that
 *    waits for an accountant-approved policy); each refusal by code, in English and Arabic, changing nothing.
 *  - What a classification changes: the two tag columns and nothing else; the review is recorded (owner-only,
 *    append-only); an unclassified DRAFT, once classified, is approved like any other draft.
 *  - Who can write the tag: only the review function. The application's role cannot, whatever it declares; the owner
 *    cannot without the review declared and its record holding the same change; and the freeze still refuses any
 *    other column on a posted entry.
 *
 * DB-backed; skips without a database. Red on main 61e691ae (assertion failures), green with 0164.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeMaybe = url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "A15ReviewScreenPw1!";
const DATE = "2026-10-05";
const ARABIC = /[؀-ۿ]/;
const REVIEW_SETTING = "app.journal_source_review";

type Client = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; release: () => void };
type Outcome = { ok: true; rows: any[] } | { ok: false; code?: string; constraint?: string; message: string };

const outcome = async (p: Promise<{ rows: any[] }>): Promise<Outcome> => {
  try {
    return { ok: true, rows: (await p).rows };
  } catch (e) {
    const err = e as { code?: string; constraint?: string; message: string; cause?: { code?: string; constraint?: string } };
    return { ok: false, code: err.code ?? err.cause?.code, constraint: err.constraint ?? err.cause?.constraint, message: err.message };
  }
};

describeMaybe("A15 review — the unclassified-entries review screen's route and its database (migration 0164)", () => {
  const h = g04Harness("a15rev");
  let orgId = "", companyId = "", otherOrgId = "", otherCompanyId = "";
  let adminId = 0, accountantId = 0, bookkeeperId = 0, otherAdminId = 0;
  let office = 0, income = 0, otherOffice = 0, otherIncome = 0;
  let mirrored = 0; // a posted manual entry the planted mirrors point at
  let noEvidence = 0, postedMirror = 0, draftMirror = 0, otherOrgEntry = 0, manualEntry = 0;
  let seq = 0;
  const num = (p: string) => `${p}-${++seq}`;

  const account = async (org: string, code: string) =>
    Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [org, code])).rows[0].id);
  const entry = async (id: number) => (await pool.query(`SELECT to_jsonb(j.*) AS j FROM journal_entries j WHERE id = $1`, [id])).rows[0].j as Record<string, any>;
  const withoutTags = (j: Record<string, any>) => { const { source_type: _t, source_id: _i, ...rest } = j; return rest; };
  const reviewCount = async (entryId: number) => outcome(pool.query(`SELECT count(*)::int AS n FROM journal_source_reviews WHERE journal_entry_id = $1`, [entryId]));

  /**
   * A `legacy_unclassified` entry as the 0163 back-fill leaves one: the entry, two balanced lines and the back-fill's
   * own rule-U record. Only the back-fill writes the tag, so it is planted with triggers set aside.
   */
  async function plantLegacy(org: string, co: string, accounts: [number, number], opts: { status: "draft" | "posted"; reversalOf?: number | null; outcome: string }) {
    const c = (await pool.connect()) as unknown as Client;
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const n = num("A15REV");
      const { rows: [e] } = await c.query(
        `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status, posted_at, reversal_of, source_type)
         VALUES ($1, $2, $3, $4, 'planted legacy', $5, CASE WHEN $5 = 'posted' THEN now() END, $6, 'legacy_unclassified') RETURNING id`,
        [org, co, n, DATE, opts.status, opts.reversalOf ?? null]);
      await c.query(`INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
                     VALUES ($1, $2, $3, $4, 'Office', 40, 0), ($1, $2, $3, $5, 'Income', 0, 40)`, [org, co, e.id, accounts[0], accounts[1]]);
      await c.query(`INSERT INTO journal_source_backfill (organization_id, company_id, journal_entry_id, entry_number, entry_status, new_source_type, rule, evidence, migration_version)
                     VALUES ($1, $2, $3, $4, $5, 'legacy_unclassified', 'U', $6::jsonb, '0163_a15_source_tag_mandatory')`,
                     [org, co, e.id, n, opts.status, JSON.stringify({ outcome: opts.outcome, candidates: [] })]);
      await c.query("COMMIT");
      return e.id as number;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  /** As the application's role, in a tenant transaction that is always rolled back (a probe). */
  async function asApp(fn: (c: Client) => Promise<{ rows: any[] }>): Promise<Outcome> {
    const c = (await pool.connect()) as unknown as Client;
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authenticated");
      await c.query(`SELECT set_config('app.current_org_id', $1, true), set_config('app.current_company_id', $2, true), set_config('app.current_user_id', $3, true)`, [orgId, companyId, String(adminId)]);
      return await outcome(fn(c));
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }
  /** As the owner, in one transaction that COMMITS — so G16's checks, which run at commit, run. */
  async function ownerTx(statements: Array<[string, unknown[]?]>): Promise<Outcome> {
    const c = (await pool.connect()) as unknown as Client;
    try {
      await c.query("BEGIN");
      let last: { rows: any[] } = { rows: [] };
      for (const [s, p] of statements) last = await c.query(s, p ?? []);
      await c.query("COMMIT");
      return { ok: true, rows: last.rows };
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      const err = e as { code?: string; constraint?: string; message: string };
      return { ok: false, code: err.code, constraint: err.constraint, message: err.message };
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "A15 Review Co", "319191919191943");
    otherOrgId = await h.mkOrg("other");
    otherCompanyId = await h.mkCompany(otherOrgId, "A15 Review Other Co", "319191919191953");
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    accountantId = await h.mkUser("accountant", PW, orgId, "accountant");
    bookkeeperId = await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    otherAdminId = await h.mkUser("otheradmin", PW, otherOrgId, "admin");
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper", "otheradmin"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    office = await account(orgId, "OFFICE_SUPPLIES");
    income = await account(orgId, "SALES");
    otherOffice = await account(otherOrgId, "OFFICE_SUPPLIES");
    otherIncome = await account(otherOrgId, "SALES");
    // a posted manual entry, through the product, for the planted mirrors to point at — and to be refused as not unclassified
    const created = await h.api("admin", "POST", "/journal-entries", { date: DATE, description: "A15 review original", lines: [
      { accountId: office, accountName: "Office", debitAmount: 40, creditAmount: 0 }, { accountId: income, accountName: "Income", debitAmount: 0, creditAmount: 40 }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await h.api("accountant", "POST", `/journal-entries/${created.body.id}/approve`, {})).status).toBe(200);
    mirrored = created.body.id as number;
    manualEntry = mirrored;
    noEvidence = await plantLegacy(orgId, companyId, [office, income], { status: "posted", outcome: "no_authoritative_relationship" });
    postedMirror = await plantLegacy(orgId, companyId, [office, income], { status: "posted", reversalOf: mirrored, outcome: "ambiguous" });
    draftMirror = await plantLegacy(orgId, companyId, [office, income], { status: "draft", reversalOf: mirrored, outcome: "ambiguous" });
    otherOrgEntry = await plantLegacy(otherOrgId, otherCompanyId, [otherOffice, otherIncome], { status: "posted", outcome: "no_authoritative_relationship" });
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 the list shows THIS organisation's unclassified entries with their evidence and status — never another's, which sees its own", async () => {
    const r = await h.api("admin", "GET", "/journal-entries/unclassified");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const ids = (r.body.items ?? []).map((i: any) => i.id);
    expect(ids.sort(), "this organisation's three").toEqual([noEvidence, postedMirror, draftMirror].sort());
    expect(r.body.total).toBe(3);
    expect(ids, "never the other organisation's").not.toContain(otherOrgEntry);
    const byId = new Map<number, any>((r.body.items as any[]).map((i) => [i.id, i]));
    const none = byId.get(noEvidence);
    expect([none.reviewStatus, none.candidates, none.backfillOutcome, none.currentSourceType]).toEqual(["awaiting_policy", [], "no_authoritative_relationship", "legacy_unclassified"]);
    const posted = byId.get(postedMirror);
    expect(posted.reviewStatus, "the rules confirm reversal_of today").toBe("classifiable");
    expect(posted.candidates.map((c: any) => [c.rule, c.type, c.sourceId, c.checksPass, c.classifiable])).toEqual([["R", "reversal", mirrored, true, true]]);
    expect(posted.total).toBe(40);
    // the movement: the other organisation's admin sees exactly its own
    const other = await h.api("otheradmin", "GET", "/journal-entries/unclassified");
    expect(other.status).toBe(200);
    expect((other.body.items ?? []).map((i: any) => i.id)).toEqual([otherOrgEntry]);
  });

  it("🔴 an accountant reads the list; a bookkeeper is refused by code, in English and Arabic", async () => {
    expect((await h.api("accountant", "GET", "/journal-entries/unclassified")).status).toBe(200);
    const r = await h.api("bookkeeper", "GET", "/journal-entries/unclassified");
    expect([r.status, r.body?.code], JSON.stringify(r.body)).toEqual([403, "journal_source_review_forbidden"]);
    expect(String(r.body?.errorAr)).toMatch(ARABIC);
  });

  it("🔴 the act is refused, each by code and changing nothing: an accountant; manual; a source the rules do not confirm; another organisation's entry; an entry that is not unclassified", async () => {
    const before = await entry(postedMirror);
    for (const [who, id, body, status, code] of [
      ["accountant", postedMirror, { sourceType: "reversal", sourceId: mirrored }, 403, "journal_source_review_admin_only"],
      ["admin", noEvidence, { sourceType: "manual" }, 422, "journal_source_review_manual_needs_policy"],
      ["admin", postedMirror, { sourceType: "manual" }, 422, "journal_source_review_manual_needs_policy"],
      ["admin", noEvidence, { sourceType: "reversal", sourceId: mirrored }, 422, "journal_source_review_no_evidence"],
      ["admin", postedMirror, { sourceType: "invoice", sourceId: 1 }, 422, "journal_source_review_no_evidence"],
      ["admin", postedMirror, { sourceType: "reversal", sourceId: mirrored + 1000000 }, 422, "journal_source_review_no_evidence"],
      ["admin", postedMirror, { sourceType: "legacy_unclassified" }, 422, "journal_source_review_type_invalid"],
      ["admin", otherOrgEntry, { sourceType: "reversal", sourceId: mirrored }, 404, "journal_source_review_entry_not_found"],
      ["admin", manualEntry, { sourceType: "reversal", sourceId: mirrored }, 409, "journal_source_review_not_unclassified"],
    ] as const) {
      const r = await h.api(who, "POST", `/journal-entries/${id}/classify`, body);
      expect([r.status, r.body?.code], `${who} ${id} ${JSON.stringify(body)}: ${JSON.stringify(r.body)}`).toEqual([status, code]);
      expect(String(r.body?.error)).toMatch(/[A-Za-z]/);
      expect(String(r.body?.errorAr)).toMatch(ARABIC);
    }
    expect(await entry(postedMirror), "nothing changed").toEqual(before);
    for (const id of [noEvidence, postedMirror, otherOrgEntry]) {
      const n = await reviewCount(id);
      expect(n.ok && n.rows[0].n, `no review recorded for ${id}`).toBe(0);
    }
  });

  it("🔴 an admin classifies a posted entry as the confirmed candidate: only the two tag columns change, the review is recorded, and a second act is refused", async () => {
    const before = await entry(postedMirror);
    const r = await h.api("admin", "POST", `/journal-entries/${postedMirror}/classify`, { sourceType: "reversal", sourceId: mirrored });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect([r.body.reviewStatus, r.body.currentSourceType, r.body.currentSourceId, r.body.review?.newSourceType, r.body.review?.newSourceId, r.body.review?.rule])
      .toEqual(["classified", "reversal", mirrored, "reversal", mirrored, "R"]);
    const after = await entry(postedMirror);
    expect([after.source_type, after.source_id]).toEqual(["reversal", mirrored]);
    expect(withoutTags(after), "every other column exactly as posted").toEqual(withoutTags(before));
    const rec = await outcome(pool.query(`SELECT previous_source_type, new_source_type, new_source_id, rule, reviewed_by, evidence -> 'chosen' ->> 'type' AS chosen FROM journal_source_reviews WHERE journal_entry_id = $1`, [postedMirror]));
    expect(rec.ok && rec.rows, "the review's record").toEqual([{ previous_source_type: "legacy_unclassified", new_source_type: "reversal", new_source_id: mirrored, rule: "R", reviewed_by: adminId, chosen: "reversal" }]);
    const again = await h.api("admin", "POST", `/journal-entries/${postedMirror}/classify`, { sourceType: "reversal", sourceId: mirrored });
    expect([again.status, again.body?.code]).toEqual([409, "journal_source_review_not_unclassified"]);
    // the list keeps it, as classified, with its review
    const listed = (await h.api("accountant", "GET", "/journal-entries/unclassified")).body.items.find((i: any) => i.id === postedMirror);
    expect([listed.reviewStatus, listed.candidates]).toEqual(["classified", []]);
  });

  it("🔴 an unclassified DRAFT is refused approval until it is classified — then it is approved like any other draft", async () => {
    const refused = await h.api("accountant", "POST", `/journal-entries/${draftMirror}/approve`, {});
    expect([refused.status, refused.body?.code], JSON.stringify(refused.body)).toEqual([409, "journal_entry_classify_first"]);
    const classified = await h.api("admin", "POST", `/journal-entries/${draftMirror}/classify`, { sourceType: "reversal", sourceId: mirrored });
    expect(classified.status, JSON.stringify(classified.body)).toBe(200);
    const approved = await h.api("accountant", "POST", `/journal-entries/${draftMirror}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await entry(draftMirror)).status).toBe("posted");
  });

  it("🔴 only the review function writes the tag: the application's role cannot, whatever it declares; the owner cannot without the review declared and its record; the freeze still refuses any other column", async () => {
    // the application's role, declaring a review: refused (it is not the owner)
    const app = await asApp(async (c) => {
      await c.query(`SELECT set_config($1, '1', true)`, [REVIEW_SETTING]);
      return c.query(`UPDATE journal_entries SET source_type = 'reversal', source_id = $2 WHERE id = $1`, [noEvidence, mirrored]);
    });
    expect(!app.ok && app.constraint, "the application's role").toBe("journal_entry_source_tag_fixed");
    // the application's role holds nothing on the record
    const read = await asApp((c) => c.query(`SELECT * FROM journal_source_reviews`));
    expect(!read.ok && read.code, "no read").toBe("42501");
    // the owner, with nothing declared: refused
    const bare = await ownerTx([[`UPDATE journal_entries SET source_type = 'reversal', source_id = $2 WHERE id = $1`, [noEvidence, mirrored]]]);
    expect(!bare.ok && bare.constraint, "the owner, undeclared").toBe("journal_entry_source_tag_fixed");
    // the owner, declaring a review whose record names ANOTHER change: refused
    const planted = await outcome(pool.query(`INSERT INTO journal_source_reviews (organization_id, company_id, journal_entry_id, entry_number, entry_status, previous_source_type, new_source_type, new_source_id, rule, evidence, reviewed_by)
                                               VALUES ($1, $2, $3, 'probe', 'posted', 'legacy_unclassified', 'reversal', $4, 'R', '{"probe": true}', $5) RETURNING id`, [orgId, companyId, noEvidence, mirrored, adminId]));
    expect(planted.ok, JSON.stringify(planted)).toBe(true);
    const rid = String((planted as { rows: any[] }).rows[0].id);
    const wrongTag = await ownerTx([[`SELECT set_config($1, $2, true)`, [REVIEW_SETTING, rid]], [`UPDATE journal_entries SET source_type = 'invoice', source_id = 1 WHERE id = $1`, [noEvidence]]]);
    expect(!wrongTag.ok && wrongTag.constraint, "a tag the record does not hold").toBe("journal_entry_source_tag_fixed");
    // the owner, declared, the record matching — but the description changes too: the freeze refuses at commit
    const withDescription = await ownerTx([[`SELECT set_config($1, $2, true)`, [REVIEW_SETTING, rid]],
      [`UPDATE journal_entries SET source_type = 'reversal', source_id = $2, description = 'changed' WHERE id = $1`, [noEvidence, mirrored]]]);
    expect(!withDescription.ok && withDescription.constraint, "another column on a posted entry").toBe("journal_entry_posted_frozen");
    expect((await entry(noEvidence)).source_type, "still unclassified").toBe("legacy_unclassified");
    // the record is append-only, for the owner too
    for (const stmt of [`UPDATE journal_source_reviews SET rule = 'F' WHERE id = $1`, `DELETE FROM journal_source_reviews WHERE id = $1`]) {
      const r = await outcome(pool.query(stmt, [rid]));
      expect(!r.ok && r.constraint, stmt.split(" ")[0]).toBe("journal_source_reviews_append_only");
    }
  });

  it("🔴 the review's setting is named only by the migration that reads it", () => {
    const root = join(import.meta.dirname, "..", "..", "..", "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "generated" || name === "dist" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|mts|sql)$/.test(name) && readFileSync(p, "utf8").includes(REVIEW_SETTING)) hits.push(p.slice(root.length + 1).replace(/\\/g, "/"));
      }
    };
    for (const d of ["apps/api/src", "apps/web/src", "packages/db/src", "packages/db/migrations", "scripts/src"]) walk(join(root, d));
    expect(hits.filter((p) => !p.endsWith("a15-review-unclassified-entries.test.ts")).sort()).toEqual(["packages/db/migrations/0164_a15_review_classification.sql"]);
  });
});
