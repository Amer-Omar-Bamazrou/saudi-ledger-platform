/**
 * Flaw-report fixes — statement ingest correctness (#2, #3, #5, #7, #10).
 *
 * Every case here was OBSERVED in the live SME-statement run, not imagined:
 *
 *  #2 a `500.00 USD` AWS row was stored and summed as 500 SAR (~1,875 real)
 *     and had SAR "VAT" extracted from it;
 *  #5 ONE TRAILING SPACE on an STC description defeated the duplicate key, so
 *     the same payment imported twice — 862.50 of expense and 112.50 of VAT
 *     counted twice — while two genuinely identical parking fees collapsed
 *     into one with only a bare count to show for it (#10);
 *  #3 categorising the export sale by hand left `tax_treatment = null`, so
 *     hand-classified rows contributed nothing to the VAT reconciliation the
 *     review surface exists to feed;
 *  #7 a GOSI contribution was booked to "Salaries and Wages Expense".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";
import { categorizeTransaction } from "../services/categorization/categorizer";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[ingest-correctness] no real DATABASE_URL — skipping.");

const SLUG = "ingest-correctness";
const EMAIL = "ingest-correctness@test.local";

/**
 * 🔴 A THIRD ID SPACE, found while fixing #7 — the two-id-spaces lesson again.
 *
 * The matcher does `SEED_CATEGORIES.find(c => c.systemCode === rule.systemCode)`
 * and, on a miss, `continue`s. So a rule can name a REAL system code that is
 * seeded in the tenant's chart AND present in `allEngineCodes()` — passing the
 * M16.2 forcing-function test — and still never fire, because a third list
 * gates it silently. That is exactly how the new GOSI rule did nothing: it
 * matched the text, then vanished.
 *
 * `allEngineCodes()` is derived from CATEGORIZATION_RULES, so it cannot catch
 * this; the missing link is rules → SEED_CATEGORIES.
 */
describe("🔴 rule coverage — every rule can actually fire", () => {
  it("every CATEGORIZATION_RULES systemCode exists in SEED_CATEGORIES", async () => {
    const { SEED_CATEGORIES, allEngineCodes } = await import("../services/categorization/categorizer");
    const known = new Set(SEED_CATEGORIES.map((c) => c.systemCode));
    const orphans = allEngineCodes().filter((code) => !known.has(code));
    expect(
      orphans,
      "these rules name a system code with no SEED_CATEGORIES entry — the matcher silently skips them, so the rule is dead code",
    ).toEqual([]);
  });
});

describe("#7 — GOSI is its own expense, not payroll", () => {
  it("a GOSI contribution resolves to GOSI_EXPENSE", () => {
    expect(categorizeTransaction("GOSI CONTRIBUTION SEP 2026", 1350, "debit")?.systemCode).toBe("GOSI_EXPENSE");
    expect(categorizeTransaction("التأمينات الاجتماعية سبتمبر", 1350, "debit")?.systemCode).toBe("GOSI_EXPENSE");
  });

  it("commercial insurance is NOT stolen by the social-insurance rule", () => {
    expect(categorizeTransaction("TAWUNIYA MOTOR INSURANCE POLICY", 3200, "debit")?.systemCode).toBe("INSURANCE");
  });
});

/**
 * 🔴 THE ARABIC HALF OF THE ENGINE WAS DEAD CODE.
 *
 * `\b` is an ASCII word boundary, so `/\bراتب\b/` never matched "راتب سبتمبر"
 * — sixty Arabic patterns were written that way and had never fired once.
 * Nothing errored: Arabic rows simply came back uncategorised, indistinguishable
 * from an honest "I don't know". In a Saudi product whose statements are
 * frequently Arabic, that is most of the engine.
 */
