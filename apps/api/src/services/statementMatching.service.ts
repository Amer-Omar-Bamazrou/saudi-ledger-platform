/**
 * Batch 1B Part 2, Phase D (2026-09-17) — DETERMINISTIC BANK MATCHING.
 *
 * A statement row is a bank movement; a payment (or a refund) is the
 * accounting event. A match links them. It is RECONCILIATION IDENTITY, not
 * an accounting event: nothing here posts a journal or touches a posted
 * line, and an override never modifies the historical payment journal.
 *
 * The rule (batch-1b decision pack §3; every clause is identity, not a
 * tolerance, except the window, which is a stated product value):
 *
 *   DETERMINISTIC   same bank ∧ same direction ∧ exact amount ∧ an
 *                   IDENTIFYING REFERENCE in the row's narrative resolving to
 *                   exactly one candidate ∧ date within ±MATCH_DATE_WINDOW_DAYS
 *                   ∧ exactly one candidate ∧ one-to-one across the batch
 *                   (`pairOneToOne`: two rows pointing at one payment are
 *                   both ambiguous — an ordering is not evidence).
 *   AMBIGUOUS       candidates exist but no clause identifies one: several
 *                   candidates; one candidate with no reference (amount +
 *                   date + bank alone never identify); a reference resolving
 *                   to several; a duplicate statement row.
 *   UNMATCHED       no candidate at all.
 *   INCONSISTENT    a reference in the narrative names a payment that fails
 *                   another clause (wrong bank, wrong direction, different
 *                   amount, outside the window, already matched, or created
 *                   from another statement row) — evidence conflicts, and a
 *                   human must say which fact is wrong.
 *
 * Never: amount alone; amount + date; nearest date; first candidate; same
 * customer; same bank; similar reference; single-bank assumption.
 *
 * `apply()` records matches for the DETERMINISTIC rows only — as an explicit
 * act (the caller is the human or the backfill), never a side effect of an
 * import. `override()` is the human's decision with actor, reason, the row
 * and the evidence recorded; it refuses bank and direction mismatches
 * (identity) and records an amount difference (evidence) rather than
 * inventing a charge. `unmatch()` supersedes a match with a reversal row;
 * nothing is deleted. One active match per row and per target is enforced
 * by the database (trigger `refuse_duplicate_active_match`, migration 0076).
 */
import { BadRequestError, BusinessRuleError, ConflictError, NotFoundError } from "../lib/errors";
import { round2 } from "../lib/money";
import { statementMatchesRepository } from "../repositories/statementMatches.repository";
import { pairOneToOne } from "./accounting/evidencePairing";
import { MATCH_DATE_WINDOW_DAYS, MATCH_MIN_REFERENCE_LENGTH } from "./accounting/matchingPolicy";
import { auditService } from "./audit.service";
import { bankReconciliationService } from "./accounting/bankReconciliation.service";
import { bankReconciliationRepository } from "../repositories/bankReconciliation.repository";
import type { StatementMatch, StatementMatchReversal } from "@workspace/db";

export type MatchClassification = "MATCHED" | "DETERMINISTIC" | "AMBIGUOUS" | "UNMATCHED" | "INCONSISTENT";

export type CandidateOut = { kind: "payment" | "refund"; id: number; amount: number; date: string; reference: string | null; identifiedBy: string | null };

export type RowClassification = {
  transactionId: number;
  bankAccountId: number;
  direction: "in" | "out";
  amount: number;
  date: string;
  description: string;
  classification: MatchClassification;
  reason: string;
  /** The single target when DETERMINISTIC or MATCHED. */
  target: CandidateOut | null;
  candidates: CandidateOut[];
  /** The active match when MATCHED. */
  match: MatchOut | null;
  window: { from: string; to: string; days: number };
};

export type MatchOut = {
  id: number;
  transactionId: number;
  paymentId: number | null;
  refundId: number | null;
  method: string;
  evidence: unknown;
  reason: string | null;
  createdBy: number | null;
  createdAt: string;
  reversedBy: { id: number; reason: string; createdAt: string } | null;
};

const num = (v: unknown) => Number(v ?? 0);
const fmt = (n: number) => n.toFixed(2);

function toMatchOut(m: StatementMatch, r: StatementMatchReversal | null = null): MatchOut {
  return {
    id: m.id, transactionId: m.transactionId, paymentId: m.paymentId ?? null, refundId: m.refundId ?? null, method: m.method, evidence: m.evidence,
    reason: m.reason ?? null, createdBy: m.createdBy ?? null, createdAt: m.createdAt.toISOString(),
    reversedBy: r ? { id: r.id, reason: r.reason, createdAt: r.createdAt.toISOString() } : null,
  };
}

