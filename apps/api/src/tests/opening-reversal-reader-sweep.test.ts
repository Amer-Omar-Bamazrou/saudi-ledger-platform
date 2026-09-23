/**
 * BATCH 1C — POLICY C: EVERY READER OF INVOICE / BILL / PAYMENT AMOUNTS
 * EXCLUDES A REVERSED OPENING ROW THROUGH THE ONE PREDICATE.
 *
 * Decision record: docs/product/batch-1c-migration-opening-balances-decision-pack.md
 * §16.12.1 (accountant A4, 2026-09-20). A migration's reversal MARKS the
 * opening invoices, bills and deposits instead of deleting them, and the
 * mirror journal nets their GL effect. From that moment every figure computed
 * from those rows — an ageing bucket, a customer statement, a vendor balance,
 * an overdue finding, a list total, a matching candidate — must leave the
 * marked rows out, or the subledger disagrees with the GL and no gate sees
 * it. "The report is a sample, not an inventory": a reader fixed one at a
 * time is a reader missed one at a time.
 *
 * 🔴 WRITTEN RED FIRST (owner, 2026-09-20): this file existed and FAILED
 * before any reader was changed, and its planted positive proves it can see
 * a reader that omits the predicate. The mechanical half below is the
 * RATCHET against the next reader; the runtime half — the figures actually
 * moving from reversed-included to reversed-excluded, per reader, on rows
 * the product wrote — is in batch-1c-migration-commit.test.ts test 20.
 *
 * WHAT IS CHECKED, mechanically (no database): every file under
 * `src/repositories` and `src/scripts/ledgerInvariants.ts` that reads one of
 * the three tables AND names an amount column must import
 * `repositories/openingReversal` — or sit in EXEMPT with a reason a reader
 * can check. EXEMPT only shrinks; a stale exemption (file gone, or file now
 * importing the predicate) is a finding, not a pass.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "..");
const REPOSITORIES = join(API_SRC, "repositories");
const SCRIPT = join(API_SRC, "scripts", "ledgerInvariants.ts");

/** A file that READS one of the three tables. */
const READS_TABLE = /\b(invoicesTable|billsTable|paymentsTable)\b|\b(FROM|JOIN)\s+(invoices|bills|payments)\b/;
/** …and turns rows into a FIGURE (names an amount column). */
const NAMES_AMOUNT = /\b(paidAmount|paid_amount|creditedAmount|credited_amount|outstanding|total::numeric|\.total\b|\.amount\b|amount::numeric|sum\()/;
/** …and consumes the one predicate. */
const IMPORTS_PREDICATE = /from\s+["'](\.\/|\.\.\/repositories\/)openingReversal["']/;

/**
 * Files that read amounts but legitimately do NOT need the predicate. Each
 * carries the reason a reviewer can verify by opening the file. 🔴 This list
 * only SHRINKS. Adding to it is a review decision, never a way to go green.
 */
const EXEMPT: Record<string, string> = {
  "analytics.repository.ts": "customerTotals/vendorTotals exclude EVERY opening row (`is_opening = false`, R7: a migrated item is never a sales/purchase event); monthlyReceivables reads the GL, where the mirror nets the reversed pair.",
  "migration.repository.ts": "reads its OWN batch's opening rows by design — the reversal preview and R2/R3/R10 must see the rows they created, reversed or not.",
  "openingReversal.ts": "the predicate itself.",
  "billPosition.ts": "SQL FRAGMENTS for a bill's sign and outstanding (Phase 11 Part 2), not a query: it selects no rows, and every caller supplies its own WHERE carrying billNotReversed (bills, vendors, findings, reports, supplierStatement, ledgerInvariants) or excludes every opening row (analytics).",
  "approvalsQueue.repository.ts": "lists DRAFT and SUBMITTED documents for the approvals worklist with their total as a label; an opening item is created 'sent'/'approved' and never enters the queue, reversed or not.",
  "reports.repository.ts.__NOT_EXEMPT__": "placeholder proving the map is a map — never matched",
};

function readerFiles(): { name: string; path: string; text: string }[] {
  const files = readdirSync(REPOSITORIES).filter((f) => f.endsWith(".ts")).map((f) => ({ name: f, path: join(REPOSITORIES, f) }));
  files.push({ name: "scripts/ledgerInvariants.ts", path: SCRIPT });
  return files.map((f) => ({ ...f, text: readFileSync(f.path, "utf8") }));
}

const isReader = (text: string) => READS_TABLE.test(text) && NAMES_AMOUNT.test(text);

describe("Policy C — every reader of invoice / bill / payment amounts consumes the one reversed-row predicate", () => {
  it("🔴 the sweep SEES a reader that omits the predicate (planted positive), and passes one that imports it", () => {
    const planted = `import { db, invoicesTable } from "@workspace/db";\nexport const r = { async total() { return db.select({ t: sql\`sum(\${invoicesTable.paidAmount})\` }).from(invoicesTable); } };`;
    expect(isReader(planted)).toBe(true);
    expect(IMPORTS_PREDICATE.test(planted)).toBe(false);
    const fixed = `${planted}\nimport { invoiceNotReversed } from "./openingReversal";`;
    expect(IMPORTS_PREDICATE.test(fixed)).toBe(true);
    // A file that reads the table for identity only (no amount) is not a reader.
    expect(isReader(`import { invoicesTable } from "@workspace/db"; db.select({ id: invoicesTable.id }).from(invoicesTable)`)).toBe(false);
  });

  it("🔴 every amount reader imports repositories/openingReversal, or is exempt with a checkable reason", () => {
    const readers = readerFiles().filter((f) => isReader(f.text));
    expect(readers.length, "the frame: at least the known readers must be found").toBeGreaterThanOrEqual(8);
    const missing = readers
      .filter((f) => !IMPORTS_PREDICATE.test(f.text) && !(f.name in EXEMPT))
      .map((f) => f.name);
    expect(missing, `readers of invoice/bill/payment amounts that do not consume the predicate (a reversed opening row would count as live):\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("the exemption list only names files that exist and still need exempting", () => {
    const stale: string[] = [];
    for (const name of Object.keys(EXEMPT)) {
      if (name.endsWith("__NOT_EXEMPT__")) continue;
      const path = name.startsWith("scripts/") ? join(API_SRC, name) : join(REPOSITORIES, name);
      if (!existsSync(path)) { stale.push(`${name}: file does not exist`); continue; }
      const text = readFileSync(path, "utf8");
      if (name !== "openingReversal.ts" && IMPORTS_PREDICATE.test(text)) stale.push(`${name}: now imports the predicate — remove the exemption`);
    }
    expect(stale).toEqual([]);
  });
});
