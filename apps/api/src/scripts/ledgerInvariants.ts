/**
 * THE LEDGER INVARIANT SWEEP — read-only, every organization (2026-09-17).
 *
 *   DATABASE_URL=... npx tsx src/scripts/ledgerInvariants.ts [--json out.json]
 *
 * Checks the D-4 invariant set across the whole database and exits 2 on any
 * UNEXPLAINED divergence. "Explained" is decided by STATED RULES, never by
 * organization name — an invariant that holds "except in that org" is how a
 * real break hides. The two rules, each a fact the row itself carries:
 *
 *   RULE-J  an issued invoice/bill with NO issue journal (`GL-<number>` /
 *           `BILL-<number>`) is outside the GL and cannot reconcile to it —
 *           demo/seed history written around the posting path. Counted and
 *           listed; never netted into the reconciliation.
 *   RULE-P  a control-account line with NO PARTY (`customer_id`/`vendor_id`
 *           NULL) predates N3 (2026-09-03, "the party on a control line")
 *           and cannot be attributed to a customer or vendor. Its amount is
 *           reported as a party-less residual per org; the by-party
 *           reconciliation covers party-carrying lines only.
 *   RULE-O  (Batch 1C, Policy C — pack §16.12.1) an OPENING item's party line
 *           is in the migration's opening journal (`MIG-<batch>-OPEN`), not in
 *           a `GL-<number>` issue journal, so a LIVE opening item (not
 *           reversed) is covered through that line; a REVERSED opening item
 *           is history — out of the subledger, while its GL pair (opening +
 *           mirror) nets to zero. The condition is the ONE predicate in
 *           repositories/openingReversal.ts, consumed as text here.
 *
 * Everything else must hold exactly. The "default" dev org's known condition
 * (known-issues file, "THE DEFAULT-ORG AR/AP DIVERGENCE") is RULE-J + RULE-P
 * data and shows up here under those rules, by construction.
 */
import { writeFileSync } from "node:fs";
import { pool } from "@workspace/db";
import { INVOICE_NOT_REVERSED_TEXT, BILL_NOT_REVERSED_TEXT, PAYMENT_NOT_REVERSED_TEXT } from "../repositories/openingReversal";
import { INVOICE_ISSUED_OR_OPENING_TEXT } from "../repositories/receivableInBooks";

type Row = Record<string, string | number | null>;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await pool.query(sql, params)).rows;
const n = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;

