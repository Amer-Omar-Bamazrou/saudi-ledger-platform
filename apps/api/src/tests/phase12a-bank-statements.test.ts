/**
 * PHASE 12A — BANK STATEMENTS AS RECORDS (2026-09-23), on real rows.
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §3.
 *
 *  · a statement upload records WHAT THE BANK SENT — period, balances, file
 *    identity — and every imported line carries it;
 *  · 🔴 all or nothing: a file that contradicts its own balances, carries a
 *    bad row, or strays outside its period writes NOTHING (no statement, no
 *    line) — and the same file WITHOUT a statement block still imports the
 *    good rows, so the refusal is the statement's rule, not a broken upload;
 *  · 🔴 the same file twice is refused by its hash, naming the first import;
 *  · continuity between statements is REPORTED (gap, overlap, balance break);
 *  · append-only at the database, provenance fixed, and invisible to another
 *    tenant — asserted with presence, absence and movement.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";
import { bankStatementsService } from "../services/accounting/bankStatements.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const sha = (c: string) => c.repeat(64);

describeMaybe("Phase 12A — bank statements (real rows)", () => {
  const SLUG = "p12a-stmt", SLUG_B = "p12a-stmt-other";
  const EMAIL = "p12a-stmt@test.local";
  let orgId = "", companyId = "", userId = 0, bankId = 0, otherBankId = 0;
  let orgB = "", companyB = "", bankB = 0;

  const inTenant = async <T,>(fn: () => Promise<T>, org = orgId, co = companyId): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const slug of [SLUG, SLUG_B]) {
        const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
        for (const t of ["transactions", "bank_statements", "journal_entry_lines", "journal_entries", "audit_logs",
                         "organization_memberships", "bank_accounts", "categories", "companies"]) {
          await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
        }
        await client.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
      }
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    let err: { statusCode?: number; status?: number; payload?: { code?: string }; message?: string } | undefined;
    try { await p; } catch (e) { err = e as typeof err; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err!.statusCode ?? err!.status, err!.message).toBe(status);
    if (code) expect(err!.payload?.code).toBe(code);
    return err!;
  };
  const counts = async () => ({
    statements: Number((await pool.query(`SELECT count(*)::int n FROM bank_statements WHERE organization_id = $1`, [orgId])).rows[0].n),
    lines: Number((await pool.query(`SELECT count(*)::int n FROM transactions WHERE organization_id = $1`, [orgId])).rows[0].n),
  });
  const row = (date: string, description: string, amount: number, type: "debit" | "credit", extra: Record<string, unknown> = {}) =>
    ({ date, description, amount, type, ...extra });
  const upload = (rows: ReturnType<typeof row>[], statement?: Record<string, unknown>, bank = bankId) =>
    inTenant(() => transactionsService.upload({ rows, bankAccountId: bank, autoCategrize: false, ...(statement ? { statement } : {}) } as never, userId));

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P12A Statements','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P12A Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P12A',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    bankId = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Main','Riyad') RETURNING id`, [orgId, companyId])).rows[0].id;
    otherBankId = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Second','SNB') RETURNING id`, [orgId, companyId])).rows[0].id;
    orgB = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P12A Other','${SLUG_B}') RETURNING id`)).rows[0].id;
    companyB = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P12A Other Co') RETURNING id`, [orgB])).rows[0].id;
    bankB = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'B Main','Alinma') RETURNING id`, [orgB, companyB])).rows[0].id;
  }, 120_000);
  afterAll(cleanup);

  it("🔴 a statement upload records what the bank sent, and every imported line carries it", async () => {
    const res = await upload(
      [row("2026-06-02", "Customer receipt INV-1", 1500, "credit"), row("2026-06-10", "Bank charge", 25, "debit")],
      { fileName: "june.csv", fileSha256: sha("a"), periodFrom: "2026-06-01", periodTo: "2026-06-30", openingBalance: 1000, closingBalance: 2475 },
    );
    expect(res.inserted).toBe(2);
    expect(res.statement).toMatchObject({
      bankAccountId: bankId, periodFrom: "2026-06-01", periodTo: "2026-06-30",
      openingBalance: 1000, closingBalance: 2475, source: "file_upload", fileName: "june.csv",
      lineCount: 2, fileCreditTotal: 1500, fileDebitTotal: 25, importedCount: 2, continuity: "first",
    });
    const lines = (await pool.query(`SELECT bank_statement_id FROM transactions WHERE organization_id = $1`, [orgId])).rows;
    expect(lines.map((l) => l.bank_statement_id)).toEqual([res.statement!.id, res.statement!.id]);
  }, 60_000);

  it("🔴 a file that contradicts its own balances imports NOTHING — and names the difference", async () => {
    const before = await counts();
    const err = await expectRefusal(upload(
      [row("2026-07-03", "Receipt", 500, "credit")],
      { fileSha256: sha("b"), periodFrom: "2026-07-01", periodTo: "2026-07-31", openingBalance: 2475, closingBalance: 3000 },
    ), 422, "statement_does_not_balance");
    expect((err.payload as Record<string, unknown>).difference).toBe(25);
    expect(await counts(), "no statement, no line").toEqual(before);
  }, 60_000);

  it("🔴 a bad row refuses the WHOLE statement — while the same rows WITHOUT a statement import the good ones", async () => {
    const rows = [row("2026-07-04", "Good line", 100, "credit"), row("2026-07-05", "Foreign charge", 40, "debit", { currency: "USD" })];
    const before = await counts();
    await expectRefusal(upload(rows, { fileSha256: sha("c") }), 422, "statement_rows_invalid");
    expect(await counts(), "all or nothing").toEqual(before);

    // MOVEMENT: the legacy, statement-less upload keeps its per-row behaviour.
    const legacy = await upload(rows);
    expect(legacy.inserted).toBe(1);
    expect(legacy.errors.length).toBe(1);
    expect(legacy.statement ?? null).toBeNull();
    expect((await counts()).lines).toBe(before.lines + 1);
  }, 60_000);

  it("🔴 lines outside the stated period, a lone balance, and a malformed hash are refused before anything is written", async () => {
    const before = await counts();
    await expectRefusal(upload([row("2026-08-15", "Late", 10, "credit")], { fileSha256: sha("d"), periodFrom: "2026-07-01", periodTo: "2026-07-31" }), 422, "statement_rows_invalid");
    await expectRefusal(upload([row("2026-07-15", "x", 10, "credit")], { fileSha256: sha("d"), openingBalance: 5 }), 422, "statement_balances_incomplete");
    await expectRefusal(upload([row("2026-07-15", "x", 10, "credit")], { fileSha256: "not-a-hash" }), 422, "statement_sha_invalid");
    expect(await counts()).toEqual(before);
  }, 60_000);

  it("🔴 the same FILE twice is refused by its hash and names the first import; a re-exported period imports no line twice", async () => {
    const [first] = (await pool.query(`SELECT id FROM bank_statements WHERE organization_id = $1 ORDER BY id LIMIT 1`, [orgId])).rows;
    const before = await counts();
    const err = await expectRefusal(upload(
      [row("2026-06-02", "Customer receipt INV-1", 1500, "credit"), row("2026-06-10", "Bank charge", 25, "debit")],
      { fileSha256: sha("a"), periodFrom: "2026-06-01", periodTo: "2026-06-30", openingBalance: 1000, closingBalance: 2475 },
    ), 409, "statement_already_imported");
    expect((err.payload as Record<string, unknown>).statementId).toBe(first.id);
    expect(await counts()).toEqual(before);

    // The same PERIOD re-exported (a different file): the statement is
    // recorded — the bank did send it — but every line is already held.
    const again = await upload(
      [row("2026-06-02", "Customer receipt INV-1", 1500, "credit"), row("2026-06-10", "Bank charge", 25, "debit")],
      { fileSha256: sha("e"), periodFrom: "2026-06-01", periodTo: "2026-06-30", openingBalance: 1000, closingBalance: 2475 },
    );
    expect(again.inserted).toBe(0);
    expect(again.duplicatesSkipped).toBe(2);
    expect(again.statement).toMatchObject({ lineCount: 2, importedCount: 0, continuity: "overlap" });
  }, 60_000);

  it("🔴 continuity is REPORTED per bank: continuous, a balance break, a gap — never refused", async () => {
    // Second bank, its own chain.
    await upload([row("2026-06-05", "In", 100, "credit")], { fileSha256: sha("1"), periodFrom: "2026-06-01", periodTo: "2026-06-30", openingBalance: 0, closingBalance: 100 }, otherBankId);
    await upload([row("2026-07-05", "In", 50, "credit")], { fileSha256: sha("2"), periodFrom: "2026-07-01", periodTo: "2026-07-31", openingBalance: 100, closingBalance: 150 }, otherBankId);
    await upload([row("2026-08-05", "In", 10, "credit")], { fileSha256: sha("3"), periodFrom: "2026-08-01", periodTo: "2026-08-31", openingBalance: 149, closingBalance: 159 }, otherBankId);
    await upload([row("2026-10-05", "In", 1, "credit")], { fileSha256: sha("4"), periodFrom: "2026-10-01", periodTo: "2026-10-31", openingBalance: 159, closingBalance: 160 }, otherBankId);
    const { items } = await inTenant(() => bankStatementsService.list(otherBankId));
    expect(items.map((s) => s.continuity)).toEqual(["first", "continuous", "balance_break", "gap"]);
    expect(items[2]!.continuityDetail).toMatch(/difference -1\.00/);
    expect(items[3]!.continuityDetail).toMatch(/2026-09-01/);
    // …and each bank is judged against its OWN previous statement
    const main = await inTenant(() => bankStatementsService.list(bankId));
    expect(main.items[0]!.continuity).toBe("first");
  }, 60_000);

  it("🔴 append-only and fixed provenance AT THE DATABASE", async () => {
    const [s] = (await pool.query(`SELECT id FROM bank_statements WHERE organization_id = $1 AND bank_account_id = $2 ORDER BY id LIMIT 1`, [orgId, bankId])).rows;
    const [line] = (await pool.query(`SELECT id FROM transactions WHERE bank_statement_id = $1 LIMIT 1`, [s.id])).rows;
    const asApp = async (sql: string, params: unknown[]) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SET LOCAL ROLE authenticated`);
        await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
        await c.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);
        await c.query(sql, params);
        await c.query("ROLLBACK");
        return "ok";
      } catch (e) { await c.query("ROLLBACK"); return (e as Error).message; }
      finally { c.release(); }
    };
    expect(await asApp(`UPDATE bank_statements SET closing_balance = 1 WHERE id = $1`, [s.id])).toMatch(/permission denied/i);
    expect(await asApp(`DELETE FROM bank_statements WHERE id = $1`, [s.id])).toMatch(/permission denied/i);
    expect(await asApp(`UPDATE transactions SET bank_statement_id = NULL WHERE id = $1`, [line.id])).toMatch(/provenance cannot change/);
    expect(await asApp(`UPDATE transactions SET bank_account_id = $2 WHERE id = $1`, [line.id, otherBankId])).toMatch(/its statement .* is for bank/);
    // positive control: an ordinary review edit on the same line is allowed
    expect(await asApp(`UPDATE transactions SET notes = 'reviewed' WHERE id = $1`, [line.id])).toBe("ok");
  }, 60_000);

  it("🔴 isolation: another tenant's statements are absent — and that tenant SEES its own", async () => {
    await inTenant(() => transactionsService.upload({ rows: [row("2026-06-03", "B receipt", 70, "credit")], bankAccountId: bankB, autoCategrize: false, statement: { fileSha256: sha("a") } } as never, userId), orgB, companyB);
    const mine = await inTenant(() => bankStatementsService.list());
    const theirs = await inTenant(() => bankStatementsService.list(), orgB, companyB);
    // presence
    expect(theirs.items).toHaveLength(1);
    expect(theirs.items[0]!.bankAccountId).toBe(bankB);
    // absence, both ways — even though both imported a file with the SAME hash
    expect(mine.items.some((s) => s.bankAccountId === bankB)).toBe(false);
    expect(theirs.items.some((s) => s.bankAccountId === bankId || s.bankAccountId === otherBankId)).toBe(false);
    expect(mine.items.length).toBeGreaterThan(1);
  }, 60_000);
});
