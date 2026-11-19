/**
 * 🔴 A15 review (migration 0164): the words the unclassified-entries review uses for a journal entry's source, for the
 * rule that found a relationship, and for each check a relationship can fail — in English and Arabic.
 */
type T = (en: string, ar: string) => string;

/** What produced a journal entry (T1d's source tags, A15's three unsourced ones included). */
export function journalSourceLabel(type: string, t: T): string {
  const labels: Record<string, [string, string]> = {
    manual: ["Manual entry", "قيد يدوي"],
    recurring: ["Recurring entry", "قيد متكرر"],
    reversal: ["Reversal of an entry", "عكس قيد"],
    invoice: ["Invoice", "فاتورة"],
    invoice_correction: ["Invoice correction", "تصحيح فاتورة"],
    invoice_write_off: ["Invoice write-off", "شطب فاتورة"],
    credit_note_application: ["Credit note applied", "تطبيق إشعار دائن"],
    customer_payment: ["Customer receipt", "سند قبض من عميل"],
    customer_payment_allocation: ["Customer receipt allocated", "تخصيص سند قبض"],
    customer_allocation_correction: ["Customer allocation corrected", "تصحيح تخصيص لعميل"],
    customer_refund: ["Refund to a customer", "رد مبلغ لعميل"],
    customer_payment_reclassification: ["Customer receipt reclassified", "إعادة تصنيف سند قبض"],
    bill: ["Supplier bill", "فاتورة مورد"],
    bill_payment: ["Supplier bill paid", "سداد فاتورة مورد"],
    vat_evidence: ["Input VAT evidence", "إثبات ضريبة المدخلات"],
    supplier_payment: ["Payment to a supplier", "دفعة لمورد"],
    supplier_advance_allocation: ["Supplier advance allocated", "تخصيص دفعة مقدمة لمورد"],
    supplier_allocation_reversal: ["Supplier allocation reversed", "عكس تخصيص لمورد"],
    supplier_payment_reclassification: ["Supplier payment reclassified", "إعادة تصنيف دفعة مورد"],
    supplier_refund: ["Refund from a supplier", "استرداد من مورد"],
    bank_transfer: ["Transfer between accounts", "تحويل بين الحسابات"],
    bank_transaction: ["Bank statement line", "حركة كشف بنكي"],
    payroll_run: ["Payroll run", "مسير رواتب"],
    payroll_net_pay: ["Net pay paid", "سداد صافي الرواتب"],
    payroll_gosi_payment: ["GOSI contributions paid", "سداد اشتراكات التأمينات الاجتماعية"],
    depreciation: ["Depreciation", "إهلاك"],
    asset_disposal: ["Asset disposal", "استبعاد أصل"],
    recognition: ["Scheduled recognition", "إثبات مجدول"],
    tax_computation: ["Tax computation", "احتساب ضريبي"],
    wht_remittance: ["Withholding tax remitted", "توريد ضريبة الاستقطاع"],
    wht_remittance_reversal: ["Withholding remittance reversed", "عكس توريد ضريبة الاستقطاع"],
    migration_opening: ["Opening balances migrated", "أرصدة افتتاحية مرحّلة"],
    migration_reversal: ["Opening balances reversed", "عكس أرصدة افتتاحية مرحّلة"],
    opening_correction: ["Opening balance corrected", "تصحيح رصيد افتتاحي"],
    vat_return_filing: ["VAT return filed", "تسوية إقرار ضريبة القيمة المضافة"],
    legacy_unclassified: ["Unclassified (older entry)", "غير مصنَّف (قيد قديم)"],
    demo_seed: ["Demonstration data", "بيانات عرض"],
    test_fixture: ["Test data", "بيانات اختبار"],
  };
  const l = labels[type];
  return l ? t(l[0], l[1]) : type;
}

/** How the rules found a relationship (0163: F, N, S, A, R). */
export function sourceRuleLabel(rule: string, sourceId: number | null, t: T): string {
  switch (rule) {
    case "F": return t("that record names this entry as its own", "يشير ذلك السجل إلى هذا القيد بوصفه قيده");
    case "N": return t("its number is the one that document gives its entry", "رقمه هو الرقم الذي يعطيه ذلك المستند لقيده");
    case "S": return t("the opening-balance migration recorded it", "سجّله ترحيل الأرصدة الافتتاحية");
    case "A": return t("the manual-entry screen recorded creating it", "سجّلت شاشة القيود اليدوية إنشاءه");
    case "R": return sourceId == null ? t("it reverses another entry", "يعكس قيداً آخر") : t(`it reverses entry #${sourceId}`, `يعكس القيد رقم ${sourceId}`);
    default: return rule;
  }
}

/** The checks a relationship failed, from its evidence (each `false` the rules recorded). */
export function failedCheckLabels(evidence: Record<string, unknown>, t: T): string[] {
  const out: string[] = [];
  if (evidence.same_organization_and_company === false) out.push(t("the record is in another company", "السجل في شركة أخرى"));
  if (evidence.number_unique === false) out.push(t("the entry's number is not unique", "رقم القيد غير فريد"));
  if (evidence.date_agrees === false) out.push(t("the dates differ", "التاريخان مختلفان"));
  if (evidence.total_agrees === false) out.push(t("the totals differ", "المجموعان مختلفان"));
  if (evidence.issued === false) out.push(t("the document is not issued", "المستند غير مُصدَر"));
  if (evidence.period_agrees === false) out.push(t("the payroll period differs", "فترة الرواتب مختلفة"));
  return out;
}

/** The owner's candidate rule P (an old GL-<invoice>-PAY receipt), as the back-fill recorded it — or null. */
export function legacyPaymentNote(backfillEvidence: Record<string, unknown>, t: T): string | null {
  const p = backfillEvidence.legacy_payment_candidate as { verdict?: string; b4_records_agreeing?: number[] } | undefined;
  if (!p?.verdict) return null;
  if (p.verdict === "b4_record_only") {
    const id = p.b4_records_agreeing?.[0];
    return t(
      `An old invoice-payment record${id != null ? ` (#${id})` : ""} matches it. A receipt is classified only from a payment record, so it stays unclassified (owner decision, 2026-11-19).`,
      `يطابقه سجل قديم لسداد فاتورة${id != null ? ` (رقم ${id})` : ""}. لا يُصنَّف سند القبض إلا من سجل دفعة، لذا يبقى غير مصنَّف (قرار المالك، 2026-11-19).`,
    );
  }
  return t("It looks like an old customer receipt, but the records do not tie it to one payment.", "يبدو سند قبض قديماً من عميل، لكن السجلات لا تربطه بدفعة واحدة.");
}
