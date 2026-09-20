/**
 * BATCH 1C — PHASE 1: THE MIGRATION FOUNDATION AND THE CHART MAPPING LAYER
 * (2026-09-18). Written RED before the service existed.
 *
 * What is pinned here, and why each is a rule rather than a preference:
 *  - the opening date is DEFINED as cutover − 1 (a DB CHECK, not a default);
 *  - a chart row's type comes from the FILE — a name is never a classification;
 *  - the mapping refusals of pack §15.4: no row lands on the CASH header; an
 *    old receivable/payable maps to AR/AP and nothing else; a balance never
 *    changes nature by mapping; a bank is mapped once; a balance is never
 *    skipped; a merge never targets a system account;
 *  - 🔴 there is NO opening-balance-equity account (accountant A5,
 *    2026-09-20; pack §16.12.2): no template, no category row in any
 *    organisation, no mapping target, no journal source `opening_clearing` —
 *    the former seam test became a test of the account's absence;
 *  - a committed batch is immutable at the DATABASE (trigger), so no service
 *    path — and no raw UPDATE — can edit a migration after it posted;
 *  - isolation: presence in the owning company, ABSENCE in another company
 *    of the same org and in another org (both directions of §3's rule).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool, SYSTEM_ACCOUNTS } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { migrationService, dayBefore } from "../services/migration.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { categoriesService } from "../services/categories.service";
import { postJournalEntry } from "../services/accounting/glPosting";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "b1c-found";
const SLUG_OTHER = "b1c-found-other";
const EMAIL = "b1c-found@test.local";

describeMaybe("Batch 1C — migration foundation and chart mapping", () => {
  let orgId = "", companyId = "", company2Id = "", otherOrgId = "", otherCompanyId = "";
  let userId = 0;
  let bank1 = 0, bank2 = 0, bankC2 = 0, bankOther = 0;
  let arId = 0;

  const tenant = (org: string, company: string) => async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: company, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  };
  const inTenant = <T,>(fn: () => Promise<T>) => tenant(orgId, companyId)(fn);
  const inCompany2 = <T,>(fn: () => Promise<T>) => tenant(orgId, company2Id)(fn);
  const inOther = <T,>(fn: () => Promise<T>) => tenant(otherOrgId, otherCompanyId)(fn);

  // Fixture teardown only: a committed/reversed batch's staging rows refuse
  // DELETE by trigger (that is the property under test), so the teardown runs
  // as the superuser with user triggers off — never a path the product has.
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const slug of [SLUG, SLUG_OTHER]) {
        const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
        for (const t of [
          "migration_advances", "migration_open_items", "migration_parties", "migration_chart_rows", "migration_batches",
          "journal_entry_lines", "journal_entries", "audit_logs", "organization_memberships", "bank_accounts", "categories", "companies",
        ]) {
          await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
        }
        await client.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
      }
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('B1C Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'B1C Co','1010838381','399999999999933') RETURNING id`, [orgId])).rows[0].id;
    company2Id = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'B1C Co 2','1010838382','399999999999943') RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('B1C Other','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'B1C Other Co','1010838383','399999999999953') RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','B1C',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    bank1 = (await inTenant(() => bankAccountsService.create({ name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bank2 = (await inTenant(() => bankAccountsService.create({ name: "ANB Payroll", bankName: "ANB", currency: "SAR" }))).id;
    bankC2 = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Co2 Main','ANB') RETURNING id`, [orgId, company2Id])).rows[0].id;
    bankOther = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Other Main','ANB') RETURNING id`, [otherOrgId, otherCompanyId])).rows[0].id;
    arId = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'AR'`, [orgId])).rows[0].id;
  });
  afterAll(cleanup);

  const CHART = [
    { sourceCode: "1000", sourceName: "Assets", sourceType: "asset" as const, sourceIsGroup: true },
    { sourceCode: "1100", sourceName: "Riyad Bank current", sourceType: "asset" as const, sourceParentCode: "1000", openingDebit: 125000, sourceRole: "bank" as const },
    { sourceCode: "1200", sourceName: "Trade debtors", sourceType: "asset" as const, sourceParentCode: "1000", openingDebit: 25000, sourceRole: "receivable" as const },
    { sourceCode: "1300", sourceName: "Old petty cash (closed)", sourceType: "asset" as const, sourceParentCode: "1000" },
    { sourceCode: "2100", sourceName: "Trade creditors", sourceType: "liability" as const, openingCredit: 40000, sourceRole: "payable" as const },
    { sourceCode: "2200", sourceName: "VAT payable", sourceType: "liability" as const, openingCredit: 3000, sourceRole: "vat_output" as const },
    { sourceCode: "3100", sourceName: "Share capital", sourceType: "equity" as const, openingCredit: 100000 },
    { sourceCode: "3200", sourceName: "Retained earnings b/f", sourceType: "equity" as const, openingCredit: 7000, sourceRole: "retained_earnings" as const },
    { sourceCode: "4100", sourceName: "Sales", sourceType: "income" as const, openingCredit: 900000 },
    { sourceCode: "5100", sourceName: "Rent", sourceType: "expense" as const, openingDebit: 700000 },
    { sourceCode: "5200", sourceName: "Consulting fees", sourceType: "expense" as const, openingDebit: 200000 },
  ];

  const create = (cutoverDate = "2026-10-01") => inTenant(() => migrationService.createBatch({ sourceSystem: "PreviousERP", cutoverDate }, userId));
  const rowOf = async (batchId: number, code: string) => (await inTenant(() => migrationService.getChart(batchId))).rows.find((r) => r.sourceCode === code)!;
  const decide = (batchId: number, rowId: number, body: Parameters<typeof migrationService.decideChartRow>[2]) => inTenant(() => migrationService.decideChartRow(batchId, rowId, body, userId));
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string, message?: RegExp) => {
    let err: any;
    try { await p; } catch (e) { err = e; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err.statusCode ?? err.status).toBe(status);
    if (code) expect(err.body?.code ?? err.payload?.code ?? err.code).toBe(code);
    if (message) expect(String(err.body?.error ?? err.payload?.error ?? err.message)).toMatch(message);
  };

  it("the opening date is DEFINED as cutover − 1: by the service, and by a DB CHECK no path can bypass", async () => {
    expect(dayBefore("2026-10-01")).toBe("2026-09-30");
    expect(dayBefore("2026-01-01")).toBe("2025-12-31");
    expect(dayBefore("2028-03-01")).toBe("2028-02-29");
    const b = await create("2026-10-01");
    expect(b.openingDate).toBe("2026-09-30");
    expect(b.status).toBe("draft");
    await expect(
      pool.query(`INSERT INTO migration_batches (organization_id, company_id, source_system, cutover_date, opening_date) VALUES ($1,$2,'X','2026-10-01','2026-10-01')`, [orgId, companyId]),
    ).rejects.toThrow(/migration_batches_opening_date_chk/);
    await expectRefusal(inTenant(() => migrationService.createBatch({ sourceSystem: "PreviousERP", cutoverDate: "2026-13-40" }, userId)), 400);
    await expectRefusal(inTenant(() => migrationService.createBatch({ sourceSystem: "  ", cutoverDate: "2026-10-01" }, userId)), 400);
  });

  it("chart import keeps the old chart verbatim, refuses what the file cannot state, and resets decisions on replacement", async () => {
    const b = await create();
    await expectRefusal(inTenant(() => migrationService.importChart(b.id, { rows: [CHART[1], CHART[1]] }, userId)), 400);
    await expectRefusal(inTenant(() => migrationService.importChart(b.id, { rows: [{ sourceCode: "9", sourceName: "X", sourceType: "revenue" as never }] }, userId)), 400);
    await expectRefusal(inTenant(() => migrationService.importChart(b.id, { rows: [{ sourceCode: "9", sourceName: "X", sourceType: "asset", openingDebit: -1 }] }, userId)), 400);
    await expectRefusal(inTenant(() => migrationService.importChart(b.id, { rows: [{ sourceCode: "9", sourceName: "X", sourceType: "asset", sourceRole: "magic" as never }] }, userId)), 400);

    const chart = await inTenant(() => migrationService.importChart(b.id, { rows: CHART }, userId));
    expect(chart.rows.length).toBe(CHART.length);
    expect(chart.summary.totalDebit).toBe(1050000);
    expect(chart.summary.totalCredit).toBe(1050000);
    expect(chart.summary.balanced).toBe(true);
    expect(chart.summary.unmapped).toBe(CHART.length);
    // Suggestions come ONLY from the role hint — a "Trade debtors" name suggests nothing on its own.
    const debtors = chart.rows.find((r) => r.sourceCode === "1200")!;
    expect(debtors.suggestion).toEqual({ decision: "map_to_system", targetSystemCode: "AR" });
    expect(chart.rows.find((r) => r.sourceCode === "1100")!.suggestion).toEqual({ decision: "map_to_bank", targetSystemCode: null });
    expect(chart.rows.find((r) => r.sourceCode === "3100")!.suggestion).toBeNull();
    expect(debtors.problems).toEqual(["no mapping decision"]);

    // A decision, then a re-import: the decision is gone (the row it named is gone).
    await decide(b.id, debtors.id, { decision: "map_to_system", targetSystemCode: "AR" });
    expect((await rowOf(b.id, "1200")).decision).toBe("map_to_system");
    await inTenant(() => migrationService.importChart(b.id, { rows: CHART }, userId));
    expect((await rowOf(b.id, "1200")).decision).toBeNull();
  });

  it("🔴 the mapping refusals of §15.4 — each a named 422, nothing guessed", async () => {
    const b = await create();
    await inTenant(() => migrationService.importChart(b.id, { rows: CHART }, userId));
    const row = (code: string) => rowOf(b.id, code);

    // There is no balancing account to name (A5) — the former code is simply not a system account; CASH is a header.
    await expectRefusal(decide(b.id, (await row("3100")).id, { decision: "map_to_system", targetSystemCode: "OPENING_BALANCE_EQUITY" }), 422, "mapping_target_refused", /not a system account/);
    await expectRefusal(decide(b.id, (await row("1100")).id, { decision: "map_to_system", targetSystemCode: "CASH" }), 422, "mapping_target_refused");
    await expectRefusal(decide(b.id, (await row("3100")).id, { decision: "map_to_system", targetSystemCode: "NOT_A_CODE" }), 422, "mapping_target_refused");
    // An old receivable maps to AR and nowhere else — not to SALES, not to a bank, not created.
    await expectRefusal(decide(b.id, (await row("1200")).id, { decision: "map_to_system", targetSystemCode: "SUSPENSE" }), 422, "mapping_target_refused");
    await expectRefusal(decide(b.id, (await row("1200")).id, { decision: "map_to_bank", targetBankAccountId: bank1 }), 422, "mapping_target_refused");
    await expectRefusal(decide(b.id, (await row("1200")).id, { decision: "create" }), 422, "mapping_target_refused");
    // A balance does not change nature by mapping: an expense cannot become AR.
    await expectRefusal(decide(b.id, (await row("5100")).id, { decision: "map_to_system", targetSystemCode: "AR" }), 422, "mapping_target_refused");
    // A bank must be THIS company's and active; another company of the same org and another org are both "not found".
    await expectRefusal(decide(b.id, (await row("1100")).id, { decision: "map_to_bank", targetBankAccountId: bankC2 }), 422, "reference_not_found");
    await expectRefusal(decide(b.id, (await row("1100")).id, { decision: "map_to_bank", targetBankAccountId: bankOther }), 422, "reference_not_found");
    // Only an asset maps to a bank.
    await expectRefusal(decide(b.id, (await row("2100")).id, { decision: "map_to_bank", targetBankAccountId: bank1 }), 422, "mapping_target_refused");
    // A balance is never skipped; a zero balance needs a reason.
    await expectRefusal(decide(b.id, (await row("3100")).id, { decision: "skip", skipReason: "unused" }), 422, "skip_requires_zero_balance");
    await expectRefusal(decide(b.id, (await row("1300")).id, { decision: "skip" }), 400);
    // merge_into never targets a system account or a header; create never takes a posting parent.
    await expectRefusal(decide(b.id, (await row("3100")).id, { decision: "merge_into", targetCategoryId: arId }), 422, "mapping_target_refused");
    const cashHeader = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'CASH'`, [orgId])).rows[0].id;
    await expectRefusal(decide(b.id, (await row("1300")).id, { decision: "merge_into", targetCategoryId: cashHeader }), 422, "mapping_target_refused");
    await expectRefusal(decide(b.id, (await row("5200")).id, { decision: "create", targetCategoryId: arId }), 422, "mapping_target_refused");
    // A group row never maps to a system account / merges.
    await expectRefusal(decide(b.id, (await row("1000")).id, { decision: "map_to_system", targetSystemCode: "SUSPENSE" }), 422, "mapping_target_refused");

    // The happy path: every row decided, every problem gone, the summary counts it.
    await decide(b.id, (await row("1000")).id, { decision: "create" });
    await decide(b.id, (await row("1100")).id, { decision: "map_to_bank", targetBankAccountId: bank1 });
    // One old account per bank.
    await expectRefusal(decide(b.id, (await row("1300")).id, { decision: "map_to_bank", targetBankAccountId: bank1 }), 422, "mapping_target_refused");
    await decide(b.id, (await row("1200")).id, { decision: "map_to_system", targetSystemCode: "AR" });
    await decide(b.id, (await row("1300")).id, { decision: "skip", skipReason: "closed in 2024, zero balance" });
    await decide(b.id, (await row("2100")).id, { decision: "map_to_system", targetSystemCode: "AP" });
    await decide(b.id, (await row("2200")).id, { decision: "map_to_system", targetSystemCode: "VAT_OUTPUT" });
    await decide(b.id, (await row("3100")).id, { decision: "create" });
    await decide(b.id, (await row("3200")).id, { decision: "map_to_system", targetSystemCode: "RETAINED_EARNINGS" });
    await decide(b.id, (await row("4100")).id, { decision: "map_to_system", targetSystemCode: "SALES" });
    const rent = await inTenant(() => categoriesService.create({ name: "Rent", nameAr: "إيجار", type: "expense", vatApplicable: false } as never));
    await decide(b.id, (await row("5100")).id, { decision: "merge_into", targetCategoryId: (rent as { id: number }).id });
    await decide(b.id, (await row("5200")).id, { decision: "create" });
    const chart = await inTenant(() => migrationService.getChart(b.id));
    expect(chart.summary.unmapped).toBe(0);
    expect(chart.summary.blocked).toBe(0);
    expect(chart.summary.byDecision).toEqual({ create: 3, map_to_bank: 1, map_to_system: 5, skip: 1, merge_into: 1 });
    expect(chart.rows.every((r) => r.problems.length === 0)).toBe(true);
  });

  it("a group row that carries a balance is blocked until the file moves it", async () => {
    const b = await create();
    const chart = await inTenant(() => migrationService.importChart(b.id, { rows: [{ sourceCode: "1", sourceName: "Assets", sourceType: "asset", sourceIsGroup: true, openingDebit: 10 }] }, userId));
    expect(chart.rows[0].problems).toContain("a group (header) row carries a balance — move it to a posting child in the source file");
    await expectRefusal(decide(b.id, chart.rows[0].id, { decision: "create" }), 422, "mapping_target_refused");
  });

  it("🔴 A5 — there is NO opening-balance-equity account: no template, no category in ANY organisation, no seam code, no mapping target; `source` admits opening / opening_reversal only and the DATABASE refuses opening_clearing", async () => {
    // Absence, proven where the account would have to live — and a planted
    // positive beside each absence so the probe is known to see.
    expect((await pool.query(`SELECT count(*)::int n FROM system_account_templates WHERE code = 'OPENING_BALANCE_EQUITY'`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM system_account_templates WHERE code = 'RETAINED_EARNINGS'`)).rows[0].n).toBe(1); // the sibling that STAYS (a mapping target)
    expect((await pool.query(`SELECT count(*)::int n FROM categories WHERE system_code = 'OPENING_BALANCE_EQUITY'`)).rows[0].n).toBe(0); // every org, owner connection
    expect((await pool.query(`SELECT count(*)::int n FROM categories WHERE organization_id = $1 AND system_code = 'RETAINED_EARNINGS'`, [orgId])).rows[0].n).toBe(1);
    expect(Object.values(SYSTEM_ACCOUNTS)).not.toContain("OPENING_BALANCE_EQUITY");
    expect(Object.values(SYSTEM_ACCOUNTS)).toContain("RETAINED_EARNINGS");
    // The seam: naming the former code is "unknown system account", not a special case.
    await expect(inTenant(() => postJournalEntry({ entryNumber: "B1C-SEAM-1", date: "2026-06-15", description: "ordinary", lines: [
      { systemCode: "SUSPENSE", accountName: "Suspense", debitAmount: 10, creditAmount: 0 },
      { systemCode: "OPENING_BALANCE_EQUITY" as never, accountName: "OBE", debitAmount: 0, creditAmount: 10 },
    ] }))).rejects.toThrow();
    // A migration-sourced entry still posts and carries its provenance; the CHECK admits exactly two sources.
    const lines = [
      { systemCode: "SUSPENSE" as const, accountName: "Suspense", debitAmount: 10, creditAmount: 0 },
      { systemCode: "RETAINED_EARNINGS" as const, accountName: "Retained earnings", debitAmount: 0, creditAmount: 10 },
    ];
    const je = await inTenant(() => postJournalEntry({ entryNumber: "B1C-SEAM-3", date: "2026-06-15", description: "opening", lines, source: "opening" }));
    expect(je.source).toBe("opening");
    await expect(pool.query(`UPDATE journal_entries SET source = 'opening_clearing' WHERE id = $1`, [je.id])).rejects.toThrow(/journal_entries_source_chk/);
    await expect(pool.query(`UPDATE journal_entries SET source = 'whatever' WHERE id = $1`, [je.id])).rejects.toThrow(/journal_entries_source_chk/);
    await pool.query(`UPDATE journal_entries SET source = 'opening_reversal' WHERE id = $1`, [je.id]); // the other admitted value — the CHECK is not refusing everything
    expect((await pool.query(`SELECT source FROM journal_entries WHERE id = $1`, [je.id])).rows[0].source).toBe("opening_reversal");
    // The line trigger that once admitted the account to migration sources is gone with it.
    expect((await pool.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgname = 'refuse_migration_only_account_line_trg'`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgname = 'migration_batches_immutable'`)).rows[0].n).toBe(1); // a trigger that STAYS — the probe sees triggers
  });

  it("🔴 isolation — presence in the owning company, absence in a sibling company and in another org; a decision by an outsider is not found", async () => {
    const b = await create();
    await inTenant(() => migrationService.importChart(b.id, { rows: CHART }, userId));
    expect((await inTenant(() => migrationService.listBatches())).some((x) => x.id === b.id)).toBe(true);
    expect((await inCompany2(() => migrationService.listBatches())).some((x) => x.id === b.id)).toBe(false);
    expect((await inOther(() => migrationService.listBatches())).some((x) => x.id === b.id)).toBe(false);
    await expectRefusal(inCompany2(() => migrationService.getBatch(b.id)), 404);
    await expectRefusal(inOther(() => migrationService.getBatch(b.id)), 404);
    const debtors = await rowOf(b.id, "1200");
    await expectRefusal(inOther(() => migrationService.decideChartRow(b.id, debtors.id, { decision: "map_to_system", targetSystemCode: "AR" }, userId)), 404);
    await expectRefusal(inCompany2(() => migrationService.importChart(b.id, { rows: CHART }, userId)), 404);
    // Movement: the other org has its own batch and sees exactly that one.
    const ob = await inOther(() => migrationService.createBatch({ sourceSystem: "Other", cutoverDate: "2026-10-01" }, userId));
    expect((await inOther(() => migrationService.listBatches())).map((x) => x.id)).toEqual([ob.id]);
  });

  it("🔴 immutability — a committed batch refuses every change at the DATABASE, and a validated batch reopens on any staging change", async () => {
    const b = await create();
    await inTenant(() => migrationService.importChart(b.id, { rows: CHART }, userId));
    const debtors = await rowOf(b.id, "1200");
    // A validated batch goes back to draft the moment staging changes (a stale validation must never commit).
    await pool.query(`UPDATE migration_batches SET status = 'validated', validated_at = now(), content_hash = 'x' WHERE id = $1`, [b.id]);
    await decide(b.id, debtors.id, { decision: "map_to_system", targetSystemCode: "AR" });
    expect((await inTenant(() => migrationService.getBatch(b.id))).status).toBe("draft");
    expect((await inTenant(() => migrationService.getBatch(b.id))).contentHash).toBeNull();

    // Committed: the service refuses (409), the trigger refuses raw SQL, and discard is refused.
    await pool.query(`UPDATE migration_batches SET status = 'committed', committed_at = now() WHERE id = $1`, [b.id]);
    await expectRefusal(inTenant(() => migrationService.importChart(b.id, { rows: CHART }, userId)), 409, "migration_batch_immutable");
    await expectRefusal(decide(b.id, debtors.id, { decision: "create" }), 409, "migration_batch_immutable");
    await expectRefusal(inTenant(() => migrationService.discardBatch(b.id, userId)), 409, "migration_batch_immutable");
    await expect(pool.query(`UPDATE migration_chart_rows SET decision = 'skip' WHERE id = $1`, [debtors.id])).rejects.toThrow(/staging rows are immutable/);
    await expect(pool.query(`DELETE FROM migration_chart_rows WHERE id = $1`, [debtors.id])).rejects.toThrow(/staging rows are immutable/);
    await expect(pool.query(`INSERT INTO migration_chart_rows (organization_id, company_id, batch_id, source_system, source_code, source_name, source_type) VALUES ($1,$2,$3,'X','9999','late','asset')`, [orgId, companyId, b.id])).rejects.toThrow(/staging rows are immutable/);
    await expect(pool.query(`UPDATE migration_batches SET cutover_date = '2027-01-01', opening_date = '2026-12-31' WHERE id = $1`, [b.id])).rejects.toThrow(/cannot be modified/);
    await expect(pool.query(`UPDATE migration_batches SET status = 'draft' WHERE id = $1`, [b.id])).rejects.toThrow(/cannot be modified/);
    // The one movement a committed batch may make: gaining its clearing journal, and becoming reversed.
    await pool.query(`UPDATE migration_batches SET status = 'reversed', reversed_at = now() WHERE id = $1`, [b.id]);
    // One LIVE migration per company: a second committed batch is refused by the partial unique index, and the service refuses a new batch while one is live.
    await pool.query(`UPDATE migration_batches SET status = 'committed' WHERE id = $1`, [b.id]).catch(() => undefined);
    const c2 = await create();
    await pool.query(`UPDATE migration_batches SET status = 'committed', committed_at = now() WHERE id = $1`, [c2.id]);
    await expectRefusal(create(), 409, "migration_already_committed");
    await expect(pool.query(`UPDATE migration_batches SET status = 'committed' WHERE id = $1`, [b.id])).rejects.toThrow();
    // Leave no live migration behind for the later tests.
    await pool.query(`UPDATE migration_batches SET status = 'reversed', reversed_at = now() WHERE id = $1`, [c2.id]);
  });

  it("discard keeps the audit trail and never deletes: a draft becomes discarded and stays readable", async () => {
    const b = await create();
    const d = await inTenant(() => migrationService.discardBatch(b.id, userId));
    expect(d.status).toBe("discarded");
    expect((await inTenant(() => migrationService.getBatch(b.id))).status).toBe("discarded");
    await expectRefusal(inTenant(() => migrationService.importChart(b.id, { rows: CHART }, userId)), 409, "migration_batch_discarded");
    const audit = await pool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND entity_type = 'migration_batch' AND entity_id = $2 ORDER BY action`, [orgId, String(b.id)]);
    expect(audit.rows.map((r) => r.action)).toEqual(["migration_batch_create", "migration_batch_discard"]);
  });
});
