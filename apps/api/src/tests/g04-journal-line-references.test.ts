/**
 * 🔴 G04 (2026-10-07) — A JOURNAL LINE NAMES ONLY ITS OWN ORGANIZATION'S
 * ACCOUNT, CUSTOMER AND VENDOR. Proven at every layer, independently.
 *
 * THE DEFECT (reproduced on unmodified main, d828f786): the manual journal
 * refused only the accounts its RLS-scoped lookup FOUND. Another tenant's id is
 * invisible under RLS, so no rule ran on it, and Postgres checks a foreign key
 * OUTSIDE RLS — so the line was written, approved and POSTED on another
 * tenant's account, and a nonexistent id failed the key as a raw 500 (an
 * existence oracle). `postJournalEntry` and the approval and reversal paths had
 * the same "refuse only what you can see" shape.
 *
 * THE RULE THESE TESTS HOLD:
 *   - the DATABASE refuses the reference itself: the line's foreign keys carry
 *     the organization (`(organization_id, account_id) → categories
 *     (organization_id, id)`, the same for customer and vendor), so no writer —
 *     under RLS or not — can store a cross-organization edge (migration 0122);
 *   - the service, the posting seam, approval and reversal each refuse an id
 *     their organization does not own, by an explicit `organization_id`
 *     predicate rather than RLS visibility, with ONE controlled 422
 *     (`reference_not_found`) — identical for a foreign and a missing id;
 *   - accounts, customers and vendors stay ORGANIZATION-level: the same
 *     organization's other company still posts to them.
 *
 * A layer is tested on its own by PLANTING what the layer above would refuse
 * (named at each site), so a test cannot pass because a higher layer caught it.
 */
process.env.PORT ??= "3124";
process.env.SESSION_SECRET ??= "g04-journal-line-references-secret-000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection, db, categoriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { __resetRateLimitsForTests } from "../routes/auth";
import { journalEntriesService } from "../services/journalEntries.service";
import { journalEntriesRepository } from "../repositories/journalEntries.repository";
import { postJournalEntry } from "../services/accounting/glPosting";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G04JournalRefsPw1!";
const MISSING = 2_000_000_000;

