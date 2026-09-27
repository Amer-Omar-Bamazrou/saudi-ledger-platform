/**
 * PHASE 12B — RECONCILING STATEMENT LINES TO THE LEDGER (2026-09-23).
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §4.
 *
 * BANK STATEMENT → RECONCILIATION → SOURCE → SUBLEDGER → GL. A statement line
 * is the bank's evidence that money moved; the ledger already holds the
 * movement if a payment, a refund, a bill payment, a journal or a transfer
 * posted it. Reconciling the two is IDENTITY, never an accounting event:
 * nothing here posts, and no posted line is rewritten.
 *
 * 🔴 The amounts are the view's (`bank_line_reconciliation`), the one
 * definition. The caps — a statement line never reconciled beyond its amount,
 * a cash line never beyond its own, across EVERY source — are enforced by the
 * database triggers of migration 0100; the checks here exist to give a person
 * a sentence instead of a constraint name, not to be the guard.
 *
 * 🔴 A statement line that is FULLY reconciled leaves review as
 * `kind = 'matched'` (accepted, no posting of its own, no category, no VAT —
 * a DB CHECK). That is what makes the defect this batch found impossible: a
 * matched line used to stay `pending_review`, and accepting it posted the
 * same money a second time. A partially reconciled line stays in review and
 * is refused by acceptance (`transactions.repository`), for the same reason.
 *
 * Deterministic linking (the AP side) uses the SAME policy as Phase D's AR
 * matcher — `matchingPolicy` and `referenceTokens` are imported, not
 * restated: same bank, same direction, exact amount, an identifying
 * reference, inside the window, exactly one candidate, one-to-one across the
 * batch. Never amount alone, never amount and date, never nearest date.
 */
import { BusinessRuleError, NotFoundError } from "../../lib/errors.js";
import { round2 } from "../../lib/money.js";
import { auditService } from "../audit.service.js";
import { bankReconciliationRepository, type CandidateRow, type LineStatus, type StatementLineRow } from "../../repositories/bankReconciliation.repository.js";
import { MATCH_DATE_WINDOW_DAYS, referenceTokens } from "./matchingPolicy.js";
import { pairOneToOne } from "./evidencePairing.js";

/** How far a MANUAL candidate may be from the statement date and still be offered. A stated product value. */
export const RECONCILE_CANDIDATE_WINDOW_DAYS = 45;

/** The sources a deterministic AP link may point at. AR receipts/refunds stay with Phase D's matcher. */
const AP_SOURCES = new Set(["supplier_payment", "supplier_refund", "bill_payment"]);

const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): never => {
  throw new BusinessRuleError(status, { code, error, ...extra });
};

function pgError(err: unknown): { code?: string; message?: string } {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  return e?.code ? e : (e?.cause ?? {});
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const dayGap = (a: string, b: string) => Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000));

export function statusOf(amount: number, reconciled: number): LineStatus {
  if (reconciled >= Math.abs(amount) - 0.005) return "reconciled";
  if (reconciled > 0.005) return "partial";
  return "unreconciled";
}

function lineOut(r: StatementLineRow) {
  const amount = Number(r.amount);
  const reconciled = round2(Number(r.reconciled));
  return {
    id: r.id, bankAccountId: r.bank_account_id, bankStatementId: r.bank_statement_id,
    date: r.date, description: r.description, direction: r.type === "credit" ? "in" as const : "out" as const,
    amount, reconciledAmount: reconciled, remaining: round2(Math.max(0, Math.abs(amount) - reconciled)),
    status: statusOf(amount, reconciled), reviewStatus: r.review_status, kind: r.kind,
    postedOwnEntry: r.journal_entry_id != null,
  };
}

function candidateOut(c: CandidateRow) {
  return {
    journalLineId: c.line_id, journalEntryId: c.journal_entry_id, entryNumber: c.entry_number, date: c.date,
    description: c.description, lineAmount: Number(c.line_amount), remaining: round2(Number(c.remaining)),
    sourceKind: c.source_kind ?? "journal", sourceId: c.source_id, sourceReference: c.source_ref, party: c.party,
  };
}