describe("🔴 Arabic categorisation actually fires", () => {
  const cases: Array<[string, string]> = [
    ["راتب شهر سبتمبر", "SALARIES"],
    ["زكاة 2026", "ZAKAT_PAYMENT"],
    ["فاتورة الكهرباء", "RENT_UTILITIES"],
    ["إيجار المكتب", "RENT_UTILITIES"],
    ["التأمينات الاجتماعية", "GOSI_EXPENSE"],
  ];

  for (const [text, code] of cases) {
    it(`"${text}" → ${code}`, () => {
      expect(categorizeTransaction(text, 1350, "debit")?.systemCode).toBe(code);
    });
  }

  it("no Arabic pattern in the engine uses an ASCII word boundary", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "..", "services", "categorization", "categorizer.ts"),
      "utf8",
    );
    // A `\b` directly against an Arabic letter can never match — that is the
    // defect, mechanized so it cannot be reintroduced.
    const offenders = [
      ...src.matchAll(/\\b[؀-ۿ]/g),
      ...src.matchAll(/[؀-ۿ]\\b/g),
    ];
    expect(
      offenders.map((m) => m[0]),
      "an ASCII word boundary next to Arabic script never matches — remove it",
    ).toEqual([]);
  });

  it("🔴 the engine source contains NO control characters", async () => {
    // Third corruption class in this one file, found while adding the
    // reverse-charge supplier list: regex escapes written through nested
    // shell/script layers arrived as literal CONTROL CHARACTERS — 54 copies of
    // U+0008 (backspace) where `\b` was intended. The patterns then matched
    // nothing and the detector silently returned false for every supplier.
    //
    // Reading the file shows `/google/i`, because a terminal renders the
    // backspace invisibly — the same "looks right in the source" property as
    // the bidi typo. A byte-level check is the only thing that sees it.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src =
      readFileSync(join(__dirname, "..", "services", "categorization", "categorizer.ts"), "utf8") +
      readFileSync(join(__dirname, "ingest-correctness.test.ts"), "utf8");
    // Built from codepoints rather than an escape sequence: the escapes for
    // THIS VERY TEST were eaten once already (see below).
    const CONTROL = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(8) +
      String.fromCharCode(11) + String.fromCharCode(12) +
      String.fromCharCode(14) + "-" + String.fromCharCode(31) + "]", "g");

    // 🔴 SELF-CHECK: prove the matcher works before trusting a clean result.
    // A guard that silently matches nothing reports "no corruption" forever —
    // which is the same shape as the bug it hunts.
    expect("a" + String.fromCharCode(8) + "b").toMatch(CONTROL);

    const control = [...src.matchAll(CONTROL)].map((m) =>
      "U+" + m[0].codePointAt(0)!.toString(16).padStart(4, "0"),
    );
    expect([...new Set(control)], "control characters in source are always corruption, never intent").toEqual([]);
  });

  it("no pattern escapes an Arabic letter with a backslash", async () => {
    // The second corruption class, found in the salary rule: what LOOKED like
    // `\b` was a backslash followed by Arabic "ب" (a bidirectional-editing
    // typo), so the pattern matched the literal string "براتب" and the salary
    // rule had never fired in Arabic either. `\<Arabic letter>` is always a
    // no-op escape, so its presence is always a mistake.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "services", "categorization", "categorizer.ts"), "utf8");
    expect([...src.matchAll(/\\[؀-ۿ]/g)].map((m) => m[0]), "a backslash before an Arabic letter escapes nothing").toEqual([]);
  });

  it("an actual salary still resolves to SALARIES", () => {
    expect(categorizeTransaction("SALARY TRANSFER - MOHAMMED AL HARBI", 9000, "debit")?.systemCode).toBe("SALARIES");
  });
});

