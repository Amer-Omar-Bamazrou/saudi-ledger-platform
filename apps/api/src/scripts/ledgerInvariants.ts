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
import { BILL_AP_CONTRIBUTION_TEXT } from "../repositories/billPosition";
import { SUPPLIER_ON_ACCOUNT_ASSET, SUPPLIER_ON_ACCOUNT_CODES } from "../services/accounting/supplierCreditPolicy";

/**
 * Phase 11 Part 2: the classification → asset account map as SQL, generated
 * from the ONE map the posting path uses (supplierCreditPolicy) — never a
 * second CASE typed out here that could drift from it.
 */
const SUPPLIER_ASSET_CASE = (col: string) =>
  `(CASE ${col} ${Object.entries(SUPPLIER_ON_ACCOUNT_ASSET).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(" ")} END)`;
const SUPPLIER_ASSET_CODES_SQL = SUPPLIER_ON_ACCOUNT_CODES.map((c) => `'${c}'`).join(", ");

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
  // FA-A (2026-09-22): the register and the ledger are ONE set of rows. A posted schedule row IS its entry: the entry exists, is in the books, debits the category's expense account and credits its accumulated account by the row's amount and nothing else.
  fail("asset_schedule_entry_shape — a posted depreciation row whose entry is missing, out of the books, or not Dr <category expense> / Cr <category accumulated> for the row's amount", await q(`
    SELECT s.organization_id::text AS org, s.asset_id, s.period, s.journal_entry_id
      FROM asset_depreciation_schedule s JOIN fixed_assets a ON a.id = s.asset_id JOIN asset_categories k ON k.id = a.category_id
     WHERE s.journal_entry_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = s.journal_entry_id AND e.status IN ('posted','reversed')
                          AND (SELECT count(*) FROM journal_entry_lines l WHERE l.journal_entry_id = e.id) = 2
                          AND EXISTS (SELECT 1 FROM journal_entry_lines l WHERE l.journal_entry_id = e.id AND l.account_id = k.depreciation_expense_account_id AND l.debit_amount = s.amount AND l.credit_amount = 0)
                          AND EXISTS (SELECT 1 FROM journal_entry_lines l WHERE l.journal_entry_id = e.id AND l.account_id = k.accumulated_depreciation_account_id AND l.credit_amount = s.amount AND l.debit_amount = 0))`));
  // FA-A: an asset in the books carries its capitalisation entry, and every asset that ever existed carries its audit spine.
  fail("asset_state_evidence — an asset in service or disposed without a posted capitalisation entry, or any asset without a 'created' event", await q(`
    SELECT a.organization_id::text AS org, a.id, a.asset_number, a.status FROM fixed_assets a
     WHERE (a.status IN ('in_service','disposed') AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = a.capitalisation_journal_entry_id AND e.status IN ('posted','reversed')))
        OR NOT EXISTS (SELECT 1 FROM asset_events v WHERE v.asset_id = a.id AND v.kind = 'created')`));
  // FA-C (2026-09-22): a disposal derecognises the asset WHOLE — its entry credits the cost account by the cost and debits the accumulated account by what was posted; and no depreciation is ever posted after the disposal date (IAS 16.55).
  fail("asset_disposal_shape — a disposal whose entry does not remove the cost and the accumulated depreciation it states, or an asset disposed without the record", await q(`
    SELECT d.organization_id::text AS org, d.asset_id, d.date::text AS date
      FROM asset_disposals d JOIN fixed_assets a ON a.id = d.asset_id JOIN asset_categories k ON k.id = a.category_id
     WHERE NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = d.journal_entry_id AND e.status IN ('posted','reversed')
                          AND EXISTS (SELECT 1 FROM journal_entry_lines l WHERE l.journal_entry_id = e.id AND l.account_id = k.cost_account_id AND l.credit_amount = a.cost)
                          AND (d.accumulated_at_disposal = 0 OR EXISTS (SELECT 1 FROM journal_entry_lines l WHERE l.journal_entry_id = e.id AND l.account_id = k.accumulated_depreciation_account_id AND l.debit_amount = d.accumulated_at_disposal)))
    UNION ALL
    SELECT a.organization_id::text, a.id, a.disposal_date::text FROM fixed_assets a
     WHERE a.status = 'disposed' AND NOT EXISTS (SELECT 1 FROM asset_disposals d WHERE d.asset_id = a.id)`));
  fail("asset_no_depreciation_after_disposal — a posted schedule row later than the disposal month (IAS 16.55)", await q(`
    SELECT s.organization_id::text AS org, s.asset_id, s.period, d.date::text AS disposed_on
      FROM asset_depreciation_schedule s JOIN asset_disposals d ON d.asset_id = s.asset_id
     WHERE s.journal_entry_id IS NOT NULL AND s.period > to_char(d.date, 'YYYY-MM')`));
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
                        WHERE e.company_id = b.company_id AND e.entry_number IN ('BILL-' || b.bill_number, 'BILLCN-' || b.bill_number) AND c.system_code = 'AP' AND l.vendor_id = b.vendor_id)
            OR (b.is_opening
                AND EXISTS (SELECT 1 FROM migration_open_items o JOIN journal_entries e ON e.migration_batch_id = o.batch_id AND e.source = 'opening'
                             JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
                             WHERE o.resolved_bill_id = b.id AND c.system_code = 'AP' AND l.vendor_id = b.vendor_id))
            OR (b.is_opening AND b.replaces_bill_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM bills o JOIN journal_entries e ON e.id = o.opening_correction_journal_entry_id AND e.source = 'opening_correction'
                             JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
                             WHERE o.id = b.replaces_bill_id AND c.system_code = 'AP' AND l.vendor_id = b.vendor_id)) )),
    -- Phase 11 Part 2: each document's contribution to AP is billPosition's
    -- definition — a CREDIT note (issue journal BILLCN-) is a debit to AP, and
    -- money applied through the AP subledger (a payment or an applied advance)
    -- settled the bill as surely as paid_amount. A credit-note APPLICATION
    -- moves no GL line, so it is not subtracted here.
    sub AS (SELECT organization_id AS org, vendor_id, sum(${BILL_AP_CONTRIBUTION_TEXT("covered")}) v FROM covered GROUP BY 1,2),
    gl AS (SELECT e.organization_id AS org, l.vendor_id, sum(l.credit_amount - l.debit_amount) v
             FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
            WHERE c.system_code = 'AP' AND e.status IN ('posted','reversed') AND l.vendor_id IS NOT NULL
              AND l.vendor_id IN (SELECT vendor_id FROM covered) GROUP BY 1,2)
    SELECT coalesce(gl.org, sub.org)::text AS org, coalesce(gl.vendor_id, sub.vendor_id) AS vendor_id, coalesce(gl.v,0)::text AS gl, coalesce(sub.v,0)::text AS subledger
      FROM gl FULL JOIN sub ON sub.org = gl.org AND sub.vendor_id = gl.vendor_id WHERE coalesce(gl.v,0) <> coalesce(sub.v,0)`));

  // Phase 11 Part 2 (B4/B5): money a supplier HOLDS — per vendor and per
  // on-account asset, the subledger (payments less live allocations less
  // refunds, by CURRENT classification) against the GL. A reclassification
  // moves the balance with one entry, so the current classification is the
  // one the GL must show.
  fail("ap_on_account_gl_vs_subledger — by vendor, over SUPPLIER_ADVANCES / SECURITY_DEPOSITS_PAID / UNIDENTIFIED_PAYMENTS", await q(`
    WITH sub AS (
      SELECT p.organization_id AS org, p.vendor_id, ${SUPPLIER_ASSET_CASE("p.classification")} AS code,
             sum(p.amount::numeric
                 - coalesce((SELECT sum(a.amount::numeric) FROM supplier_payment_allocations a
                              WHERE a.supplier_payment_id = p.id
                                AND NOT EXISTS (SELECT 1 FROM supplier_payment_allocation_reversals r WHERE r.allocation_id = a.id)), 0)
                 - coalesce((SELECT sum(f.amount::numeric) FROM supplier_refunds f WHERE f.supplier_payment_id = p.id), 0)
                 -- Z-AP1: the VAT the supplier's advance invoice CLAIMED has left the
                 -- advance for Input VAT; what is still open (not credited, not yet
                 -- deducted by a final bill) is off the asset in the GL.
                 - coalesce((SELECT sum(ai.vat_amount::numeric
                                        - coalesce((SELECT sum(n.vat_amount::numeric) FROM bills n
                                                     WHERE n.credit_note_against_bill_id = ai.id AND n.document_type = 'advance_credit_note'
                                                       AND n.status NOT IN ('draft','submitted')), 0)
                                        - coalesce((SELECT sum(bp.tax_amount::numeric) FROM bill_prepayments bp
                                                     WHERE bp.advance_bill_id = ai.id AND bp.allocation_id IS NOT NULL), 0))
                               FROM bills ai WHERE ai.advance_supplier_payment_id = p.id AND ai.document_type = 'advance_invoice'
                                AND ai.status NOT IN ('draft','submitted')), 0)) AS v
        FROM supplier_payments p GROUP BY 1,2,3),
    gl AS (SELECT e.organization_id AS org, l.vendor_id, c.system_code AS code, sum(l.debit_amount - l.credit_amount) v
             FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
            WHERE c.system_code IN (${SUPPLIER_ASSET_CODES_SQL}) AND e.status IN ('posted','reversed') GROUP BY 1,2,3)
    SELECT coalesce(gl.org, sub.org)::text AS org, coalesce(gl.vendor_id, sub.vendor_id) AS vendor_id, coalesce(gl.code, sub.code) AS account,
           coalesce(gl.v,0)::text AS gl, coalesce(sub.v,0)::text AS subledger
      FROM gl FULL JOIN sub ON sub.org = gl.org AND sub.vendor_id IS NOT DISTINCT FROM gl.vendor_id AND sub.code = gl.code
     WHERE coalesce(gl.v,0) <> coalesce(sub.v,0)`));

  // Z-AP1: the input VAT of a supplier's advance tax invoice is claimed ONCE —
  // what final bills deduct plus what credit notes reverse can never exceed
  // what the advance invoice claimed (in VAT or in total).
  fail("advance_invoice_vat_overused — a supplier advance invoice whose VAT (or amount) has been deducted by final bills and credited by notes beyond what it claimed", await q(`
    SELECT ai.organization_id::text AS org, ai.id AS advance_bill_id, ai.vat_amount::text AS claimed,
           (coalesce(adj.tax, 0) + coalesce(cr.tax, 0))::text AS used_tax, ai.total::text AS total, (coalesce(adj.total, 0) + coalesce(cr.total, 0))::text AS used_total
      FROM bills ai
      LEFT JOIN LATERAL (SELECT sum(bp.tax_amount::numeric) tax, sum(bp.amount::numeric) total FROM bill_prepayments bp
                          WHERE bp.advance_bill_id = ai.id AND bp.allocation_id IS NOT NULL) adj ON true
      LEFT JOIN LATERAL (SELECT sum(n.vat_amount::numeric) tax, sum(n.total::numeric) total FROM bills n
                          WHERE n.credit_note_against_bill_id = ai.id AND n.document_type = 'advance_credit_note'
                            AND n.status NOT IN ('draft','submitted')) cr ON true
     WHERE ai.document_type = 'advance_invoice' AND ai.status NOT IN ('draft','submitted')
       AND (coalesce(adj.tax, 0) + coalesce(cr.tax, 0) > ai.vat_amount::numeric + 0.005
            OR coalesce(adj.total, 0) + coalesce(cr.total, 0) > ai.total::numeric + 0.005)`));

  // ── Phase 12B: bank reconciliation, over the ONE view ─────────────────
  // A statement line is the bank's evidence of ONE movement. These read
  // bank_line_reconciliation — every source — and name what no trigger can
  // repair after the fact.
  fail("bank_line_reconciled_twice — a statement line that posted its OWN entry and is ALSO matched or linked (the same money in the ledger twice)", await q(`
    SELECT r.organization_id::text AS org, r.transaction_id, string_agg(DISTINCT r.source, ',') AS sources
      FROM bank_line_reconciliation r
     GROUP BY r.organization_id, r.transaction_id
    HAVING bool_or(r.source = 'posted') AND bool_or(r.source <> 'posted')`));
  fail("bank_line_over_reconciled — a statement line reconciled beyond its amount", await q(`
    SELECT t.organization_id::text AS org, t.id AS transaction_id, abs(t.amount)::text AS amount, sum(r.amount)::text AS reconciled
      FROM transactions t JOIN bank_line_reconciliation r ON r.transaction_id = t.id
     GROUP BY t.organization_id, t.id, t.amount HAVING sum(r.amount) > abs(t.amount) + 0.005`));
  fail("cash_line_over_reconciled — a ledger cash line answered by statement lines beyond its own amount", await q(`
    SELECT v.organization_id::text AS org, v.line_id, abs(v.debit_amount - v.credit_amount)::text AS amount, sum(r.amount)::text AS reconciled
      FROM journal_line_bank_identity v JOIN bank_line_reconciliation r ON r.line_id = v.line_id
     GROUP BY v.organization_id, v.line_id, v.debit_amount, v.credit_amount
    HAVING sum(r.amount) > abs(v.debit_amount - v.credit_amount) + 0.005`));
  fail("matched_line_not_reconciled — a statement line marked `matched` (it posts nothing) that the view no longer fully reconciles: its money is in no ledger", await q(`
    SELECT t.organization_id::text AS org, t.id AS transaction_id, abs(t.amount)::text AS amount,
           coalesce((SELECT sum(r.amount) FROM bank_line_reconciliation r WHERE r.transaction_id = t.id), 0)::text AS reconciled
      FROM transactions t
     WHERE t.kind = 'matched'
       AND coalesce((SELECT sum(r.amount) FROM bank_line_reconciliation r WHERE r.transaction_id = t.id), 0) < abs(t.amount) - 0.005`));

  // Phase 12C — a transfer and its entry must agree: a live transfer on a
  // reversed entry (reversed behind the document) or a reversal row whose
  // entry is still live both make the document lie about the books.
  fail("bank_transfer_reversal_mismatch — a transfer whose entry's reversal and the transfer's own reversal record disagree", await q(`
    SELECT bt.organization_id::text AS org, bt.id AS transfer_id, e.status, (r.id IS NOT NULL) AS has_reversal_record
      FROM bank_transfers bt JOIN journal_entries e ON e.id = bt.journal_entry_id
      LEFT JOIN bank_transfer_reversals r ON r.transfer_id = bt.id
     WHERE (e.status = 'reversed') <> (r.id IS NOT NULL)`));

  // Phase 12D — a completed reconciliation that still stands must still be
  // TRUE: the bank's ledger at its date equals what it recorded. The lock
  // triggers keep this so; a violation means something wrote past them.
  fail("bank_reconciliation_moved — a completed, unreopened reconciliation whose bank ledger at its date no longer equals the recorded ledger balance", await q(`
    SELECT r.organization_id::text AS org, r.id AS reconciliation_id, r.as_of::text, r.ledger_balance::text AS recorded,
           coalesce((SELECT sum(v.debit_amount - v.credit_amount) FROM journal_line_bank_identity v
                       JOIN journal_entries e ON e.id = v.journal_entry_id
                      WHERE v.bank_account_id = r.bank_account_id AND e.status IN ('posted','reversed') AND e.date::date <= r.as_of), 0)::text AS now
      FROM bank_reconciliations r
     WHERE NOT EXISTS (SELECT 1 FROM bank_reconciliation_reopenings o WHERE o.reconciliation_id = r.id)
       AND abs(r.ledger_balance - coalesce((SELECT sum(v.debit_amount - v.credit_amount) FROM journal_line_bank_identity v
                       JOIN journal_entries e ON e.id = v.journal_entry_id
                      WHERE v.bank_account_id = r.bank_account_id AND e.status IN ('posted','reversed') AND e.date::date <= r.as_of), 0)) > 0.005`));

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