describeMaybe("G04 — a journal line references only its own organization's account, customer and vendor", () => {
  const h = g04Harness("g04j");
  const { api, inTenant } = h;
  const org: Record<string, string> = {};
  const co: Record<string, string> = {};
  const uid: Record<string, number> = {};
  const acct: Record<string, number> = {};
  const party: Record<string, number> = {};
  let seq = 0;

  const sys = async (o: string, code: string) =>
    (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [o, code])).rows[0].id as number;
  const entry = (debitAccount: number, extra: Record<string, unknown> = {}) => ({
    entryNumber: `G04J-${++seq}`,
    date: "2026-10-01",
    description: "G04 journal references",
    lines: [
      { accountId: debitAccount, accountName: "debit line", debitAmount: 100, creditAmount: 0, ...extra },
      { accountId: acct.xIncome, accountName: "credit line", debitAmount: 0, creditAmount: 100 },
    ],
  });
  const counts = async () => (await pool.query(
    `SELECT (SELECT count(*)::int FROM journal_entries WHERE organization_id = $1) AS entries,
            (SELECT count(*)::int FROM journal_entry_lines WHERE organization_id = $1) AS lines`, [org.x])).rows[0] as { entries: number; lines: number };
  /** Lines of X naming a row of ANOTHER organization — the cross-tenant edge itself, read as the owner. */
  const crossLines = async () => Number((await pool.query(
    `SELECT count(*)::int AS n FROM journal_entry_lines l
       LEFT JOIN categories c ON c.id = l.account_id
       LEFT JOIN customers cu ON cu.id = l.customer_id
       LEFT JOIN vendors v ON v.id = l.vendor_id
      WHERE l.organization_id = $1
        AND (c.organization_id <> l.organization_id OR cu.organization_id <> l.organization_id OR v.organization_id <> l.organization_id)`, [org.x])).rows[0].n);
  /** Create through the API and, when created, approve — what an attacker would do with a 201. */
  const createAndApprove = async (body: unknown) => {
    const r = await api("x", "POST", "/journal-entries", body);
    if (r.status === 201) await api("x", "POST", `/journal-entries/${r.body.id}/approve`, {});
    return r;
  };
  /**
   * Re-point a stored line BELOW every check: the owner connection with
   * triggers and foreign keys set aside. A stand-in for any writer that would
   * bypass the key — it exists so approval and reversal are tested on their
   * own, not because such a writer is known.
   */
  const plantLineReference = async (lineId: number, column: "account_id" | "customer_id" | "vendor_id", value: number) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`UPDATE journal_entry_lines SET ${column} = $1 WHERE id = $2`, [value, lineId]);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  };
  const refusalOf = (e: any) => ({ status: e?.statusCode, code: e?.payload?.code ?? e?.code, field: e?.payload?.field, error: e?.payload?.error ?? e?.message });

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    org.x = await h.mkOrg("x");
    org.y = await h.mkOrg("y");
    co.x1 = await h.mkCompany(org.x, "G04J x1", "304040404040503");
    co.x2 = await h.mkCompany(org.x, "G04J x2", "304040404040513");
    co.y1 = await h.mkCompany(org.y, "G04J y1", "304040404040523");
    uid.x = await h.mkUser("x", PW, org.x);
    uid.y = await h.mkUser("y", PW, org.y);
    await h.start();
    for (const k of ["x", "y"]) expect(await h.login(k, h.email(k), PW)).toBe(200);

    acct.xExpense = await sys(org.x, "RENT_UTILITIES");
    acct.xIncome = await sys(org.x, "OTHER_INCOME");
    acct.xAR = await sys(org.x, "AR");
    acct.xAP = await sys(org.x, "AP");
    acct.xWht = await sys(org.x, "WHT_PAYABLE");
    acct.yExpense = await sys(org.y, "RENT_UTILITIES"); // the SAME system code as X's
    acct.yIncome = await sys(org.y, "OTHER_INCOME");
    acct.yAR = await sys(org.y, "AR");
    acct.yWht = await sys(org.y, "WHT_PAYABLE");
    const named = async (who: "x" | "y") => {
      const r = await api(who, "POST", "/categories", { name: "G04 Shared Name", nameAr: "اسم مشترك", type: "expense", vatApplicable: false });
      expect(r.status).toBe(201);
      return r.body.id as number;
    };
    acct.xSameName = await named("x");
    acct.ySameName = await named("y");
    const yb = await api("y", "POST", "/bank-accounts", { name: "Y Main", bankName: "Y Bank", currency: "SAR", balance: 0, openingBalance: 0 });
    expect(yb.status).toBe(201);
    acct.yBankLeaf = (await pool.query(`SELECT id FROM categories WHERE bank_account_id = $1`, [yb.body.id])).rows[0].id;
    acct.xHeader = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND is_posting = false LIMIT 1`, [org.x])).rows[0].id;
    acct.yHeader = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND is_posting = false LIMIT 1`, [org.y])).rows[0].id;
    // An account that EXISTED and was removed (no API deletes one; its id stops existing).
    const gone = await api("x", "POST", "/categories", { name: "G04 Deleted", nameAr: "محذوف", type: "expense", vatApplicable: false });
    acct.deleted = gone.body.id;
    await pool.query(`DELETE FROM categories WHERE id = $1`, [acct.deleted]);
    for (const w of ["x", "y"] as const) {
      party[`${w}Customer`] = (await api(w, "POST", "/customers", { name: `G04J customer ${w}` })).body.id;
      party[`${w}Vendor`] = (await api(w, "POST", "/vendors", { name: `G04J vendor ${w}`, residency: "resident" })).body.id;
    }
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  // ── The API: what a tenant can send ─────────────────────────────────────────
  it("CONTROL: the tenant's OWN account is created (201) and approved/posted (200)", async () => {
    const r = await api("x", "POST", "/journal-entries", entry(acct.xExpense));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const a = await api("x", "POST", `/journal-entries/${r.body.id}/approve`, {});
    expect(a.status).toBe(200);
    expect(a.body.status).toBe("posted");
  });

  it("CONTROL (sharing): the SAME organization's other company posts to the organization's account", async () => {
    const out: any = await inTenant(org.x, co.x2, uid.x, async () => {
      const je: any = await journalEntriesService.create(entry(acct.xExpense) as any, uid.x);
      return journalEntriesService.approve(je.id, uid.x);
    });
    expect(out.status).toBe("posted");
    const { rows } = await pool.query(`SELECT company_id FROM journal_entry_lines WHERE journal_entry_id = $1`, [out.id]);
    expect(rows.every((r) => r.company_id === co.x2), "the lines are company x2's, on the organization's chart").toBe(true);
  });

  it("CONTROL: the tenant's OWN AR without a customer is refused (422) — the party rule still runs", async () => {
    const r = await api("x", "POST", "/journal-entries", entry(acct.xAR));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("journal_line_party_invalid");
  });

  it("🔴 ANOTHER TENANT's account (the same system code) is refused 422 reference_not_found, and nothing is written", async () => {
    const before = await counts();
    const r = await createAndApprove(entry(acct.yExpense));
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body).toMatchObject({ code: "reference_not_found", field: "lines[0].accountId" });
    expect(await counts(), "no entry and no line").toEqual(before);
  });

  it("🔴 a NONEXISTENT and a DELETED account id get the SAME refusal as another tenant's — no raw 500, no oracle", async () => {
    const foreign = await api("x", "POST", "/journal-entries", entry(acct.yExpense));
    const missing = await api("x", "POST", "/journal-entries", entry(MISSING));
    const deleted = await api("x", "POST", "/journal-entries", entry(acct.deleted));
    expect(missing.status).toBe(422);
    expect(missing.body, "missing ≡ foreign").toEqual(foreign.body);
    expect(deleted.body, "deleted ≡ foreign").toEqual(foreign.body);
  });

  it("🔴 every other shape of another tenant's account is refused the same way: system AR, header, same name, bank cash leaf", async () => {
    const ref = (await api("x", "POST", "/journal-entries", entry(MISSING))).body;
    for (const [label, id] of [["system AR", acct.yAR], ["header", acct.yHeader], ["same name", acct.ySameName], ["bank cash leaf", acct.yBankLeaf]] as const) {
      const r = await createAndApprove(entry(id));
      expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBe(422);
      expect(r.body, `${label} ≡ missing`).toEqual(ref);
    }
    // The tenant's OWN header is still refused by its own rule.
    expect((await api("x", "POST", "/journal-entries", entry(acct.xHeader))).body.code).toBe("account_not_posting");
  });

  it("CONTROL + 🔴 WHT_PAYABLE: the tenant's own manual line is refused (Phase 16); another tenant's is refused as well", async () => {
    const own = await createAndApprove(entry(acct.xWht));
    const ownApproved = own.status === 201 ? (await api("x", "GET", `/journal-entries/${own.body.id}`)).body.status : null;
    expect(own.status === 201 ? ownApproved : own.status, "own WHT_PAYABLE manual line is refused somewhere").not.toBe("posted");
    const foreign = await createAndApprove(entry(acct.yWht));
    expect(foreign.status).toBe(422);
  });

  it("🔴 the line's PARTY: another tenant's customer on AR, or vendor on AP, is refused — and a missing one the same way", async () => {
    const ar = (customerId: number) => ({ entryNumber: `G04J-${++seq}`, date: "2026-10-01", description: "AR party", lines: [
      { accountId: acct.xAR, accountName: "AR", debitAmount: 10, creditAmount: 0, customerId },
      { accountId: acct.xIncome, accountName: "Inc", debitAmount: 0, creditAmount: 10 }] });
    const ap = (vendorId: number) => ({ entryNumber: `G04J-${++seq}`, date: "2026-10-01", description: "AP party", lines: [
      { accountId: acct.xExpense, accountName: "Exp", debitAmount: 10, creditAmount: 0 },
      { accountId: acct.xAP, accountName: "AP", debitAmount: 0, creditAmount: 10, vendorId }] });
    expect((await api("x", "POST", "/journal-entries", ar(party.xCustomer))).status, "control: own customer").toBe(201);
    expect((await api("x", "POST", "/journal-entries", ap(party.xVendor))).status, "control: own vendor").toBe(201);
    const before = await counts();
    const fc = await createAndApprove(ar(party.yCustomer));
    const mc = await api("x", "POST", "/journal-entries", ar(MISSING));
    const fv = await createAndApprove(ap(party.yVendor));
    const mv = await api("x", "POST", "/journal-entries", ap(MISSING));
    for (const r of [fc, mc, fv, mv]) expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(mc.body, "missing customer ≡ foreign customer").toEqual(fc.body);
    expect(mv.body, "missing vendor ≡ foreign vendor").toEqual(fv.body);
    expect(await counts()).toEqual(before);
  });

  it("🔴 CONCURRENT: X writing on Y's account while Y posts to it — every X write refused, Y's three posted, the account carries only Y's lines", async () => {
    const xs = Array.from({ length: 3 }, () => createAndApprove(entry(acct.ySameName)));
    const ys = Array.from({ length: 3 }, async () => {
      const c = await api("y", "POST", "/journal-entries", {
        entryNumber: `G04J-Y-${++seq}`, date: "2026-10-01", description: "Y own",
        lines: [
          { accountId: acct.ySameName, accountName: "y debit", debitAmount: 10, creditAmount: 0 },
          { accountId: acct.yIncome, accountName: "y credit", debitAmount: 0, creditAmount: 10 },
        ],
      });
      return c.status === 201 ? (await api("y", "POST", `/journal-entries/${c.body.id}/approve`, {})).status : c.status;
    });
    const [xr, yr] = [await Promise.all(xs), await Promise.all(ys)];
    expect(xr.map((r) => r.status)).toEqual([422, 422, 422]);
    expect(yr).toEqual([200, 200, 200]);
    const byOrg = (await pool.query(`SELECT organization_id, count(*)::int AS n FROM journal_entry_lines WHERE account_id = $1 GROUP BY 1`, [acct.ySameName])).rows;
    expect(byOrg).toEqual([{ organization_id: org.y, n: 3 }]);
  });

  // ── Each layer on its own ───────────────────────────────────────────────────
  it("🔴 SERVICE: journalEntriesService.create refuses another tenant's account and a missing one identically", async () => {
    const foreign = await inTenant(org.x, co.x1, uid.x, () => journalEntriesService.create(entry(acct.yExpense) as any, uid.x)).then(() => null, refusalOf);
    const missing = await inTenant(org.x, co.x1, uid.x, () => journalEntriesService.create(entry(MISSING) as any, uid.x)).then(() => null, refusalOf);
    expect(foreign).toMatchObject({ status: 422, code: "reference_not_found" });
    expect(missing).toEqual(foreign);
  });

  it("🔴 REPOSITORY: insertLines naming another tenant's account is refused by the database (the composite key)", async () => {
    const out = await inTenant(org.x, co.x1, uid.x, async () => {
      const [je] = await journalEntriesRepository.insertEntry({ entryNumber: `G04J-R-${++seq}`, date: "2026-10-01", description: "repository layer" } as any);
      await journalEntriesRepository.insertLines([{ journalEntryId: je.id, accountId: acct.yExpense, accountName: "repo", debitAmount: "100.00", creditAmount: "0.00" } as any]);
    }).then(() => "accepted", (e) => `refused:${e.code ?? e.cause?.code}:${e.constraint ?? e.cause?.constraint}`);
    expect(out).toBe("refused:23503:journal_entry_lines_account_tenant_fk");
  });

  describe("🔴 DATABASE — every writer, under RLS and as the owner", () => {
    const tryInsert = async (asAppRole: boolean, cols: Record<string, unknown>) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        if (asAppRole) {
          await c.query("SET LOCAL ROLE authenticated");
          await c.query("SELECT set_config('app.current_org_id', $1, true), set_config('app.current_company_id', $2, true)", [org.x, co.x1]);
        }
        const je = (await c.query(
          `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description) VALUES ($1,$2,$3,'2026-10-01','db layer') RETURNING id`,
          [org.x, co.x1, `G04J-D-${++seq}`])).rows[0].id;
        const keys = Object.keys(cols);
        await c.query(
          `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_name, debit_amount, credit_amount, ${keys.join(", ")})
           VALUES ($1,$2,$3,'db',100,0, ${keys.map((_, i) => `$${i + 4}`).join(", ")})`,
          [org.x, co.x1, je, ...Object.values(cols)]);
        return "accepted";
      } catch (e: any) {
        return `refused:${e.code}:${e.constraint}`;
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    };

    it("RLS hides the foreign account from the tenant — the READ side was never the hole", async () => {
      const conn = await beginTenantConnection({ organizationId: org.x, companyId: co.x1, role: "authenticated" });
      try {
        const seen = await conn.run(async () => (await db.select().from(categoriesTable).where(eq(categoriesTable.id, acct.ySameName))).length);
        expect(seen).toBe(0);
      } finally {
        await conn.rollback();
      }
    });

    for (const asAppRole of [true, false]) {
      const who = asAppRole ? "the app role, under RLS" : "the OWNER, with no RLS";
      it(`a line naming another organization's ACCOUNT, CUSTOMER or VENDOR is refused — ${who}`, async () => {
        expect(await tryInsert(asAppRole, { account_id: acct.yExpense })).toBe("refused:23503:journal_entry_lines_account_tenant_fk");
        expect(await tryInsert(asAppRole, { account_id: MISSING })).toBe("refused:23503:journal_entry_lines_account_tenant_fk");
        expect(await tryInsert(asAppRole, { account_id: acct.xAR, party_type: "customer", customer_id: party.yCustomer })).toBe("refused:23503:journal_entry_lines_customer_tenant_fk");
        expect(await tryInsert(asAppRole, { account_id: acct.xAP, party_type: "vendor", vendor_id: party.yVendor })).toBe("refused:23503:journal_entry_lines_vendor_tenant_fk");
      });
      it(`CONTROL: its OWN account, customer and vendor are accepted — ${who}`, async () => {
        expect(await tryInsert(asAppRole, { account_id: acct.xExpense })).toBe("accepted");
        expect(await tryInsert(asAppRole, { account_id: acct.xAR, party_type: "customer", customer_id: party.xCustomer })).toBe("accepted");
        expect(await tryInsert(asAppRole, { account_id: acct.xAP, party_type: "vendor", vendor_id: party.xVendor })).toBe("accepted");
      });
    }
  });

  describe("🔴 POSTING SEAM — postJournalEntry trusts no caller", () => {
    const seam = (lines: any[]) => inTenant(org.x, co.x1, uid.x, () =>
      postJournalEntry({ entryNumber: `G04J-S-${++seq}`, date: "2026-10-01", description: "seam", lines } as any)).then((je: any) => `accepted:${je?.status}`, refusalOf);
    const credit = { accountId: 0, accountName: "seam credit", debitAmount: 0, creditAmount: 100 };

    it("an accountId of another tenant, and a missing one, are refused identically — before anything is written", async () => {
      const before = await counts();
      const foreign = await seam([{ accountId: acct.yExpense, accountName: "seam debit", debitAmount: 100, creditAmount: 0 }, { ...credit, accountId: acct.xIncome }]);
      const missing = await seam([{ accountId: MISSING, accountName: "seam debit", debitAmount: 100, creditAmount: 0 }, { ...credit, accountId: acct.xIncome }]);
      expect(foreign).toMatchObject({ status: 422, code: "reference_not_found" });
      expect(missing).toEqual(foreign);
      expect(await counts()).toEqual(before);
    });

    it("a party naming another tenant's customer or vendor is refused (systemCode lines)", async () => {
      const before = await counts();
      const c = await seam([
        { systemCode: "AR", accountName: "AR", debitAmount: 100, creditAmount: 0, party: { type: "customer", customerId: party.yCustomer } },
        { ...credit, accountId: acct.xIncome }]);
      const v = await seam([
        { accountId: acct.xExpense, accountName: "Exp", debitAmount: 100, creditAmount: 0 },
        { systemCode: "AP", accountName: "AP", debitAmount: 0, creditAmount: 100, party: { type: "vendor", vendorId: party.yVendor } }]);
      expect(c).toMatchObject({ status: 422, code: "reference_not_found" });
      expect(v).toMatchObject({ status: 422, code: "reference_not_found" });
      expect(await counts()).toEqual(before);
    });

    it("CONTROL: the tenant's own account and parties post (accepted:posted)", async () => {
      expect(await seam([
        { systemCode: "AR", accountName: "AR", debitAmount: 100, creditAmount: 0, party: { type: "customer", customerId: party.xCustomer } },
        { ...credit, accountId: acct.xIncome }])).toBe("accepted:posted");
    });
  });

  it("🔴 APPROVAL is not a bypass: a draft whose stored line names another tenant's account is refused, stays a draft, posts nothing", async () => {
    const r = await api("x", "POST", "/journal-entries", entry(acct.xExpense));
    expect(r.status).toBe(201);
    const lineId = (await pool.query(`SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 AND debit_amount > 0`, [r.body.id])).rows[0].id;
    await plantLineReference(lineId, "account_id", acct.yExpense);
    const a = await api("x", "POST", `/journal-entries/${r.body.id}/approve`, {});
    expect(a.status, JSON.stringify(a.body)).toBe(422);
    expect(a.body.code).toBe("reference_not_found");
    expect((await pool.query(`SELECT status, posted_at FROM journal_entries WHERE id = $1`, [r.body.id])).rows[0]).toEqual({ status: "draft", posted_at: null });
    await api("x", "DELETE", `/journal-entries/${r.body.id}`);
  });

  it("🔴 APPROVAL refuses a planted foreign CUSTOMER on a stored AR line the same way", async () => {
    const r = await api("x", "POST", "/journal-entries", { entryNumber: `G04J-${++seq}`, date: "2026-10-01", description: "AR plant", lines: [
      { accountId: acct.xAR, accountName: "AR", debitAmount: 10, creditAmount: 0, customerId: party.xCustomer },
      { accountId: acct.xIncome, accountName: "Inc", debitAmount: 0, creditAmount: 10 }] });
    expect(r.status).toBe(201);
    const lineId = (await pool.query(`SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 AND customer_id IS NOT NULL`, [r.body.id])).rows[0].id;
    await plantLineReference(lineId, "customer_id", party.yCustomer);
    const a = await api("x", "POST", `/journal-entries/${r.body.id}/approve`, {});
    expect(a.status).toBe(422);
    expect(a.body.code).toBe("reference_not_found");
    expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [r.body.id])).rows[0].status).toBe("draft");
    await api("x", "DELETE", `/journal-entries/${r.body.id}`);
  });

  it("🔴 REVERSAL is not a bypass: a posted entry whose stored line names another tenant's account is refused — no mirror, the original untouched", async () => {
    const r = await api("x", "POST", "/journal-entries", entry(acct.xExpense));
    expect((await api("x", "POST", `/journal-entries/${r.body.id}/approve`, {})).status).toBe(200);
    const lineId = (await pool.query(`SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 AND debit_amount > 0`, [r.body.id])).rows[0].id;
    await plantLineReference(lineId, "account_id", acct.ySameName);
    try {
      const before = await counts();
      const rev = await api("x", "POST", `/journal-entries/${r.body.id}/reverse`, { date: "2026-10-02" });
      expect(rev.status, JSON.stringify(rev.body)).toBe(422);
      expect(rev.body.code).toBe("reference_not_found");
      expect(await counts(), "no mirror entry, no mirror line").toEqual(before);
      expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [r.body.id])).rows[0].status).toBe("posted");
      expect(Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE reversal_of = $1`, [r.body.id])).rows[0].n)).toBe(0);
    } finally {
      await plantLineReference(lineId, "account_id", acct.xExpense);
    }
  });

  it("CONTROL: the same reversal, on the tenant's own accounts, mirrors the entry", async () => {
    const r = await api("x", "POST", "/journal-entries", entry(acct.xExpense));
    expect((await api("x", "POST", `/journal-entries/${r.body.id}/approve`, {})).status).toBe(200);
    const rev = await api("x", "POST", `/journal-entries/${r.body.id}/reverse`, { date: "2026-10-02" });
    expect([200, 201]).toContain(rev.status);
  });

  // ── What the statements say afterwards ──────────────────────────────────────
  it("🔴 STATEMENTS: after every attempt above, X holds no cross-tenant line; its trial balance has no account-less row and its balance sheet balances; Y's books hold only Y's", async () => {
    expect(await crossLines(), "no line of X names another organization's row").toBe(0);
    const tb = await api("x", "GET", "/reports/trial-balance?date_from=2026-01-01&date_to=2026-12-31");
    expect(tb.status).toBe(200);
    expect(JSON.stringify(tb.body)).not.toContain("(no account)");
    expect(tb.body.totalDebit, "X's trial balance moved (not vacuous)").toBeGreaterThan(0);
    expect(tb.body.totalDebit).toBeCloseTo(tb.body.totalCredit, 2);
    const bs = await api("x", "GET", "/reports/balance-sheet?as_of=2026-12-31");
    expect(bs.status).toBe(200);
    expect(bs.body.balanced).toBe(true);
    const yTb = await api("y", "GET", "/reports/trial-balance?date_from=2026-01-01&date_to=2026-12-31");
    expect(yTb.body.totalDebit, "Y's books hold exactly its own three postings of 10").toBeCloseTo(30, 2);
  });
});
