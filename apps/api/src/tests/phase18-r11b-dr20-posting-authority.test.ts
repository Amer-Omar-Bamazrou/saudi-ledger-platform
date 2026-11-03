/**
 * 🔴 Phase 18 R-11b — DR-20 with DR-13 (owner, 2026-11-01; register §11.82, §11.111): "mode by fact, as DR-14: a
 * bookkeeper's tax, cash and equity postings are approver-level where the company has two or more approvers, and
 * flagged where it has one." DR-13: "action-level grants for the acts DR-20 classifies as high-risk, as seeded
 * permission data in the permission matrix, NOT editable at runtime."
 *
 *  - THE BOUNDARY IS THE DATABASE, at the draft → posted flip every writer passes. A posting whose declared actor
 *    (T1b) does not hold the grant for a class its lines touch — cash, tax, equity — is REFUSED where the organisation
 *    has two or more usable approvers, and FLAGGED (`unreviewed_posting`) where it has one.
 *  - Each class on its own, through the posting seam, as the bookkeeper: refused with two approvers (nothing
 *    written), flagged with one; a posting touching none of the three is untouched.
 *  - Real routes as the bookkeeper: a bank transfer (cash) and a VAT return's filing (tax); and over HTTP, the
 *    refusal is a 403 `approver_required`.
 *  - Untouched: an approver's posting (they hold the grants), a job's posting (no declared actor).
 *  - "Usable" approvers: an accountant whose account is inactive does not count.
 *  - DR-13: the three grants are seeded for admin and accountant only; the SQL tax list is TAX_ACCOUNT_SYSTEM_CODES.
 *
 * In-process inside real tenant transactions (the acting user as the declared actor), as the request runs them; one
 * case over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3222";
process.env.SESSION_SECRET ??= "r11b-dr20-posting-authority-00000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection, TAX_ACCOUNT_SYSTEM_CODES, PERMISSION_MATRIX } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { createApproved } from "./helpers/createApproved";
import { postJournalEntry } from "../services/accounting/glPosting";
import { bankAccountsService } from "../services/bankAccounts.service";
import { bankTransfersService } from "../services/accounting/bankTransfers.service";
import { invoicesService } from "../services/invoices.service";
import { periodRecordsService } from "../services/periodRecords.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "R11bAuthorityPw123!";
const DATE = "2026-10-01";
const GRANTS = ["gl_cash_posting", "gl_tax_posting", "gl_equity_posting"];

type Org = { id: string; co: string; admin: number; keeper: number; bank: number; bank2: number; equity: number; customer: number };

describeMaybe("Phase 18 R-11b (DR-20, DR-13) — a bookkeeper's cash, tax and equity postings: approver-level with two approvers, flagged with one", () => {
  const h = g04Harness("r11bauth");
  const two = {} as Org; // admin + accountant + bookkeeper
  const one = {} as Org; // admin + bookkeeper
  const dormant = {} as Org; // admin + an INACTIVE accountant + bookkeeper
  let seq = 0;
  const as = (o: Org, uid: number) => <T,>(fn: () => Promise<T>) => h.inTenant(o.id, o.co, uid, fn);

  const entries = async (o: Org) => Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [o.id])).rows[0].n);
  const flagsOf = async (o: Org, entityId?: number) => {
    const rows = (await pool.query(`SELECT kind, entity_type, entity_id, actor_user_id FROM control_flags WHERE organization_id = $1 AND kind = 'unreviewed_posting' ORDER BY id`, [o.id])).rows;
    return entityId == null ? rows : rows.filter((r) => r.entity_id === String(entityId));
  };
  const refusalOf = (e: any) => String(e?.cause?.message ?? e?.message ?? e);

  /** One posted entry through the posting seam, as `uid`, touching the named class (or none). */
  const plant = (o: Org, uid: number, cls: "cash" | "tax" | "equity" | "none") => {
    const n = ++seq;
    const lines: unknown[] =
      cls === "cash" ? [{ bankAccountId: o.bank, debitAmount: 100, creditAmount: 0 }, { systemCode: "OTHER_INCOME", accountName: "Other Income", debitAmount: 0, creditAmount: 100 }]
      : cls === "tax" ? [{ systemCode: "ZAKAT_EXPENSE", accountName: "Zakat", debitAmount: 100, creditAmount: 0 }, { systemCode: "OTHER_INCOME", accountName: "Other Income", debitAmount: 0, creditAmount: 100 }]
      : cls === "equity" ? [{ systemCode: "OTHER_EXPENSES", accountName: "Other Expenses", debitAmount: 100, creditAmount: 0 }, { accountId: o.equity, accountName: "Owner capital", debitAmount: 0, creditAmount: 100 }]
      : [{ systemCode: "OTHER_EXPENSES", accountName: "Other Expenses", debitAmount: 100, creditAmount: 0 }, { systemCode: "OTHER_INCOME", accountName: "Other Income", debitAmount: 0, creditAmount: 100 }];
    return as(o, uid)(async () => (await postJournalEntry({ sourceType: "recognition", sourceId: 2_100_000_000 + n, entryNumber: `R11B-${n}-${cls}`, date: DATE, description: `R-11b ${cls}`, lines } as never)).id as number);
  };
  /** The same, refused: nothing written, the refusal named. */
  const expectRefused = async (o: Org, act: () => Promise<unknown>) => {
    const before = await entries(o);
    const err = await act().then(() => null, (e: unknown) => e);
    expect(err, "refused").not.toBeNull();
    expect(refusalOf(err)).toMatch(/approver/i);
    expect(await entries(o), "nothing written").toBe(before);
  };

  beforeAll(async () => {
    await h.cleanup();
    for (const [o, key, extra] of [[two, "two", "accountant"], [one, "one", null], [dormant, "dormant", "inactive"]] as const) {
      o.id = await h.mkOrg(key);
      o.co = await h.mkCompany(o.id, `R11b ${key}`, key === "two" ? "319191919193003" : key === "one" ? "319191919193103" : "319191919193203");
      o.admin = await h.mkUser(`${key}-admin`, PW, o.id, "admin");
      o.keeper = await h.mkUser(`${key}-keeper`, PW, o.id, "bookkeeper");
      if (extra === "accountant") await h.mkUser(`${key}-accountant`, PW, o.id, "accountant");
      if (extra === "inactive") {
        const acc = await h.mkUser(`${key}-accountant`, PW, o.id, "accountant");
        await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [acc]);
      }
      o.bank = (await as(o, o.admin)(() => bankAccountsService.create({ name: `R11b Bank ${key}`, bankName: "SNB", currency: "SAR" }))).id as number;
      o.bank2 = (await as(o, o.admin)(() => bankAccountsService.create({ name: `R11b Bank ${key} 2`, bankName: "SNB", currency: "SAR" }))).id as number;
      o.equity = (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable) VALUES ($1,'R11b Owner capital','رأس مال المالك','equity',false) RETURNING id`, [o.id])).rows[0].id;
      o.customer = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'R11b Customer') RETURNING id`, [o.id])).rows[0].id;
    }
    await h.start();
    expect(await h.login("keeper", h.email("two-keeper"), PW), "login the bookkeeper of the two-approver org").toBe(200);
  }, 180_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  describe("each class, through the posting seam, as the bookkeeper", () => {
    for (const cls of ["cash", "tax", "equity"] as const) {
      it(`🔴 ${cls}: refused with two approvers, nothing written`, async () => {
        await expectRefused(two, () => plant(two, two.keeper, cls));
      });
      it(`🔴 ${cls}: posted and flagged with one approver`, async () => {
        const id = await plant(one, one.keeper, cls);
        expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [id])).rows[0].status).toBe("posted");
        const f = await flagsOf(one, id);
        expect(f, "one unreviewed_posting flag").toHaveLength(1);
        expect(f[0]!.actor_user_id, "naming the bookkeeper").toBe(one.keeper);
      });
    }
    it("control: a posting touching none of the three is untouched, in either organisation", async () => {
      const a = await plant(two, two.keeper, "none");
      const b = await plant(one, one.keeper, "none");
      for (const id of [a, b]) expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [id])).rows[0].status).toBe("posted");
      expect(await flagsOf(one, b)).toHaveLength(0);
    });
  });

  describe("who is counted, and who is untouched", () => {
    it("🔴 an inactive accountant is not a usable approver: one approver, so the bookkeeper's cash posting is flagged, not refused", async () => {
      const id = await plant(dormant, dormant.keeper, "cash");
      expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [id])).rows[0].status).toBe("posted");
      expect(await flagsOf(dormant, id)).toHaveLength(1);
    });
    it("control: an approver's cash, tax and equity postings are untouched where there are two approvers", async () => {
      for (const cls of ["cash", "tax", "equity"] as const) {
        const id = await plant(two, two.admin, cls);
        expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [id])).rows[0].status).toBe("posted");
      }
      expect(await flagsOf(two)).toHaveLength(0);
    });
    it("control: a job's posting (no declared actor) is untouched", async () => {
      const conn = await beginTenantConnection({ organizationId: two.id, companyId: two.co, role: "authenticated" });
      let id = 0;
      try {
        id = await conn.run(async () => (await postJournalEntry({ sourceType: "recognition", sourceId: 2_100_000_000 + ++seq, entryNumber: `R11B-${seq}-job`, date: DATE, description: "R-11b job",
          lines: [{ bankAccountId: two.bank, debitAmount: 100, creditAmount: 0 }, { systemCode: "OTHER_INCOME", accountName: "Other Income", debitAmount: 0, creditAmount: 100 }] } as never)).id as number);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      }
      expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [id])).rows[0].status).toBe("posted");
    });
  });

  describe("real routes, as the bookkeeper", () => {
    it("🔴 a bank transfer (cash): refused with two approvers; posted and flagged with one", async () => {
      const body = (o: Org) => ({ fromBankAccountId: o.bank, toBankAccountId: o.bank2, amount: 50, transferDate: DATE });
      await expectRefused(two, () => as(two, two.keeper)(() => bankTransfersService.create(body(two), two.keeper)));
      const t = await as(one, one.keeper)(() => bankTransfersService.create(body(one), one.keeper)) as { journalEntryId: number };
      expect(await flagsOf(one, t.journalEntryId)).toHaveLength(1);
    });
    it("🔴 a VAT return's filing (tax: its clearing entry): refused with two approvers; recorded and flagged with one", async () => {
      const filing = async (o: Org, ref: string) => {
        await as(o, o.admin)(() => createApproved(invoicesService, { invoiceNumber: `R11B-INV-${++seq}`, date: "2026-04-15", dueDate: "2026-04-30", customerId: o.customer,
          items: [{ description: "Work", quantity: 1, unitPrice: 1000, vatRate: 15 }] }, o.admin));
        return () => as(o, o.keeper)(() => periodRecordsService.recordVatFiling({ periodFrom: "2026-04", periodTo: "2026-04", filedOn: "2026-05-20", zatcaReference: ref }, o.keeper));
      };
      await expectRefused(two, await filing(two, "R11B-VAT-TWO"));
      expect(Number((await pool.query(`SELECT count(*)::int n FROM vat_return_filings WHERE organization_id = $1`, [two.id])).rows[0].n), "no filing recorded either").toBe(0);
      await (await filing(one, "R11B-VAT-ONE"))();
      const je = (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND source_type = 'vat_return_filing'`, [one.id])).rows[0].id;
      expect(await flagsOf(one, je)).toHaveLength(1);
    });
    it("🔴 over HTTP the refusal is a 403 approver_required, in words that name the approver", async () => {
      const r = await h.api("keeper", "POST", "/bank-transfers", { fromBankAccountId: two.bank, toBankAccountId: two.bank2, amount: 25, transferDate: DATE });
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body.code).toBe("approver_required");
      expect(String(r.body.error)).toMatch(/approver/i);
    });
  });

  describe("DR-13 — the grants, seeded and never editable", () => {
    it("🔴 the three grants are seeded for admin and accountant only, in the matrix and in the database", async () => {
      for (const g of GRANTS) {
        const matrix = PERMISSION_MATRIX.filter((p) => p.resource === g).map((p) => `${p.role}:${p.action}`).sort();
        expect(matrix, `${g} in the matrix`).toEqual(["accountant:approve", "admin:approve"]);
        const rows = (await pool.query(`SELECT role || ':' || action AS g FROM permissions WHERE resource = $1 ORDER BY 1`, [g])).rows.map((r) => r.g);
        expect(rows, `${g} in the database`).toEqual(["accountant:approve", "admin:approve"]);
      }
    });
    it("🔴 the database's tax accounts are TAX_ACCOUNT_SYSTEM_CODES, exactly (one definition, mirrored with a test)", async () => {
      const fn = await pool.query(`SELECT gl_tax_account_codes() AS c`).then((r) => r.rows[0].c as string[], () => null);
      expect(fn ? [...fn].sort() : null).toEqual([...TAX_ACCOUNT_SYSTEM_CODES].sort());
    });
  });
});
