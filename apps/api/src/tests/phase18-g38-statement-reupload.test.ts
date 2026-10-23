/**
 * 🔴 G38 (Phase 18, B-SMALL-4) — PROOF FIRST: A RE-UPLOAD OF THE SAME
 * STATEMENT IMPORTS NOTHING.
 *
 * The line de-duplication counts by MULTIPLICITY (`scale-and-collision.test.ts`):
 * an upload imports as many copies of a line as the file carries MINUS as many
 * as the bank already holds. It reads "already holds" with NO LOCK, and the
 * file-level refusal (`statement_already_imported`) keys on a SHA-256 the
 * CLIENT computes and may omit (`transactions.service.ts` upload,
 * `bankStatements.service.ts` prepare). So the same file sent twice at once — a
 * double submit, a retry while the first is still in flight, two tabs — is
 * judged twice against a bank that holds neither copy yet.
 *
 * The interleaving is FORCED, not hoped for (`helpers/g08rRace.ts`): a holder
 * transaction locks one row that the upload's FIRST LINE insert must key-share;
 * each upload is SEEN waiting in the holder's wait tree before the next is
 * sent; then the holder commits. Both uploads have therefore read the bank's
 * holdings for that line before either can commit — whatever the server does
 * to serialise them (a lock, a unique key) shows up as the second upload
 * waiting on the first, which the wait tree counts too.
 *
 * 🔴 THE STAND-IN, NAMED: every line carries `categoryId` (one of the org's own
 * expense accounts). The category is NOT part of a line's identity — the
 * de-duplication key is (date, description, amount, type, bank) — and is there
 * only because the line INSERT key-shares that account's row (its foreign
 * key), which makes the account row the gate AFTER the holdings read. The bank
 * row cannot be the gate for a statement upload: the statement's own insert
 * key-shares it BEFORE the line reads, so the race would no longer be forced.
 *
 * FIX-NEUTRAL: the invariant is the bank's line count and net (one copy per
 * statement line) and Σ `inserted` over both responses. A re-upload may be
 * refused (409) or answered with nothing imported; it may never import a line
 * twice, and never answer 5xx.
 *
 * CONTROLS (the probe can SEE the safe case, so a green proof is not a blind
 * one): the same file twice IN SEQUENCE imports nothing; the same file twice AT
 * ONCE with the same client hash is already safe — the unique index on
 * (company, bank, file_sha256) queues the second behind the first.
 */
process.env.PORT ??= "3215";
process.env.SESSION_SECRET ??= "g38-statement-reupload-secret-0000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { g04Harness, type Res } from "./helpers/g04Harness";
import { queuedBehind } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G38ProofPw1!";
const sha = (c: string) => c.repeat(64);

describeMaybe("G38 — the same statement uploaded twice imports every line ONCE", () => {
  const h = g04Harness("g38p");
  const { api } = h;
  let orgId = "";
  let account = 0; // the gate: an expense account of the org (see the stand-in note above)
  let n = 0;

  /** The statement, as the browser sends it after parsing the file: three distinct lines. */
  const rows = () => [
    { date: "2026-05-03", description: "G38 OFFICE RENT MAY", amount: 4000, type: "debit", currency: "SAR", categoryId: account },
    { date: "2026-05-07", description: "G38 ELECTRICITY APRIL", amount: 612.4, type: "debit", currency: "SAR", categoryId: account },
    { date: "2026-05-12", description: "G38 WATER APRIL", amount: 23, type: "debit", currency: "SAR", categoryId: account },
  ];
  const ONCE = { lines: 3, total: 4635.4 };

  const mkBank = async () => {
    const r = await api("a", "POST", "/bank-accounts", { name: `G38 bank ${++n}`, bankName: "Riyad", currency: "SAR", balance: 0, openingBalance: 0 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };
  const upload = (bankAccountId: number, statement?: Record<string, unknown>) => () =>
    api("a", "POST", "/transactions/upload", { rows: rows(), bankAccountId, autoCategrize: false, ...(statement ? { statement } : {}) });
  /** What the bank holds: its line count and their total. */
  const held = async (bankAccountId: number) => {
    const { rows: r } = await pool.query(
      `SELECT count(*)::int AS n, coalesce(sum(amount), 0)::numeric AS total FROM transactions WHERE organization_id = $1 AND bank_account_id = $2`,
      [orgId, bankAccountId],
    );
    return { lines: r[0].n as number, total: Number(r[0].total) };
  };
  /** Fix-neutral reading of the responses: each is 200 or a 409 refusal, never a 5xx; Σ inserted over the 200s. */
  const imported = (rs: Res[]) => {
    for (const r of rs) expect([200, 409], `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`).toContain(r.status);
    return rs.filter((r) => r.status === 200).reduce((s, r) => s + Number(r.body.inserted), 0);
  };

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    await h.start();
    orgId = await h.mkOrg("a");
    await h.mkCompany(orgId, "G38 Co", "308080808080803");
    await h.mkUser("a", PW, orgId);
    expect(await h.login("a", h.email("a"), PW)).toBe(200);
    account = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'RENT_UTILITIES'`, [orgId])).rows[0].id;
  }, 120_000);
  afterAll(async () => {
    await h.cleanup();
    await h.stop();
  });

  it("CONTROL — the same file twice IN SEQUENCE: the second imports nothing", async () => {
    const bank = await mkBank();
    const first = await upload(bank)();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.inserted).toBe(3);
    const second = await upload(bank)();
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.inserted).toBe(0);
    expect(second.body.duplicatesSkipped).toBe(3);
    expect(await held(bank)).toEqual(ONCE);
  });

  it("CONTROL — the same file twice AT ONCE, both with the same client hash: the second is refused, nothing imported twice", async () => {
    const bank = await mkBank();
    const statement = { fileName: "may.csv", fileSha256: sha("c") };
    const rs = await queuedBehind("categories", account, [upload(bank, statement), upload(bank, statement)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)!.body.code).toBe("statement_already_imported");
    expect({ imported: imported(rs), ...(await held(bank)) }).toEqual({ imported: 3, ...ONCE });
  });

  it("🔴 PROOF — the same file twice AT ONCE with no statement block (paste, manual entry, any API client): every line held ONCE", async () => {
    const bank = await mkBank();
    const rs = await queuedBehind("categories", account, [upload(bank), upload(bank)]);
    expect({ imported: imported(rs), ...(await held(bank)) }).toEqual({ imported: 3, ...ONCE });
  });

  it("🔴 PROOF — the same file twice AT ONCE as a statement whose hash the client omitted: every line held ONCE", async () => {
    const bank = await mkBank();
    const statement = { fileName: "may.csv" };
    const rs = await queuedBehind("categories", account, [upload(bank, statement), upload(bank, statement)]);
    expect({ imported: imported(rs), ...(await held(bank)) }).toEqual({ imported: 3, ...ONCE });
  });

  it("🔴 PROOF — the same file twice AT ONCE as a statement, the client stating a different hash each time: every line held ONCE", async () => {
    const bank = await mkBank();
    const rs = await queuedBehind("categories", account, [
      upload(bank, { fileName: "may.csv", fileSha256: sha("d") }),
      upload(bank, { fileName: "may.csv", fileSha256: sha("e") }),
    ]);
    expect({ imported: imported(rs), ...(await held(bank)) }).toEqual({ imported: 3, ...ONCE });
  });
});
