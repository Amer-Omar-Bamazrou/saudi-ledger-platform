/**
 * ONE-TO-ONE EVIDENCE PAIRING (2026-09-17) — the generic rule behind the
 * cash cut-over's A2 and, later, D-4's payment backfill.
 *
 * ── The problem it solves ──────────────────────────────────────────────────
 * A RECORD (a payment record, say) and a piece of EVIDENCE (a settlement row
 * that names the record's document and a bank) can only be tied together
 * when the tie is unique. The first A2 rule asked "is there exactly one
 * agreeing settlement row for this document?" per record — so two payment
 * records sharing a date and amount both claimed the same single settlement
 * row, and one of them was wrong. A settlement row evidences ONE payment.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * Records and evidence are grouped by a caller-supplied key (for A2: the
 * document plus date plus amount — the document is the identity; date and
 * amount only partition the document's own records, they are never used to
 * find a document). Within a group:
 *
 *   exactly ONE record and exactly ONE evidence  → paired, DETERMINISTIC;
 *   any other cardinality                        → every record in the group
 *                                                   is AMBIGUOUS — including
 *                                                   n records ↔ n evidence
 *                                                   with n > 1.
 *
 * n ↔ n with n > 1 is deliberately NOT paired even when every evidence row
 * names the same bank: pairing them would need an ordering (oldest, first
 * inserted, …) and an ordering is not evidence. If an accountant later
 * confirms that "same bank, same count" may be attributed as a set, that is
 * a rule change with a record, not a default. Evidence rows in an ambiguous
 * group are consumed by nobody, so no row is ever reused across records.
 *
 * Pure: no I/O, no ordering assumptions, no dependence on insertion order.
 */
export interface PairingOutcome<R, E> {
  /** record id → the single evidence row that stands for it. */
  paired: Map<string | number, E>;
  /** record id → why it could not be paired. */
  ambiguous: Map<string | number, string>;
  /** evidence ids that stand for no record (informational; never re-used). */
  unconsumedEvidence: E[];
  /** records that had no evidence at all. */
  unmatched: R[];
}

export function pairOneToOne<R, E>(
  records: R[],
  evidence: E[],
  opts: {
    recordId: (r: R) => string | number;
    recordKey: (r: R) => string;
    evidenceKey: (e: E) => string;
    describe?: (e: E) => string;
  },
): PairingOutcome<R, E> {
  const byKeyR = new Map<string, R[]>();
  for (const r of records) {
    const k = opts.recordKey(r);
    byKeyR.set(k, [...(byKeyR.get(k) ?? []), r]);
  }
  const byKeyE = new Map<string, E[]>();
  for (const e of evidence) {
    const k = opts.evidenceKey(e);
    byKeyE.set(k, [...(byKeyE.get(k) ?? []), e]);
  }

  const paired = new Map<string | number, E>();
  const ambiguous = new Map<string | number, string>();
  const unmatched: R[] = [];
  const consumed = new Set<E>();

  for (const [k, rs] of byKeyR) {
    const es = byKeyE.get(k) ?? [];
    if (es.length === 0) {
      unmatched.push(...rs);
      continue;
    }
    if (rs.length === 1 && es.length === 1) {
      paired.set(opts.recordId(rs[0]!), es[0]!);
      consumed.add(es[0]!);
      continue;
    }
    const why =
      rs.length > 1 && es.length === 1
        ? `${rs.length} records share the same document, date and amount but only 1 evidence row exists — it can stand for only one of them, and nothing says which`
        : rs.length === 1 && es.length > 1
          ? `${es.length} evidence rows agree with this one record (${es.map((e) => opts.describe?.(e) ?? String(opts.evidenceKey(e))).join("; ")}) — the record cannot be tied to one of them`
          : `${rs.length} records and ${es.length} evidence rows share the same document, date and amount — pairing them would need an ordering, and an ordering is not evidence`;
    for (const r of rs) ambiguous.set(opts.recordId(r), why);
  }

  const unconsumedEvidence = evidence.filter((e) => !consumed.has(e));
  return { paired, ambiguous, unconsumedEvidence, unmatched };
}
