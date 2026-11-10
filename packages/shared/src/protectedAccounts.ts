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
 *
 * 🔴 ROUTE-AWARE (register §11.77): a bank line is the PAY or SETTLEMENT path of
 * three of these — a salary line pays the run (Dr payable / Cr bank, DR-41), a
 * GOSI line pays GOSI, a VAT remittance line settles the return (the
 * categoriser's own "VAT remittance" rule). Those three stay open to the bank
 * line (`bankLineSettles`) and close to the manual journal and recognition.
 */
export const PROTECTED_SYSTEM_ACCOUNTS = {
  RETAINED_EARNINGS: { writtenByAr: "تصحيح مصنَّف (قيد يدوي يذكر نوعه وفق معيار المحاسبة الدولي 8: خطأ، أو تقدير، أو سياسة)", writtenBy: "a classified correction (a manual journal stating its IAS 8 kind: error, estimate or policy)", classifiableCorrection: true, bankLineSettles: false },
  SALARIES_PAYABLE: { writtenByAr: "مسيّر الرواتب، وحركة البنك للرواتب التي تسدده", writtenBy: "a payroll run, and the salary bank line that pays it", classifiableCorrection: false, bankLineSettles: true },
  GOSI_PAYABLE: { writtenByAr: "مسيّر الرواتب، وحركة البنك للتأمينات الاجتماعية التي تسدده", writtenBy: "a payroll run, and the GOSI bank line that pays it", classifiableCorrection: false, bankLineSettles: true },
  VAT_INPUT: { writtenByAr: "فاتورة المورد، أو المصروف، أو إشعار المورد، أو مطالبة الإثبات، أو تسوية إقرار ضريبة القيمة المضافة", writtenBy: "a bill, an expense, a supplier note, the evidence claim and the VAT return's filing", classifiableCorrection: false, bankLineSettles: false },
  VAT_OUTPUT: { writtenByAr: "الفاتورة، أو الإشعار الدائن أو المدين، أو تسوية إقرار ضريبة القيمة المضافة", writtenBy: "an invoice, a credit or debit note and the VAT return's filing", classifiableCorrection: false, bankLineSettles: false },
  VAT_AWAITING_EVIDENCE: { writtenByAr: "فاتورة المورد التي تنتظر إثباتها، ومطالبة الإثبات", writtenBy: "a bill awaiting its evidence and the evidence claim", classifiableCorrection: false, bankLineSettles: false },
  VAT_PAYMENT: { writtenByAr: "تسوية إقرار ضريبة القيمة المضافة، وحركة البنك لسداد الضريبة التي تسويها", writtenBy: "the VAT return's filing, and the remittance bank line that settles it", classifiableCorrection: false, bankLineSettles: true },
} as const;

export type ProtectedSystemAccount = keyof typeof PROTECTED_SYSTEM_ACCOUNTS;

/** The rule for a system code, or null when the code is not protected (a plain account, or no code at all). */
export function protectedAccountRule(systemCode: string | null | undefined): { code: ProtectedSystemAccount; writtenBy: string; writtenByAr: string; classifiableCorrection: boolean; bankLineSettles: boolean } | null {
  if (!systemCode || !(systemCode in PROTECTED_SYSTEM_ACCOUNTS)) return null;
  const code = systemCode as ProtectedSystemAccount;
  return { code, ...PROTECTED_SYSTEM_ACCOUNTS[code] };
}
