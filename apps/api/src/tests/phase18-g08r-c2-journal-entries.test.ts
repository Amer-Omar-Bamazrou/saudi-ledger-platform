/**
 * 🔴 B-G08R-P (c2) — PROOF ONLY (owner-approved 2026-10-18), MANUAL JOURNAL
 * ENTRIES. Known-failing by design while a defect exists: each assertion states
 * the correct behaviour.
 *
 * Residual R3 (register DR-49). The journal-entry adapter posts with an update
 * keyed on id only (`updateEntry`), `hardDelete` deletes keyed on id only, and
 * `deleteDraft` checks the status, then deletes; the lines cascade with the
 * entry. A journal entry has no submit or send-back stage. Forced with
 * `helpers/g08rRace.ts`: two approvals at once; a reject and a DELETE, each
 * queued behind an approval. Soft assertions report every consequence.
 *
 * DB-backed (sl_test); skips on the DB-free placeholder. Run through the pre-flight gate.
 */
process.env.PORT ??= "3175";
process.env.SESSION_SECRET ??= "g08r-c2-journal-proof-000000000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { auditsOf, brief, queuedBehind, statuses } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G08rProofPw123!";

describeMaybe("B-G08R-P (c2) — the G08 races on MANUAL JOURNAL ENTRIES", () => {
  const h = g04Harness("g08rc2");
  let orgId = "";
  let debitAccount = 0;
  let creditAccount = 0;
  let n = 0;
  const seqMsg: Record<string, string> = {};

  async function draftEntry(): Promise<number> {
    const no = `G08RC2-JE-${String(++n).padStart(3, "0")}`;
    const r = await h.api("bookkeeper", "POST", "/journal-entries", {
      entryNumber: no, date: "2026-10-05", description: "B-G08R-P (c2)",
      lines: [
        { accountId: debitAccount, accountName: "debit", debitAmount: 100, creditAmount: 0 },
        { accountId: creditAccount, accountName: "credit", debitAmount: 0, creditAmount: 100 },
      ],
    });
    expect(r.status, `create ${no}: ${JSON.stringify(r.body)}`).toBe(201);
    return r.body.id as number;
  }
  async function evidence(id: number) {
    const row = (await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [id])).rows[0] ?? null;
    const lines = Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entry_lines WHERE journal_entry_id = $1`, [id])).rows[0].n);
    return { entry: row, lines, audits: await auditsOf(orgId, "journal_entry", id) };
  }
  const approve = (who: string, id: number) => h.api(who, "POST", `/journal-entries/${id}/approve`, {});
  const reject = (id: number) => h.api("accountant", "POST", `/journal-entries/${id}/reject`, {});
  const del = (id: number) => h.api("admin", "DELETE", `/journal-entries/${id}`);
  const accountOf = async (code: string) => Number((await pool.query(
    `SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "G08R-c2 Co", "318181818181875");
    debitAccount = await accountOf("RENT_UTILITIES");
    creditAccount = await accountOf("OTHER_INCOME");
    for (const [who, role] of [["admin", "admin"], ["accountant", "accountant"], ["bookkeeper", "bookkeeper"]]) await h.mkUser(who, PW, orgId, role);
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("CONTROL (sequential): a draft rejects and deletes; a POSTED entry refuses a second approve, a reject and a DELETE", async () => {
    expect((await reject(await draftEntry())).status, "a draft rejects").toBe(204);
    expect((await del(await draftEntry())).status, "a draft deletes").toBe(204);
    const id = await draftEntry();
    expect((await approve("admin", id)).status).toBe(200);
    const before = await evidence(id);
    expect(before.entry?.status).toBe("posted");
    expect(before.lines).toBe(2);
    const r = { approveAgain: await approve("accountant", id), reject: await reject(id), del: await del(id) };
    expect(Object.values(r).map((x) => x.status)).toEqual([409, 409, 409]);
    expect(await evidence(id), "the posted entry is untouched by the three refusals").toEqual(before);
    for (const [k, v] of Object.entries(r)) seqMsg[k] = v.body?.error;
  }, 60_000);

  it("🔴 R3 — two approvals of one entry at once: one 200, the other the sequential 409; one approval recorded", async () => {
    const id = await draftEntry();
    const rs = await queuedBehind("journal_entries", id, [() => approve("admin", id), () => approve("accountant", id)]);
    const ev = await evidence(id);
    // eslint-disable-next-line no-console
    console.warn("[G08R-c2] double approve", JSON.stringify({ results: rs.map(brief), ...ev }));
    expect.soft(statuses(rs)).toEqual([200, 409]);
    expect.soft(rs.find((x) => x.status !== 200)?.body?.error, "the loser gets the sequential refusal").toBe(seqMsg.approveAgain);
    expect.soft(ev.entry?.status).toBe("posted");
    expect.soft(ev.audits.filter((a) => a.startsWith("approve:"))).toEqual(["approve:1"]);
  }, 60_000);

  for (const [label, act] of [["REJECT", reject], ["DELETE", del]] as const) {
    it(`🔴 R3 — a ${label} queued behind an approval: the approval 200, the ${label.toLowerCase()} the sequential 409; the posted entry survives with its lines`, async () => {
      const id = await draftEntry();
      const [ap, lost] = await queuedBehind("journal_entries", id, [() => approve("admin", id), () => act(id)]);
      const ev = await evidence(id);
      // eslint-disable-next-line no-console
      console.warn(`[G08R-c2] ${label.toLowerCase()} behind approve`, JSON.stringify({ approve: brief(ap), [label.toLowerCase()]: brief(lost), ...ev }));
      expect(ap.status).toBe(200);
      expect.soft(lost.status).toBe(409);
      expect.soft(lost.body?.error).toBe(label === "REJECT" ? seqMsg.reject : seqMsg.del);
      expect.soft(ev.entry?.status, "the posted entry still exists, posted").toBe("posted");
      expect.soft(ev.lines, "its lines are still in the ledger").toBe(2);
    }, 60_000);
  }
});
