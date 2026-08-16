/**
 * B5 — a transfer can now say where the money went, and NULL still means
 * "nobody has said".
 *
 * 🔴 WHY THIS COLUMN EXISTS AT ALL. `bank_account_id` records which account a
 * transfer LEFT; nothing recorded where it arrived. So "money between two of my
 * own accounts" (business cash unchanged, ledger correctly silent) and "money
 * that left the business" (cash fell, ledger understating it) were the same
 * row. The fact is knowable only to the person entering it, on the day — not
 * derivable from the amount or the description — so every transfer recorded
 * without it lost that fact permanently.
 *
 * 🔴 AND WHY NULL IS NOT "EXTERNAL". A default here would have the platform
 * assert on the tenant's behalf exactly the fact it is trying to collect —
 * M17.1's `ownership_type` lesson and the fiscal-year decision (F8/F10) in a
 * third place. Three states, and the third is real.
 *
 * The invariants are DB CHECKs rather than service code because three paths
 * write transactions (import, manual create, review edit) and per-path
 * enforcement is per-path review — a fourth path starts at zero. So they are
 * tested at the database, by trying to violate them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[transfer-destination] no real DATABASE_URL — skipping.");

const SLUG = "b5-transfer";
const EMAIL = "b5-transfer@test.local";

describeMaybe("B5 — where a transfer went", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let accountA = 0;
  let accountB = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({
      organizationId: orgId,
      companyId,
      role: "authenticated",
    });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usr = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    for (const t of ["transactions", "bank_accounts", "categories"]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
    }
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(
      `DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`,
    );
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug) VALUES ('B5 Org','${SLUG}') RETURNING id`,
      )
    ).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name) VALUES ($1,'B5 Co') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active)
         VALUES ('${EMAIL}','B5',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status)
       VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    for (const name of ["Main", "Savings"]) {
      const { rows } = await pool.query(
        `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name)
         VALUES ($1,$2,$3,'Test Bank') RETURNING id`,
        [orgId, companyId, name],
      );
      if (name === "Main") accountA = Number(rows[0].id);
      else accountB = Number(rows[0].id);
    }
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  const makeTransfer = async (bankAccountId: number | null = accountA) => {
    const { rows } = await pool.query(
      `INSERT INTO transactions
         (organization_id, company_id, date, description, amount, type, kind,
          review_status, bank_account_id)
       VALUES ($1,$2,'2026-05-04','move','1000.00','debit','transfer','accepted',$3)
       RETURNING id`,
      [orgId, companyId, bankAccountId],
    );
    return Number(rows[0].id);
  };

  // ── The default state ────────────────────────────────────────────────────

  it("🔴 a new transfer is UNDECLARED, not internal and not external", async () => {
    const id = await makeTransfer();
    const { rows } = await pool.query(
      `SELECT transfer_direction, counterparty_bank_account_id FROM transactions WHERE id = $1`,
      [id],
    );
    expect(rows[0].transfer_direction, "no default — nobody has said").toBeNull();
    expect(rows[0].counterparty_bank_account_id).toBeNull();
  });

  // ── The declaration ──────────────────────────────────────────────────────

  it("records own_account, with the destination when it is tracked", async () => {
    const id = await makeTransfer();
    await inTenant(() =>
      transactionsService.update(id, {
        transferDirection: "own_account",
        counterpartyBankAccountId: accountB,
      } as never),
    );
    const { rows } = await pool.query(
      `SELECT transfer_direction, counterparty_bank_account_id FROM transactions WHERE id = $1`,
      [id],
    );
    expect(rows[0].transfer_direction).toBe("own_account");
    expect(Number(rows[0].counterparty_bank_account_id)).toBe(accountB);
  });

  it("🔴 own_account WITHOUT a destination is allowed — the other account may not be tracked", async () => {
    // Requiring the id would block the tenant from declaring the fact that
    // actually matters (did it leave the business) whenever the destination is
    // an account this product does not know about.
    const id = await makeTransfer();
    await inTenant(() =>
      transactionsService.update(id, { transferDirection: "own_account" } as never),
    );
    const { rows } = await pool.query(
      `SELECT transfer_direction, counterparty_bank_account_id FROM transactions WHERE id = $1`,
      [id],
    );
    expect(rows[0].transfer_direction).toBe("own_account");
    expect(rows[0].counterparty_bank_account_id).toBeNull();
  });

  it("🔴 clearing the declaration returns the row to UNDECLARED, not to a default", async () => {
    const id = await makeTransfer();
    await inTenant(() =>
      transactionsService.update(id, { transferDirection: "external" } as never),
    );
    await inTenant(() => transactionsService.update(id, { transferDirection: null } as never));
    const { rows } = await pool.query(
      `SELECT transfer_direction FROM transactions WHERE id = $1`,
      [id],
    );
    expect(rows[0].transfer_direction).toBeNull();
  });

  it("declaring external CLEARS a previously-recorded destination", async () => {
    // A destination account and "the money left the business" are a
    // contradiction, not a detail to leave lying around.
    const id = await makeTransfer();
    await inTenant(() =>
      transactionsService.update(id, {
        transferDirection: "own_account",
        counterpartyBankAccountId: accountB,
      } as never),
    );
    await inTenant(() =>
      transactionsService.update(id, { transferDirection: "external" } as never),
    );
    const { rows } = await pool.query(
      `SELECT transfer_direction, counterparty_bank_account_id FROM transactions WHERE id = $1`,
      [id],
    );
    expect(rows[0].transfer_direction).toBe("external");
    expect(rows[0].counterparty_bank_account_id).toBeNull();
  });

  // ── The write boundary, tested by trying to violate it ───────────────────

  describe("🔴 the DB CHECKs hold whatever the caller does", () => {
    it("rejects a direction on a NON-transfer row", async () => {
      await expect(
        pool.query(
          `INSERT INTO transactions
             (organization_id, company_id, date, description, amount, type, kind,
              review_status, transfer_direction)
           VALUES ($1,$2,'2026-05-04','x','10.00','debit','operating','accepted','external')`,
          [orgId, companyId],
        ),
      ).rejects.toThrow(/transactions_transfer_fields_need_transfer/);
    });

    it("rejects an unknown direction value", async () => {
      await expect(
        pool.query(
          `INSERT INTO transactions
             (organization_id, company_id, date, description, amount, type, kind,
              review_status, transfer_direction)
           VALUES ($1,$2,'2026-05-04','x','10.00','debit','transfer','accepted','somewhere')`,
          [orgId, companyId],
        ),
      ).rejects.toThrow(/transactions_transfer_direction_values/);
    });

    it("rejects a destination account without own_account", async () => {
      await expect(
        pool.query(
          `INSERT INTO transactions
             (organization_id, company_id, date, description, amount, type, kind,
              review_status, transfer_direction, counterparty_bank_account_id)
           VALUES ($1,$2,'2026-05-04','x','10.00','debit','transfer','accepted','external',$3)`,
          [orgId, companyId, accountB],
        ),
      ).rejects.toThrow(/transactions_counterparty_needs_own_account/);
    });

    it("rejects a transfer to the account it came from", async () => {
      await expect(
        pool.query(
          `INSERT INTO transactions
             (organization_id, company_id, date, description, amount, type, kind,
              review_status, bank_account_id, transfer_direction, counterparty_bank_account_id)
           VALUES ($1,$2,'2026-05-04','x','10.00','debit','transfer','accepted',$3,'own_account',$3)`,
          [orgId, companyId, accountA],
        ),
      ).rejects.toThrow(/transactions_counterparty_is_not_self/);
    });
  });

  // ── The service's named refusals ─────────────────────────────────────────

  it("refuses a direction on a non-transfer with a readable message", async () => {
    const { rows } = await pool.query(
      `INSERT INTO transactions
         (organization_id, company_id, date, description, amount, type, kind, review_status)
       VALUES ($1,$2,'2026-05-04','op','50.00','debit','operating','accepted') RETURNING id`,
      [orgId, companyId],
    );
    await expect(
      inTenant(() =>
        transactionsService.update(Number(rows[0].id), {
          transferDirection: "external",
        } as never),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
