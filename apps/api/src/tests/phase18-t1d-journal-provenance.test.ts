/**
 * 🔴 T1d (Phase 18; G07, G17, SG-11, N-G): WHO wrote and approved every journal
 * entry, WHAT produced it, and no system number typed by a user. Owner
 * authorisation 2026-10-24 (evening) item 4, re-ordered 2026-10-27 morning;
 * register §11.28.
 *
 *  - Every entry records its creator (`created_by`), its source (`source_type`,
 *    `source_id`), and its approver (`approved_by`) when an approval posted it.
 *  - 🔴 The owner's rule for the approver: written on the DRAFT, in the same
 *    transaction, immediately before the draft → posted flip. G16's rules are
 *    unchanged: its flip check still allows only `status` and `posted_at` to
 *    change, so an approver written IN the flip is refused at commit.
 *  - A manual entry cannot be posted without its approver (the database refuses).
 *  - A user-typed number cannot take a system shape (`JE-000043`, `DEP-…`,
 *    `BILL-7`, `…-REV`): refused by the service and, for the document shapes, by
 *    the database.
 *  - A taken entry number is reported as taken, not as a race (N-G).
 *
 * DB-backed (sl_test / CI); the N-G case needs no database.
 */
process.env.PORT ??= "3235";
process.env.SESSION_SECRET ??= "phase18-t1d-journal-provenance-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { translateDbRefusal } from "../lib/dbRefusals";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { JOURNAL_SOURCE_TYPES, RESERVED_ENTRY_NUMBER_PREFIXES } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18T1dProvenancePw1!";
const DATE = "2026-10-05";

type Client = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, any>> }> };
type Prov = { status: string; created_by: number | null; approved_by: number | null; source_type: string | null; source_id: number | null };

describe("N-G: a taken journal entry number is reported as taken", () => {
  it("🔴 a 23505 on journal_entries_company_number_unq says first that the number is already used; the race-only text is gone", () => {
    const r = translateDbRefusal(Object.assign(new Error("duplicate key"), { code: "23505", constraint: "journal_entries_company_number_unq" }));
    expect(r?.status).toBe(409);
    const text = String((r?.body as { error?: string }).error);
    expect(text).toMatch(/^That entry number is already used/);
    expect(text).not.toBe("Another entry was recorded at the same moment — reload and try again.");
  });
});

// Guards added WITH the change (not part of the red proof): they hold the census and the two lists.
describe("T1d guards — every production call of the posting seam names its source; the database lists match the code's", () => {
  const SRC = join(__dirname, "..");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "tests" ? [] : files(p);
    return p.endsWith(".ts") ? [p] : [];
  });
  /** Each `postJournalEntry({ … })` object literal, by balanced braces. */
  const calls = files(SRC).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const out: Array<{ at: string; obj: string }> = [];
    for (let i = text.indexOf("postJournalEntry({"); i !== -1; i = text.indexOf("postJournalEntry({", i + 1)) {
      let depth = 0;
      let j = i + "postJournalEntry(".length;
      for (; j < text.length; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}" && --depth === 0) break;
      }
      out.push({ at: `${file.slice(SRC.length + 1)}:${text.slice(0, i).split("\n").length}`, obj: text.slice(i, j + 1) });
    }
    return out;
  });

  it("🔴 every production call names sourceType and sourceId (37 at T1d; a census that cannot see them is not a census)", () => {
    expect(calls.length, "the instrument sees the calls").toBeGreaterThanOrEqual(37);
    const missing = calls.filter((c) => !/\bsourceType:/.test(c.obj) || !/\bsourceId:/.test(c.obj)).map((c) => c.at);
    expect(missing).toEqual([]);
  });

  const migration = readFileSync(join(SRC, "..", "..", "..", "packages", "db", "migrations", "0129_t1d_journal_provenance.sql"), "utf8");
  it("🔴 the database's source types are JOURNAL_SOURCE_TYPES, exactly", () => {
    const check = migration.slice(migration.indexOf('"journal_entries_source_type_chk"'), migration.indexOf('"journal_entries_source_id_chk"'));
    expect([...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...JOURNAL_SOURCE_TYPES].sort());
  });
  it("🔴 the database's reserved prefixes are RESERVED_ENTRY_NUMBER_PREFIXES, exactly (in the CHECK and in the pre-check)", () => {
    const lists = [...migration.matchAll(/\^\(([A-Z|]+)\)-\|-REV\$/g)].map((m) => m[1]!.split("|").sort());
    expect(lists.length).toBe(2);
    for (const l of lists) expect(l).toEqual([...RESERVED_ENTRY_NUMBER_PREFIXES].sort());
  });
});

