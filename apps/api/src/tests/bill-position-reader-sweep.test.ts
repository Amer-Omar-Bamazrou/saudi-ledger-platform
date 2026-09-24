/**
 * PHASE 11 PART 2 — EVERY READER THAT TURNS BILL ROWS INTO A FIGURE USES THE
 * ONE DEFINITION OF A BILL'S SIGN AND OUTSTANDING (`repositories/billPosition`).
 *
 * Decision record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §17.
 *
 * Part 2 changed both halves of `total − paid_amount`: a `bills` row can now
 * be a CREDIT note (it reduces what we owe), and money reaches a bill through
 * the AP subledger as well as through `paid_amount`. The first build fixed the
 * ageing, the statement and the VAT return — the readers it was working on —
 * and left eight others on the old expression: the Bills list headline, the
 * overdue count, the vendor totals, supplier spend analytics, bank-match
 * candidates, the overdue-payables finding, the migration-reversal guard and
 * the AP subledger invariant. "A targeted fix sees only what it was sent to
 * fix": this test is the inventory, and it is the RATCHET for the next reader.
 *
 * 🔴 WRITTEN RED FIRST: it failed, listing those files, before any of them was
 * changed. The planted positive proves it can see a reader that omits the
 * import.
 *
 * WHAT IS CHECKED, mechanically (no database): every file under
 * `src/repositories`, `src/services` and `src/scripts/ledgerInvariants.ts`
 * that reads bills AND names an amount must import `billPosition` — or sit in
 * EXEMPT with a reason a reviewer can check by opening the file. EXEMPT only
 * shrinks; a stale exemption is a finding, not a pass.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const API_SRC = join(__dirname, "..");

/** Reads bills: the table, raw SQL over it, its repository, or a bill row's money fields. */
const READS_BILLS = /\bbillsTable\b|\b(FROM|JOIN)\s+bills\b|\bbillsRepository\b|\bbill!?\.(total|paidAmount)\b/;
/** …and names an amount. */
const NAMES_AMOUNT = /\b(paidAmount|paid_amount)\b|\.total\b|total::numeric/;
/** …and consumes the one definition. */
const IMPORTS_DEFINITION = /from\s+["'](\.\/|\.\.\/|\.\.\/\.\.\/)(repositories\/)?billPosition(\.js)?["']/;

/**
 * Files that read bill amounts but do NOT compute what a bill owes or what a
 * set of bills sums to. 🔴 This list only SHRINKS; adding to it is a review
 * decision, never a way to go green.
 */
const EXEMPT: Record<string, string> = {
  "repositories/billPosition.ts": "the definition itself.",
  "repositories/approvalsQueue.repository.ts": "lists DRAFT and SUBMITTED documents with their total as a label; nothing in the queue has been paid or applied, and no figure is summed.",
  "repositories/purchaseOrders.repository.ts": "sums a purchase ORDER's own lines (`row.total` is the PO total); it does not read bills' money.",
  "services/bills.approvable.ts": "POSTS a document's own subtotal/VAT/total at approval — the moment before anything can have been paid or applied.",
  "services/bills.presenter.ts": "renders the stored fields of one row; the outstanding it shows is computed by the repository through billPosition and passed in.",
  "services/accounting/purchaseNotePolicy.ts": "computes the CREDIT-NOTE CEILING (what a bill was charged less what notes have credited) — deliberately not outstanding: a paid bill may still be credited in full (pack §13.4).",
  "services/accounting/supplierCreditNotes.service.ts": "computes a NOTE's own unapplied balance (its total less its live applications) — a different figure from what a bill owes; targets are validated through supplierPayments.service, which uses billPosition.",
  "services/migrationCommit.service.ts": "checks rows it created in the SAME transaction, at commit, before anything can have been paid or applied (R8 ties them to their opening journal).",
  "services/migrationCorrection.service.ts": "writes a replacement opening row with paidAmount 0 and reads the live row's total to size the correction; it sums nothing.",
  "services/purchaseOrderConversion.service.ts": "reports the converted bill's total as a label beside the PO's.",
  "services/bills.service.ts": "the legacy pay path reads what a bill owes through `billsRepository.outstandingOf` (billPosition, under a row lock); `paidAmount` here is the counter it WRITES, not a balance it computes.",
  "services/accounting/supplierAdvanceInvoices.service.ts": "Z-AP1: computes an ADVANCE INVOICE's own open amount (its total less its advance credit notes less its finalised bill_prepayments deductions) — not what a bill owes. Advance documents owe nothing in billPosition (sign 0, outstanding 0); the FINAL bill's outstanding is billPosition's, through billsRepository.",
  "services/reconciliation.service.ts": "bank-match candidates quote the `outstanding` column `billsRepository.openForSettlement` computes through billPosition; the remaining amount expressions are the INVOICE side.",
  "services/accounting/supplierPayments.service.ts": "reads what a bill owes through `billsRepository.outstandingOf` (billPosition, under a row lock); its own SQL computes what a PAYMENT still has on account — a different figure.",
};

/**
 * 🔴 AN EXEMPTION IS NOT A LICENCE TO RESTATE THE EXPRESSION. Whatever reason
 * a file is exempt for, it must not compute a bill's balance locally — the
 * exact shape Part 2 made wrong.
 */
const RESTATES_BILL_BALANCE = /\b(bill|existing|b)\w*!?\.total\)?\s*-\s*[^;\n]*\b(bill|existing|b)\w*!?\.paidAmount\b|\bb\.total(::numeric)?\s*-\s*coalesce\(b\.paid_amount/i;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "__fixtures__" ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]);
}

