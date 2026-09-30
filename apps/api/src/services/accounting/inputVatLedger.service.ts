/**
 * 🔴 PHASE 13B-3 — THE INPUT-VAT EVENT WRITER (2026-09-29).
 * Records: docs/product/phase-13b-vat-claim-ledger-architecture.md §26;
 *          docs/product/phase-13b2-credit-note-event-design.md §19.
 *
 * The ONE place a purchase document's input-VAT position is written: the
 * append-only events (`input_vat_events`, the source of truth) AND their cache
 * (`bills.input_vat_state` / `input_vat_pending` / `input_vat_claimed_on` /
 * `input_vat_claim_entry_id`), in the SAME transaction as the posting that
 * caused them. Its callers are the three live acts that move input VAT:
 *
 *   · a purchase document's approval (`bills.approvable` — bills, debit notes,
 *     supplier credit notes, and the supplier's advance documents, Z-AP1);
 *   · the evidence claim (`vatEvidenceService.claimHeldVat`, X1).
 *
 * What it records — live behaviour stated as events, no new treatment:
 *   recognised_claimed / _held / _blocked  the document's VAT net of advance
 *                                          VAT already claimed, on its date,
 *                                          inside its own BILL- / BILLADV- entry;
 *   advance_deducted                       per supplier advance a final bill
 *                                          deducts (an annotation — Z-AP1);
 *   claimed                                the WHOLE held VAT, on the evidence
 *                                          date, inside VATEV- (none when notes
 *                                          consumed it: O-6);
 *   reduced_by_note                        a supplier credit note, as an event
 *                                          of its ORIGINAL, inside the note's
 *                                          BILLCN- / BILLADVCN- entry (B-1).
 * A DEBIT note is its own document (O-3): its own recognition, its own claim.
 *
 * 🔴 The database is the boundary, not this file: migration 0109 admits only
 * these shapes, checks each against its entry at commit, and refuses — at
 * commit — any bill whose cache disagrees with its events
 * (`bills_input_vat_cache_consistency`). What this file adds is the REFUSAL IN
 * WORDS before anything posts (O-2, D-6), from the SAME SQL function the
 * trigger reads (`input_vat_note_refusal`) — one definition, two readers.
 */
import { sql } from "drizzle-orm";
import { db, inputVatEventsTable, type billsTable } from "@workspace/db";
import { BusinessRuleError } from "../../lib/errors";
import { money2, round2 } from "../../lib/money";
import { billsRepository } from "../../repositories/bills.repository";
import type { VatEvidenceVerdict } from "../purchaseEvidence/vatEvidence";

type Bill = typeof billsTable.$inferSelect;
export type InputVatTreatment = "claimed" | "awaiting_evidence" | "not_deductible";
type Bucket = "HELD" | "CLAIMED" | "BLOCKED";

const BUCKET: Record<InputVatTreatment, Bucket> = { claimed: "CLAIMED", awaiting_evidence: "HELD", not_deductible: "BLOCKED" };
const RECOGNITION: Record<InputVatTreatment, string> = {
  claimed: "recognised_claimed", awaiting_evidence: "recognised_held", not_deductible: "recognised_blocked",
};
const NOTE_TYPES = new Set(["credit_note", "advance_credit_note"]);
const UNPOSTED = new Set(["draft", "submitted"]);

/** Who recorded it: the approver (with the act as the reason), or the named system identity. */
function actor(userId: number | null | undefined, reason: string) {
  return userId != null ? { actorUserId: userId, reason } : { actorSystem: "approval:bills", reason };
}

/** The evidence verdict as it was when the event was made (architecture §5.1). */
function snapshot(bill: Bill, verdict: Pick<VatEvidenceVerdict, "status" | "basis" | "flags"> | null, capture: { id: string; sha256: string } | null) {
  return {
    status: verdict?.status ?? bill.vatEvidenceStatus ?? null,
    basis: verdict?.basis ?? bill.vatEvidenceBasis ?? null,
    flags: verdict?.flags ?? bill.vatEvidenceFlags ?? [],
    supplierDocumentKind: bill.supplierDocumentKind ?? null,
    captureId: capture?.id ?? null,
    captureSha256: capture?.sha256 ?? null,
  };
}