// `referenceTokens` lives with the rest of the matching policy (one definition,
// shared by this AR matcher and the AP reconciliation of Phase 12B).
export { referenceTokens } from "./accounting/matchingPolicy";
import { referenceTokens } from "./accounting/matchingPolicy";

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function pgError(err: unknown): { code?: string; constraint?: string } {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return e?.cause && typeof e.cause === "object" ? e.cause : e;
}

export const statementMatchingService = {
  /**
   * Classify every statement row of the company (or one bank) against its
   * candidates. Pure read: nothing is written.
   */
  async classify(filter: { bankAccountId?: number; from?: string; to?: string; limit?: number } = {}): Promise<RowClassification[]> {
    const rows = await statementMatchesRepository.statementRows({ bankAccountId: filter.bankAccountId, from: filter.from, to: filter.to, limit: Math.min(500, Math.max(1, filter.limit ?? 200)) });
    const active = (await statementMatchesRepository.activeMatches()).map((r) => r.m);
    const activeByRow = new Map(active.map((m) => [m.transactionId, m]));
    // Phase 12B: a line the ledger already answers — its own posting, or a
    // reconciliation link — is not a candidate for a receipt match; matching it
    // too would count the same money twice (the database refuses it as well).
    const reconciledElsewhere = await bankReconciliationRepository.reconciledIds(rows.map((r) => r.id));
    const results: RowClassification[] = [];

    for (const row of rows) {
      const direction: "in" | "out" = row.type === "credit" ? "in" : "out";
      const amount = round2(num(row.amount));
      const window = { from: shiftDate(row.date, -MATCH_DATE_WINDOW_DAYS), to: shiftDate(row.date, MATCH_DATE_WINDOW_DAYS), days: MATCH_DATE_WINDOW_DAYS };
      const base = { transactionId: row.id, bankAccountId: row.bankAccountId!, direction, amount, date: row.date, description: row.description, window };
      const tokens = referenceTokens(row.description);

      // Already linked — by an explicit match, or by construction (settled from Review → the receipt was created FROM this row).
      const existing = activeByRow.get(row.id);
      if (existing) {
        results.push({ ...base, classification: "MATCHED", reason: `matched (${existing.method})`, target: null, candidates: [], match: toMatchOut(existing) });
        continue;
      }
      const [settled] = await statementMatchesRepository.settlementPaymentFor(row.id);
      if (settled) {
        results.push({
          ...base, classification: "MATCHED", reason: "the receipt was created from this row (settlement)", candidates: [], match: null,
          target: { kind: "payment", id: settled.id, amount: num(settled.amount), date: settled.paidAt, reference: settled.reference ?? null, identifiedBy: "settlement" },
        });
        continue;
      }
      // After the two specific answers above (an explicit match, a Review
      // settlement), which name their target: a line reconciled any OTHER way.
      if (reconciledElsewhere.has(row.id)) {
        results.push({ ...base, classification: "MATCHED", reason: row.journalEntryId != null ? "accepted and posted as its own entry" : "reconciled in the bank reconciliation workbench", target: null, candidates: [], match: null });
        continue;
      }

      // Candidates under the identity clauses (bank, direction, exact amount, window, not consumed).
      let candidates: CandidateOut[] = [];
      if (direction === "in") {
        const found = await statementMatchesRepository.candidateReceipts({ bankAccountId: row.bankAccountId!, amount, from: window.from, to: window.to });
        for (const { p } of found) {
          const invoiceNumbers = (await statementMatchesRepository.allocatedInvoiceNumbers(p.id)).map((s) => s.toUpperCase());
          const refTok = (p.reference ?? "").toUpperCase().trim();
          const identifiedBy =
            refTok.length >= MATCH_MIN_REFERENCE_LENGTH && tokens.includes(refTok) ? `reference ${p.reference}`
            : tokens.includes(`RCPT-${p.id}`) ? `receipt number RCPT-${p.id}`
            : invoiceNumbers.find((n) => tokens.includes(n)) ? `invoice ${invoiceNumbers.find((n) => tokens.includes(n))}`
            : null;
          candidates.push({ kind: "payment", id: p.id, amount: num(p.amount), date: p.paidAt, reference: p.reference ?? null, identifiedBy });
        }
      } else {
        const found = await statementMatchesRepository.candidateRefunds({ bankAccountId: row.bankAccountId!, amount, from: window.from, to: window.to });
        for (const { f } of found) {
          const refTok = (f.reference ?? "").toUpperCase().trim();
          const identifiedBy =
            refTok.length >= MATCH_MIN_REFERENCE_LENGTH && tokens.includes(refTok) ? `reference ${f.reference}`
            : tokens.includes(`REFUND-${f.id}`) ? `refund number REFUND-${f.id}`
            : null;
          candidates.push({ kind: "refund", id: f.id, amount: num(f.amount), date: f.refundedAt, reference: f.reference ?? null, identifiedBy });
        }
      }

      // The INCONSISTENT probe: does the narrative name a payment/refund that FAILS a clause?
      const conflict = await this.referenceConflict(row.id, direction, row.bankAccountId!, amount, window, tokens, new Set(candidates.map((c) => c.id)));
      if (conflict) {
        results.push({ ...base, classification: "INCONSISTENT", reason: conflict, target: null, candidates, match: null });
        continue;
      }

      const identified = candidates.filter((c) => c.identifiedBy);
      if (candidates.length === 0) {
        results.push({ ...base, classification: "UNMATCHED", reason: `no ${direction === "in" ? "receipt" : "refund"} in this bank for ${fmt(amount)} between ${window.from} and ${window.to}`, target: null, candidates, match: null });
      } else if (identified.length === 1) {
        results.push({ ...base, classification: "DETERMINISTIC", reason: `one candidate, identified by ${identified[0]!.identifiedBy}`, target: identified[0]!, candidates, match: null });
      } else if (identified.length > 1) {
        results.push({ ...base, classification: "AMBIGUOUS", reason: `${identified.length} candidates are each named by the narrative — the reference does not resolve uniquely`, target: null, candidates, match: null });
      } else {
        results.push({
          ...base, classification: "AMBIGUOUS", target: null, candidates, match: null,
          reason: candidates.length === 1
            ? "one candidate agrees on bank, amount and date but nothing in the narrative identifies it — amount and date alone never match; confirm it by override"
            : `${candidates.length} candidates agree on bank, amount and date; nothing distinguishes them`,
        });
      }
    }

    // One-to-one across the batch: two DETERMINISTIC rows pointing at the same target are both AMBIGUOUS (a duplicate statement row).
    const det = results.filter((r) => r.classification === "DETERMINISTIC");
    const pairing = pairOneToOne(det, det.map((r) => r.target!), {
      recordId: (r) => r.transactionId,
      recordKey: (r) => `${r.target!.kind}:${r.target!.id}`,
      evidenceKey: (t) => `${t.kind}:${t.id}`,
      describe: (t) => `${t.kind} ${t.id}`,
    });
    for (const r of det) {
      const why = pairing.ambiguous.get(r.transactionId);
      if (why) {
        r.classification = "AMBIGUOUS";
        r.reason = `duplicate statement rows: ${why}`;
        r.target = null;
      }
    }
    return results;
  },

  /** A reference in the narrative that names a target failing another clause — the conflict, named. */
  async referenceConflict(rowId: number, direction: "in" | "out", bankAccountId: number, amount: number, window: { from: string; to: string }, tokens: string[], candidateIds: Set<number>): Promise<string | null> {
    if (direction === "in") {
      for (const p of await statementMatchesRepository.receiptsReferencedBy(tokens)) {
        if (candidateIds.has(p.id)) continue;
        const clause =
          p.bankAccountId !== bankAccountId ? `it belongs to a different bank account (${p.bankAccountId})`
          : round2(num(p.amount)) !== amount ? `its amount is ${fmt(num(p.amount))}, not ${fmt(amount)}`
          : p.paidAt < window.from || p.paidAt > window.to ? `its date ${p.paidAt} is outside the ±${MATCH_DATE_WINDOW_DAYS}-day window`
          : p.sourceTransactionId != null && p.sourceTransactionId !== rowId ? `it was created from statement row ${p.sourceTransactionId}`
          : "it is already matched to another statement row";
        return `the narrative names receipt ${p.id} (by ${p.via}) but ${clause}`;
      }
      return null;
    }
    for (const f of await statementMatchesRepository.refundsReferencedBy(tokens)) {
      if (candidateIds.has(f.id)) continue;
      const clause =
        f.bankAccountId !== bankAccountId ? `it was paid from a different bank account (${f.bankAccountId})`
        : round2(num(f.amount)) !== amount ? `its amount is ${fmt(num(f.amount))}, not ${fmt(amount)}`
        : f.refundedAt < window.from || f.refundedAt > window.to ? `its date ${f.refundedAt} is outside the ±${MATCH_DATE_WINDOW_DAYS}-day window`
        : "it is already matched to another statement row";
      return `the narrative names refund ${f.id} (by ${f.via}) but ${clause}`;
    }
    return null;
  },

  /**
   * Record the DETERMINISTIC matches — an explicit act. Returns what was
   * recorded and what was left for review. A concurrent apply that already
   * recorded a row is a 409 for the whole request (the database refuses the
   * duplicate; re-run to see the new state).
   */
  async apply(filter: { bankAccountId?: number; from?: string; to?: string } = {}, userId: number | null) {
    const rows = await this.classify(filter);
    const recorded: MatchOut[] = [];
    for (const r of rows) {
      if (r.classification !== "DETERMINISTIC" || !r.target) continue;
      let m: StatementMatch;
      try {
        m = await statementMatchesRepository.insertMatch({
          transactionId: r.transactionId,
          paymentId: r.target.kind === "payment" ? r.target.id : null,
          refundId: r.target.kind === "refund" ? r.target.id : null,
          method: "deterministic",
          evidence: { identifiedBy: r.target.identifiedBy, amount: r.amount, bankAccountId: r.bankAccountId, direction: r.direction, rowDate: r.date, targetDate: r.target.date, window: r.window, candidates: r.candidates.length },
          reason: null,
          createdBy: userId,
        });
      } catch (err) {
        const e = pgError(err);
        if (e?.code === "23505") throw new ConflictError(`Statement row ${r.transactionId} or its counterpart was matched concurrently. Re-run to read the new state.`);
        throw err;
      }
      recorded.push(toMatchOut(m));
      await auditService.record({ action: "match", entityType: "statement_match", entityId: m.id, after: toMatchOut(m) });
      // 12B: a fully matched line leaves review as `matched` — it can no longer be accepted and post again.
      await bankReconciliationService.refreshLineState(r.transactionId);
    }
    return {
      recorded,
      summary: {
        deterministic: recorded.length,
        ambiguous: rows.filter((r) => r.classification === "AMBIGUOUS").length,
        unmatched: rows.filter((r) => r.classification === "UNMATCHED").length,
        inconsistent: rows.filter((r) => r.classification === "INCONSISTENT").length,
        matched: rows.filter((r) => r.classification === "MATCHED").length,
      },
    };
  },

  /**
   * The human's decision. Bank and direction are identity and cannot be
   * overridden; an amount difference is recorded as evidence, not corrected.
   */
  async override(body: { transactionId: unknown; paymentId?: unknown; refundId?: unknown; reason?: string | null; idempotencyKey?: string | null }, userId: number | null): Promise<MatchOut> {
    const reason = body.reason?.trim();
    if (!reason) throw new BadRequestError("A reason for the override is required.");
    const transactionId = Number(body.transactionId);
    if (!Number.isInteger(transactionId) || transactionId <= 0) throw new BadRequestError("transactionId must be a positive integer.");
    const paymentId = body.paymentId != null ? Number(body.paymentId) : null;
    const refundId = body.refundId != null ? Number(body.refundId) : null;
    if ((paymentId == null) === (refundId == null)) throw new BadRequestError("Name exactly one of paymentId or refundId.");
    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const [existing] = await statementMatchesRepository.findMatchByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.transactionId !== transactionId) throw new ConflictError(`Idempotency key "${idempotencyKey}" was already used for a different match. Use a new key.`);
        return toMatchOut(existing);
      }
    }
    const [row] = await statementMatchesRepository.findRow(transactionId);
    if (!row) throw new NotFoundError("Statement row not found");
    if (row.bankAccountId == null) throw new BusinessRuleError(422, { error: `Statement row ${transactionId} names no bank account, so it cannot be matched.`, code: "bank_account_required", field: "transactionId" });
    const direction: "in" | "out" = row.type === "credit" ? "in" : "out";
    const [settled] = await statementMatchesRepository.settlementPaymentFor(transactionId);
    if (settled) throw new ConflictError(`Statement row ${transactionId} already produced receipt ${settled.id} by settlement; it is matched by construction.`);
    for (const m of (await statementMatchesRepository.matchesForRow(transactionId)).filter((x) => x.r == null)) {
      throw new ConflictError(`Statement row ${transactionId} already has an active match (${m.m.id}). Unmatch it first.`);
    }

    let targetBank: number;
    let targetAmount: number;
    let targetDate: string;
    if (paymentId != null) {
      if (direction !== "in") throw new BusinessRuleError(422, { error: "A money-out statement row cannot match a receipt; direction is identity.", code: "match_direction_mismatch", field: "paymentId" });
      const [p] = await statementMatchesRepository.findPayment(paymentId);
      if (!p) throw new BusinessRuleError(422, { error: `Receipt ${paymentId} does not exist for this organization.`, code: "reference_not_found", field: "paymentId" });
      if (p.sourceTransactionId != null) throw new ConflictError(`Receipt ${paymentId} was created from statement row ${p.sourceTransactionId}; it is matched by construction.`);
      targetBank = p.bankAccountId; targetAmount = num(p.amount); targetDate = p.paidAt;
    } else {
      if (direction !== "out") throw new BusinessRuleError(422, { error: "A money-in statement row cannot match a refund; direction is identity.", code: "match_direction_mismatch", field: "refundId" });
      const [f] = await statementMatchesRepository.findRefund(refundId!);
      if (!f) throw new BusinessRuleError(422, { error: `Refund ${refundId} does not exist for this organization.`, code: "reference_not_found", field: "refundId" });
      targetBank = f.bankAccountId; targetAmount = num(f.amount); targetDate = f.refundedAt;
    }
    if (targetBank !== row.bankAccountId) {
      throw new BusinessRuleError(422, { error: `The statement row is in bank account ${row.bankAccountId} but the counterpart moved through bank account ${targetBank}. Bank identity cannot be overridden.`, code: "match_bank_mismatch", field: paymentId != null ? "paymentId" : "refundId" });
    }
    const amountDifference = round2(num(row.amount) - targetAmount);
    let m: StatementMatch;
    try {
      m = await statementMatchesRepository.insertMatch({
        transactionId, paymentId, refundId, method: "manual", reason, idempotencyKey, createdBy: userId,
        evidence: { rowAmount: num(row.amount), targetAmount, amountDifference, rowDate: row.date, targetDate, bankAccountId: row.bankAccountId, direction, narrative: row.description },
      });
    } catch (err) {
      const e = pgError(err);
      if (e?.code === "23505") throw new ConflictError(`Statement row ${transactionId} or its counterpart was matched concurrently.`);
      // 12B: the database refuses a match on a line (or a receipt) already reconciled another way.
      if (e?.code === "23514") throw new BusinessRuleError(409, { error: (err as Error).message.replace(/^.*?: /, ""), code: "already_reconciled", field: "transactionId" });
      throw err;
    }
    const out = toMatchOut(m);
    await auditService.record({ action: "match_override", entityType: "statement_match", entityId: m.id, after: out });
    await bankReconciliationService.refreshLineState(transactionId);
    return out;
  },

  /** Supersede a match. The match row stays; a reversal names it. */
  async unmatch(matchId: number, body: { reason?: string | null }, userId: number | null): Promise<MatchOut> {
    const reason = body.reason?.trim();
    if (!reason) throw new BadRequestError("A reason is required.");
    const [found] = await statementMatchesRepository.findMatch(matchId);
    if (!found) throw new NotFoundError("Match not found");
    if (found.r) throw new BusinessRuleError(409, { error: `Match ${matchId} was already unmatched (${found.r.id}).`, code: "match_already_reversed", field: "id" });
    let r: StatementMatchReversal;
    try {
      r = await statementMatchesRepository.insertReversal({ matchId, reason, createdBy: userId });
    } catch (err) {
      const e = pgError(err);
      if (e?.code === "23505") throw new BusinessRuleError(409, { error: `Match ${matchId} was unmatched concurrently.`, code: "match_already_reversed", field: "id" });
      throw err;
    }
    await auditService.record({ action: "unmatch", entityType: "statement_match", entityId: matchId, before: toMatchOut(found.m), after: { reversalId: r.id, reason } });
    // 12B: an unmatched line goes back to review, where it can be matched, linked or accepted.
    await bankReconciliationService.refreshLineState(found.m.transactionId);
    return toMatchOut(found.m, r);
  },

  async get(id: number): Promise<MatchOut> {
    const [found] = await statementMatchesRepository.findMatch(id);
    if (!found) throw new NotFoundError("Match not found");
    return toMatchOut(found.m, found.r);
  },
};
