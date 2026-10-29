/**
 * 🔴 Phase 18 H-8 — DR-23 (D-6; register §11.55): an IBAN is checked ONE way,
 * here — ISO 13616: two country letters, two check digits, the account part,
 * and the mod-97 check over the rearranged number. A Saudi IBAN is exactly 24
 * characters (SA, two check digits, 20 more); any other country's 15 to 34.
 * Stored normalised: upper case, no spaces.
 */
export type IbanCheck = { ok: true; iban: string } | { ok: false; reason: string };

export function checkIban(raw: string): IbanCheck {
  const iban = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) {
    return { ok: false, reason: "an IBAN is two country letters, two check digits and the account part — 15 to 34 characters in all" };
  }
  if (iban.startsWith("SA") && iban.length !== 24) {
    return { ok: false, reason: `a Saudi IBAN is 24 characters (SA, two check digits and 20 more), not ${iban.length}` };
  }
  let remainder = 0;
  for (const ch of iban.slice(4) + iban.slice(0, 4)) {
    const digits = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  if (remainder !== 1) return { ok: false, reason: "its check digits do not match the account part — a character is mistyped" };
  return { ok: true, iban };
}
