/**
 * The explanation verifier (AI-3b) — the mechanism the feature's safety
 * rests on, so its contract is stated exactly:
 *
 * 🔴 WHAT IT PROVES: no numeric token and no quoted/identifier-like entity
 * in the explanation is absent from the finding's facts. Numbers are
 * compared CANONICALLY across scripts and formats (Arabic-Indic ↔ Western,
 * separators, trailing decimal zeros), in BOTH directions — an
 * Arabic-script number in the explanation must match a Western-script fact
 * and vice versa (facts can carry Arabic-Indic digits inside descriptions).
 *
 * 🔴 WHAT IT CANNOT PROVE: qualitative invention — an inferred cause, a
 * risk claim — has no mechanical oracle here. That class is bounded
 * elsewhere (prompt scope, the judge pass, the UI rendering the
 * deterministic facts beside the explanation), never claimed as proven.
 *
 * 🔴 TELEMETRY DISTINGUISHABILITY (owner condition, 2026-08-24): a rejection
 * carries the offending token, its SCRIPT, and its NORMALIZED form — so "the
 * model invented a number" and "the verifier couldn't match a real number"
 * are distinguishable in review. If those looked identical, a safety catch
 * and a normalisation bug would be indistinguishable.
 */

/**
 * 🔴 COPIED from `apps/web/src/lib/receiptParser.ts` (`normalizeDigits`),
 * which is the CANONICAL implementation — the owner's instruction was to
 * reuse it, and a workspace boundary (web ↔ api) prevents a direct import.
 * `findings-explain.test.ts` pins behavioral equivalence against
 * receiptParser's own cases; if either copy changes, that test is the tell.
 * True single-sourcing needs a shared package — flagged in the AI-3b PR,
 * deliberately not restructured here.
 */
export function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٫/g, "."); // Arabic decimal separator U+066B
}

export type RejectionReason = "invented_number" | "invented_entity";

export interface VerifierVerdict {
  ok: boolean;
  reason?: RejectionReason;
  /** The offending token as the model wrote it. */
  token?: string;
  /** 'arabic-indic' | 'western' — the diagnosability half of the telemetry condition. */
  script?: "arabic-indic" | "western";
  /** What the token normalized to (what the matcher actually compared). */
  normalized?: string;
}

/** Canonical decimal form: separators stripped (incl. Arabic thousands U+066C), trailing fraction zeros trimmed, leading zeros trimmed. */
function canonical(raw: string): string {
  let s = normalizeDigits(raw).replace(/[,\s٬]/g, "");
  if (s.includes(".")) {
    s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  s = s.replace(/^0+(?=\d)/, "");
  return s;
}

/** Every number form a fact set licenses: numeric values (raw + 2dp) and every digit run inside string values, all canonicalized. */
export function allowedNumberForms(facts: Record<string, unknown>): Set<string> {
  const allowed = new Set<string>();
  const addNumber = (n: number) => {
    allowed.add(canonical(String(n)));
    allowed.add(canonical(n.toFixed(2)));
  };
  const addString = (s: string) => {
    const runs = normalizeDigits(s).match(/\d+(?:\.\d+)?/g) ?? [];
    for (const r of runs) allowed.add(canonical(r));
  };
  const walk = (v: unknown): void => {
    if (typeof v === "number" && Number.isFinite(v)) addNumber(v);
    else if (typeof v === "string") addString(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(facts);
  return allowed;
}

/** String facts, flattened and digit-normalized, for entity substring checks. */
function flattenedStrings(facts: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(normalizeDigits(v).toLowerCase());
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(facts);
  return out;
}

export function verifyExplanation(text: string, facts: Record<string, unknown>): VerifierVerdict {
  const allowed = allowedNumberForms(facts);

  // ── Numbers ────────────────────────────────────────────────────────────────
  // Tokens are taken from the RAW text so the script is observable for
  // telemetry; matching happens on the canonical form.
  const numberTokens = text.match(/[\d٠-٩][\d٠-٩.,٫٬]*/g) ?? [];
  for (const token of numberTokens) {
    const norm = canonical(token);
    if (norm === "" || allowed.has(norm)) continue;
    // A composite like "1,150.00" already canonicalizes whole; as a last
    // resort accept a token whose every internal digit-run is licensed
    // (e.g. a model writing a date as "01.08" against date parts).
    const parts = (normalizeDigits(token).match(/\d+/g) ?? []).map(canonical);
    if (parts.length > 1 && parts.every((p) => allowed.has(p))) continue;
    return {
      ok: false,
      reason: "invented_number",
      token,
      script: /[٠-٩]/.test(token) ? "arabic-indic" : "western",
      normalized: norm,
    };
  }

  // ── Entities ───────────────────────────────────────────────────────────────
  // Quoted spans and identifier-shaped tokens (INV-2026-000044) must appear
  // in some string fact. Case-insensitive substring on digit-normalized text.
  const strings = flattenedStrings(facts);
  const quoted = [...text.matchAll(/«([^»]{2,})»|"([^"]{2,})"|'([^']{2,})'|“([^”]{2,})”/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
  const identifiers = text.match(/\b[A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]+)+\b/g) ?? [];
  for (const entity of [...quoted, ...identifiers]) {
    const needle = normalizeDigits(entity).toLowerCase().trim();
    if (needle.length === 0) continue;
    if (!strings.some((s) => s.includes(needle))) {
      return {
        ok: false,
        reason: "invented_entity",
        token: entity,
        script: /[٠-٩]/.test(entity) ? "arabic-indic" : "western",
        normalized: needle,
      };
    }
  }

  return { ok: true };
}
