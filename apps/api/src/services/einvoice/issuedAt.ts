/**
 * The single source of the issuance instant's textual forms (M12.4).
 *
 * 🔴 WHY THIS EXISTS AS A SHARED MODULE RATHER THAN TWO LOCAL HELPERS
 *
 * ZATCA cross-checks the QR's tag 3 against the XML's `cbc:IssueDate` +
 * `cbc:IssueTime` and rejects a mismatch with
 * `invoiceTimeStamp_QRCODE_INVALID`. Those two values were previously produced
 * in two different places from two different expressions, and they disagreed:
 * the XML emitted `09:13:57` (no timezone designator, per UBL) while the QR
 * emitted `2026-04-01T09:13:57Z` with a trailing `Z`.
 *
 * The bug was not the `Z` as such — it was that the same fact had two
 * independent formatters. Deriving both from here makes the class of bug
 * impossible rather than fixing one instance of it.
 *
 * Verified against the live compliance API: with `Z` → WARNING; without → PASS.
 * Stripping milliseconds alone was tested separately and did NOT clear it.
 */

/** UBL's two fields: `["2026-04-01", "09:13:57"]`. */
export function splitIssuedAt(issuedAt: Date): [string, string] {
  const iso = issuedAt.toISOString();
  return [iso.slice(0, 10), iso.slice(11, 19)];
}

/**
 * QR tag 3: `YYYY-MM-DDTHH:MM:SS`.
 *
 * Deliberately NO trailing `Z` — it must equal the XML's IssueDate and IssueTime
 * joined by `T`, and UBL's `cbc:IssueTime` carries no timezone designator.
 */
export function qrTimestamp(issuedAt: Date): string {
  const [date, time] = splitIssuedAt(issuedAt);
  return `${date}T${time}`;
}
