/**
 * Canonical digit normalization — THE single copy (the 2026-09-03 constants
 * sweep; consolidated 2026-09-14). It lived in `apps/web/src/lib/receiptParser.ts`
 * with a hand-copied twin in `apps/api/src/services/findings.explanationVerifier.ts`,
 * pinned equivalent only by a test. Both now import from here; a second
 * definition anywhere is the two-id-spaces disease (§3).
 */

/** Arabic-Indic digits → Western; the Arabic decimal separator U+066B → ".". */
export function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٫/g, ".");
}
