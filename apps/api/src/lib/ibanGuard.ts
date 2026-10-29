/**
 * 🔴 Phase 18 H-8 — DR-23 (register §11.55): the IBAN field of a write, checked
 * the one way (`checkIban`, `@workspace/shared`) and normalised in place. An
 * absent or empty IBAN is left as it is (an IBAN stays optional); a wrong one is
 * refused by name before anything is written.
 */
import { checkIban } from "@workspace/shared";
import { BusinessRuleError } from "./errors";

export function withValidIban<T extends Record<string, unknown>>(values: T): T {
  if (!("iban" in values)) return values;
  const v = values.iban;
  if (v == null || (typeof v === "string" && v.trim() === "")) return values;
  if (typeof v !== "string") throw new BusinessRuleError(422, { code: "iban_invalid", error: "The IBAN is text.", field: "iban" });
  const c = checkIban(v);
  if (!c.ok) throw new BusinessRuleError(422, { code: "iban_invalid", error: `${v.trim()} is not a valid IBAN: ${c.reason}.`, field: "iban" });
  return { ...values, iban: c.iban };
}
