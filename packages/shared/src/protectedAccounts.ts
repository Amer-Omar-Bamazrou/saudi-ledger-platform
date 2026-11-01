/**
 * 🔴 Phase 18 H-19 — DR-33 (OD-11; register §11.75): THE ONE protected-account
 * list, read by the three free routes — the manual journal, the bank-line
 * categorisation and a recognition schedule — at each one's own write
 * boundary. Each code names the paths that may write it, so a refusal can say
 * where the account IS written. Owner decision 2026-10-27; the sequencing it
 * set is met: the payroll pay paths and the VAT filing's clearing exist.
 *
 * Retained earnings is the one entry a free route may still reach — through a
 * CLASSIFIED correction only (a manual journal carrying an IAS 8 kind).
 */
export const PROTECTED_SYSTEM_ACCOUNTS = {
  RETAINED_EARNINGS: { writtenBy: "a classified correction (a manual journal stating its IAS 8 kind: error, estimate or policy)", classifiableCorrection: true },
  SALARIES_PAYABLE: { writtenBy: "a payroll run and its pay path", classifiableCorrection: false },
  GOSI_PAYABLE: { writtenBy: "a payroll run and its GOSI payment", classifiableCorrection: false },
  VAT_INPUT: { writtenBy: "a bill, an expense, a supplier note, the evidence claim and the VAT return's filing", classifiableCorrection: false },
  VAT_OUTPUT: { writtenBy: "an invoice, a credit or debit note and the VAT return's filing", classifiableCorrection: false },
  VAT_AWAITING_EVIDENCE: { writtenBy: "a bill awaiting its evidence and the evidence claim", classifiableCorrection: false },
  VAT_PAYMENT: { writtenBy: "the VAT return's filing and its settlement", classifiableCorrection: false },
} as const;

export type ProtectedSystemAccount = keyof typeof PROTECTED_SYSTEM_ACCOUNTS;

/** The rule for a system code, or null when the code is not protected (a plain account, or no code at all). */
export function protectedAccountRule(systemCode: string | null | undefined): { code: ProtectedSystemAccount; writtenBy: string; classifiableCorrection: boolean } | null {
  if (!systemCode || !(systemCode in PROTECTED_SYSTEM_ACCOUNTS)) return null;
  const code = systemCode as ProtectedSystemAccount;
  return { code, ...PROTECTED_SYSTEM_ACCOUNTS[code] };
}