describeMaybe("statement ingest — currency, whitespace, duplicates, manual categorisation", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let accountId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
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
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Ingest Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'IC','1010101020','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','IC',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    accountId = (
      await pool.query(
        `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'IC SAR','Riyad') RETURNING id`,
        [orgId, companyId],
      )
    ).rows[0].id;
  });

  afterAll(cleanup);

  const upload = (rows: unknown[], auto = true) =>
    inTenant(() =>
      transactionsService.upload({ rows, autoCategrize: auto, bankAccountId: accountId } as never),
    ) as Promise<{ inserted: number; categorized: number; duplicatesSkipped: number; duplicates: Array<{ description: string; amount: number }>; errors: string[] }>;

  it("🔴 #2 a non-SAR row is REFUSED, not silently summed as SAR", async () => {
    const r = await upload([
      { date: "2026-10-01", description: "AWS EMEA SARL WEB SERVICES", amount: 500, currency: "USD", type: "debit" },
      { date: "2026-10-01", description: "LOCAL SUPPLIER SAR", amount: 100, currency: "SAR", type: "debit" },
    ]);
    expect(r.inserted).toBe(1); // only the SAR row
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("USD");
    expect(r.errors[0]).toMatch(/not supported yet/i);
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM transactions WHERE organization_id = $1 AND description LIKE 'AWS%'`,
      [orgId],
    );
    expect(rows[0].n).toBe(0); // nothing stored at a wrong SAR value
  });

  it("🔴 #5 a trailing space no longer defeats the duplicate key", async () => {
    const base = { date: "2026-10-02", description: "SADAD PAYMENT - STC 0112345678", amount: 862.5, currency: "SAR", type: "debit" };
    const first = await upload([base]);
    expect(first.inserted).toBe(1);

    // The same statement re-exported with sloppier spacing — ONE line, spelled
    // differently. Normalisation makes it the same row, so nothing imports.
    const again = await upload([{ ...base, description: "  SADAD PAYMENT - STC 0112345678 " }]);
    expect(again.inserted).toBe(0);
    expect(again.duplicatesSkipped).toBe(1);

    // …and the other spelling too, independently.
    const third = await upload([{ ...base, description: "SADAD PAYMENT  -  STC 0112345678" }]);
    expect(third.inserted).toBe(0);

    const { rows } = await pool.query(
      `SELECT description FROM transactions WHERE organization_id = $1 AND description LIKE 'SADAD%'`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe(base.description); // stored normalised, no stray spaces
  });

  /**
   * 🔴 2026-08-28 — THE DELIBERATE TRADE THIS TEST NOW RECORDS.
   *
   * Duplicate detection went from EXISTENCE to MULTIPLICITY: import as many
   * copies as the file carries minus as many as the account already holds. So a
   * file that lists a line TWICE imports the second copy, even if the line is
   * really one charge that a sloppy re-export spelled two ways. The old test
   * asserted the opposite, because it presented two spellings of one line as if
   * they were a re-upload.
   *
   * We chose the direction on which error is RECOVERABLE, not on which is rarer:
   *   • Under-import (the old behaviour) drops a real charge from the books.
   *     Expenses and input VAT are understated, nothing on any screen says so,
   *     and the only trace was a `duplicates` array no UI reads.
   *   • Over-import lands in `pending_review`, where a human sees it before it
   *     can post, AND is detected by the existing `duplicate_transaction`
   *     finding, which keys on exactly (date, amount, description).
   *
   * One direction is caught by two mechanisms we already own; the other is
   * caught by nothing. That is the whole argument.
   */
  it("🔴 a file that lists the same line twice imports both — the file's own count is the evidence", async () => {
    const fee = { date: "2026-10-05", description: "ATM WITHDRAWAL FEE", amount: 15, currency: "SAR", type: "debit" };
    const r = await upload([fee, fee]);
    expect(r.inserted).toBe(2);
    expect(r.duplicatesSkipped).toBe(0);

    // Re-uploading that same statement adds nothing: the account already holds
    // as many copies as the file claims.
    const again = await upload([fee, fee]);
    expect(again.inserted).toBe(0);
    expect(again.duplicatesSkipped).toBe(2);
  });

  it("🔴 #10 two genuinely identical payments both reach the books", async () => {
    /**
     * 🔴 THIS TEST USED TO ASSERT THE DEFECT. Its own words were "two real
     * parking fees on one day", and it then asserted that only ONE of them was
     * inserted — the obsolete-assertion family, except it was never correct:
     * it pinned a known loss because the mitigation shipped at the time was to
     * RETURN the dropped row rather than import it. No UI ever read that field
     * (checked: zero references to `duplicates` in `apps/web`), so the
     * mitigation had no consumer and the second fee was silently missing from
     * the expense figure and the VAT reconciliation.
     */
    const park = { date: "2026-10-03", description: "PARKING FEE", amount: 20, currency: "SAR", type: "debit" };
    const r = await upload([park, park]); // two real parking fees on one day
    expect(r.inserted).toBe(2);
    expect(r.duplicatesSkipped).toBe(0);

    const { rows } = await pool.query(
      `SELECT count(*)::int n, sum(amount)::numeric total FROM transactions
        WHERE organization_id = $1 AND description = 'PARKING FEE'`,
      [orgId],
    );
    expect(rows[0].n).toBe(2);
    expect(Number(rows[0].total)).toBe(40); // not 20 — the books hold both
  });

  it("🔴 #3 categorising by hand stamps the treatment and extracts VAT, exactly as the engine does", async () => {
    await upload([{ date: "2026-10-04", description: "REF 5512 UNKNOWN MERCHANT", amount: 862.5, currency: "SAR", type: "debit" }], false);
    const { rows: [tx] } = await pool.query(
      `SELECT id, tax_treatment, vat_amount FROM transactions WHERE organization_id = $1 AND description LIKE 'REF 5512%'`,
      [orgId],
    );
    expect(tx.tax_treatment).toBeNull(); // uncategorised: honest unknown

    const { rows: [telecom] } = await pool.query(
      `SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'TELECOM'`,
      [orgId],
    );
    await inTenant(() => transactionsService.update(Number(tx.id), { categoryId: Number(telecom.id) } as never));

    const { rows: [after] } = await pool.query(
      `SELECT tax_treatment, vat_amount::text, vat_rate::text FROM transactions WHERE id = $1`,
      [tx.id],
    );
    expect(after.tax_treatment).toBe("S");
    expect(after.vat_amount).toBe("112.50"); // EXTRACTED from gross, never applied to it
    expect(after.vat_rate).toBe("15.00");
  });

  it("#3 a hand-assigned Z/E/O category clears any VAT instead of violating the DB CHECK", async () => {
    await upload([{ date: "2026-10-05", description: "SADAD PAYMENT - STC 999", amount: 230, currency: "SAR", type: "debit" }]);
    const { rows: [tx] } = await pool.query(
      `SELECT id, vat_amount FROM transactions WHERE organization_id = $1 AND description LIKE 'SADAD PAYMENT - STC 999%'`,
      [orgId],
    );
    expect(tx.vat_amount).not.toBeNull(); // engine extracted, treatment 'S'

    const { rows: [zakat] } = await pool.query(
      `SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'ZAKAT_PAYMENT'`,
      [orgId],
    );
    // ZAKAT_PAYMENT defaults to 'O'. Without clearing the VAT this write would
    // be rejected by CHECK transactions_treatment_vat_agree (a 500).
    await inTenant(() => transactionsService.update(Number(tx.id), { categoryId: Number(zakat.id) } as never));
    const { rows: [after] } = await pool.query(`SELECT tax_treatment, vat_amount FROM transactions WHERE id = $1`, [tx.id]);
    expect(after.tax_treatment).toBe("O");
    expect(after.vat_amount).toBeNull();
  });

  it("#3 clearing the category clears the treatment with it", async () => {
    const { rows: [tx] } = await pool.query(
      `SELECT id FROM transactions WHERE organization_id = $1 AND description LIKE 'REF 5512%'`,
      [orgId],
    );
    await inTenant(() => transactionsService.update(Number(tx.id), { categoryId: null } as never));
    const { rows: [after] } = await pool.query(`SELECT tax_treatment, vat_amount FROM transactions WHERE id = $1`, [tx.id]);
    expect(after.tax_treatment).toBeNull();
    expect(after.vat_amount).toBeNull();
  });

  it("🔴 the 'assumed' hint survives a human choosing the category — it describes the TREATMENT, not who picked it", async () => {
    await upload([{ date: "2026-10-06", description: "REF 7781 SOME MERCHANT", amount: 500, currency: "SAR", type: "debit" }], false);
    const { rows: [tx] } = await pool.query(
      `SELECT id FROM transactions WHERE organization_id = $1 AND description LIKE 'REF 7781%'`,
      [orgId],
    );
    const { rows: [travel] } = await pool.query(
      `SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'TRAVEL'`,
      [orgId],
    );
    await inTenant(() => transactionsService.update(Number(tx.id), { categoryId: Number(travel.id) } as never));

    const pending = await inTenant(() => transactionsService.pendingReview());
    const row = pending.find((p) => p.id === Number(tx.id));
    // TRAVEL stays unverified after C9 (a genuine mix — hotels S, international
    // transport Z, blocked entertainment; docs/tax/vat-treatment-verification.md),
    // so the treatment is still a guess even though the human picked the
    // category. (Was FOOD_MEALS until C9 verified it on 2026-08-19.) Pre-fix
    // the override flag suppressed this hint and the guess looked authoritative.
    expect(row?.taxTreatment).toBe("S");
    expect(row?.treatmentAssumed).toBe(true);

    // Overriding the TREATMENT itself is the human's assertion — hint gone.
    await inTenant(() => transactionsService.update(Number(tx.id), { taxTreatment: "E" } as never));
    const after = await inTenant(() => transactionsService.pendingReview());
    expect(after.find((p) => p.id === Number(tx.id))?.treatmentAssumed).toBe(false);
  });
});
