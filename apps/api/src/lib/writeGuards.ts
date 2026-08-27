/**
 * Write-boundary guards for the hand-rolled (non-OpenAPI) write paths.
 *
 * ── Why this exists (2026-08-20 audit, findings H1/H2) ─────────────────────
 * A cluster of create/update services spread raw `req.body` straight into
 * Drizzle `.set(...)` / `.insert(...)`. Because the body was never whitelisted,
 * a client could set ANY real column — including workflow state and ZATCA
 * identity: a draft invoice PATCHed to `{status:"sent", invoiceHash, icv}`
 * became an "issued" invoice that never posted to the GL and could hijack the
 * hash-chain head; a journal entry POSTed with `{status:"posted"}` bypassed
 * approval into every report. And item/line amounts took no validation, so
 * `NaN` defeated the JE balance check (`Math.abs(NaN-NaN) > 0.01` is false) and
 * negative amounts posted to the ledger — with no DB CHECK underneath to catch
 * either (migration 0049 adds that backstop).
 *
 * These entities are not in the OpenAPI spec, so no generated zod body exists
 * for them. `pick` is the field ALLOWLIST that replaces the raw spread;
 * `assertAmount` / `assertRate` / `assertDateString` are the value guards. The
 * allowlist is default-DENY: a column absent from the list can never be set by
 * a client, so a newly-added sensitive column is protected by omission.
 */
import { BadRequestError } from "./errors";

/**
 * Return only the allowlisted keys that are actually present in `body`.
 * Unknown keys — the mass-assignment surface — are dropped. Absent allowed
 * keys stay absent (so a PATCH remains partial).
 */
export function pick<T extends object>(body: unknown, allowed: readonly (keyof T)[]): Partial<T> {
  const src = (body ?? {}) as Record<string, unknown>;
  const out: Partial<T> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(src, key as string)) {
      (out as Record<string, unknown>)[key as string] = src[key as string];
    }
  }
  return out;
}

/** Numbers stored in `numeric(15,2)` — the largest value the column holds. */
export const NUMERIC_15_2_MAX = 9_999_999_999_999.99;

/**
 * A monetary amount: a finite number within the column's range. Amounts are
 * stored POSITIVE (direction lives in `document_type`), so the floor is 0 by
 * default. Rejects NaN/Infinity/`"banana"` — the values that defeated the JE
 * balance check and produced raw 22P02 500s.
 */
export function assertAmount(
  value: unknown,
  field: string,
  opts: { min?: number; allowZero?: boolean } = {},
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new BadRequestError(`${field} must be a number.`);
  }
  const min = opts.min ?? 0;
  if (n < min || (!opts.allowZero && opts.min === undefined && n < 0)) {
    throw new BadRequestError(`${field} must be at least ${min}.`);
  }
  if (Math.abs(n) > NUMERIC_15_2_MAX) {
    throw new BadRequestError(`${field} is out of range.`);
  }
  return n;
}

/** A VAT/percentage rate: finite, 0–100. `999%` and `NaN` are rejected. */
export function assertRate(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new BadRequestError(`${field} must be a percentage between 0 and 100.`);
  }
  return n;
}

/**
 * The ZATCA tax category of a line: S, Z, E or O — or NULL, which is
 * first-class ("0% is genuinely ambiguous between Z/E/O and the platform
 * never guesses a tax fact", the M12.8 rule). The column feeds the VAT
 * return's line-level classification, and until the 2026-08-20 audit it
 * accepted ANY string at every layer. This is the named 400; the DB CHECKs
 * (migration 0056, invoice_items + quotation_items) are the backstop every
 * future writer inherits.
 */
export function assertTaxCategoryCode(value: unknown, field: string): void {
  if (value == null) return;
  if (value !== "S" && value !== "Z" && value !== "E" && value !== "O") {
    throw new BadRequestError(`${field} must be one of S, Z, E, O (or null for an undeclared 0% line).`);
  }
}

/**
 * The ONLY currency this platform can represent.
 *
 * ── Why this is a refusal and not a formatter fix (2026-08-26) ─────────────
 * `currency` is stored on NINE tables and consulted by no aggregate: a grep of
 * `glPosting.ts`, `reports.repository.ts`, `analytics.repository.ts`,
 * `summary.repository.ts` and the VAT return returns ZERO references, and no
 * exchange-rate column or conversion function exists anywhere in the schema or
 * the services. So a row stored as USD has its bare number added straight into
 * SAR totals, the trial balance and the filed VAT return.
 *
 * Rendering it honestly ("USD 1,000.00") would be the WORSE fix: it would
 * advertise multi-currency support the ledger cannot deliver, turning a visible
 * inconsistency into an endorsed one. The single-currency assumption is real —
 * so it is enforced here rather than assumed everywhere, which is what makes
 * the hardcoded SAR formatters in the web app correct instead of lucky.
 *
 * 🔴 This is the WRITE-BOUNDARY half of an invariant that already existed in
 * exactly ONE path: `transactions.service.ts` refuses non-SAR statement rows
 * (audit finding #4). Per-path enforcement is per-path review, and
 * `bankAccounts.service.ts` allowlisted `currency` for direct client writes
 * with no validation at all — a free-text input in the UI wrote through it.
 * Migration 0062 is the DB CHECK backstop underneath this.
 */
export const SUPPORTED_CURRENCY = "SAR";

export function assertSupportedCurrency(value: unknown, field = "currency"): void {
  if (value == null) return;
  const code = String(value).trim().toUpperCase();
  if (code !== SUPPORTED_CURRENCY) {
    throw new BadRequestError(
      `${field} must be ${SUPPORTED_CURRENCY}. This platform keeps one set of books in Saudi riyals and ` +
        `holds no exchange rates, so a ${code} amount would be added to SAR totals and the VAT return unconverted. ` +
        `Convert the amount to SAR and enter that figure.`,
    );
  }
}

/**
 * A `YYYY-MM-DD` string that is a REAL calendar date. Business date columns are
 * `text`, so an invalid string otherwise persists and silently evades period
 * locks (which slice `YYYY-MM` off it) and lexical range filters. Rejects
 * `"banana"` and `"2026-13-40"`.
 */
export function assertDateString(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestError(`${field} must be a valid date (YYYY-MM-DD).`);
  }
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new BadRequestError(`${field} is not a real calendar date.`);
  }
  return value;
}