export const bankReconciliationService = {
  async lines(filter: { bankAccountId?: number; from?: string; to?: string; status?: LineStatus; limit?: number; offset?: number }) {
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    const rows = await bankReconciliationRepository.lines({ ...filter, limit, offset });
    return { items: rows.map(lineOut), page: { limit, offset, total: rows[0]?.total ?? 0 } };
  },

  /** One statement line: what reconciles it, and — while it is not fully reconciled — what could. */
  async line(id: number) {
    const row = await bankReconciliationRepository.line(id);
    if (!row) throw new NotFoundError("Statement line not found.");
    const out = lineOut(row);
    const reconciledBy = (await bankReconciliationRepository.reconciliationOf(id)).map((r) => ({
      source: r.source, sourceId: r.source_id, journalLineId: r.line_id, amount: round2(Number(r.amount)),
      journalEntryId: r.entry_id, entryNumber: r.entry_number, entryDate: r.entry_date,
      documentKind: r.source_kind ?? "journal", documentReference: r.source_ref, party: r.party,
      // Only a LINK is undone here; a posting, a Phase D match and a Review settlement have their own corrections.
      linkId: r.source === "link" ? r.source_id : null,
    }));
    const candidates = out.status === "reconciled" || out.postedOwnEntry ? [] : await this.candidatesFor(row);
    return { ...out, reconciledBy, candidates };
  },

  async candidatesFor(row: StatementLineRow) {
    const rows = await bankReconciliationRepository.candidates({
      bankAccountId: row.bank_account_id, type: row.type,
      from: shiftDate(row.date, -RECONCILE_CANDIDATE_WINDOW_DAYS), to: shiftDate(row.date, RECONCILE_CANDIDATE_WINDOW_DAYS),
      excludeEntryId: row.journal_entry_id,
    });
    return rows.map(candidateOut);
  },

  /**
   * Reconcile a statement line to one or more GL cash lines, for stated
   * amounts. A person's decision (`manual`), or the deterministic rule's
   * (`deterministic`), or a Review settlement (`settlement`), or a transfer
   * leg (`transfer`, 12C).
   */
  async link(
    transactionId: number,
    body: { lines?: Array<{ journalLineId: number; amount: number }>; reason?: string | null; idempotencyKey?: string | null },
    userId: number | null,
    method: "manual" | "deterministic" | "settlement" | "transfer" = "manual",
    evidenceExtra: Record<string, unknown> = {},
  ) {
    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const [prior] = await bankReconciliationRepository.findLinkByIdempotencyKey(idempotencyKey);
      if (prior) return this.line(prior.transactionId);
    }
    await bankReconciliationRepository.lockLine(transactionId);
    const row = await bankReconciliationRepository.line(transactionId);
    if (!row) throw new NotFoundError("Statement line not found.");
    if (row.journal_entry_id != null) {
      refuse(409, "line_posted_its_own_entry", `Statement line ${row.id} was accepted and posted its own entry, so its money is already in the ledger. Linking it to another cash line would count it twice — undo the acceptance first if the entry was wrong.`);
    }
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (lines.length === 0) refuse(422, "lines_required", "Name at least one ledger cash line to reconcile this statement line to.", { field: "lines" });
    const seen = new Set<number>();
    for (const l of lines) {
      if (!Number.isInteger(Number(l.journalLineId))) refuse(422, "line_invalid", "Each line names a journalLineId.", { field: "lines" });
      if (seen.has(Number(l.journalLineId))) refuse(422, "line_duplicate", `Journal line ${l.journalLineId} is named twice — state one amount per line.`, { field: "lines" });
      seen.add(Number(l.journalLineId));
      if (!(Number(l.amount) > 0)) refuse(422, "amount_invalid", "Each reconciled amount is positive.", { field: "lines" });
    }
    const current = lineOut(row);
    const requested = round2(lines.reduce((s, l) => s + round2(Number(l.amount)), 0));
    if (requested > current.remaining + 0.005) {
      refuse(409, "exceeds_statement_line", `Statement line ${row.id} has ${current.remaining.toFixed(2)} left to reconcile; ${requested.toFixed(2)} was asked for.`);
    }

    // Candidates are re-read here, so the service can explain a refusal in words
    // (another bank, the wrong direction, already reconciled) before the trigger does.
    // Only the named lines are read — a bank's whole cash history is not.
    const candidates = new Map((await bankReconciliationRepository.candidates({
      bankAccountId: row.bank_account_id, type: row.type, from: "1900-01-01", to: "2999-12-31", excludeEntryId: null,
      lineIds: lines.map((l) => Number(l.journalLineId)),
    })).map((c) => [c.line_id, c]));
    const reason = body.reason?.trim() || null;
    for (const l of lines) {
      const c = candidates.get(Number(l.journalLineId));
      if (!c) {
        refuse(409, "line_not_a_candidate", `Journal line ${l.journalLineId} cannot answer this statement line: it is not a cash line on the same bank moving money the same way in a posted entry, or it is already fully reconciled.`);
      }
      if (Number(l.amount) > Number(c!.remaining) + 0.005) {
        refuse(409, "exceeds_ledger_line", `Journal line ${c!.line_id} (${c!.entry_number}) has ${Number(c!.remaining).toFixed(2)} left to reconcile; ${Number(l.amount).toFixed(2)} was asked for.`);
      }
      // 🔴 Evidence a person must answer for: a date far from the statement's.
      if (method === "manual" && dayGap(c!.date, row.date) > MATCH_DATE_WINDOW_DAYS && !reason) {
        refuse(422, "reason_required", `${c!.entry_number} is dated ${c!.date}, ${dayGap(c!.date, row.date)} days from the statement line (${row.date}). Say why they are the same money.`, { field: "reason" });
      }
    }

    try {
      for (const [i, l] of lines.entries()) {
        const c = candidates.get(Number(l.journalLineId))!;
        // A person's link to a recorded bank-to-bank transfer IS a transfer leg (12C).
        const linkMethod = method === "manual" && c.source_kind === "bank_transfer" ? "transfer" : method;
        const [link] = await bankReconciliationRepository.insertLink({
          transactionId, journalLineId: c.line_id, amount: round2(Number(l.amount)).toFixed(2), method: linkMethod,
          evidence: {
            statementDate: row.date, statementAmount: Number(row.amount), direction: current.direction,
            entryNumber: c.entry_number, entryDate: c.date, daysApart: dayGap(c.date, row.date),
            lineAmount: Number(c.line_amount), document: c.source_kind ?? "journal", documentId: c.source_id, ...evidenceExtra,
          },
          // The key rides on the FIRST link of the request: a retry finds it and
          // returns the line, however many links the request made.
          reason, idempotencyKey: i === 0 ? idempotencyKey : null, createdBy: userId,
        });
        await auditService.created("bank_statement_link", link!.id, link);
      }
    } catch (err) {
      const e = pgError(err);
      if (e.code === "23514") refuse(409, "reconciliation_refused", e.message ?? "The database refused the reconciliation.");
      if (e.code === "23505") refuse(409, "reconciliation_conflict", "This reconciliation was recorded by another request a moment ago.");
      throw err;
    }
    await this.refreshLineState(transactionId);
    return this.line(transactionId);
  },

  /** Undo a link with a SUPERSEDING record; the link row stays as it was. */
  async unlink(linkId: number, body: { reason?: string | null }, userId: number | null) {
    const reason = body.reason?.trim();
    if (!reason) refuse(422, "reason_required", "Say why this reconciliation is being undone — the record keeps both the link and its reversal.", { field: "reason" });
    const [link] = await bankReconciliationRepository.findLink(linkId);
    if (!link) throw new NotFoundError("Reconciliation link not found.");
    await bankReconciliationRepository.lockLine(link.transactionId);
    const [already] = await bankReconciliationRepository.findReversal(linkId);
    if (already) refuse(409, "link_already_reversed", `Link ${linkId} was already undone; its reversal is the record.`);
    try {
      const [rev] = await bankReconciliationRepository.insertReversal({ linkId, reason: reason!, createdBy: userId });
      await auditService.record({ action: "reverse", entityType: "bank_statement_link", entityId: String(linkId), before: link, after: rev });
    } catch (err) {
      if (pgError(err).code === "23505") refuse(409, "link_already_reversed", `Link ${linkId} was undone by another request a moment ago.`);
      throw err;
    }
    await this.refreshLineState(link.transactionId);
    return this.line(link.transactionId);
  },

  /**
   * Keep a line's review state in step with the view: fully reconciled ⇒
   * `matched` (leaves review, can never post); no longer fully reconciled ⇒
   * back to review. Called after every write that changes reconciliation —
   * a link, an unlink, a Phase D match or unmatch.
   */
  async refreshLineState(transactionId: number) {
    const row = await bankReconciliationRepository.line(transactionId);
    if (!row) return;
    const status = statusOf(Number(row.amount), Number(row.reconciled));
    if (status === "reconciled" && row.review_status === "pending_review" && row.journal_entry_id == null) {
      await bankReconciliationRepository.setMatched(transactionId);
    } else if (status !== "reconciled" && row.kind === "matched") {
      await bankReconciliationRepository.returnToReview(transactionId);
    }
  },

  /**
   * The AP side of deterministic matching, classified. Phase D's rule, over
   * supplier payments, supplier refunds and bill payments: exact amount (the
   * candidate's REMAINING equals the statement line), same bank and direction,
   * inside ±MATCH_DATE_WINDOW_DAYS, and a reference token in the narrative
   * that identifies exactly one candidate — then one-to-one across the batch.
   */
  async classifyAp(filter: { bankAccountId?: number } = {}) {
    // EVERY pending, unreconciled line — never a page of them: a line past a
    // cap would silently never be classified.
    const rows = await bankReconciliationRepository.pendingUnreconciled(filter.bankAccountId);
    type Out = { transactionId: number; classification: "DETERMINISTIC" | "AMBIGUOUS" | "UNMATCHED"; reason: string; target: ReturnType<typeof candidateOut> | null };
    const identified: Array<{ row: StatementLineRow; cand: CandidateRow }> = [];
    const out: Out[] = [];
    // ONE candidate read per bank and direction, over the lines' whole date
    // span — not one per line (at volume, one per line took longer than the
    // page would wait).
    const groups = new Map<string, StatementLineRow[]>();
    for (const row of rows) {
      const key = `${row.bank_account_id}:${row.type}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const group of groups.values()) {
      const dates = group.map((r) => r.date).sort();
      const pool = (await bankReconciliationRepository.candidates({
        bankAccountId: group[0]!.bank_account_id, type: group[0]!.type,
        from: shiftDate(dates[0]!, -MATCH_DATE_WINDOW_DAYS), to: shiftDate(dates[dates.length - 1]!, MATCH_DATE_WINDOW_DAYS), excludeEntryId: null,
      })).filter((c) => AP_SOURCES.has(c.source_kind ?? ""));
      for (const row of group) {
        const from = shiftDate(row.date, -MATCH_DATE_WINDOW_DAYS), to = shiftDate(row.date, MATCH_DATE_WINDOW_DAYS);
        const cands = pool.filter((c) => c.date >= from && c.date <= to && Math.abs(Number(c.remaining) - Number(row.amount)) < 0.005);
        if (cands.length === 0) { out.push({ transactionId: row.id, classification: "UNMATCHED", reason: "no supplier payment, refund or bill payment of exactly this amount on this bank inside the window", target: null }); continue; }
        const tokens = referenceTokens(row.description);
        const byRef = cands.filter((c) => c.source_ref && tokens.some((t) => c.source_ref!.toUpperCase().includes(t)));
        if (byRef.length === 1) identified.push({ row, cand: byRef[0]! });
        else out.push({
          transactionId: row.id, classification: "AMBIGUOUS", target: null,
          reason: byRef.length === 0
            ? `${cands.length} candidate(s) of this amount, but no reference in the narrative identifies one — amount and date alone never do`
            : `the narrative's reference matches ${byRef.length} candidates`,
        });
      }
    }
    const pairing = pairOneToOne(identified, identified.map((i) => i.cand), {
      recordId: (i) => i.row.id, recordKey: (i) => String(i.cand.line_id), evidenceKey: (c) => String(c.line_id),
      describe: (c) => c.entry_number,
    });
    for (const i of identified) {
      if (pairing.paired.has(i.row.id)) out.push({ transactionId: i.row.id, classification: "DETERMINISTIC", reason: `the reference identifies ${i.cand.source_ref} (${i.cand.entry_number})`, target: candidateOut(i.cand) });
      else out.push({ transactionId: i.row.id, classification: "AMBIGUOUS", reason: pairing.ambiguous.get(i.row.id) ?? "another statement line identifies the same ledger line", target: null });
    }
    return { items: out.sort((a, b) => a.transactionId - b.transactionId) };
  },

  /** Record the DETERMINISTIC rows only — an explicit act, never a side effect of an import. */
  async applyAp(filter: { bankAccountId?: number } = {}, userId: number | null) {
    const { items } = await this.classifyAp(filter);
    const recorded: number[] = [];
    for (const i of items) {
      if (i.classification !== "DETERMINISTIC" || !i.target) continue;
      await this.link(i.transactionId, { lines: [{ journalLineId: i.target.journalLineId, amount: i.target.remaining }] }, userId, "deterministic", { rule: "ap_reference", reference: i.target.sourceReference });
      recorded.push(i.transactionId);
    }
    return { recorded, summary: { deterministic: recorded.length, ambiguous: items.filter((i) => i.classification === "AMBIGUOUS").length, unmatched: items.filter((i) => i.classification === "UNMATCHED").length } };
  },
};
