/**
 * 🔴 Phase 18 G2b — OWNER DECISION A5(c) (2026-10-27): "filing a VAT return is
 * recorded by an entry clearing output VAT and input VAT to VAT payable (or
 * receivable)". DECIDED 2026-10-27: an owner decision based on research, not a
 * professional opinion; reversible; to be reviewed before go-live. The master
 * plan's DR-38: "record filing; the settlement entry".
 *
 * ONE entry, dated the FILING date (the act's own day; the period lock of that
 * day applies, and the filing is refused with it), source `vat_return_filing`:
 *  · each of VAT_OUTPUT and VAT_INPUT is cleared of its movement in the
 *    return's period — entries dated in the period, in the books — less what
 *    earlier filings of the SAME period already cleared (an amendment clears
 *    only what the period gained since);
 *  · the net goes to VAT_PAYMENT, the seeded liability a VAT remittance bank
 *    line is categorised to: credited when payable, debited when receivable.
 * Nothing to clear posts nothing. NOT cleared: VAT_AWAITING_EVIDENCE (held
 * VAT is on no return) and the VAT_ADJ_* accounts (A5(c) names output and
 * input VAT only — an open question for the adviser).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { BusinessRuleError } from "../../lib/errors";
import { round2 } from "../../lib/money";
import { categoriesRepository } from "../../repositories/categories.repository";
import { postJournalEntry, type GLLine } from "./glPosting";

const currentCompany = sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`;
const nextMonthStart = (month: string) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
};

/** Debit − credit on VAT_OUTPUT and VAT_INPUT still uncleared for the period: its own entries, plus earlier clearings of it. */
async function unclearedBalances(periodFrom: string, periodTo: string): Promise<{ output: number; input: number }> {
  const { rows } = await db.execute<{ code: string; balance: string }>(sql`
    SELECT c.system_code AS code, coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS balance
      FROM journal_entry_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id
      JOIN categories c ON c.id = l.account_id
     WHERE e.company_id = ${currentCompany} AND e.status IN ('posted', 'reversed')
       AND c.system_code IN ('VAT_OUTPUT', 'VAT_INPUT')
       AND (
         (coalesce(e.source_type, '') <> 'vat_return_filing' AND e.date >= ${`${periodFrom}-01`} AND e.date < ${nextMonthStart(periodTo)})
         OR (e.source_type = 'vat_return_filing' AND e.source_id IN (
               SELECT f.id FROM vat_return_filings f
                WHERE f.company_id = ${currentCompany} AND f.period_from = ${periodFrom} AND f.period_to = ${periodTo}))
       )
     GROUP BY c.system_code`);
  const of = (code: string) => round2(Number(rows.find((r) => r.code === code)?.balance ?? 0));
  return { output: of("VAT_OUTPUT"), input: of("VAT_INPUT") };
}

export async function postVatFilingClearing(filing: { id: number; periodFrom: string; periodTo: string; filedOn: string; zatcaReference: string }) {
  const { output, input } = await unclearedBalances(filing.periodFrom, filing.periodTo);
  if (output === 0 && input === 0) return null;
  const settlement = await categoriesRepository.findBySystemCode("VAT_PAYMENT");
  if (!settlement) {
    throw new BusinessRuleError(422, { code: "vat_payment_account_missing", error: "This company's chart has no VAT payable account (VAT_PAYMENT) to clear the filed return to." });
  }
  const label = `VAT return ${filing.periodFrom === filing.periodTo ? filing.periodFrom : `${filing.periodFrom}–${filing.periodTo}`} filed (${filing.zatcaReference})`;
  // A balance b (debit − credit) is cleared by a line of −b: a credit balance is debited, a debit balance credited.
  const clear = (b: number) => (b < 0 ? { debitAmount: -b, creditAmount: 0 } : { debitAmount: 0, creditAmount: b });
  const lines: GLLine[] = [];
  if (output !== 0) lines.push({ systemCode: "VAT_OUTPUT", accountName: "VAT Payable", description: label, ...clear(output) });
  if (input !== 0) lines.push({ systemCode: "VAT_INPUT", accountName: "Input VAT Receivable", description: label, ...clear(input) });
  const net = round2(output + input); // what the VAT lines leave: < 0 payable, > 0 receivable
  if (net !== 0) lines.push({ accountId: settlement.id, accountName: settlement.name, description: label, ...(net < 0 ? { debitAmount: 0, creditAmount: -net } : { debitAmount: net, creditAmount: 0 }) });
  const je = await postJournalEntry({
    sourceType: "vat_return_filing", sourceId: filing.id,
    entryNumber: `VATFILE-${filing.zatcaReference}`,
    date: filing.filedOn,
    description: label,
    reference: filing.zatcaReference,
    lines,
  });
  return { entryId: je.id, entryNumber: je.entryNumber, outputVat: round2(-output), inputVat: input, net: round2(-net) };
}