type EventValues = typeof inputVatEventsTable.$inferInsert;
/**
 * Record ONE event (one per statement — the database refuses two for one
 * document in one statement, 0107). 🔴 RETRY-SAFE: the idempotency key names
 * the act. Restating an act already recorded — same key, same accounting
 * content — records nothing and moves no balance (ON CONFLICT DO NOTHING; the
 * admission trigger skips the balance checks for it). Reusing a key for a
 * DIFFERENT act is refused by the database (`input_vat_event_idempotency_conflict`,
 * migration 0109) and surfaces here as a 409 — never swallowed.
 * Returns true when this call recorded the event, false when it was a retry.
 */
async function record(values: Omit<EventValues, "provenance">): Promise<boolean> {
  try {
    const rows = await db.insert(inputVatEventsTable).values({ ...values, provenance: "recorded" })
      .onConflictDoNothing({ target: [inputVatEventsTable.organizationId, inputVatEventsTable.idempotencyKey] })
      .returning({ id: inputVatEventsTable.id });
    return rows.length === 1;
  } catch (err) {
    const pg = (err as { cause?: { constraint?: string }; constraint?: string });
    if ((pg.cause?.constraint ?? pg.constraint) === "input_vat_event_idempotency_conflict") {
      throw new BusinessRuleError(409, {
        code: "input_vat_idempotency_conflict",
        error: `This input VAT act (${values.idempotencyKey}) was already recorded with different figures, so it was not recorded again. Nothing was posted; this needs investigating.`,
      });
    }
    throw err;
  }
}

/** The refusals O-2 names (design §19.4, §19.8), and the opening-original precondition (0109 §3). */
const NOTE_REFUSALS = new Set([
  "input_vat_note_opening_original", "credit_note_exceeds_invoice_vat",
  "input_vat_note_interaction_undecided", "input_vat_note_allocation_undecided",
]);

