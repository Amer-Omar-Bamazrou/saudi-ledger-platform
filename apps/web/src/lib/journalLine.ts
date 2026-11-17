/**
 * 🔴 The Phase 18 walk, W5/W6/W9 (2026-11-17) — what a journal line and entry SAY to their reader.
 *
 * W5: owner decision A20 stores a line's stated reason for naming no party (0162), and N3 its customer or supplier — and
 * the entry's detail showed neither, so the statement A20 asks for was written and never read.
 * W6: the line hint said "a receivable/payable line must name its customer/vendor" to a line on UNIDENTIFIED_RECEIPTS,
 * whose rule is "a customer, or a stated reason".
 * W9: the status read draft / posted / reversed in English to an Arabic reader.
 */
type T = (en: string, ar: string) => string;

export function journalStatusLabel(status: string, t: T): string {
  switch (status) {
    case "draft": return t("Draft", "مسودة");
    case "posted": return t("Posted", "مرحّل");
    case "reversed": return t("Reversed", "معكوس");
    default: return status;
  }
}

export interface LineParty { customerId?: number | null; vendorId?: number | null; partyNoneReason?: string | null }

/** The line's party in words — the customer, the supplier, or the stated reason there is none; null when it names none. */
export function linePartyText(
  l: LineParty,
  names: { customer: (id: number) => string | undefined; vendor: (id: number) => string | undefined },
  t: T,
): string | null {
  if (l.customerId != null) return `${t("Customer", "العميل")}: ${names.customer(l.customerId) ?? `#${l.customerId}`}`;
  if (l.vendorId != null) return `${t("Supplier", "المورد")}: ${names.vendor(l.vendorId) ?? `#${l.vendorId}`}`;
  const reason = (l.partyNoneReason ?? "").trim();
  if (reason) return `${t("No customer", "لا عميل")} — ${reason}`;
  return null;
}

/** Which rule a line misses: a named party (AR, AP, customer deposits and credits), or a customer-or-reason (A20). */
export type PartyRuleMissed = "named" | "customer-or-reason";

export function partyHint(missed: PartyRuleMissed, t: T): string {
  return missed === "customer-or-reason"
    ? t(
        "A security-deposit or unidentified-receipt line names its customer, or says why there is none.",
        "سطر التأمينات المحتجزة أو المقبوضات غير المحددة يحدد عميله، أو يذكر سبب عدم وجوده.",
      )
    : t(
        "A receivable, customer-deposit or customer-credit line names its customer; a payable line names its supplier.",
        "سطر الذمم المدينة أو دفعات العملاء المقدمة أو أرصدتهم الدائنة يحدد العميل، وسطر الذمم الدائنة يحدد المورد.",
      );
}
