import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 🔴 THE UNIQUE INDEXES THAT MAKE A DOCUMENT NUMBER MEAN ONE DOCUMENT.
 *
 * ── Why this file exists (2026-09-03) ──────────────────────────────────────
 * `invoices_company_number_unq` is the ONLY enforcement of ZATCA's requirement
 * that the invoice number uniquely identifies the Tax Invoice. It was created
 * by hand-written SQL in `0054_c12_invoice_number_uniqueness.sql` and was NOT
 * declared in `schema/invoices.ts` — while the sibling ICV index, two lines
 * away in the same table, WAS.
 *
 * That asymmetry is the whole defect. drizzle-kit generates migrations by
 * diffing the schema (desired state) against its own snapshot. The snapshot
 * carried `invoices_company_icv_unq` and not `invoices_company_number_unq`, so
 * the number index existed in the database and in NEITHER model — which is how
 * drift is spelled. The next `generate` could emit a `DROP INDEX` for it, in a
 * migration that reads as entirely ordinary housekeeping.
 *
 * Nothing would have failed. No test asserted the index. Duplicate invoice
 * numbers do not throw — they produce two financial records that claim to be
 * the same document, silently, which is the exact sentence
 * `0063_document_number_counters.sql` uses about the tables that still lack
 * this protection.
 *
 * 🔴 THIS TEST READS `pg_indexes`, NOT THE SCHEMA FILE. A declaration that has
 * drifted from the database is the same defect one layer up, and a test that
 * checked the TypeScript would agree with a lie. The database is the thing that
 * refuses the second row, so the database is what gets asserted.
 *
 * ── Why the list is a constant and not a query ─────────────────────────────
 * A test that asked "are there unique indexes?" would pass on any set of them,
 * including a set with this one missing. The list is pinned so that removing an
 * entry is an edit someone has to make on purpose, in a file that says why.
 * Entries are ADDED as the remaining document-number tables get their indexes
 * (see CLAUDE.md §5 — `journal_entries.entry_number` and `bills.bill_number`
 * are unprotected today); an entry only ever leaves if the guarantee itself is
 * deliberately withdrawn.
 */

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString ? describe : describe.skip;
if (!connectionString) {
  // eslint-disable-next-line no-console
  console.warn("[money-unique-indexes] DATABASE_URL not set — skipping index guard.");
}

/** Each entry: the index, the table it protects, and the columns it must span. */
const REQUIRED_UNIQUE_INDEXES = [
  {
    name: "invoices_company_number_unq",
    table: "invoices",
    columns: ["company_id", "invoice_number"],
    guarantees:
      "ZATCA: the invoice number uniquely identifies the Tax Invoice within the company",
  },
  {
    name: "invoices_company_icv_unq",
    table: "invoices",
    columns: ["company_id", "icv"],
    guarantees: "no two invoices in a company share an ICV (the chain counter)",
  },
] as const;

describeMaybe("money document numbers — the unique indexes are present in the DATABASE", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  for (const required of REQUIRED_UNIQUE_INDEXES) {
    it(`${required.name} exists and is UNIQUE — ${required.guarantees}`, async () => {
      const { rows } = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = $1
            AND indexname = $2`,
        [required.table, required.name],
      );

      expect(
        rows,
        `${required.name} is MISSING from the database.\n` +
          `It guarantees: ${required.guarantees}.\n` +
          `If a migration dropped it, that migration is the defect — restore the index.\n` +
          `Do not delete this assertion to go green.`,
      ).toHaveLength(1);

      expect(rows[0].indexdef, `${required.name} exists but is not UNIQUE`).toMatch(/CREATE UNIQUE INDEX/i);
      for (const column of required.columns) {
        expect(rows[0].indexdef, `${required.name} does not span ${column}`).toContain(column);
      }
    });
  }

  /**
   * The anti-vacuity half. Every assertion above passes trivially if the query
   * is wrong, the connection points somewhere empty, or `invoices` does not
   * exist — the "confident zero" this suite exists to catch. If the read is
   * broken, THIS is the test that goes red, and it names the reason.
   */
  it("is actually reading a database that has the invoices table", async () => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'invoices'`,
    );
    expect(
      Number(rows[0].count),
      "no indexes found on `invoices` at all — the assertions above would be vacuous",
    ).toBeGreaterThan(0);
  });
});

/**
 * 🔴 The declaration half, checked separately and for a different reason.
 *
 * The test above proves the index is in the DATABASE. This one proves it is in
 * the SCHEMA — because an index the schema does not declare is what drizzle-kit
 * reads as drift, and drift is what it writes a DROP for. Both halves are
 * needed: the database assertion catches an index that was dropped, and this
 * one catches the condition that would cause the drop.
 *
 * It does not need a database, so it runs everywhere the suite runs.
 */
describe("money document numbers — the indexes are DECLARED in the Drizzle schema", () => {
  const schemaDir = join(import.meta.dirname, "..", "schema");

  for (const required of REQUIRED_UNIQUE_INDEXES) {
    it(`${required.name} is declared in schema/, so codegen cannot read it as drift`, () => {
      const declared = readdirSync(schemaDir)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => readFileSync(join(schemaDir, f), "utf8"))
        .some((src) => src.includes(`uniqueIndex("${required.name}")`));

      expect(
        declared,
        `${required.name} is created by hand-written SQL but not declared in packages/db/src/schema/.\n` +
          `drizzle-kit diffs the schema against its snapshot, so an index in the database and in\n` +
          `neither model reads as drift — and the next \`generate\` can emit a DROP INDEX for it in a\n` +
          `migration that looks ordinary. Declare it with uniqueIndex("${required.name}").`,
      ).toBe(true);
    });
  }
});
