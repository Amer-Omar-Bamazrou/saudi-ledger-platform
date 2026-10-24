/**
 * 🔴 G16 PROOF (Phase 18; owner decisions 2026-10-22 §5 and 2026-10-23
 * afternoon, item 3): a posted or reversed journal entry, and its lines,
 * cannot be changed, deleted or truncated at the database — by the owner
 * connection or the app role — while every permitted transition still works.
 *
 * The defect (main at `eafe7ded`): nothing at the database stops it. A posted
 * entry's date, number, amounts or status can be rewritten, its lines edited,
 * the entry deleted (cascading into the payment tables) or both tables
 * truncated; only narrow, owner-specific guards exist (bank reconciliation,
 * input VAT, WHT, mirrors), and `status` has no CHECK.
 *
 * What this file asserts, each refusal under G16's OWN constraint name so an
 * older guard cannot satisfy it:
 *  - the permitted transitions work through the product (draft → posted,
 *    posted → reversed with its mirror, the seam's draft → lines → flip);
 *  - every change to a posted header, the no-op, posted → draft, reversed →
 *    anything, and a mirror's own reversal: refused AT COMMIT;
 *  - DELETE of a posted entry: refused, and the cascade into its payment
 *    never happens;
 *  - lines: an INSERT into a posted entry refused AT ONCE (the one rule that
 *    cannot wait — see the migration), an UPDATE or DELETE AT COMMIT;
 *  - a header is born a draft; draft → reversed is refused;
 *  - posting checks the stored lines at COMMIT: only status and posted_at
 *    change, and debits equal credits (balance only: owner decision 2);
 *  - posted → reversed needs its posted mirror AT COMMIT (deferred: owner
 *    decision 3), so the mirror may be written later in the same transaction;
 *  - the older guards still refuse through the REORDERED seam: a reconciled
 *    bank period (at the flip, through the seam and through approval), an
 *    unowned WHT line, an input-VAT entry without its event, an inadmissible
 *    mirror;
 *  - TRUNCATE is refused; every G16 trigger is ordinary (replica mode, owner
 *    only, is the one bypass) and sorts after every older guard;
 *  - each of the five pre-checks SEES a planted violation (in a transaction
 *    that is rolled back), and the migration's own DO block refuses on one.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3222";
process.env.SESSION_SECRET ??= "phase18-g16-posted-journal-freeze-proof-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { g04Harness } from "./helpers/g04Harness";
import { postJournalEntry } from "../services/accounting/glPosting";
import { bankReconciliationsService } from "../services/accounting/bankReconciliations.service";
import { translateDbRefusal } from "../lib/dbRefusals";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "G16PostedJournalFreezePw123!";
const DATE = "2026-10-01";
const FROZEN = "journal_entry_posted_frozen";
const LINE_FROZEN = "journal_entry_line_posted_frozen";

type Attempt = { refused: boolean; rowCount: number | null; constraint: string | null; message: string | null };
type PoolClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; release: () => void };
const connect = async () => (await pool.connect()) as unknown as PoolClient;
const constraintOf = (e: unknown): string | null => {
  const err = e as { constraint?: string; cause?: { constraint?: string } };
  return err?.constraint ?? err?.cause?.constraint ?? null;
};
const messageOf = (e: unknown): string => {
  const err = e as { message?: string; cause?: { message?: string } };
  return String(err?.cause?.message ?? err?.message ?? e);
};
const fail = (e: unknown): Attempt => ({ refused: true, rowCount: null, constraint: constraintOf(e), message: messageOf(e).slice(0, 240) });

describeMaybe("G16 — the posted-journal freeze", () => {
  const h = g04Harness("p18g16");
  let orgId = "";
  let companyId = "";
  let company2 = "";
  let adminId = 0;
  let bankLeaf = 0;
  let bankId = 0;
  let office = 0;
  let seq = 0;

  const account = async (code: string) => Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id);
  const entry = async (id: number) => (await pool.query(`SELECT to_jsonb(j) AS r FROM journal_entries j WHERE id = $1`, [id])).rows[0]?.r ?? null;
  const linesOf = async (id: number) => (await pool.query(`SELECT to_jsonb(l) AS r FROM journal_entry_lines l WHERE journal_entry_id = $1 ORDER BY id`, [id])).rows.map((r) => r.r);
  const tenant = <T,>(fn: () => Promise<T>) => h.inTenant(orgId, companyId, adminId, fn);

  /** Autocommit as the owner: a deferred refusal surfaces from the statement's own COMMIT. */
  async function asOwner(sql: string, params: unknown[] = []): Promise<Attempt> {
    try {
      const r = await pool.query(sql, params);
      return { refused: false, rowCount: r.rowCount, constraint: null, message: null };
    } catch (e) {
      return fail(e);
    }
  }
  /** As the app role, in the tenant's own GUCs, committed. */
  async function asApp(sql: string, params: unknown[] = []): Promise<Attempt> {
    const c = await connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE authenticated`);
      await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
      await c.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);
      try {
        const r = await c.query(sql, params);
        await c.query("COMMIT");
        return { refused: false, rowCount: r.rowCount, constraint: null, message: null };
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        return fail(e);
      }
    } finally {
      c.release();
    }
  }
  /** Several statements as the owner, then COMMIT; `where` says whether a refusal came from a statement or the COMMIT. */
  async function ownerTx(fn: (c: PoolClient) => Promise<void>): Promise<Attempt & { where: "statement" | "commit" | null }> {
    const c = await connect();
    try {
      await c.query("BEGIN");
      try {
        await fn(c);
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        return { ...fail(e), where: "statement" };
      }
      try {
        await c.query("COMMIT");
        return { refused: false, rowCount: null, constraint: null, message: null, where: null };
      } catch (e) {
        return { ...fail(e), where: "commit" };
      }
    } finally {
      c.release();
    }
  }
  /** Plant with every trigger set aside (owner, replica), read, and ROLL BACK — nothing planted is ever committed. */
  async function planted<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      return await fn(c);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }

  const lines2 = (dr: number, cr: number, acctDr = office, acctCr = bankLeaf) => [
    { accountId: acctDr, accountName: "Dr", debitAmount: dr, creditAmount: 0 },
    { accountId: acctCr, accountName: "Cr", debitAmount: 0, creditAmount: cr },
  ];
  /** T2 + T3 through the product: a manual draft, approved by the accountant. */
  async function postedEntry(amount = 100, date = DATE): Promise<number> {
    const created = await h.api("admin", "POST", "/journal-entries", { date, description: `G16 posted ${++seq}`, lines: lines2(amount, amount) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const approved = await h.api("accountant", "POST", `/journal-entries/${created.body.id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    return created.body.id as number;
  }
  /** T5 through the product. */
  async function reversedPair(): Promise<{ original: number; mirror: number }> {
    const original = await postedEntry();
    const r = await h.api("accountant", "POST", `/journal-entries/${original}/reverse`, { reason: "G16 proof" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { original, mirror: r.body.reversalId as number };
  }
  /** A draft header written directly (the T2 shape), with lines; returns its id. */
  async function rawDraft(c: PoolClient, lines: Array<[number, number, number]>, extra: { reversalOf?: number; company?: string } = {}): Promise<number> {
    const { rows: [je] } = await c.query(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status, reversal_of)
       VALUES ($1, $2, $3, $4, 'G16 raw draft', 'draft', $5) RETURNING id`,
      [orgId, extra.company ?? companyId, `G16-RAW-${++seq}`, DATE, extra.reversalOf ?? null]);
    for (const [acct, dr, cr] of lines) {
      await c.query(
        `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4, 'raw', $5, $6)`, [orgId, extra.company ?? companyId, je.id, acct, dr, cr]);
    }
    return je.id as number;
  }

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "G16 Freeze Co", "318181818181893");
    company2 = await h.mkCompany(orgId, "G16 Freeze Second Co", "318181818181892");
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("accountant", PW, orgId, "accountant");
    await h.start();
    for (const who of ["admin", "accountant"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "G16 Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    bankId = bank.body.id as number;
    bankLeaf = Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND bank_account_id = $2`, [orgId, bankId])).rows[0].id);
    office = await account("OFFICE_SUPPLIES");
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("🔴 the permitted transitions work through the product: draft → posted (approval), posted → reversed with its posted mirror, and the seam's draft → lines → flip", async () => {
    const created = await h.api("admin", "POST", "/journal-entries", { date: DATE, description: "G16 lifecycle", lines: lines2(250, 250) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await entry(created.body.id)).status, "T2: born a draft").toBe("draft");
    expect((await h.api("accountant", "POST", `/journal-entries/${created.body.id}/approve`, {})).status).toBe(200);
    const posted = await entry(created.body.id);
    expect([posted.status, posted.posted_at !== null], "T3").toEqual(["posted", true]);
    const r = await h.api("accountant", "POST", `/journal-entries/${created.body.id}/reverse`, { reason: "G16 lifecycle" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [original, mirror] = [await entry(created.body.id), await entry(r.body.reversalId)];
    expect([original.status, mirror.status, mirror.reversal_of, mirror.posted_at !== null], "T5: the mirror is posted").toEqual(["reversed", "posted", created.body.id, true]);
    expect((await linesOf(r.body.reversalId)).map((l) => [Number(l.debit_amount), Number(l.credit_amount)])).toEqual([[0, 250], [250, 0]]);
    // The seam itself: draft → lines → flip, one transaction.
    const je = await tenant(() => postJournalEntry({ entryNumber: `G16-SEAM-${++seq}`, date: DATE, description: "G16 seam", lines: [
      { accountId: office, accountName: "Office", debitAmount: 40, creditAmount: 0 },
      { bankAccountId: bankId, debitAmount: 0, creditAmount: 40 },
    ] }));
    expect([(await entry(je.id)).status, je.status, (await linesOf(je.id)).length], "the seam returns the POSTED row").toEqual(["posted", "posted", 2]);
  }, 60_000);

  it("🔴 a posted entry's header cannot change — every column, a no-op, posted → draft — owner and app role, AT COMMIT", async () => {
    const id = await postedEntry();
    const other = await postedEntry();
    const before = await entry(id);
    const changes: Record<string, [string, unknown[]]> = {
      date: [`UPDATE journal_entries SET date = '2026-10-02' WHERE id = $1`, [id]],
      entryNumber: [`UPDATE journal_entries SET entry_number = entry_number || '-X' WHERE id = $1`, [id]],
      description: [`UPDATE journal_entries SET description = 'rewritten' WHERE id = $1`, [id]],
      reference: [`UPDATE journal_entries SET reference = 'REF-X' WHERE id = $1`, [id]],
      source: [`UPDATE journal_entries SET source = 'opening' WHERE id = $1`, [id]],
      notes: [`UPDATE journal_entries SET notes = 'x' WHERE id = $1`, [id]],
      postedAt: [`UPDATE journal_entries SET posted_at = posted_at + interval '1 day' WHERE id = $1`, [id]],
      createdAt: [`UPDATE journal_entries SET created_at = created_at - interval '1 day' WHERE id = $1`, [id]],
      createdBy: [`UPDATE journal_entries SET created_by = NULL WHERE id = $1`, [id]],
      reversalOf: [`UPDATE journal_entries SET reversal_of = $2 WHERE id = $1`, [id, other]],
      reversalReason: [`UPDATE journal_entries SET reversal_reason = 'x' WHERE id = $1`, [id]],
      noOp: [`UPDATE journal_entries SET status = status WHERE id = $1`, [id]],
      toDraft: [`UPDATE journal_entries SET status = 'draft' WHERE id = $1`, [id]],
    };
    const out: Record<string, { owner: string | null; app: string | null }> = {};
    for (const [k, [sql, params]] of Object.entries(changes)) {
      const owner = await asOwner(sql, params);
      const app = await asApp(sql, params);
      out[k] = { owner: owner.refused ? owner.constraint : `APPLIED ${owner.rowCount}`, app: app.refused ? app.constraint : `APPLIED ${app.rowCount}` };
    }
    out.company = { owner: (await asOwner(`UPDATE journal_entries SET company_id = $2 WHERE id = $1`, [id, company2])).constraint, app: FROZEN };
    console.warn("[G16] posted header", JSON.stringify(out));
    for (const [k, v] of Object.entries(out)) expect.soft([k, v], k).toEqual([k, { owner: FROZEN, app: FROZEN }]);
    expect(await entry(id), "the entry is exactly as posted").toEqual(before);
  }, 120_000);

  it("🔴 a reversed entry cannot go back, and a mirror is never itself reversed", async () => {
    const { original, mirror } = await reversedPair();
    const out = {
      reversedToPosted: (await asOwner(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [original])).constraint,
      reversedToDraft: (await asApp(`UPDATE journal_entries SET status = 'draft' WHERE id = $1`, [original])).constraint,
      mirrorReversed: (await asOwner(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [mirror])).constraint,
    };
    expect(out).toEqual({ reversedToPosted: FROZEN, reversedToDraft: FROZEN, mirrorReversed: FROZEN });
    expect([(await entry(original)).status, (await entry(mirror)).status]).toEqual(["reversed", "posted"]);
  }, 60_000);

  it("🔴 a posted entry cannot be deleted — owner and app role — and the cascade into its payment never happens", async () => {
    const cust = await h.api("admin", "POST", "/customers", { name: "G16 Buyer" });
    expect(cust.status, JSON.stringify(cust.body)).toBe(201);
    const rcpt = await h.api("admin", "POST", "/payments", { customerId: cust.body.id, amount: 300, paidAt: DATE, bankAccountId: bankId, classification: "unknown" });
    expect(rcpt.status, JSON.stringify(rcpt.body)).toBe(201);
    const jeId = (await pool.query(`SELECT journal_entry_id FROM payments WHERE id = $1`, [rcpt.body.id])).rows[0].journal_entry_id as number;
    expect(jeId, "the receipt is a posted entry").toBeGreaterThan(0);
    const manual = await postedEntry();
    const out = {
      receiptOwner: (await asOwner(`DELETE FROM journal_entries WHERE id = $1`, [jeId])).constraint,
      manualApp: (await asApp(`DELETE FROM journal_entries WHERE id = $1`, [manual])).constraint,
    };
    expect(out).toEqual({ receiptOwner: FROZEN, manualApp: FROZEN });
    const still = await pool.query(`SELECT (SELECT count(*)::int FROM payments WHERE id = $1) AS payment, (SELECT count(*)::int FROM journal_entries WHERE id = ANY($2::int[])) AS entries`, [rcpt.body.id, [jeId, manual]]);
    expect(still.rows[0], "the entries and the payment are all still there").toEqual({ payment: 1, entries: 2 });
  }, 60_000);

  it("🔴 the lines of a posted entry: a new line is refused AT ONCE, a change or a deletion AT COMMIT — owner and app role", async () => {
    const id = await postedEntry();
    const lineId = (await linesOf(id))[0].id as number;
    const before = await linesOf(id);
    const add = `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount) VALUES ($1,$2,$3,$4,'late',5,0)`;
    const insertTx = await ownerTx(async (c) => { await c.query(add, [orgId, companyId, id, office]); });
    const updateTx = await ownerTx(async (c) => { await c.query(`UPDATE journal_entry_lines SET debit_amount = debit_amount + 1 WHERE id = $1`, [lineId]); });
    const out = {
      insert: [insertTx.constraint, insertTx.where],
      update: [updateTx.constraint, updateTx.where],
      deleteOwner: (await asOwner(`DELETE FROM journal_entry_lines WHERE id = $1`, [lineId])).constraint,
      insertApp: (await asApp(add, [orgId, companyId, id, office])).constraint,
      updateApp: (await asApp(`UPDATE journal_entry_lines SET description = 'x' WHERE id = $1`, [lineId])).constraint,
      deleteApp: (await asApp(`DELETE FROM journal_entry_lines WHERE id = $1`, [lineId])).constraint,
    };
    expect(out).toEqual({
      insert: [LINE_FROZEN, "statement"], update: [LINE_FROZEN, "commit"],
      deleteOwner: LINE_FROZEN, insertApp: LINE_FROZEN, updateApp: LINE_FROZEN, deleteApp: LINE_FROZEN,
    });
    expect(await linesOf(id), "the lines are exactly as posted").toEqual(before);
  }, 60_000);

  it("🔴 a header is born a draft: an INSERT as posted or reversed is refused AT COMMIT, and draft → reversed is refused", async () => {
    const insertAs = (status: string) => asOwner(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status) VALUES ($1,$2,$3,$4,'born',$5)`,
      [orgId, companyId, `G16-BORN-${++seq}`, DATE, status]);
    const draftToReversed = await ownerTx(async (c) => {
      const d = await rawDraft(c, [[office, 10, 0], [bankLeaf, 0, 10]]);
      await c.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [d]);
    });
    const out = { posted: (await insertAs("posted")).constraint, reversed: (await insertAs("reversed")).constraint, draftToReversed: [draftToReversed.constraint, draftToReversed.where] };
    expect(out).toEqual({ posted: "journal_entry_inserted_not_draft", reversed: "journal_entry_inserted_not_draft", draftToReversed: [FROZEN, "commit"] });
    expect(Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1 AND entry_number LIKE 'G16-BORN-%'`, [orgId])).rows[0].n), "nothing born posted").toBe(0);
  }, 60_000);

  it("🔴 posting checks the stored lines AT COMMIT: debits equal credits, and only status and posted_at change", async () => {
    const posting = (lines: Array<[number, number, number]>, set = "status = 'posted', posted_at = now()") =>
      ownerTx(async (c) => {
        const d = await rawDraft(c, lines);
        await c.query(`UPDATE journal_entries SET ${set} WHERE id = $1`, [d]);
      });
    const unbalanced = await posting([[office, 100, 0], [bankLeaf, 0, 90]]);
    const balanced = await posting([[office, 100, 0], [bankLeaf, 0, 100]]);
    const extraColumn = await posting([[office, 100, 0], [bankLeaf, 0, 100]], "status = 'posted', posted_at = now(), description = 'and more'");
    const zero = await posting([[office, 0, 0], [bankLeaf, 0, 0]]);
    const lineAfterFlip = await ownerTx(async (c) => {
      const d = await rawDraft(c, [[office, 10, 0], [bankLeaf, 0, 10]]);
      await c.query(`UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = $1`, [d]);
      await c.query(`INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount) VALUES ($1,$2,$3,$4,'late',0,0)`, [orgId, companyId, d, office]);
    });
    const out = {
      unbalanced: [unbalanced.constraint, unbalanced.where],
      balanced: balanced.refused,
      extraColumn: [extraColumn.constraint, extraColumn.where],
      zeroBalances: zero.refused,
      lineAfterFlip: [lineAfterFlip.constraint, lineAfterFlip.where],
    };
    console.warn("[G16] posting", JSON.stringify(out));
    expect(out).toEqual({
      unbalanced: ["journal_entry_posted_unbalanced", "commit"],
      balanced: false,
      extraColumn: [FROZEN, "commit"],
      // Owner decision 2: balance only — no line-count or non-zero rule.
      zeroBalances: false,
      lineAfterFlip: [LINE_FROZEN, "statement"],
    });
  }, 60_000);

  it("🔴 posted → reversed needs its posted mirror AT COMMIT: written later in the same transaction it is admitted; without it, or with another column changed, refused", async () => {
    const withMirrorAfter = await postedEntry();
    const mirrorLater = await ownerTx(async (c) => {
      await c.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [withMirrorAfter]);
      const m = await rawDraft(c, [[bankLeaf, 100, 0], [office, 0, 100]], { reversalOf: withMirrorAfter });
      await c.query(`UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = $1`, [m]);
    });
    const noMirror = await postedEntry();
    const alone = await ownerTx(async (c) => { await c.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [noMirror]); });
    const draftMirrorOnly = await ownerTx(async (c) => {
      await c.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [noMirror]);
      await rawDraft(c, [[bankLeaf, 100, 0], [office, 0, 100]], { reversalOf: noMirror });
    });
    const withMore = await ownerTx(async (c) => {
      await c.query(`UPDATE journal_entries SET status = 'reversed', reference = 'and more' WHERE id = $1`, [noMirror]);
      const m = await rawDraft(c, [[bankLeaf, 100, 0], [office, 0, 100]], { reversalOf: noMirror });
      await c.query(`UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = $1`, [m]);
    });
    const out = {
      mirrorLater: mirrorLater.refused,
      alone: [alone.constraint, alone.where],
      draftMirrorOnly: [draftMirrorOnly.constraint, draftMirrorOnly.where],
      withMore: [withMore.constraint, withMore.where],
    };
    expect(out).toEqual({
      mirrorLater: false,
      alone: ["journal_entry_reversal_mirror_missing", "commit"],
      draftMirrorOnly: ["journal_entry_reversal_mirror_missing", "commit"],
      withMore: [FROZEN, "commit"],
    });
    expect([(await entry(withMirrorAfter)).status, (await entry(noMirror)).status]).toEqual(["reversed", "posted"]);
  }, 60_000);

  it("🔴 the older guards still refuse through the REORDERED seam: a reconciled bank period (at the flip — seam and approval), an unowned WHT line, an input-VAT entry without its event, an inadmissible mirror", async () => {
    const bank2 = await h.api("admin", "POST", "/bank-accounts", { name: "G16 Reconciled", bankName: "SNB", currency: "SAR" });
    expect(bank2.status, JSON.stringify(bank2.body)).toBe(201);
    const leaf2 = Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND bank_account_id = $2`, [orgId, bank2.body.id])).rows[0].id);
    await tenant(() => bankReconciliationsService.complete({ bankAccountId: bank2.body.id, asOf: "2026-06-30", statementBalance: 0 }, adminId));
    type SeamOpts = Parameters<typeof postJournalEntry>[0];
    const seam = (date: string, extra: Record<string, unknown> = {}, lines?: unknown[]) =>
      tenant(() => postJournalEntry({ entryNumber: `G16-GUARD-${++seq}`, date, description: "G16 guard", lines: lines ?? [
        { accountId: office, accountName: "Office", debitAmount: 20, creditAmount: 0 },
        { bankAccountId: bank2.body.id, debitAmount: 0, creditAmount: 20 },
      ], ...extra } as SeamOpts)).then(() => null, (e) => ({ constraint: constraintOf(e), message: messageOf(e) }));
    const before = Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n);

    const reconciled = await seam("2026-06-15");
    const afterIt = await seam("2026-07-05");
    // Through the approval: the draft is written (its lines' own check skips a draft), the flip is refused.
    const draft = await h.api("admin", "POST", "/journal-entries", { date: "2026-06-16", description: "G16 into reconciled", lines: lines2(15, 15, office, leaf2) });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const approve = await h.api("accountant", "POST", `/journal-entries/${draft.body.id}/approve`, {});
    const wht = await seam(DATE, {}, [
      { accountId: await account("WHT_PAYABLE"), accountName: "WHT payable", debitAmount: 30, creditAmount: 0 },
      { accountId: office, accountName: "Office", debitAmount: 0, creditAmount: 30 },
    ]);
    const inputVat = await seam(DATE, { source: "input_vat_event" }, [
      { accountId: office, accountName: "Office", debitAmount: 25, creditAmount: 0 },
      { accountId: bankLeaf, accountName: "Ops", debitAmount: 0, creditAmount: 25 },
    ]);
    const { mirror } = await reversedPair();
    // The seam itself admits `reversalOf` only for the migration's reversal (`opening_reversal`, a 422 in
    // words); with that source the header INSERT reaches the database, whose 0119 guard refuses a mirror of a mirror.
    const mirrorOfMirror = await seam(DATE, { reversalOf: mirror, source: "opening_reversal" }, [
      { accountId: office, accountName: "Office", debitAmount: 100, creditAmount: 0 },
      { accountId: bankLeaf, accountName: "Ops", debitAmount: 0, creditAmount: 100 },
    ]);
    const out = {
      reconciled: reconciled && /is reconciled through/.test(reconciled.message),
      afterReconciledDate: afterIt,
      approval: [approve.status, approve.body?.code, (await entry(draft.body.id)).status],
      wht: wht?.constraint,
      inputVat: inputVat?.constraint,
      mirrorOfMirror: mirrorOfMirror?.constraint,
    };
    console.warn("[G16] older guards", JSON.stringify(out));
    expect(out).toEqual({
      reconciled: true,
      afterReconciledDate: null,
      approval: [409, "bank_reconciled_through", "draft"],
      wht: "wht_payable_unowned",
      inputVat: "journal_entries_input_vat_link",
      mirrorOfMirror: "journal_mirror_not_reversible",
    });
    // One entry was written (the 07-05 posting), plus the manual draft and the reversed pair's two.
    expect(Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n) - before).toBe(4);
  }, 120_000);

  it("🔴 TRUNCATE of either table is refused; every G16 trigger is ordinary (replica, owner-only, is the one bypass) and sorts after every older trigger on its table", async () => {
    // 🔴 THE STAND-IN, NAMED: neither journal table can be truncated without CASCADE (other tables
    // reference them), and a CASCADE would take exclusive locks across the ledger while other files
    // run. So the refusal is proven on a TEMPORARY table bound to the SAME function, and the binding
    // to both journal tables is read from the catalogue — BEFORE TRUNCATE, per statement.
    const viaFunction = await ownerTx(async (c) => {
      await c.query("CREATE TEMP TABLE g16_truncate_probe (x int) ON COMMIT DROP");
      await c.query("CREATE TRIGGER g16_truncate_probe_trg BEFORE TRUNCATE ON g16_truncate_probe FOR EACH STATEMENT EXECUTE FUNCTION zz_journal_truncate_refused()");
      await c.query("TRUNCATE g16_truncate_probe");
    });
    expect([viaFunction.constraint, viaFunction.where], "the function refuses a TRUNCATE").toEqual(["journal_truncate_refused", "statement"]);
    const bound = (await pool.query(
      `SELECT c.relname AS tbl, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname LIKE 'zz_%truncate_refused' ORDER BY c.relname`)).rows.map((r) => `${r.tbl}: ${r.def.replace(/^.* BEFORE/, "BEFORE")}`);
    expect(bound).toEqual([
      "journal_entries: BEFORE TRUNCATE ON public.journal_entries FOR EACH STATEMENT EXECUTE FUNCTION zz_journal_truncate_refused()",
      "journal_entry_lines: BEFORE TRUNCATE ON public.journal_entry_lines FOR EACH STATEMENT EXECUTE FUNCTION zz_journal_truncate_refused()",
    ]);
    const { rows } = await pool.query(
      `SELECT c.relname AS tbl, t.tgname AS name, t.tgenabled AS enabled
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname IN ('journal_entries', 'journal_entry_lines') AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`);
    const g16 = rows.filter((r) => r.name.startsWith("zz_"));
    expect(g16.map((r) => `${r.tbl}.${r.name}=${r.enabled}`).sort()).toEqual([
      "journal_entries.zz_journal_entries_posted_frozen=O",
      "journal_entries.zz_journal_entries_truncate_refused=O",
      "journal_entry_lines.zz_journal_entry_lines_posted_frozen=O",
      "journal_entry_lines.zz_journal_entry_lines_posted_frozen_at_commit=O",
      "journal_entry_lines.zz_journal_entry_lines_truncate_refused=O",
    ]);
    for (const tbl of ["journal_entries", "journal_entry_lines"]) {
      const older = rows.filter((r) => r.tbl === tbl && !r.name.startsWith("zz_")).map((r) => r.name);
      const mine = rows.filter((r) => r.tbl === tbl && r.name.startsWith("zz_")).map((r) => r.name);
      expect(older.length, `${tbl} has older guards`).toBeGreaterThan(0);
      for (const m of mine) for (const o of older) expect(m > o, `${m} sorts after ${o}`).toBe(true);
    }
  }, 60_000);

  it("🔴 each pre-check SEES its violation, planted and rolled back; an entry balancing at zero is not one (balance only); the migration's DO block refuses on a violation", async () => {
    const { original, mirror } = await reversedPair();
    const posted = await postedEntry();
    const noLines = await postedEntry();
    const mine = async (c: PoolClient) => (await c.query(
      `SELECT check_no, entry_id FROM g16_journal_precheck_violations() WHERE entry_id = ANY($1::int[]) ORDER BY check_no, entry_id`,
      [[original, mirror, posted, noLines]])).rows.map((r) => [r.check_no, r.entry_id]);
    const clean = await planted(mine);
    const p1 = await planted(async (c) => {
      await c.query(`ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_status_chk`);
      await c.query(`UPDATE journal_entries SET status = 'void' WHERE id = $1`, [posted]);
      return mine(c);
    });
    const p2 = await planted(async (c) => { await c.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [posted]); return mine(c); });
    const p3 = await planted(async (c) => { await c.query(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [original]); return mine(c); });
    const p4 = await planted(async (c) => {
      await c.query(`UPDATE journal_entry_lines SET company_id = $2 WHERE id = (SELECT min(id) FROM journal_entry_lines WHERE journal_entry_id = $1)`, [posted, company2]);
      return mine(c);
    });
    const p5 = await planted(async (c) => {
      await c.query(`UPDATE journal_entry_lines SET debit_amount = debit_amount + 1 WHERE id = (SELECT min(id) FROM journal_entry_lines WHERE journal_entry_id = $1 AND debit_amount > 0)`, [posted]);
      return mine(c);
    });
    const zeroLines = await planted(async (c) => { await c.query(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [noLines]); return mine(c); });
    const here = dirname(fileURLToPath(import.meta.url));
    const migration = readFileSync(resolve(here, "../../../../packages/db/migrations/0126_g16_posted_journal_freeze.sql"), "utf8");
    const doBlock = migration.slice(migration.indexOf("DO $$"), migration.indexOf("END $$;") + "END $$;".length);
    const refusal = await planted(async (c) => {
      await c.query(`UPDATE journal_entry_lines SET debit_amount = debit_amount + 1 WHERE id = (SELECT min(id) FROM journal_entry_lines WHERE journal_entry_id = $1 AND debit_amount > 0)`, [posted]);
      return c.query(doBlock).then(() => "PASSED", (e) => messageOf(e));
    });
    // The DO block reads the WHOLE database, so its refusal is identified by THIS entry, not by a count.
    const names = (m: string) => m.startsWith("G16 pre-check REFUSED:") && m.includes(`"check": 5`) && m.includes(`"entry_id": ${posted}`);
    const out = { clean, p1, p2, p3, p4, p5, zeroLines, refusalNamesIt: names(refusal) };
    console.warn("[G16] pre-checks", JSON.stringify({ ...out, refusal: refusal.slice(0, 300) }));
    expect(out).toEqual({
      clean: [],
      p1: [[1, posted]],
      p2: [[2, posted]],
      p3: [[3, mirror]],
      p4: [[4, posted]],
      p5: [[5, posted]],
      zeroLines: [],
      refusalNamesIt: true,
    });
  }, 120_000);

  it("G16's refusals are deliberately not translated: reaching one is a defect — a 500 `commit_failed`, paged, never a 2xx (the gate test proves the path)", () => {
    for (const constraint of [FROZEN, LINE_FROZEN, "journal_entry_inserted_not_draft", "journal_entry_posted_unbalanced", "journal_entry_reversal_mirror_missing", "journal_truncate_refused"]) {
      expect(translateDbRefusal({ code: "23514", constraint, message: "x" }), constraint).toBeNull();
    }
  });
});