describeMaybe("T1d — every journal entry records who created it, who approved it, and what produced it", () => {
  const h = g04Harness("p18t1d");
  let orgId = "";
  let companyId = "";
  let makerId = 0;
  let checkerId = 0;
  let adminId = 0;
  let bankId = 0;
  let office = 0;
  let income = 0;

  // to_jsonb, so a column that does not exist reads as undefined (an assertion failure), not an SQL error.
  const prov = async (id: number): Promise<Prov> => {
    const { rows: [r] } = await pool.query(`SELECT to_jsonb(j.*) AS j FROM journal_entries j WHERE id = $1`, [id]);
    const j = r.j;
    return { status: j.status, created_by: j.created_by, approved_by: j.approved_by, source_type: j.source_type, source_id: j.source_id };
  };
  const account = async (code: string) =>
    Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id);
  const manual = (entryNumber?: string) => ({
    ...(entryNumber === undefined ? {} : { entryNumber }),
    date: DATE,
    description: "T1d proof",
    lines: [
      { accountId: office, accountName: "Office", debitAmount: 100, creditAmount: 0 },
      { accountId: income, accountName: "Income", debitAmount: 0, creditAmount: 100 },
    ],
  });
  const jeCount = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "T1d Provenance Co", "318181818181922");
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    makerId = await h.mkUser("maker", PW, orgId, "admin");
    checkerId = await h.mkUser("checker", PW, orgId, "accountant");
    await h.start();
    for (const who of ["admin", "maker", "checker"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "T1d Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    bankId = bank.body.id as number;
    office = await account("OFFICE_SUPPLIES");
    income = await account("SALES");
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  let manualId = 0;

  it("🔴 a manual entry records its maker, and its approver on the draft before the flip; its source is manual", async () => {
    const created = await h.api("maker", "POST", "/journal-entries", manual());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    manualId = created.body.id as number;
    const asDraft = await prov(manualId);
    expect((await h.api("checker", "POST", `/journal-entries/${manualId}/approve`, {})).status).toBe(200);
    // Read both, then assert: the approval happens either way, so the later cases test their own rule.
    expect(asDraft, "the draft: maker recorded, no approver yet").toEqual({ status: "draft", created_by: makerId, approved_by: null, source_type: "manual", source_id: null });
    expect(await prov(manualId), "posted: the approver is the checker, not the maker").toEqual({ status: "posted", created_by: makerId, approved_by: checkerId, source_type: "manual", source_id: null });
  });

  it("🔴 an entry the posting seam writes INSIDE an approval records the approver and its source document (an invoice)", async () => {
    const cust = await h.api("admin", "POST", "/customers", { name: "T1d Buyer", taxNumber: "300000000000003" });
    expect(cust.status, JSON.stringify(cust.body)).toBe(201);
    const inv = await h.api("maker", "POST", "/invoices", { date: DATE, customerId: cust.body.id, items: [{ description: "Services", quantity: 1, unitPrice: 1_000, vatRate: 15 }] });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect((await h.api("checker", "POST", `/invoices/${inv.body.id}/approve`, {})).status).toBe(200);
    const { rows: [gl] } = await pool.query(`SELECT j.id FROM journal_entries j JOIN invoices i ON j.entry_number = 'GL-' || i.invoice_number AND j.company_id = i.company_id WHERE i.id = $1`, [inv.body.id]);
    expect(gl, "the invoice's entry exists").toBeDefined();
    expect(await prov(gl.id)).toEqual({ status: "posted", created_by: checkerId, approved_by: checkerId, source_type: "invoice", source_id: inv.body.id });

    // OUTSIDE an approval: a payment records its actor and source, and no approver.
    const pay = await h.api("admin", "POST", `/invoices/${inv.body.id}/pay`, { amount: 1_150, paidAt: DATE, bankAccountId: bankId });
    expect(pay.status, JSON.stringify(pay.body)).toBe(200);
    const { rows: [rc] } = await pool.query(
      `SELECT j.id, substring(j.entry_number from '-RCPT-([0-9]+)$')::int AS payment_id FROM journal_entries j JOIN invoices i ON j.company_id = i.company_id
        WHERE i.id = $1 AND j.entry_number LIKE 'GL-' || i.invoice_number || '-RCPT-%'`, [inv.body.id]);
    expect(rc, "the receipt's entry exists").toBeDefined();
    expect(await prov(rc.id)).toEqual({ status: "posted", created_by: adminId, approved_by: null, source_type: "customer_payment", source_id: rc.payment_id });
  });

  it("🔴 the generic reverse records who reversed and the entry it reverses", async () => {
    const r = await h.api("checker", "POST", `/journal-entries/${manualId}/reverse`, { reason: "T1d proof" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await prov(r.body.reversalId as number)).toEqual({ status: "posted", created_by: checkerId, approved_by: null, source_type: "reversal", source_id: manualId });
  });

  it("🔴 a user-typed number cannot take a system shape — refused by name, nothing written; an ordinary number is accepted", async () => {
    const before = await jeCount();
    for (const n of ["JE-000043", "DEP-FA-1-2026-10", "BILL-7", "bill-7", "GL-INV-000001", "PAY-2026-10-R1", "MANUAL-9-REV"]) {
      const r = await h.api("maker", "POST", "/journal-entries", manual(n));
      expect([r.status, r.body.code], `${n}: ${JSON.stringify(r.body)}`).toEqual([422, "entry_number_reserved"]);
    }
    expect(await jeCount(), "nothing was written").toBe(before);
    const ok = await h.api("maker", "POST", "/journal-entries", manual("ADJ-2026-10"));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await jeCount()).toBe(before + 1);
  });

  it("🔴 the database: a manual entry is not posted without its approver; the approver goes on the draft, never in the flip (G16 unchanged); a manual entry cannot take a document's number", async () => {
    const draft = async (c: Client, n: string, approvedBy: number | null) => {
      const { rows: [e] } = await c.query(
        `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status, created_by, approved_by, source_type)
         VALUES ($1, $2, $3, $4, 'T1d DB', 'draft', $5, $6, 'manual') RETURNING id`, [orgId, companyId, n, DATE, makerId, approvedBy]);
      await c.query(
        `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4, 'Office', 10, 0), ($1, $2, $3, $5, 'Income', 0, 10)`, [orgId, companyId, e.id, office, income]);
      return e.id as number;
    };
    const attempt = async (fn: (c: Client) => Promise<void>) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await fn(c);
        await c.query("COMMIT");
        return null;
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        return err as { constraint?: string; message: string };
      } finally {
        c.release();
      }
    };
    // (a) posted with no approver: refused.
    const a = await attempt(async (c) => { const id = await draft(c, "T1D-DB-A", null); await c.query(`UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = $1`, [id]); });
    expect(a?.constraint, a?.message).toBe("journal_entry_posted_without_approver");
    // (b) the approver written IN the flip: G16 refuses at commit, naming the column.
    const b = await attempt(async (c) => { const id = await draft(c, "T1D-DB-B", null); await c.query(`UPDATE journal_entries SET status = 'posted', posted_at = now(), approved_by = $2 WHERE id = $1`, [id, checkerId]); });
    expect([b?.constraint, /approved_by/.test(String(b?.message))], b?.message).toEqual(["journal_entry_posted_frozen", true]);
    // (c) the owner's order: the approver on the draft, then the flip — committed.
    let cId = 0;
    const cErr = await attempt(async (c) => {
      cId = await draft(c, "T1D-DB-C", null);
      await c.query(`UPDATE journal_entries SET approved_by = $2 WHERE id = $1`, [cId, checkerId]);
      await c.query(`UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = $1`, [cId]);
    });
    expect(cErr?.message ?? null).toBeNull();
    expect(await prov(cId)).toEqual({ status: "posted", created_by: makerId, approved_by: checkerId, source_type: "manual", source_id: null });
    // (d) a manual entry numbered like a bill's entry: refused by the database.
    const d = await attempt(async (c) => { await draft(c, "BILL-7", null); });
    expect(d?.constraint, d?.message).toBe("journal_entries_manual_number_reserved_chk");
  });
});
