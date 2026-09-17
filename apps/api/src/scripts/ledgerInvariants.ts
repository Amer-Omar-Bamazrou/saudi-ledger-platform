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
 *
 * Everything else must hold exactly. The "default" dev org's known condition
 * (known-issues file, "THE DEFAULT-ORG AR/AP DIVERGENCE") is RULE-J + RULE-P
 * data and shows up here under those rules, by construction.
 */
import { writeFileSync } from "node:fs";
import { pool } from "@workspace/db";

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
  fail("invoice_outstanding_nonnegative — issued invoices with total − paid − credited < 0", await q(`
    SELECT organization_id::text AS org, id, invoice_number, (total::numeric - coalesce(paid_amount,0) - credited_amount)::text AS outstanding
      FROM invoices WHERE document_type = 'invoice' AND invoice_hash IS NOT NULL AND total::numeric - coalesce(paid_amount,0) - credited_amount < -0.001`));
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
  fail("deposits_gl_vs_subledger — by customer", await q(`
    WITH gl AS (SELECT e.organization_id AS org, l.customer_id, sum(l.credit_amount - l.debit_amount) v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id WHERE c.system_code = 'CUSTOMER_DEPOSITS' AND e.status IN ('posted','reversed') GROUP BY 1,2),
         sub AS (SELECT p.organization_id AS org, p.customer_id,
                        sum(p.amount) - coalesce((SELECT sum(a.amount) FROM payment_allocations a JOIN payments qq ON qq.id = a.payment_id LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id WHERE qq.customer_id = p.customer_id AND qq.organization_id = p.organization_id AND r.id IS NULL), 0)
                                    - coalesce((SELECT sum(f.amount) FROM customer_refunds f WHERE f.customer_id = p.customer_id AND f.organization_id = p.organization_id AND f.origin = 'deposit'), 0) v
                   FROM payments p WHERE p.direction = 'in' GROUP BY 1,2)
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
    SELECT i.organization_id::text AS org, count(*)::int AS invoices, sum(i.total::numeric - coalesce(i.paid_amount,0) - i.credited_amount)::text AS outstanding
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

  // Covered set: invoices WITH an issue journal whose AR issue line carries the customer.
  fail("ar_gl_vs_subledger_by_customer — over invoices with a party-carrying issue journal (RULE-J, RULE-P excluded)", await q(`
    WITH covered AS (
      SELECT i.* FROM invoices i
       WHERE i.document_type = 'invoice' AND i.invoice_hash IS NOT NULL AND i.customer_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
                      WHERE e.company_id = i.company_id AND e.entry_number = 'GL-' || i.invoice_number AND c.system_code = 'AR' AND l.customer_id = i.customer_id)),
    sub AS (SELECT organization_id AS org, customer_id, sum(total::numeric - coalesce(paid_amount,0) - credited_amount) v FROM covered GROUP BY 1,2),
    gl AS (SELECT e.organization_id AS org, l.customer_id, sum(l.debit_amount - l.credit_amount) v
             FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
            WHERE c.system_code = 'AR' AND e.status IN ('posted','reversed') AND l.customer_id IS NOT NULL
              AND l.customer_id IN (SELECT customer_id FROM covered) GROUP BY 1,2)
    SELECT coalesce(gl.org, sub.org)::text AS org, coalesce(gl.customer_id, sub.customer_id) AS customer_id, coalesce(gl.v,0)::text AS gl, coalesce(sub.v,0)::text AS subledger
      FROM gl FULL JOIN sub ON sub.org = gl.org AND sub.customer_id = gl.customer_id WHERE coalesce(gl.v,0) <> coalesce(sub.v,0)`));
  fail("ap_gl_vs_subledger_by_vendor — over bills with a party-carrying issue journal (RULE-J, RULE-P excluded)", await q(`
    WITH covered AS (
      SELECT b.* FROM bills b
       WHERE b.status NOT IN ('draft','submitted','rejected') AND b.vendor_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
                      WHERE e.company_id = b.company_id AND e.entry_number = 'BILL-' || b.bill_number AND c.system_code = 'AP' AND l.vendor_id = b.vendor_id)),
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