async function main() {
  const jsonOut = process.argv.indexOf("--json") >= 0 ? process.argv[process.argv.indexOf("--json") + 1] : null;
  const report: Record<string, unknown> = {};
  let failures = 0;
  const fail = (name: string, rows: Row[]) => {
    report[name] = rows;
    if (rows.length > 0) {
      failures++;
      console.log(`✗ ${name}: ${rows.length}`);
      for (const r of rows.slice(0, 20)) console.log("   ", JSON.stringify(r));
    } else console.log(`✓ ${name}`);
  };

  // ── Universal invariants (no exceptions) ──────────────────────────────
  fail("journal_balance — entries whose debits ≠ credits", await q(`
    SELECT e.organization_id::text AS org, e.entry_number, sum(l.debit_amount)::text AS dr, sum(l.credit_amount)::text AS cr
      FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id
     GROUP BY e.id HAVING sum(l.debit_amount) <> sum(l.credit_amount)`));
  // Issue 1: the covered set is every invoice ISSUED here or migrated as an OPENING item — not "has a hash" (an opening receivable never does, and it is collected).
  fail("invoice_outstanding_nonnegative — issued or opening invoices with total − paid − credited − written off < 0", await q(`
    SELECT i.organization_id::text AS org, i.id, i.invoice_number, (i.total::numeric - coalesce(i.paid_amount,0) - i.credited_amount - i.written_off_amount)::text AS outstanding
      FROM invoices i WHERE ${INVOICE_ISSUED_OR_OPENING_TEXT("i")} AND i.total::numeric - coalesce(i.paid_amount,0) - i.credited_amount - i.written_off_amount < -0.001`));
  // 2026-09-22: a write-off with relief is a posted fact — its entry exists, its VAT is the entry's VAT_OUTPUT debit, and a recovery never exceeds it.
  fail("bad_debt_write_off_posted — a recorded relief without its entry, or whose relief VAT ≠ the entry's VAT debit", await q(`
    SELECT i.organization_id::text AS org, i.id, i.invoice_number
      FROM invoices i WHERE i.bad_debt_relief_source = 'recorded'
       AND NOT EXISTS (SELECT 1 FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
                        WHERE e.id = i.bad_debt_relief_journal_entry_id AND e.status IN ('posted','reversed') AND c.system_code = 'AR' AND l.credit_amount = i.written_off_amount)`));
  // 2026-09-22: an item-level correction's other side is retained earnings and nothing else (answer 5); its original is reversed and its replacement live.
  fail("opening_correction_shape — a correction entry without exactly AR/AP (party) and RETAINED_EARNINGS lines, or an original not reversed, or without a live replacement", await q(`
    SELECT e.organization_id::text AS org, e.entry_number
      FROM journal_entries e WHERE e.source = 'opening_correction'
       AND ( (SELECT count(*) FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = e.id AND c.system_code = 'RETAINED_EARNINGS') <> 1
          OR (SELECT count(*) FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = e.id AND c.system_code IN ('AR','AP') AND (l.customer_id IS NOT NULL OR l.vendor_id IS NOT NULL)) <> 1
          OR (SELECT count(*) FROM journal_entry_lines l WHERE l.journal_entry_id = e.id) <> 2
          OR NOT EXISTS (SELECT 1 FROM invoices o WHERE o.opening_correction_journal_entry_id = e.id AND o.reversed_at IS NOT NULL AND EXISTS (SELECT 1 FROM invoices r WHERE r.replaces_invoice_id = o.id)
                         UNION ALL
                         SELECT 1 FROM bills o WHERE o.opening_correction_journal_entry_id = e.id AND o.reversed_at IS NOT NULL AND EXISTS (SELECT 1 FROM bills r WHERE r.replaces_bill_id = o.id)) )`));
  fail("bad_debt_recovery_bounded — Σ issued Art. 40(9) recoveries against a receivable > what was written off (recorded)", await q(`
    SELECT i.organization_id::text AS org, i.id, i.invoice_number, i.written_off_amount::text AS written_off, s.v::text AS recovered
      FROM invoices i JOIN (SELECT recovers_invoice_id, sum(total::numeric) v FROM invoices WHERE document_type = 'recovery_invoice' AND invoice_hash IS NOT NULL GROUP BY 1) s ON s.recovers_invoice_id = i.id
     WHERE i.bad_debt_relief_source = 'recorded' AND s.v > i.written_off_amount + 0.001`));
  fail("payment_not_over_consumed — Σ active allocations + refunds > amount", await q(`
    SELECT p.organization_id::text AS org, p.id FROM payments p
     WHERE p.amount < coalesce((SELECT sum(a.amount) FROM payment_allocations a LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id WHERE a.payment_id = p.id AND r.id IS NULL), 0)
                    + coalesce((SELECT sum(f.amount) FROM customer_refunds f WHERE f.payment_id = p.id), 0)`));
  fail("credit_note_not_over_consumed — Σ active applications + refunds > total", await q(`
    SELECT n.organization_id::text AS org, n.id FROM invoices n
     WHERE n.document_type = 'credit_note' AND n.invoice_hash IS NOT NULL
       AND n.total::numeric < coalesce((SELECT sum(a.amount) FROM payment_allocations a LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id WHERE a.credit_note_id = n.id AND r.id IS NULL), 0)
                            + coalesce((SELECT sum(f.amount) FROM customer_refunds f WHERE f.credit_note_id = n.id), 0)`));
  fail("credited_cache — invoices.credited_amount ≠ Σ active credit allocations", await q(`
    SELECT i.organization_id::text AS org, i.id, i.credited_amount::text AS cache, coalesce(s.v,0)::text AS truth
      FROM invoices i LEFT JOIN (SELECT a.invoice_id, sum(a.amount) v FROM payment_allocations a LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id WHERE a.credit_note_id IS NOT NULL AND r.id IS NULL GROUP BY 1) s ON s.invoice_id = i.id
     WHERE i.credited_amount <> coalesce(s.v, 0)`));
  fail("paid_cache — invoices.paid_amount ≠ Σ legacy rows + Σ active payment allocations", await q(`
    SELECT i.organization_id::text AS org, i.id, coalesce(i.paid_amount,0)::text AS cache, (coalesce(l.v,0) + coalesce(s.v,0))::text AS truth
      FROM invoices i
      LEFT JOIN (SELECT invoice_id, sum(amount) v FROM invoice_payments GROUP BY 1) l ON l.invoice_id = i.id
      LEFT JOIN (SELECT a.invoice_id, sum(a.amount) v FROM payment_allocations a LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id WHERE a.payment_id IS NOT NULL AND r.id IS NULL GROUP BY 1) s ON s.invoice_id = i.id
     WHERE coalesce(i.paid_amount,0) <> coalesce(l.v,0) + coalesce(s.v,0)`));
  // AP-2: the GL deposit is the NET contract liability — the subledger's cash-on-account
  // MINUS the VAT declared by issued advance tax invoices (386) not yet adjusted by an
  // issued final invoice (E2 moved it to VAT_OUTPUT; E3 released the net part).
  // 2026-09-22: the deposit side is THREE liabilities (customerCreditPolicy.ts) — the GL sum over
  // CUSTOMER_DEPOSITS + UNIDENTIFIED_RECEIPTS + SECURITY_DEPOSITS_HELD reconciles to the subledger;
  // reclassifications move between them and net to zero here.
  fail("deposits_gl_vs_subledger — by customer, over the three deposit liabilities (RULE-O: reversed opening deposits out; AP-2: net of open advance-invoice VAT)", await q(`
    WITH gl AS (SELECT e.organization_id AS org, l.customer_id, sum(l.credit_amount - l.debit_amount) v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id WHERE c.system_code IN ('CUSTOMER_DEPOSITS','UNIDENTIFIED_RECEIPTS','SECURITY_DEPOSITS_HELD') AND e.status IN ('posted','reversed') GROUP BY 1,2),
         adv AS (SELECT i.organization_id AS org, i.customer_id,
                        sum(i.vat_amount::numeric) - coalesce(sum((SELECT coalesce(sum(x.tax_amount), 0) FROM invoice_prepayments x WHERE x.advance_invoice_id = i.id AND x.allocation_id IS NOT NULL)), 0)
                                                   - coalesce(sum((SELECT coalesce(sum(n.vat_amount::numeric), 0) FROM invoices n WHERE n.original_invoice_id = i.id AND n.document_type = 'advance_credit_note' AND n.invoice_hash IS NOT NULL)), 0) v
                   FROM invoices i WHERE i.document_type = 'advance_invoice' AND i.invoice_hash IS NOT NULL AND i.customer_id IS NOT NULL GROUP BY 1,2),
         sub AS (SELECT p.organization_id AS org, p.customer_id,
                        sum(p.amount) - coalesce((SELECT sum(a.amount) FROM payment_allocations a JOIN payments qq ON qq.id = a.payment_id LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id WHERE qq.customer_id = p.customer_id AND qq.organization_id = p.organization_id AND r.id IS NULL), 0)
                                    - coalesce((SELECT sum(f.amount) FROM customer_refunds f WHERE f.customer_id = p.customer_id AND f.organization_id = p.organization_id AND f.origin = 'deposit'), 0)
                                    - coalesce((SELECT v FROM adv WHERE adv.org = p.organization_id AND adv.customer_id = p.customer_id), 0) v
                   FROM payments p WHERE p.direction = 'in' AND ${PAYMENT_NOT_REVERSED_TEXT("p")} GROUP BY 1,2)
    SELECT coalesce(gl.org, sub.org)::text AS org, coalesce(gl.customer_id, sub.customer_id) AS customer_id, coalesce(gl.v,0)::text AS gl, coalesce(sub.v,0)::text AS subledger
      FROM gl FULL JOIN sub ON sub.org = gl.org AND sub.customer_id = gl.customer_id WHERE coalesce(gl.v,0) <> coalesce(sub.v,0)`));
  fail("credits_gl_vs_subledger — by customer", await q(`
    WITH gl AS (SELECT e.organization_id AS org, l.customer_id, sum(l.credit_amount - l.debit_amount) v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id WHERE c.system_code = 'CUSTOMER_CREDITS' AND e.status IN ('posted','reversed') GROUP BY 1,2),
         sub AS (SELECT n.organization_id AS org, n.customer_id,
                        sum(n.total::numeric) - coalesce(sum((SELECT sum(a.amount) FROM payment_allocations a LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id WHERE a.credit_note_id = n.id AND r.id IS NULL)), 0)
                                              - coalesce(sum((SELECT sum(f.amount) FROM customer_refunds f WHERE f.credit_note_id = n.id)), 0) v
                   FROM invoices n WHERE n.document_type = 'credit_note' AND n.invoice_hash IS NOT NULL AND n.customer_id IS NOT NULL GROUP BY 1,2)
    SELECT coalesce(gl.org, sub.org)::text AS org, coalesce(gl.customer_id, sub.customer_id) AS customer_id, coalesce(gl.v,0)::text AS gl, coalesce(sub.v,0)::text AS subledger
      FROM gl FULL JOIN sub ON sub.org = gl.org AND sub.customer_id = gl.customer_id WHERE coalesce(gl.v,0) <> coalesce(sub.v,0)`));
  fail("statement_match_one_to_one — a row or a target with two active matches", await q(`
    SELECT organization_id::text AS org, 'row' AS kind, transaction_id AS id, count(*)::int AS n FROM statement_matches m WHERE NOT EXISTS (SELECT 1 FROM statement_match_reversals r WHERE r.match_id = m.id) GROUP BY 1,2,3 HAVING count(*) > 1
    UNION ALL
    SELECT organization_id::text, 'payment', payment_id, count(*)::int FROM statement_matches m WHERE payment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM statement_match_reversals r WHERE r.match_id = m.id) GROUP BY 1,2,3 HAVING count(*) > 1
    UNION ALL
    SELECT organization_id::text, 'refund', refund_id, count(*)::int FROM statement_matches m WHERE refund_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM statement_match_reversals r WHERE r.match_id = m.id) GROUP BY 1,2,3 HAVING count(*) > 1`));

  // ── AR by customer, under the two stated rules ────────────────────────
  const ruleJ = await q(`
    SELECT i.organization_id::text AS org, count(*)::int AS invoices, sum(i.total::numeric - coalesce(i.paid_amount,0) - i.credited_amount - i.written_off_amount)::text AS outstanding
      FROM invoices i WHERE i.document_type = 'invoice' AND i.invoice_hash IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.company_id = i.company_id AND e.entry_number = 'GL-' || i.invoice_number)
     GROUP BY 1`);
  report["RULE-J invoices without an issue journal (outside the GL; excluded from AR reconciliation)"] = ruleJ;
  console.log(`ℹ RULE-J invoices without an issue journal: ${ruleJ.length === 0 ? "none" : JSON.stringify(ruleJ)}`);
  const ruleP = await q(`
    SELECT e.organization_id::text AS org, c.system_code, count(*)::int AS lines, sum(l.debit_amount - l.credit_amount)::text AS net
      FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
     WHERE c.system_code IN ('AR','AP') AND e.status IN ('posted','reversed') AND l.customer_id IS NULL AND l.vendor_id IS NULL
     GROUP BY 1,2`);
  report["RULE-P party-less control-account lines (pre-N3; excluded from by-party reconciliation)"] = ruleP;
  console.log(`ℹ RULE-P party-less AR/AP lines: ${ruleP.length === 0 ? "none" : JSON.stringify(ruleP)}`);

  // Covered set: invoices WITH an issue journal whose AR issue line carries the customer —
  // plus (RULE-O) LIVE opening items, covered through the opening journal's AR party line.
  fail("ar_gl_vs_subledger_by_customer — over invoices with a party-carrying issue journal (RULE-J, RULE-P excluded; RULE-O: live opening items in, reversed out)", await q(`
    WITH covered AS (
      SELECT i.* FROM invoices i
       WHERE i.document_type = 'invoice' AND i.customer_id IS NOT NULL AND ${INVOICE_NOT_REVERSED_TEXT("i")}
         AND ( (i.invoice_hash IS NOT NULL
                AND EXISTS (SELECT 1 FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
                             WHERE e.company_id = i.company_id AND e.entry_number = 'GL-' || i.invoice_number AND c.system_code = 'AR' AND l.customer_id = i.customer_id))
            OR (i.is_opening
                AND EXISTS (SELECT 1 FROM migration_open_items o JOIN journal_entries e ON e.migration_batch_id = o.batch_id AND e.source = 'opening'
                             JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
                             WHERE o.resolved_invoice_id = i.id AND c.system_code = 'AR' AND l.customer_id = i.customer_id))
            -- 2026-09-22: a replacement made by an item-level CORRECTION (A4 + answer 5) is covered through its reversed original's opening line plus the correction entry's AR line
            OR (i.is_opening AND i.replaces_invoice_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM invoices o JOIN journal_entries e ON e.id = o.opening_correction_journal_entry_id AND e.source = 'opening_correction'
                             JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
                             WHERE o.id = i.replaces_invoice_id AND c.system_code = 'AR' AND l.customer_id = i.customer_id)) )),
    sub AS (SELECT organization_id AS org, customer_id, sum(total::numeric - coalesce(paid_amount,0) - credited_amount - written_off_amount) v FROM covered GROUP BY 1,2),
    gl AS (SELECT e.organization_id AS org, l.customer_id, sum(l.debit_amount - l.credit_amount) v
             FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
            WHERE c.system_code = 'AR' AND e.status IN ('posted','reversed') AND l.customer_id IS NOT NULL
              AND l.customer_id IN (SELECT customer_id FROM covered) GROUP BY 1,2)
    SELECT coalesce(gl.org, sub.org)::text AS org, coalesce(gl.customer_id, sub.customer_id) AS customer_id, coalesce(gl.v,0)::text AS gl, coalesce(sub.v,0)::text AS subledger
      FROM gl FULL JOIN sub ON sub.org = gl.org AND sub.customer_id = gl.customer_id WHERE coalesce(gl.v,0) <> coalesce(sub.v,0)`));
  fail("ap_gl_vs_subledger_by_vendor — over bills with a party-carrying issue journal (RULE-J, RULE-P excluded; RULE-O: live opening items in, reversed out)", await q(`
    WITH covered AS (
      SELECT b.* FROM bills b
       WHERE b.status NOT IN ('draft','submitted','rejected') AND b.vendor_id IS NOT NULL AND ${BILL_NOT_REVERSED_TEXT("b")}
         AND ( EXISTS (SELECT 1 FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
                        WHERE e.company_id = b.company_id AND e.entry_number = 'BILL-' || b.bill_number AND c.system_code = 'AP' AND l.vendor_id = b.vendor_id)
            OR (b.is_opening
                AND EXISTS (SELECT 1 FROM migration_open_items o JOIN journal_entries e ON e.migration_batch_id = o.batch_id AND e.source = 'opening'
                             JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
                             WHERE o.resolved_bill_id = b.id AND c.system_code = 'AP' AND l.vendor_id = b.vendor_id))
            OR (b.is_opening AND b.replaces_bill_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM bills o JOIN journal_entries e ON e.id = o.opening_correction_journal_entry_id AND e.source = 'opening_correction'
                             JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
                             WHERE o.id = b.replaces_bill_id AND c.system_code = 'AP' AND l.vendor_id = b.vendor_id)) )),
    sub AS (SELECT organization_id AS org, vendor_id, sum(total::numeric - coalesce(paid_amount,0)) v FROM covered GROUP BY 1,2),
    gl AS (SELECT e.organization_id AS org, l.vendor_id, sum(l.credit_amount - l.debit_amount) v
             FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
            WHERE c.system_code = 'AP' AND e.status IN ('posted','reversed') AND l.vendor_id IS NOT NULL
              AND l.vendor_id IN (SELECT vendor_id FROM covered) GROUP BY 1,2)
    SELECT coalesce(gl.org, sub.org)::text AS org, coalesce(gl.vendor_id, sub.vendor_id) AS vendor_id, coalesce(gl.v,0)::text AS gl, coalesce(sub.v,0)::text AS subledger
      FROM gl FULL JOIN sub ON sub.org = gl.org AND sub.vendor_id = gl.vendor_id WHERE coalesce(gl.v,0) <> coalesce(sub.v,0)`));

  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  await pool.end();
  if (failures > 0) {
    console.log(`\n${failures} invariant(s) violated.`);
    process.exit(2);
  }
  console.log("\nall invariants hold (RULE-J / RULE-P residuals listed above are excluded by rule, not by name).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
