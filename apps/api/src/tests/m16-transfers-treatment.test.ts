/**
 * M16.2 — transfers as a class, S/Z/E/O treatment, and the bank-account link.
 *
 * The headline is verification-pass finding #6, the one place the M15 pipeline
 * still confidently accepted a wrong tax figure: "ATM CASH WITHDRAWAL - ANB…"
 * matched the BARE BANK NAME pattern (\bANB\b) → Bank Charges at 0.90 → SAR
 * 260.87 of phantom input VAT → swept into accepted figures by bulk accept.
 * Two independent fixes, each pinned here:
 *   1. THE CLASSIFICATION — `kind: transfer` excludes it from every P&L/tax
 *      aggregate (proven through the REAL report services, M10.3/10.4 style).
 *   2. THE RULE — a bank's name says WHO processed a movement, not what it
 *      was. Fee-words are now required; the exclusion must not paper over a
 *      bad match (owner instruction).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";
import { summaryService } from "../services/summary.service";
import { reportsService } from "../services/reports.service";
import { categorizeTransaction, allEngineCodes } from "../services/categorization/categorizer";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[m16-transfers-treatment] no real DATABASE_URL — skipping.");

const SLUG = "m16-transfers";
const EMAIL = "m16-transfers@test.local";

describeMaybe("M16.2 — transfers, treatment, bank accounts", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let accountA = 0;
  let accountB = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
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
    await pool.query(`DELETE FROM transactions WHERE organization_id IN ${org}`);
    // Flaw #1 (Option A): accepting a transaction now posts a journal entry,
    // so teardown must clear the ledger before the company it references.
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bank_accounts WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Transfers Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'TF','1010101014','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','TF',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    accountA = (
      await pool.query(
        `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Main SAR','Al Rajhi') RETURNING id`,
        [orgId, companyId],
      )
    ).rows[0].id;
    accountB = (
      await pool.query(
        `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Payroll SAR','SNB') RETURNING id`,
        [orgId, companyId],
      )
    ).rows[0].id;
  });

  afterAll(cleanup);

  async function taxFigures() {
    const [vat, zakat, cash, summary, byCat] = await Promise.all([
      inTenant(() => summaryService.getVat({ dateFrom: "2026-01-01", dateTo: "2026-12-31" })),
      inTenant(() => summaryService.getZakat()),
      inTenant(() => reportsService.cashFlow("2026-01-01", "2026-12-31")),
      inTenant(() => summaryService.getSummary({ dateFrom: "2026-01-01", dateTo: "2026-12-31" })),
      inTenant(() => summaryService.getByCategory({ dateFrom: "2026-01-01", dateTo: "2026-12-31" })),
    ]);
    return {
      vatPaid: (vat as { vatPaid: number }).vatPaid,
      netVat: (vat as { netVatPosition: number }).netVatPosition,
      zakatBase: (zakat as { totalZakatableAssets?: number }).totalZakatableAssets ?? 0,
      cashNet: (cash as { netChange: number }).netChange,
      income: (summary as { totalIncome?: number }).totalIncome ?? 0,
      expenses: (summary as { totalExpenses?: number }).totalExpenses ?? 0,
      categoryRows: (byCat as unknown[]).length,
    };
  }

  // ── The rule, in isolation ─────────────────────────────────────────────────
  describe("🔴 the rule fix: a bank name is not a fee", () => {
    it("the verification-pass ATM row is a TRANSFER now, not Bank Charges", () => {
      const m = categorizeTransaction("ATM CASH WITHDRAWAL - ANB RIYADH MAIN BR", 2000, "debit");
      expect(m?.kind).toBe("transfer");
      expect(m?.systemCode).not.toBe("BANK_CHARGES");
    });

    it("a bare bank name matches NOTHING — who processed it says nothing about what it was", () => {
      expect(categorizeTransaction("ANB TRANSFER TO IBN SINA TRADING EST", 9200, "debit")).toBeNull();
      expect(categorizeTransaction("AL RAJHI OUTGOING 88213", 4500, "debit")).toBeNull();
    });

    it("an actual fee line IS a bank charge", () => {
      expect(categorizeTransaction("AL RAJHI BANK MONTHLY ACCOUNT FEE", 57.5, "debit")?.systemCode).toBe("BANK_CHARGES");
      expect(categorizeTransaction("SNB TRANSFER FEE", 5.75, "debit")?.systemCode).toBe("BANK_CHARGES");
    });

    it("a bare gateway name matches nothing (it is usually a card-sales settlement), its fee line does", () => {
      expect(categorizeTransaction("TAMARA SETTLEMENT 20260715", 12400, "credit")).toBeNull();
      expect(categorizeTransaction("TAMARA COMMISSION FEE JUL", 372, "debit")?.systemCode).toBe("BANK_CHARGES");
    });

    it("own-account moves and card settlements are transfers; a bare TRANSFER stays unknown", () => {
      expect(categorizeTransaction("TRANSFER BETWEEN OWN ACCOUNTS", 25000, "debit")?.kind).toBe("transfer");
      expect(categorizeTransaction("CREDIT CARD PAYMENT - SNB", 6800, "debit")?.kind).toBe("transfer");
      // No own-account signal ⇒ could be a supplier payment ⇒ NULL, never a guess.
      expect(categorizeTransaction("TRANSFER", 3000, "debit")).toBeNull();
    });
  });

  // ── The classification, end to end ─────────────────────────────────────────
  it("🔴 #6 CLOSED: an accepted ATM withdrawal moves NO tax figure — and DOES move cash flow", async () => {
    const before = await taxFigures();

    const result = (await inTenant(() =>
      transactionsService.upload({
        rows: [
          { date: "2026-07-05", description: "ATM CASH WITHDRAWAL - ANB RIYADH MAIN BR", amount: 2000, currency: "SAR", type: "debit" },
        ],
        autoCategrize: true,
        bankAccountId: accountA,
      } as never),
    )) as { inserted: number; categorized: number };
    expect(result.inserted).toBe(1);
    expect(result.categorized).toBe(1); // classified — as a transfer, not a category

    const { rows } = await pool.query(
      `SELECT kind, category_id, vat_amount, tax_treatment, confidence_score, bank_account_id FROM transactions
        WHERE organization_id = $1 AND description LIKE 'ATM%'`,
      [orgId],
    );
    expect(rows[0].kind).toBe("transfer");
    expect(rows[0].category_id).toBeNull();
    expect(rows[0].vat_amount).toBeNull(); // 🔴 the SAR 260.87 phantom is gone
    expect(rows[0].bank_account_id).toBe(accountA);

    // A confident transfer is classified — bulk accept may take it…
    const pending = await inTenant(() => transactionsService.pendingReview());
    expect(pending.find((p) => p.description.startsWith("ATM"))?.needsAttention).toBe(false);
    const bulk = await inTenant(() => transactionsService.acceptPending());
    expect(bulk.accepted).toBe(1);

    // …and even ACCEPTED it reaches no P&L or tax figure. Cash flow is the one
    // reader that must see it — the bank balance genuinely moved.
    const after = await taxFigures();
    expect(after.vatPaid).toBe(before.vatPaid);
    expect(after.netVat).toBe(before.netVat);
    expect(after.zakatBase).toBe(before.zakatBase);
    expect(after.income).toBe(before.income);
    expect(after.expenses).toBe(before.expenses);
    expect(after.categoryRows).toBe(before.categoryRows);
    expect(after.cashNet).not.toBe(before.cashNet); // cannot pass vacuously
  });

  // ── Treatment ──────────────────────────────────────────────────────────────
  it("S extracts VAT; O records zero AND says why; unknown stays null — four facts, no longer one", async () => {
    await inTenant(() =>
      transactionsService.upload({
        rows: [
          { date: "2026-07-02", description: "SADAD PAYMENT - STC 0112345678", amount: 862.5, currency: "SAR", type: "debit" },
          { date: "2026-07-11", description: "ZAKAT PAYMENT ZATCA 2025", amount: 18000, currency: "SAR", type: "debit" },
          { date: "2026-07-15", description: "SALARY TRANSFER - AHMED AL QAHTANI", amount: 8000, currency: "SAR", type: "debit" },
          { date: "2026-07-20", description: "REF 99213 MISC", amount: 750, currency: "SAR", type: "debit" },
        ],
        autoCategrize: true,
        bankAccountId: accountA,
      } as never),
    );
    const { rows } = await pool.query(
      `SELECT description, tax_treatment, vat_amount::text FROM transactions WHERE organization_id = $1 ORDER BY date`,
      [orgId],
    );
    type TreatmentRow = { description: string; tax_treatment: string | null; vat_amount: string | null };
    const byDesc: Record<string, TreatmentRow> = Object.fromEntries(
      (rows as TreatmentRow[]).map((r) => [r.description, r]),
    );
    // S — standard-rated: VAT extracted from gross.
    expect(byDesc["SADAD PAYMENT - STC 0112345678"].tax_treatment).toBe("S");
    expect(byDesc["SADAD PAYMENT - STC 0112345678"].vat_amount).toBe("112.50");
    // O — out of scope: zero VAT, AND the row says why.
    expect(byDesc["ZAKAT PAYMENT ZATCA 2025"].tax_treatment).toBe("O");
    expect(byDesc["ZAKAT PAYMENT ZATCA 2025"].vat_amount).toBeNull();
    expect(byDesc["SALARY TRANSFER - AHMED AL QAHTANI"].tax_treatment).toBe("O");
    // Unknown — treatment null and ONLY unknown is null.
    expect(byDesc["REF 99213 MISC"].tax_treatment).toBeNull();
  });

  it("🔴 FORCING FUNCTION: every engine-emittable code has a seeded default treatment (catch-alls excepted)", async () => {
    // A category the engine confidently assigns must state its treatment, or a
    // categorized row lands treatment-unknown — the conflation M16.2 removes.
    // OTHER_INCOME / OTHER_EXPENSES are the deliberate exception: a catch-all
    // cannot honestly claim a treatment, so unknown IS its correct default.
    const HONESTLY_UNKNOWN = new Set(["OTHER_INCOME", "OTHER_EXPENSES"]);
    const { rows } = await pool.query(`SELECT code, default_tax_treatment FROM system_account_templates`);
    const treatment = new Map(rows.map((r: { code: string; default_tax_treatment: string | null }) => [r.code, r.default_tax_treatment]));
    const missing = allEngineCodes().filter((c) => !HONESTLY_UNKNOWN.has(c) && !["S", "Z", "E", "O"].includes(treatment.get(c) as string));
    expect(missing, "these engine codes have no default treatment in the template").toEqual([]);
  });

  // ── Bank accounts ──────────────────────────────────────────────────────────
  it("duplicates scope to the ACCOUNT: same row re-uploaded = duplicate; same row on another account = real", async () => {
    const row = { date: "2026-07-25", description: "RENT - OFFICE UNIT 4", amount: 15000, currency: "SAR", type: "debit" };
    const first = (await inTenant(() =>
      transactionsService.upload({ rows: [row], autoCategrize: false, bankAccountId: accountA } as never),
    )) as { inserted: number };
    expect(first.inserted).toBe(1);

    const again = (await inTenant(() =>
      transactionsService.upload({ rows: [row], autoCategrize: false, bankAccountId: accountA } as never),
    )) as { inserted: number; duplicatesSkipped: number };
    expect(again.inserted).toBe(0);
    expect(again.duplicatesSkipped).toBe(1);

    const otherAccount = (await inTenant(() =>
      transactionsService.upload({ rows: [row], autoCategrize: false, bankAccountId: accountB } as never),
    )) as { inserted: number; duplicatesSkipped: number };
    expect(otherAccount.inserted).toBe(1);
    expect(otherAccount.duplicatesSkipped).toBe(0);
  });

  // ── M16.3.1: checked vs assumed treatment defaults ────────────────────────
  describe("M16.3.1 — an unverified treatment default is visible where it is USED", () => {
    it("verification is DATA, and exactly the two checked categories carry it", async () => {
      // Flipping `treatment_verified` records an actual KSA rule lookup; if
      // this list grows, the lookup must be recorded in the design doc's
      // verification-status section (queue C9), or this test fails on purpose.
      const { rows } = await pool.query(
        `SELECT code FROM system_account_templates WHERE treatment_verified ORDER BY code`,
      );
      expect(rows.map((r: { code: string }) => r.code)).toEqual(["BANK_CHARGES", "INSURANCE"]);
    });

    it("an assumed treatment is flagged in review; a verified one is not", async () => {
      await inTenant(() =>
        transactionsService.upload({
          rows: [
            // TELECOM → 'S' — a majority-default nobody has verified.
            { date: "2026-08-01", description: "SADAD PAYMENT - STC 0555000111", amount: 575, currency: "SAR", type: "debit" },
            // BANK_CHARGES → 'S' — checked against the ZATCA guideline (M16.2).
            { date: "2026-08-02", description: "AL RAJHI BANK MONTHLY ACCOUNT FEE", amount: 57.5, currency: "SAR", type: "debit" },
          ],
          autoCategrize: true,
          bankAccountId: accountA,
        } as never),
      );
      const pending = await inTenant(() => transactionsService.pendingReview());
      const telecom = pending.find((p) => p.description.includes("STC 0555000111"));
      const fee = pending.find((p) => p.description.includes("MONTHLY ACCOUNT FEE"));
      expect(telecom?.taxTreatment).toBe("S");
      expect(telecom?.treatmentAssumed).toBe(true); // the user sees "assumed", not a confident S
      expect(fee?.taxTreatment).toBe("S");
      expect(fee?.treatmentAssumed).toBe(false); // verified default — no hint needed
    });

    it("a per-row override to non-'S' clears the VAT, ends the assumed state, and marks the row overridden", async () => {
      const { rows: [row] } = await pool.query(
        `SELECT id FROM transactions WHERE organization_id = $1 AND description LIKE '%STC 0555000111%'`,
        [orgId],
      );
      await inTenant(() => transactionsService.update(Number(row.id), { taxTreatment: "Z" } as never));
      const { rows: [after] } = await pool.query(
        `SELECT tax_treatment, vat_amount, is_manually_overridden FROM transactions WHERE id = $1`,
        [row.id],
      );
      expect(after.tax_treatment).toBe("Z");
      expect(after.vat_amount).toBeNull(); // Z carries zero VAT and says why
      expect(after.is_manually_overridden).toBe(true);
      const pending = await inTenant(() => transactionsService.pendingReview());
      expect(pending.find((p) => p.id === Number(row.id))?.treatmentAssumed).toBe(false);
    });
  });

  it("an unknown bank account id fails closed (400), importing nothing", async () => {
    await expect(
      inTenant(() =>
        transactionsService.upload({
          rows: [{ date: "2026-07-26", description: "X", amount: 10, currency: "SAR", type: "debit" }],
          autoCategrize: false,
          bankAccountId: 99999999,
        } as never),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