function readerFiles(): { name: string; text: string }[] {
  const paths = [
    ...walk(join(API_SRC, "repositories")),
    ...walk(join(API_SRC, "services")),
    join(API_SRC, "scripts", "ledgerInvariants.ts"),
  ].filter((p) => p.endsWith(".ts"));
  return paths.map((p) => ({ name: relative(API_SRC, p).split(sep).join("/"), text: readFileSync(p, "utf8") }));
}

const isReader = (text: string) => READS_BILLS.test(text) && NAMES_AMOUNT.test(text);

describe("Phase 11 Part 2 — every reader of bill amounts consumes the one definition of sign and outstanding", () => {
  it("🔴 the sweep SEES a reader that omits the definition (planted positive), and passes one that imports it", () => {
    const planted = `import { db, billsTable } from "@workspace/db";\nexport const r = { async owed() { return db.select({ t: sql\`sum(\${billsTable.total} - \${billsTable.paidAmount})\` }).from(billsTable); } };`;
    expect(isReader(planted)).toBe(true);
    expect(IMPORTS_DEFINITION.test(planted)).toBe(false);
    expect(IMPORTS_DEFINITION.test(`${planted}\nimport { billOutstandingSql } from "./billPosition";`)).toBe(true);
    expect(IMPORTS_DEFINITION.test(`${planted}\nimport { billOutstandingSql } from "../../repositories/billPosition.js";`)).toBe(true);
    // Reading bills for identity only (no amount) is not a reader.
    expect(isReader(`import { billsTable } from "@workspace/db"; db.select({ id: billsTable.id }).from(billsTable)`)).toBe(false);
  });

  it("🔴 every bill-amount reader imports repositories/billPosition, or is exempt with a checkable reason", () => {
    const readers = readerFiles().filter((f) => isReader(f.text));
    expect(readers.length, "the frame: at least the known readers must be found").toBeGreaterThanOrEqual(15);
    const missing = readers
      .filter((f) => !IMPORTS_DEFINITION.test(f.text) && !(f.name in EXEMPT))
      .map((f) => f.name);
    expect(missing, `readers of bill amounts that do not consume billPosition (a credit note or a subledger payment would be miscounted):\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("🔴 no exempt file restates `total − paid_amount` for a bill (planted positive first)", () => {
    expect(RESTATES_BILL_BALANCE.test("const o = round2(Number(bill.total) - Number(bill.paidAmount ?? 0));")).toBe(true);
    expect(RESTATES_BILL_BALANCE.test("SELECT b.total::numeric - coalesce(b.paid_amount::numeric, 0)")).toBe(true);
    expect(RESTATES_BILL_BALANCE.test("const o = await billsRepository.outstandingOf(id, { lock: true });")).toBe(false);
    /**
     * The ONE file allowed to restate it, because its exemption IS that
     * restatement: migrationCommit's R8 check sums `total − paidAmount` over
     * bills it inserted in the same transaction, when no payment, allocation
     * or note can yet exist (paidAmount is 0 by construction). Found by this
     * check on its first run, and left in place deliberately — the brief
     * forbids redoing migration.
     */
    const RESTATEMENT_ALLOWED = new Set(["repositories/billPosition.ts", "services/migrationCommit.service.ts"]);
    const offenders = Object.keys(EXEMPT)
      .filter((name) => !RESTATEMENT_ALLOWED.has(name) && existsSync(join(API_SRC, name)))
      .filter((name) => RESTATES_BILL_BALANCE.test(readFileSync(join(API_SRC, name), "utf8")));
    expect(offenders, "exempt files computing a bill balance locally — use billPosition").toEqual([]);
  });

  it("the exemption list only names files that exist, still read bills, and still do not import the definition", () => {
    const stale: string[] = [];
    for (const name of Object.keys(EXEMPT)) {
      const path = join(API_SRC, name);
      if (!existsSync(path)) { stale.push(`${name}: file does not exist`); continue; }
      const text = readFileSync(path, "utf8");
      if (name !== "repositories/billPosition.ts" && IMPORTS_DEFINITION.test(text)) stale.push(`${name}: now imports billPosition — remove the exemption`);
      if (!isReader(text)) stale.push(`${name}: no longer reads bill amounts — remove the exemption`);
    }
    expect(stale).toEqual([]);
  });
});
