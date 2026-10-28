/**
 * 🔴 Phase 18 G1 — OWNER DECISION 8 (2026-10-27): a debit note's extra charge
 * is classified BY SUBSTANCE, with no default. Only a change to the price of
 * the original supply is a debit note; the other three are refused, each
 * naming its route. Here: what each choice means for the user, and the
 * server's refusals in the reader's language — keyed on the structured CODE,
 * never on the server's wording (CLAUDE.md §3, "explain a refusal").
 *
 * Both error classes are read (`refusalOf`): `apiFetch`'s and the generated client's.
 */
import type { ChargeSubstance } from "@workspace/shared";
import { refusalOf } from "./openingVatRefusals";

type T = (en: string, ar: string) => string;

export function chargeSubstanceLabel(s: ChargeSubstance, t: T): string {
  switch (s) {
    case "price_change": return t("A change to the price of the original supply", "تغيّر في سعر التوريد الأصلي");
    case "new_supply": return t("A new, separate supply", "توريد جديد مستقل");
    case "compensation": return t("Compensation for damage or loss", "تعويض عن ضرر أو خسارة");
    case "late_payment_fee": return t("A late-payment fee", "رسوم تأخر في السداد");
  }
}

/**
 * Where a charge that is NOT a price change goes instead — shown as soon as it
 * is chosen, so the user learns the route before the server has to refuse it.
 * Null for a price change: that IS a debit note.
 */
export function chargeSubstanceRoute(s: ChargeSubstance, t: T): string | null {
  switch (s) {
    case "price_change": return null;
    case "new_supply": return t(
      "A new supply is not a debit note: issue a new tax invoice for it (Invoices → New invoice).",
      "التوريد الجديد ليس إشعارًا مدينًا: أصدر له فاتورة ضريبية جديدة (الفواتير ← فاتورة جديدة).",
    );
    case "compensation": return t(
      "Compensation for damage or loss is not consideration for a supply, so it takes no VAT document (committee decision IR-2024-192725). Record it outside the VAT documents.",
      "التعويض عن الضرر أو الخسارة ليس مقابلًا لتوريد، فلا يصدر له مستند ضريبي (قرار اللجنة IR-2024-192725). سجّله خارج المستندات الضريبية.",
    );
    case "late_payment_fee": return t(
      "A late-payment fee has no default treatment: classify it by what it is — a change to the price of the original supply, a new supply, or compensation.",
      "ليس لرسوم التأخر في السداد معالجة افتراضية: صنّفها بحسب حقيقتها — تغيّر في سعر التوريد الأصلي، أو توريد جديد، أو تعويض.",
    );
  }
}

/** The server's decision-8 refusal in the reader's language, or null when the error is something else. */
export function debitNoteRefusalText(e: unknown, t: T): string | null {
  const { code } = refusalOf(e);
  switch (code) {
    case "debit_note_substance_required": return t(
      "State what the extra charge is. There is no default. Nothing was saved.",
      "حدّد ماهية المبلغ الإضافي، فلا توجد قيمة افتراضية. لم يُحفظ شيء.",
    );
    case "extra_charge_is_new_supply": return chargeSubstanceRoute("new_supply", t);
    case "extra_charge_is_compensation": return chargeSubstanceRoute("compensation", t);
    case "late_payment_fee_needs_substance": return chargeSubstanceRoute("late_payment_fee", t);
    case "charge_event_date_required": return t(
      "Enter the date the price changed: the Art. 54(6) deadline runs from it. Nothing was saved.",
      "أدخل تاريخ تغيّر السعر، فمنه يُحسب الموعد النظامي في المادة 54(6). لم يُحفظ شيء.",
    );
    case "charge_event_date_before_original": return t(
      "The price cannot have changed before the original invoice's own date. Nothing was saved.",
      "لا يمكن أن يتغيّر السعر قبل تاريخ الفاتورة الأصلية نفسها. لم يُحفظ شيء.",
    );
    case "charge_event_date_after_note": return t(
      "The price change cannot come after the debit note that records it. Nothing was saved.",
      "لا يمكن أن يأتي تغيّر السعر بعد الإشعار المدين الذي يسجّله. لم يُحفظ شيء.",
    );
    default: return null;
  }
}