export const inputVatLedgerService = {
  /**
   * 🔴 O-2 and D-6, asked BEFORE a supplier credit note posts — so a refusal
   * reaches the user in words, never as a raw database error. The same SQL
   * function (`input_vat_note_refusal`) is what the admission trigger reads.
   * Returns the bucket the note reduces (null when it carries no VAT).
   */
  async assertNoteAdmissible(note: Bill, original: Bill): Promise<Bucket | null> {
    // D-6 (O-4): a note corrects an invoice already issued (IR Art. 54(4)).
    if (note.date < original.date) {
      throw new BusinessRuleError(422, {
        code: "credit_note_before_original",
        error: `This credit note is dated ${note.date}, before ${original.billNumber} (dated ${original.date}), the document it corrects. A supplier's credit note corrects an invoice already issued — check the note's date.`,
        field: "date",
      });
    }
    const vat = round2(Number(note.vatAmount));
    if (!(vat > 0)) return null;
    const { rows } = await db.execute<{ refusal: string | null; from_bucket: Bucket | null; remaining: string; bucket_amount: string }>(
      sql`SELECT refusal, from_bucket, remaining::text, bucket_amount::text FROM input_vat_note_refusal(${original.id}, ${note.id}, ${money2(vat)}::numeric)`);
    const r = rows[0]!;
    if (r.refusal && NOTE_REFUSALS.has(r.refusal)) {
      const left = Number(r.remaining).toFixed(2);
      const words: Record<string, string> = {
        input_vat_note_opening_original:
          `${original.billNumber} is an opening balance migrated at cut-over; its VAT was accounted for before this system, so a supplier credit note against it cannot be recorded here yet. This case is awaiting a decision — record the note outside the system for now and keep it for the accountant.`,
        credit_note_exceeds_invoice_vat:
          `This credit note reduces VAT by ${vat.toFixed(2)}, but only ${left} of the ${Number(original.vatAmount).toFixed(2)} VAT charged on ${original.billNumber} is left after its other credit notes. A credit note cannot credit more VAT than the invoice charged (VAT IR Art. 54(1)) — check the note's VAT amount.`,
        input_vat_note_interaction_undecided:
          `${original.billNumber}'s input VAT has been reversed, restored, corrected or written off since it was recorded. How a supplier credit note applies after that is not yet decided, so it cannot be recorded; nothing was posted.`,
        input_vat_note_allocation_undecided:
          `This credit note's VAT (${vat.toFixed(2)}) is within the VAT charged on ${original.billNumber}, but more than the VAT that bill itself still holds (${Number(r.bucket_amount).toFixed(2)}) — part of it would reach VAT recorded on another document (a supplier advance or a debit note). How that is allocated is not yet decided, so it cannot be recorded; nothing was posted.`,
      };
      throw new BusinessRuleError(422, { code: r.refusal, error: words[r.refusal], field: "vatAmount" });
    }
    if (r.refusal) throw new BusinessRuleError(422, { code: r.refusal, error: `This credit note cannot be recorded against ${original.billNumber} (${r.refusal}).`, field: "creditNoteAgainstBillId" });
    return r.from_bucket;
  },

  /**
   * The APPROVAL's input-VAT position, in its transaction, after its entry
   * posted: the cache (in the SAME update as `columns` — the status change —
   * because `bills_vat_evidence_gate` checks the state against the verdict
   * there), then the events.
   *
   *   · an ordinary document (a bill, a debit note, a supplier advance
   *     invoice): its recognition of `vatToClaim` inside `entryId`, and one
   *     advance_deducted per prepayment carrying tax;
   *   · a supplier credit note: its reduction, as an event of `original`,
   *     inside the note's own `entryId`; a note on HELD VAT also lowers the
   *     original's held amount (X3 — the later claim is the net).
   */
  async recordPosting(input: {
    bill: Bill;
    treatment: InputVatTreatment;
    vatToClaim: number;
    entryId: number | null;
    original?: Bill | null;
    prepayments?: ReadonlyArray<{ advanceBillId: number; taxAmount: number }>;
    verdict: Pick<VatEvidenceVerdict, "status" | "basis" | "flags">;
    capture?: { id: string; sha256: string } | null;
    columns: Record<string, unknown>;
    userId: number | null;
  }): Promise<void> {
    const { bill, treatment, entryId, original, verdict, userId } = input;
    const vat = round2(input.vatToClaim);
    const isNote = NOTE_TYPES.has(bill.documentType);

    /**
     * 🔴 RETRY-SAFE AS A WHOLE. A posting happens once: when the document is
     * already posted, this call is a RETRY of it — it writes no status and no
     * cache (a late retry must not turn `paid` back into `received`, nor reset
     * a held amount a credit note has since lowered) and only RESTATES the
     * events, which the database either finds identical (nothing recorded,
     * nothing moved) or refuses as a different act (409). A zero-VAT posting
     * has no event to restate; its retry must state the same treatment.
     */
    const [current] = await billsRepository.findById(bill.id);
    const retry = current != null && !UNPOSTED.has(current.status);
    if (retry && !(vat > 0) && current.inputVatState != null && current.inputVatState !== treatment) {
      throw new BusinessRuleError(409, {
        code: "input_vat_idempotency_conflict",
        error: `${bill.billNumber} is already posted with its input VAT ${current.inputVatState}; restating it as ${treatment} is a different act. Nothing was changed.`,
      });
    }
    if (!retry) {
      await billsRepository.update(bill.id, {
        ...input.columns,
        inputVatState: treatment,
        inputVatPending: !isNote && treatment === "awaiting_evidence" && vat > 0 ? money2(vat) : "0",
        inputVatClaimedOn: treatment === "claimed" ? bill.date : null,
      });
    }
    if (!(vat > 0)) return;
    if (entryId == null) throw new Error(`input VAT writer: ${bill.billNumber} carries VAT ${vat} but posted no entry`);

    if (isNote) {
      if (!original) throw new Error(`input VAT writer: credit note ${bill.billNumber} names no original`);
      const recorded = await record({
        organizationId: bill.organizationId, companyId: bill.companyId,
        documentId: original.id, relatedDocumentId: bill.id,
        eventType: "reduced_by_note", fromBucket: BUCKET[treatment], toBucket: "NONE", amount: money2(vat),
        occurredOn: bill.date, postingDate: bill.date,
        causeType: "credit_note", causeId: bill.id,
        evidenceSnapshot: snapshot(bill, verdict, null),
        journalEntryId: entryId, journalRole: "note_entry",
        ...actor(userId, `Supplier credit note ${bill.billNumber} approved`),
        idempotencyKey: `reduced_by_note:${bill.id}`,
      });
      // X3: a note on HELD VAT lowers what the original holds — once. A retry recorded nothing, so it moves nothing.
      if (recorded && !retry && treatment === "awaiting_evidence") {
        await billsRepository.update(original.id, { inputVatPending: money2(round2(Number(original.inputVatPending) - vat)) });
      }
      return;
    }

    await record({
      organizationId: bill.organizationId, companyId: bill.companyId, documentId: bill.id,
      eventType: RECOGNITION[treatment], fromBucket: "NONE", toBucket: BUCKET[treatment], amount: money2(vat),
      occurredOn: bill.date, postingDate: bill.date,
      evidenceCaptureId: input.capture?.id ?? null,
      evidenceSnapshot: snapshot(bill, verdict, input.capture ?? null),
      journalEntryId: entryId, journalRole: "own_entry",
      ...actor(userId, `${bill.documentType === "advance_invoice" ? "Supplier advance invoice" : bill.documentType === "debit_note" ? "Supplier debit note" : "Bill"} ${bill.billNumber} approved`),
      idempotencyKey: `${RECOGNITION[treatment]}:${bill.id}`,
    });
    for (const p of input.prepayments ?? []) {
      if (!(round2(p.taxAmount) > 0)) continue;
      await record({
        organizationId: bill.organizationId, companyId: bill.companyId, documentId: bill.id, relatedDocumentId: p.advanceBillId,
        eventType: "advance_deducted", fromBucket: "NONE", toBucket: "NONE", amount: money2(round2(p.taxAmount)),
        occurredOn: bill.date, postingDate: bill.date,
        causeType: "advance_invoice", causeId: p.advanceBillId,
        journalEntryId: entryId, journalRole: "own_entry",
        ...actor(userId, `Bill ${bill.billNumber} deducts a supplier advance`),
        idempotencyKey: `advance_deducted:${bill.id}:${p.advanceBillId}`,
      });
    }
  },

  /**
   * The EVIDENCE CLAIM (X1), after its VATEV- entry posted: the cache
   * moves to claimed, the held credit notes follow it into the claim (their
   * rows copy the original's — the live return queries read them that way),
   * and the `claimed` event records the WHOLE held amount. When credit notes
   * consumed all of it there is no event (O-6: an event moves a positive
   * amount) — the cache still reads claimed, as today.
   */
  async recordClaim(input: {
    bill: Bill; amount: number; claimedOn: string; entryId: number | null;
    verdict: Pick<VatEvidenceVerdict, "status" | "basis" | "flags"> | null;
    capture?: { id: string; sha256: string } | null;
    userId: number | null;
  }): Promise<Array<{ id: number }>> {
    const { bill, claimedOn, entryId, userId } = input;
    const amount = round2(input.amount);
    // 🔴 RETRY-SAFE AS A WHOLE: a claim happens once. Already claimed → this is a retry: it must restate the SAME
    // claim (date and entry — the event, when there is one, is verified by the database) and changes nothing.
    const [current] = await billsRepository.findById(bill.id);
    const retry = current?.inputVatState === "claimed";
    if (retry && (current.inputVatClaimedOn !== claimedOn || (current.inputVatClaimEntryId ?? null) !== entryId)) {
      throw new BusinessRuleError(409, {
        code: "input_vat_idempotency_conflict",
        error: `${bill.billNumber}'s input VAT was already claimed on ${current.inputVatClaimedOn}; a claim on ${claimedOn} is a different act. Nothing was changed.`,
      });
    }
    if (!retry) await billsRepository.update(bill.id, { inputVatState: "claimed", inputVatPending: "0", inputVatClaimedOn: claimedOn, inputVatClaimEntryId: entryId });
    const notes = retry ? [] : await billsRepository.claimNotesFollowing(bill.id, claimedOn, entryId);
    if (amount > 0) {
      if (entryId == null) throw new Error(`input VAT writer: claim of ${amount} on ${bill.billNumber} posted no entry`);
      await record({
        organizationId: bill.organizationId, companyId: bill.companyId, documentId: bill.id,
        eventType: "claimed", fromBucket: "HELD", toBucket: "CLAIMED", amount: money2(amount),
        occurredOn: claimedOn, postingDate: claimedOn,
        evidenceCaptureId: input.capture?.id ?? null,
        evidenceSnapshot: snapshot(bill, input.verdict, input.capture ?? null),
        journalEntryId: entryId, journalRole: "claim_entry",
        ...actor(userId, `Evidence held for ${bill.billNumber}: input VAT claimed`),
        idempotencyKey: `claimed:${bill.id}`,
      });
    }
    return notes;
  },
};
