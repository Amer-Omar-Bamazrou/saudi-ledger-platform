/**
 * 🔴 A15 (owner decisions 2026-11-16 and 2026-11-17; migration 0163) — EVERY JOURNAL ENTRY NAMES ITS SOURCE.
 *
 *  - The tag is required: the database refuses an entry without one, and the posting seam refuses a call that names
 *    none before anything is written.
 *  - Three tags name no source row and no ordinary product operation writes them: `legacy_unclassified` (only the
 *    0163 back-fill), `demo_seed` and `test_fixture` (only while the connection declares that exact tag — which only
 *    the demo seed and the tests' fixture helpers do). They never change, and no entry becomes one.
 *  - The posted-journal freeze admits ONE more change, for the back-fill alone: the two tag columns written from NULL,
 *    with the back-fill declared and its own record holding the change. On a tagged entry nothing changes — not the
 *    tag, not any other column — even with the back-fill declared and a record present.
 *  - The back-fill's record is owner-only and append-only.
 *  - The generic reverse refuses the three unsourced tags, by code, in English and Arabic.
 *  - A `legacy_unclassified` DRAFT is never approved (owner, 2026-11-19): the approval route refuses it by a code naming
 *    the next step (classify it on the review screen), and the database refuses the flip whoever writes it.
 *  - The rules (`journal_source_classify`) reproduce the tag each writer stamps, and leave an ambiguous or failed
 *    relationship unclassified; the owner's candidate rule for the old `GL-<invoice>-PAY…` entries reports its
 *    verdicts and is never applied by the migration.
 *
 * The back-fill itself (NULL → tag on posted entries, the record written first, idempotence) needs entries with no
 * tag, which this schema cannot hold: it is rehearsed on disposable pre-migration databases (the A15 report).
 *
 * DB-backed; skips without a database. Red on main 96cab09b (assertion failures), green with 0163.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pool } from "@workspace/db";
import { postJournalEntry } from "../services/accounting/glPosting";
import { recurringService } from "../services/recurring/recurring.service";
import { recurringGenerationService } from "../services/recurring/generation.service";
import { fixtureQuery, SYNTHETIC_SOURCE_SETTING, TEST_FIXTURE_SOURCE } from "./helpers/journalFixtures";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeMaybe = url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "A15SourceTagPw1!";
const DATE = "2026-10-05";
const ARABIC = /[؀-ۿ]/;

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

describeMaybe("A15 — every journal entry names its source (migration 0163)", () => {
  const h = g04Harness("a15src");
  let orgId = "", companyId = "", otherCompanyId = "", adminId = 0, checkerId = 0, bankId = 0, customerId = 0, office = 0, income = 0;
  let seq = 0;
  const num = (p: string) => `${p}-${++seq}`;

  const account = async (code: string) =>
    Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id);
  const columns = `organization_id, company_id, entry_number, date, description, status`;

  /** As the application's role, in a tenant transaction that is always rolled back (a probe). */
  async function asApp(fn: (c: Client) => Promise<{ rows: any[] }>): Promise<Outcome> {
    const c = (await pool.connect()) as unknown as Client;
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authenticated");
      await c.query(`SELECT set_config('app.current_org_id', $1, true), set_config('app.current_company_id', $2, true)`, [orgId, companyId]);
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
  /** With `tag` declared on a connection of its own, for one statement (the demo seed's shape). */
  async function declared(tag: string, text: string, params: unknown[]): Promise<Outcome> {
    const c = (await pool.connect()) as unknown as Client;
    try {
      await c.query(`SELECT set_config($1, $2, false)`, [SYNTHETIC_SOURCE_SETTING, tag]);
      return await outcome(c.query(text, params));
    } finally {
      await c.query(`SELECT set_config($1, '', false)`, [SYNTHETIC_SOURCE_SETTING]).catch(() => undefined);
      c.release();
    }
  }
  const lines = async (entryId: number, amount: number) =>
    pool.query(`INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
                VALUES ($1, $2, $3, $4, 'Office', $5, 0), ($1, $2, $3, $6, 'Income', 0, $5)`, [orgId, companyId, entryId, office, amount, income]);
  const flip = async (entryId: number) => pool.query(`UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = $1 AND status = 'draft'`, [entryId]);
  /** A posted `test_fixture` entry, written as the product writes one (draft, lines, flip). */
  const fixtureEntry = async (entryNumber: string, amount = 10, date = DATE, post = true) => {
    const { rows: [e] } = await fixtureQuery(pool,
      `INSERT INTO journal_entries (${columns}, source_type) VALUES ($1, $2, $3, $4, 'A15 fixture', 'draft', 'test_fixture') RETURNING id`,
      [orgId, companyId, entryNumber, date]);
    await lines(e.id, amount);
    if (post) await flip(e.id);
    return e.id as number;
  };
  const tagOf = async (id: number) => (await pool.query(`SELECT to_jsonb(j.*) AS j FROM journal_entries j WHERE id = $1`, [id])).rows[0].j as Record<string, any>;
  const fnExists = async (name: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = $1`, [name])).rows[0].n) > 0;
  const tableExists = async (name: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`, [name])).rows[0].n) === 1;
  /**
   * Posts a planted `legacy_unclassified` draft as the back-fill leaves a POSTED one: the back-fill tags an entry that was
   * posted before it ran, so the flip is planted with the tag (triggers set aside) — 0163 refuses posting such a draft.
   */
  const flipPlanted = async (entryId: number) => {
    const c = (await pool.connect()) as unknown as Client;
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = $1 AND status = 'draft'`, [entryId]);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  };
  /** A `legacy_unclassified` DRAFT, as the back-fill leaves one (only the back-fill writes the tag, so it is planted). */
  const plantUnclassifiedDraft = async (entryNumber: string) => {
    const c = (await pool.connect()) as unknown as Client;
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const { rows: [e] } = await c.query(`INSERT INTO journal_entries (${columns}, source_type) VALUES ($1, $2, $3, $4, 'planted legacy draft', 'draft', 'legacy_unclassified') RETURNING id`, [orgId, companyId, entryNumber, DATE]);
      await c.query("COMMIT");
      return e.id as number;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  };

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "A15 Source Co", "319191919191923");
    otherCompanyId = await h.mkCompany(orgId, "A15 Other Co", "319191919191933");
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    checkerId = await h.mkUser("checker", PW, orgId, "accountant");
    await h.start();
    for (const who of ["admin", "checker"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "A15 Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    bankId = bank.body.id as number;
    const cust = await h.api("admin", "POST", "/customers", { name: "A15 Buyer", taxNumber: "300000000000003" });
    expect(cust.status, JSON.stringify(cust.body)).toBe(201);
    customerId = cust.body.id as number;
    office = await account("OFFICE_SUPPLIES");
    income = await account("SALES");
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 an entry with no source tag is refused by the database, whichever role writes it", async () => {
    const insert = `INSERT INTO journal_entries (${columns}) VALUES ($1, $2, $3, $4, 'no tag', 'draft') RETURNING id`;
    const asOwner = await outcome(pool.query(insert, [orgId, companyId, num("A15-NOTAG"), DATE]));
    expect([asOwner.ok, !asOwner.ok && asOwner.code], "the owner").toEqual([false, "23502"]);
    const asTheApp = await asApp((c) => c.query(insert, [orgId, companyId, num("A15-NOTAG"), DATE]));
    expect([asTheApp.ok, !asTheApp.ok && asTheApp.code], "the application's role").toEqual([false, "23502"]);
  });

  it("🔴 the posting seam refuses a call that names no source tag — before anything is written", async () => {
    const count = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE company_id = $1`, [companyId])).rows[0].n);
    const before = await count();
    const call = h.inTenant(orgId, companyId, adminId, () => postJournalEntry({
      entryNumber: num("A15-SEAM"), date: DATE, description: "no tag",
      lines: [{ accountId: office, accountName: "Office", debitAmount: 5, creditAmount: 0 }, { accountId: income, accountName: "Income", debitAmount: 0, creditAmount: 5 }],
    } as never));
    await expect(call).rejects.toThrow(/names no source/);
    expect(await count(), "nothing written").toBe(before);
  });

  it("🔴 legacy_unclassified is never written on a new entry — the owner and the application are refused alike", async () => {
    const insert = `INSERT INTO journal_entries (${columns}, source_type) VALUES ($1, $2, $3, $4, 'legacy?', 'draft', 'legacy_unclassified')`;
    const asOwner = await outcome(pool.query(insert, [orgId, companyId, num("A15-LEG"), DATE]));
    expect(!asOwner.ok && asOwner.constraint, "the owner").toBe("journal_entry_source_unclassified_refused");
    const asTheApp = await asApp((c) => c.query(insert, [orgId, companyId, num("A15-LEG"), DATE]));
    expect(!asTheApp.ok && asTheApp.constraint, "the application's role").toBe("journal_entry_source_unclassified_refused");
  });

  it("🔴 test_fixture and demo_seed are written only while the connection declares that exact tag", async () => {
    const insert = (tag: string) => `INSERT INTO journal_entries (${columns}, source_type) VALUES ($1, $2, $3, $4, 'synthetic', 'draft', '${tag}') RETURNING id`;
    for (const tag of [TEST_FIXTURE_SOURCE, "demo_seed"]) {
      const owner = await outcome(pool.query(insert(tag), [orgId, companyId, num("A15-SYN"), DATE]));
      expect(!owner.ok && owner.constraint, `${tag}, undeclared, the owner`).toBe("journal_entry_source_synthetic_refused");
      const app = await asApp((c) => c.query(insert(tag), [orgId, companyId, num("A15-SYN"), DATE]));
      expect(!app.ok && app.constraint, `${tag}, undeclared, the application's role`).toBe("journal_entry_source_synthetic_refused");
    }
    const wrongDeclaration = await declared(TEST_FIXTURE_SOURCE, insert("demo_seed"), [orgId, companyId, num("A15-SYN"), DATE]);
    expect(!wrongDeclaration.ok && wrongDeclaration.constraint, "a declaration names ONE tag").toBe("journal_entry_source_synthetic_refused");
    // the movement: each, declared, is written — and names no source row
    const fixture = await outcome(fixtureQuery(pool, insert(TEST_FIXTURE_SOURCE), [orgId, companyId, num("A15-SYN"), DATE]));
    expect(fixture.ok, JSON.stringify(fixture)).toBe(true);
    const demo = await declared("demo_seed", insert("demo_seed"), [orgId, companyId, num("A15-SYN"), DATE]);
    expect(demo.ok, JSON.stringify(demo)).toBe(true);
    for (const id of [(fixture as { rows: any[] }).rows[0].id, (demo as { rows: any[] }).rows[0].id]) {
      const j = await tagOf(id);
      expect([j.source_type, j.source_id]).toEqual([id === (fixture as { rows: any[] }).rows[0].id ? TEST_FIXTURE_SOURCE : "demo_seed", null]);
    }
    const withId = await outcome(fixtureQuery(pool, `INSERT INTO journal_entries (${columns}, source_type, source_id) VALUES ($1, $2, $3, $4, 'synthetic', 'draft', 'test_fixture', 7)`, [orgId, companyId, num("A15-SYN"), DATE]));
    expect(!withId.ok && withId.constraint, "an unsourced tag names no row").toBe("journal_entries_source_id_chk");
  });

  it("🔴 an unclassified or synthetic tag never changes, and no entry becomes one; an ordinary draft's tag still may", async () => {
    const planted = await outcome(fixtureQuery(pool, `INSERT INTO journal_entries (${columns}, source_type) VALUES ($1, $2, $3, $4, 'A15 fixture', 'draft', 'test_fixture') RETURNING id`, [orgId, companyId, num("A15-FIX"), DATE]));
    expect(planted.ok, "a declared test_fixture draft is written").toBe(true);
    const fixture = (planted as { rows: any[] }).rows[0].id as number;
    const toManual = await outcome(pool.query(`UPDATE journal_entries SET source_type = 'manual' WHERE id = $1`, [fixture]));
    expect(!toManual.ok && toManual.constraint, "test_fixture → manual").toBe("journal_entry_source_tag_fixed");
    const manual = (await pool.query(`INSERT INTO journal_entries (${columns}, source_type) VALUES ($1, $2, $3, $4, 'manual draft', 'draft', 'manual') RETURNING id`, [orgId, companyId, num("A15-MAN"), DATE])).rows[0].id as number;
    const toFixture = await declared(TEST_FIXTURE_SOURCE, `UPDATE journal_entries SET source_type = 'test_fixture' WHERE id = $1`, [manual]);
    expect(!toFixture.ok && toFixture.constraint, "manual → test_fixture, even declared").toBe("journal_entry_source_tag_fixed");
    const toLegacy = await outcome(pool.query(`UPDATE journal_entries SET source_type = 'legacy_unclassified' WHERE id = $1`, [manual]));
    expect(!toLegacy.ok && toLegacy.constraint, "manual → legacy_unclassified").toBe("journal_entry_source_tag_fixed");
    // the movement: a draft's ordinary tag changes as it did before 0163
    expect((await outcome(pool.query(`UPDATE journal_entries SET source_type = 'recurring' WHERE id = $1`, [manual]))).ok).toBe(true);
    expect((await tagOf(manual)).source_type).toBe("recurring");
  });

  it("🔴 the freeze's one new admission is the back-fill's tag write FROM NULL: on a tagged posted entry nothing changes — not the tag, not another column — even with the back-fill declared and its record present", async () => {
    expect(await tableExists("journal_source_backfill"), "the back-fill's record exists").toBe(true);
    const n = num("A15-FRZ");
    const id = (await pool.query(`INSERT INTO journal_entries (${columns}, source_type, source_id) VALUES ($1, $2, $3, $4, 'frozen', 'draft', 'invoice', 1) RETURNING id`, [orgId, companyId, n, DATE])).rows[0].id as number;
    await lines(id, 25);
    await flip(id);
    await pool.query(`INSERT INTO journal_source_backfill (organization_id, company_id, journal_entry_id, entry_number, entry_status, new_source_type, new_source_id, rule, evidence, migration_version)
                      VALUES ($1, $2, $3, $4, 'posted', 'bill', 1, 'F', '{"probe": true}', 'a15-probe')`, [orgId, companyId, id, n]);
    const declare: [string, unknown[]] = [`SELECT set_config('app.journal_source_backfill', 'a15-probe', true)`, []];
    const before = await tagOf(id);
    for (const [what, stmt] of [
      ["the tag itself", `UPDATE journal_entries SET source_type = 'bill', source_id = 1 WHERE id = $1`],
      ["the description", `UPDATE journal_entries SET description = 'changed' WHERE id = $1`],
      ["the date", `UPDATE journal_entries SET date = '2026-10-06' WHERE id = $1`],
      ["the number", `UPDATE journal_entries SET entry_number = entry_number || '-X' WHERE id = $1`],
      ["the reference", `UPDATE journal_entries SET reference = 'changed' WHERE id = $1`],
      ["the status", `UPDATE journal_entries SET status = 'draft' WHERE id = $1`],
    ] as const) {
      const r = await ownerTx([declare, [stmt, [id]]]);
      expect(!r.ok && r.constraint, what).toBe("journal_entry_posted_frozen");
    }
    for (const [what, stmt] of [
      ["an amount", `UPDATE journal_entry_lines SET debit_amount = 26 WHERE journal_entry_id = $1 AND debit_amount > 0`],
      ["an account", `UPDATE journal_entry_lines SET account_id = account_id WHERE journal_entry_id = $1`],
    ] as const) {
      const r = await ownerTx([declare, [stmt, [id]]]);
      expect(!r.ok && r.constraint, what).toBe("journal_entry_line_posted_frozen");
    }
    expect(await tagOf(id), "the entry is exactly as posted").toEqual(before);
    // and the application's role cannot even write the record the admission reads
    const record = await asApp((c) => c.query(`INSERT INTO journal_source_backfill (organization_id, company_id, journal_entry_id, entry_number, entry_status, new_source_type, rule, evidence, migration_version)
                                                VALUES ($1, $2, $3, 'x', 'posted', 'manual', 'A', '{}', 'a15-probe')`, [orgId, companyId, id]));
    expect(!record.ok && record.code, "permission denied").toBe("42501");
  });

  it("🔴 the back-fill's record is the owner's alone, and append-only even for the owner", async () => {
    expect(await tableExists("journal_source_backfill"), "the back-fill's record exists").toBe(true);
    const id = await fixtureEntry(num("A15-REC"));
    await pool.query(`INSERT INTO journal_source_backfill (organization_id, company_id, journal_entry_id, entry_number, entry_status, new_source_type, rule, evidence, migration_version)
                      VALUES ($1, $2, $3, 'A15-REC', 'posted', 'legacy_unclassified', 'U', '{"probe": true}', 'a15-probe')`, [orgId, companyId, id]);
    const read = await asApp((c) => c.query(`SELECT * FROM journal_source_backfill`));
    expect(!read.ok && read.code, "the application cannot read it").toBe("42501");
    for (const stmt of [
      `UPDATE journal_source_backfill SET evidence = '{}' WHERE journal_entry_id = $1`,
      `DELETE FROM journal_source_backfill WHERE journal_entry_id = $1`,
    ]) {
      const r = await outcome(pool.query(stmt, [id]));
      expect(!r.ok && r.constraint, stmt.split(" ")[0]).toBe("journal_source_backfill_append_only");
    }
    const t = await ownerTx([[`TRUNCATE journal_source_backfill`]]);
    expect(!t.ok && t.constraint, "TRUNCATE").toBe("journal_source_backfill_append_only");
    expect(Number((await pool.query(`SELECT count(*)::int AS n FROM journal_source_backfill WHERE journal_entry_id = $1`, [id])).rows[0].n), "the row stands").toBe(1);
    // the rules' own vocabulary: a candidate rule (P) is not one the back-fill can record
    const rule = (await pool.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'journal_source_backfill_rule_chk'`)).rows[0]?.d as string | undefined;
    expect(rule).toMatch(/'F'.*'N'.*'S'.*'A'.*'R'.*'U'/);
    expect(rule).not.toMatch(/'P'/);
  });

  it("🔴 the generic reverse refuses an unclassified or synthetic entry — by code, in English and Arabic — and reverses nothing; a manual entry still reverses", async () => {
    const plantLegacy = async () => {
      const c = (await pool.connect()) as unknown as Client;
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL session_replication_role = replica"); // only the back-fill writes this tag; planted as it would leave one
        const { rows: [e] } = await c.query(`INSERT INTO journal_entries (${columns}, source_type) VALUES ($1, $2, $3, $4, 'planted legacy', 'draft', 'legacy_unclassified') RETURNING id`, [orgId, companyId, num("A15-OLD"), DATE]);
        await c.query("COMMIT");
        return e.id as number;
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        c.release();
      }
    };
    const legacy = await outcome(plantLegacy().then((id) => ({ rows: [{ id }] })));
    expect(legacy.ok, "a legacy_unclassified entry can stand (as the back-fill leaves one)").toBe(true);
    const legacyId = (legacy as { rows: any[] }).rows[0].id as number;
    await lines(legacyId, 12);
    await flipPlanted(legacyId); // posted as the back-fill leaves one — an unclassified DRAFT is never posted (0163)
    const demo = await declared("demo_seed", `INSERT INTO journal_entries (${columns}, source_type) VALUES ($1, $2, $3, $4, 'demo', 'draft', 'demo_seed') RETURNING id`, [orgId, companyId, num("A15-DEMO"), DATE]);
    expect(demo.ok, JSON.stringify(demo)).toBe(true);
    const demoId = (demo as { rows: any[] }).rows[0].id as number;
    await lines(demoId, 13);
    await flip(demoId);
    const fixture = await fixtureEntry(num("A15-REVFIX"), 14);
    for (const [id, code] of [[legacyId, "journal_entry_unclassified"], [demoId, "journal_entry_synthetic"], [fixture, "journal_entry_synthetic"]] as const) {
      const r = await h.api("admin", "POST", `/journal-entries/${id}/reverse`, { reason: "A15 probe" });
      expect([r.status, r.body?.code], `${id}: ${JSON.stringify(r.body)}`).toEqual([409, code]);
      expect(String(r.body?.error)).toMatch(/[A-Za-z]/);
      expect(String(r.body?.errorAr)).toMatch(ARABIC);
      expect((await tagOf(id)).status, "still posted").toBe("posted");
      expect(Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE reversal_of = $1`, [id])).rows[0].n), "no mirror").toBe(0);
    }
    // the movement: an entry with a source the generic reverse owns — a manual one — reverses
    const created = await h.api("admin", "POST", "/journal-entries", { date: DATE, description: "A15 manual", lines: [
      { accountId: office, accountName: "Office", debitAmount: 9, creditAmount: 0 }, { accountId: income, accountName: "Income", debitAmount: 0, creditAmount: 9 }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await h.api("checker", "POST", `/journal-entries/${created.body.id}/approve`, {})).status).toBe(200);
    expect((await h.api("checker", "POST", `/journal-entries/${created.body.id}/reverse`, { reason: "A15 movement" })).status).toBe(200);
  });

  it("🔴 a legacy_unclassified DRAFT is never approved (owner, 2026-11-19): refused by a code naming the next step — classify it on the review screen first — in English and Arabic, and by the database whoever writes the flip; nothing is written; a manual draft still approves", async () => {
    const legacyDraft = await plantUnclassifiedDraft(num("A15-OLDDRAFT"));
    await lines(legacyDraft, 11);
    const before = await tagOf(legacyDraft);
    const r = await h.api("checker", "POST", `/journal-entries/${legacyDraft}/approve`, {});
    expect([r.status, r.body?.code], JSON.stringify(r.body)).toEqual([409, "journal_entry_classify_first"]);
    expect(String(r.body?.error)).toMatch(/review/i);
    expect(String(r.body?.errorAr)).toMatch(ARABIC);
    expect(await tagOf(legacyDraft), "nothing written: still a draft, no approver recorded").toEqual(before);
    // the database refuses the flip whoever writes it — with the approver recorded first, as the product records it
    const flipped = await ownerTx([
      [`UPDATE journal_entries SET approved_by = $1 WHERE id = $2`, [checkerId, legacyDraft]],
      [`UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = $1`, [legacyDraft]],
    ]);
    expect(!flipped.ok && flipped.constraint, "the database").toBe("journal_entry_unclassified_not_posted");
    expect((await tagOf(legacyDraft)).status, "still a draft").toBe("draft");
    // the movement: a manual draft of the same shape approves and posts
    const created = await h.api("admin", "POST", "/journal-entries", { date: DATE, description: "A15 manual draft", lines: [
      { accountId: office, accountName: "Office", debitAmount: 11, creditAmount: 0 }, { accountId: income, accountName: "Income", debitAmount: 0, creditAmount: 11 }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const approved = await h.api("checker", "POST", `/journal-entries/${created.body.id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await tagOf(created.body.id)).status).toBe("posted");
  });

  it("🔴 only the fixture helpers and the demo seed declare a synthetic source (beside the migration that reads it and the schema that documents it)", () => {
    const root = join(__dirname, "..", "..", "..", "..");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
      if (["node_modules", "dist", ".git", "generated", "test-results", "playwright-report"].includes(f)) return [];
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(ts|tsx|mts|mjs|js|sql)$/.test(f) ? [p] : [];
    });
    const found = ["apps", "packages", "scripts"].flatMap((d) => walk(join(root, d)))
      .filter((p) => readFileSync(p, "utf8").includes(SYNTHETIC_SOURCE_SETTING))
      .map((p) => p.slice(root.length + 1).replace(/\\/g, "/"))
      .sort();
    expect(found).toEqual([
      "apps/api/src/tests/helpers/journalFixtures.ts",
      "packages/db/migrations/0163_a15_source_tag_mandatory.sql",
      "packages/db/src/schema/journalEntries.ts",
      "scripts/src/demo-seed.mts",
    ]);
    expect(readFileSync(join(root, "scripts/src/demo-seed.mts"), "utf8"), "the demo seed declares its own tag").toMatch(/demo_seed/);
  });

  it("🔴 the rules reproduce the tag each writer stamped — a manual entry, an invoice, its receipt, a reversal — and say legacy_unclassified where nothing explains an entry", async () => {
    expect(await fnExists("journal_source_classify"), "the rules exist").toBe(true);
    const created = await h.api("admin", "POST", "/journal-entries", { date: DATE, description: "A15 rules", lines: [
      { accountId: office, accountName: "Office", debitAmount: 11, creditAmount: 0 }, { accountId: income, accountName: "Income", debitAmount: 0, creditAmount: 11 }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const manualId = created.body.id as number;
    expect((await h.api("checker", "POST", `/journal-entries/${manualId}/approve`, {})).status).toBe(200);
    const inv = await h.api("admin", "POST", "/invoices", { date: DATE, customerId, items: [{ description: "Services", quantity: 1, unitPrice: 1_000, vatRate: 15 }] });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect((await h.api("checker", "POST", `/invoices/${inv.body.id}/approve`, {})).status).toBe(200);
    const { rows: [gl] } = await pool.query(`SELECT j.id FROM journal_entries j JOIN invoices i ON j.entry_number = 'GL-' || i.invoice_number AND j.company_id = i.company_id WHERE i.id = $1`, [inv.body.id]);
    expect((await h.api("admin", "POST", `/invoices/${inv.body.id}/pay`, { amount: 1_150, paidAt: DATE, bankAccountId: bankId })).status).toBe(200);
    const { rows: [rc] } = await pool.query(`SELECT j.id FROM journal_entries j JOIN invoices i ON j.company_id = i.company_id WHERE i.id = $1 AND j.entry_number LIKE 'GL-' || i.invoice_number || '-RCPT-%'`, [inv.body.id]);
    const rev = await h.api("checker", "POST", `/journal-entries/${manualId}/reverse`, { reason: "A15 rules" });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    // a recurring rule's journal draft, generated by the engine itself
    const rule = await h.inTenant(orgId, companyId, adminId, () => recurringService.create({
      entity: "journal_entry", frequency: "monthly", dayOfMonth: 1, startsOn: "2026-06-01",
      template: { description: "A15 recurring", lines: [
        { accountId: office, accountName: "Office", debitAmount: 7, creditAmount: 0 }, { accountId: income, accountName: "Income", debitAmount: 0, creditAmount: 7 }] },
    } as never, { userId: adminId, role: "admin" }));
    await pool.query(`UPDATE recurring_rules SET next_run_on = $2 WHERE id = $1`, [rule.id, "2026-06-01"]);
    await recurringGenerationService.runOnce("2026-06-01", orgId);
    const recurringId = (await pool.query(`SELECT document_id FROM recurring_runs WHERE rule_id = $1 AND outcome = 'generated'`, [rule.id])).rows[0]?.document_id as number;
    expect(recurringId, "the engine generated its draft").toBeGreaterThan(0);
    const nothing = await fixtureEntry(num("A15-NONE"));
    const ids = [manualId, gl.id, rc.id, rev.body.reversalId, recurringId, nothing];
    const got = new Map((await pool.query(`SELECT entry_id, new_source_type, new_source_id, rule, evidence ->> 'outcome' AS outcome FROM journal_source_classify($1::int[])`, [ids])).rows.map((r) => [r.entry_id, r]));
    for (const [id, rule] of [[manualId, "A"], [gl.id, "N"], [rc.id, "F"], [rev.body.reversalId, "R"], [recurringId, "F"]] as const) {
      const j = await tagOf(id);
      expect(got.get(id), `entry ${id} (${j.source_type})`).toMatchObject({ new_source_type: j.source_type, new_source_id: j.source_id, rule, outcome: "classified" });
    }
    expect(got.get(nothing)).toMatchObject({ new_source_type: "legacy_unclassified", new_source_id: null, rule: "U", outcome: "no_authoritative_relationship" });
  }, 60_000);

  it("🔴 an ambiguous or failed relationship is never classified: two documents claiming one entry, a document in another company, a draft invoice behind a GL number", async () => {
    expect(await fnExists("journal_source_classify"), "the rules exist").toBe(true);
    const twice = await fixtureEntry(num("A15-TWO"), 30);
    const elsewhere = await fixtureEntry(num("A15-ELSE"), 31);
    const c = (await pool.connect()) as unknown as Client;
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica"); // planted relationships, as old data could hold them
      const pay = `INSERT INTO payments (organization_id, company_id, direction, party_type, customer_id, bank_account_id, amount, paid_at, source, journal_entry_id) VALUES ($1, $2, 'in', 'customer', $3, $4, $5, $6, 'manual', $7)`;
      await c.query(pay, [orgId, companyId, customerId, bankId, 30, DATE, twice]);
      await c.query(pay, [orgId, companyId, customerId, bankId, 30, DATE, twice]);
      await c.query(pay, [orgId, otherCompanyId, customerId, bankId, 31, DATE, elsewhere]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const draft = await h.api("admin", "POST", "/invoices", { date: DATE, customerId, items: [{ description: "Draft", quantity: 1, unitPrice: 100, vatRate: 15 }] });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const draftNumber = (await pool.query(`SELECT invoice_number FROM invoices WHERE id = $1`, [draft.body.id])).rows[0].invoice_number as string;
    const behindDraft = await fixtureEntry(`GL-${draftNumber}`, 115);
    const got = new Map((await pool.query(`SELECT entry_id, new_source_type, rule, evidence FROM journal_source_classify($1::int[])`, [[twice, elsewhere, behindDraft]])).rows.map((r) => [r.entry_id, r]));
    for (const id of [twice, elsewhere, behindDraft]) {
      expect(got.get(id), `entry ${id}`).toMatchObject({ new_source_type: "legacy_unclassified", rule: "U", evidence: { outcome: "ambiguous" } });
    }
    expect(got.get(twice)!.evidence.candidates).toHaveLength(2);
    expect(got.get(elsewhere)!.evidence.candidates[0].evidence.same_organization_and_company).toBe(false);
    expect(got.get(behindDraft)!.evidence.candidates[0]).toMatchObject({ rule: "N", checks_pass: false, evidence: { issued: false } });
  }, 60_000);

  it("🔴 the owner's candidate rule for the old GL-<invoice>-PAY… entries: a B4 record is reported, never used as a payments id; a mismatch, an aggregate, a shared record, a payment that is another entry's and a missing invoice are each refused by name", async () => {
    expect(await fnExists("journal_source_legacy_payment_candidates"), "the candidate rule exists").toBe(true);
    // 🔴 why `qualifies` cannot arise here: a payments row always names its own entry
    expect((await pool.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'journal_entry_id'`)).rows[0].is_nullable).toBe("NO");
    const approvedInvoice = async (unitPrice: number) => {
      const inv = await h.api("admin", "POST", "/invoices", { date: DATE, customerId, items: [{ description: "Old", quantity: 1, unitPrice, vatRate: 15 }] });
      expect(inv.status, JSON.stringify(inv.body)).toBe(201);
      expect((await h.api("checker", "POST", `/invoices/${inv.body.id}/approve`, {})).status).toBe(200);
      return { id: inv.body.id as number, number: (await pool.query(`SELECT invoice_number FROM invoices WHERE id = $1`, [inv.body.id])).rows[0].invoice_number as string };
    };
    const b4 = async (invoiceId: number, amount: number, backfilled = false) =>
      (await pool.query(`INSERT INTO invoice_payments (organization_id, company_id, invoice_id, amount, paid_at, backfilled) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [orgId, companyId, invoiceId, amount, DATE, backfilled])).rows[0].id as number;
    const a = await approvedInvoice(1_000); // total 1,150
    const ok = await b4(a.id, 100);
    const partial = await fixtureEntry(`GL-${a.number}-PAY-${ok}`, 100);
    const off = await b4(a.id, 60);
    const mismatch = await fixtureEntry(`GL-${a.number}-PAY-${off}`, 70);
    const agg = await b4(a.id, 80, true);
    const aggregate = await fixtureEntry(`GL-${a.number}-PAY-${agg}`, 80);
    const b = await approvedInvoice(100);
    await b4(b.id, 40);
    await b4(b.id, 40);
    const twoRecords = await fixtureEntry(`GL-${b.number}-PAY`, 40);
    const c = await approvedInvoice(200);
    await b4(c.id, 30);
    const claimA = await fixtureEntry(`GL-${c.number}-PAY`, 30);
    const claimB = await fixtureEntry(`GL-${c.number}-PAY-D${claimA}`, 30);
    const paid = await approvedInvoice(300); // total 345, paid in full through the product: its payment names its RCPT entry
    expect((await h.api("admin", "POST", `/invoices/${paid.id}/pay`, { amount: 345, paidAt: DATE, bankAccountId: bankId })).status).toBe(200);
    const twiceInLedger = await fixtureEntry(`GL-${paid.number}-PAY`, 345);
    const noInvoice = await fixtureEntry(`GL-A15-NO-SUCH-PAY-${seq}`, 5);
    const otherShape = await fixtureEntry(num("A15-NOT-OLD-FORMAT"), 5); // not a candidate at all
    const ids = [partial, mismatch, aggregate, twoRecords, claimA, claimB, twiceInLedger, noInvoice, otherShape];
    const got = new Map((await pool.query(`SELECT * FROM journal_source_legacy_payment_candidates($1::int[])`, [ids])).rows.map((r) => [r.entry_id, r]));
    expect(got.get(partial), "a partial payment's B4 record agrees with the ENTRY, not the invoice's 1,150").toMatchObject({ verdict: "b4_record_only", b4_payment_id: ok, payment_id: null });
    expect(got.get(mismatch)).toMatchObject({ verdict: "no_match", b4_payment_id: null, evidence: { b4_records_disagreeing_or_aggregate: [off] } });
    expect(got.get(aggregate)).toMatchObject({ verdict: "no_match", evidence: { b4_records_disagreeing_or_aggregate: [agg] } });
    expect(got.get(twoRecords)).toMatchObject({ verdict: "ambiguous" });
    expect(got.get(claimA)).toMatchObject({ verdict: "ambiguous" });
    expect(got.get(claimB)).toMatchObject({ verdict: "ambiguous", evidence: { renamed_duplicate: true } });
    expect(got.get(twiceInLedger), "the receipt already stands in the ledger under its own entry").toMatchObject({ verdict: "conflict", payment_id: null });
    expect((got.get(twiceInLedger)!.evidence.payments_already_another_entrys as number[]).length).toBe(1);
    expect(got.get(noInvoice)).toMatchObject({ verdict: "no_invoice" });
    expect(got.has(otherShape), "an entry of another number shape is no candidate").toBe(false);
    expect(got.size, "exactly the old-format entries asked about").toBe(ids.length - 1);
    expect([...got.values()].filter((r) => r.verdict === "qualifies"), "nothing qualifies").toEqual([]);
  }, 90_000);
});
