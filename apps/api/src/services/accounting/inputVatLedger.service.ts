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
import { db, inputVatEventsTable, type billsTable, type OpeningPayableVatDeclaration } from "@workspace/db";
import { BusinessRuleError } from "../../lib/errors";
import { money2, round2 } from "../../lib/money";
import { billsRepository } from "../../repositories/bills.repository";
import { billOutstandingSql } from "../../repositories/billPosition";
import type { VatEvidenceVerdict } from "../purchaseEvidence/vatEvidence";

type Bill = typeof billsTable.$inferSelect;
export type InputVatTreatment = "claimed" | "awaiting_evidence" | "not_deductible";
/** Where a document's input VAT can sit when a credit note meets it (S1 adds the declared positions). */
export type NoteBucket = "HELD" | "CLAIMED" | "BLOCKED" | "REVERSED_UNPAID" | "NOT_DEDUCTED";

const BUCKET: Record<InputVatTreatment, NoteBucket> = { claimed: "CLAIMED", awaiting_evidence: "HELD", not_deductible: "BLOCKED" };

/**
 * 🔴 S1 — A CREDIT NOTE'S TREATMENT COMES FROM THE LEDGER, never from the
 * original's cache column (for an opening payable that column is empty or
 * reads `claimed` by 0106's convention — it says nothing about the history).
 * The ONE non-zero bucket the note meets decides it: VAT that was DEDUCTED
 * (CLAIMED) is reduced in full; VAT held for evidence follows the original (X3);
 * VAT with no input-VAT effect — Art. 50 BLOCKED, never deducted, fully
 * reversed with nothing restored — is cost, so the note reduces the cost and
 * input VAT by 0 (AQ-2; R1 Case 2).
 */
export function treatmentForBucket(bucket: NoteBucket): InputVatTreatment {
  return bucket === "CLAIMED" ? "claimed" : bucket === "HELD" ? "awaiting_evidence" : "not_deductible";
}
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
async function record(values: Omit<EventValues, "provenance">, provenance: "recorded" | "declared" = "recorded"): Promise<boolean> {
  try {
    const rows = await db.insert(inputVatEventsTable).values({ ...values, provenance })
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

/**
 * The refusals O-2 names (design §19.4, §19.8), and S1's (contract §13, §15):
 * an opening payable's note needs the supplier's document, a declared history
 * and a non-transitional supply; a document holding VAT in two positions, and
 * a note settling a payable whose reversed VAT would stay restorable, wait for
 * S2 / the accountant. Every one names its next step; nothing is posted.
 */
const NOTE_REFUSALS = new Set([
  "credit_note_exceeds_invoice_vat", "input_vat_note_interaction_undecided", "input_vat_note_allocation_undecided",
  "supplier_note_evidence_missing", "input_vat_note_opening_undeclared", "input_vat_note_transitional_supply",
  "input_vat_note_multistate", "input_vat_note_overpaid_reversed", "input_vat_note_opening_reversed",
]);

function noteRefusalWords(code: string, original: Bill, vat: number, left: string, ceiling: string, bucketAmount: string): string {
  const words: Record<string, string> = {
    supplier_note_evidence_missing:
      `${original.billNumber} is an opening balance migrated at cut-over. A supplier credit note against it must carry the supplier's own credit note as evidence — attach the supplier's document to this draft, then post it again. This applies even when the note shows no VAT: the VAT is what the supplier's document says. Nothing was posted.`,
    input_vat_note_opening_reversed:
      `${original.billNumber} is an opening balance its migration has since reversed (the batch was withdrawn, or the amount was corrected onto a replacement). It is history, not a live debt, so no credit note corrects it — record the note against the live payable, if there is one. Nothing was posted.`,
    input_vat_note_opening_undeclared:
      `${original.billNumber} is an opening balance migrated at cut-over, and how its input VAT was treated in the previous system has not been declared — so what this credit note does to input VAT is unknown. An admin or accountant declares it once, with its evidence, under Migration → open items; then post the note again. Nothing was posted.`,
    input_vat_note_transitional_supply:
      `${original.billNumber} is a transitional supply (made before 1 January 2018, or taxed at 5 %). A supplier credit note against it is not supported here yet. Nothing was posted.`,
    input_vat_note_multistate:
      `${original.billNumber}'s input VAT sits in more than one position (for example part deducted and part reversed). A credit note against it needs the proportional split, which is not available yet. Nothing was posted.`,
    input_vat_note_overpaid_reversed:
      `This credit note would settle what is still owed on ${original.billNumber} while part of its input VAT reversed under Art. 40(10) would remain restorable. How that remainder is treated awaits the accountant's decision, so the note cannot be recorded yet. Nothing was posted.`,
    credit_note_exceeds_invoice_vat:
      `This credit note reduces VAT by ${vat.toFixed(2)}, but only ${left} of the ${ceiling} VAT charged on ${original.billNumber} is left after its other credit notes. A credit note cannot credit more VAT than the invoice charged (VAT IR Art. 54(1)) — check the note's VAT amount.`,
    input_vat_note_interaction_undecided:
      `${original.billNumber}'s input VAT has been reversed, restored, corrected or written off since it was recorded. How a supplier credit note applies after that is not yet decided, so it cannot be recorded; nothing was posted.`,
    input_vat_note_allocation_undecided:
      `This credit note's VAT (${vat.toFixed(2)}) is within the VAT charged on ${original.billNumber}, but more than the VAT that bill itself still holds (${bucketAmount}) — part of it would reach VAT recorded on another document (a supplier advance or a debit note). How that is allocated is not yet decided, so it cannot be recorded; nothing was posted.`,
  };
  return words[code] ?? `This credit note cannot be recorded against ${original.billNumber} (${code}).`;
}

/**
 * 🔴 S1 / reconciliation B8 — refused, NOT decided. A note that would settle
 * what an opening payable still owes, while its fully reversed VAT keeps a
 * restorable remainder after this note, leaves that remainder's treatment open
 * (accountant). Asked of EVERY such note, VAT 0 included.
 *
 * What is still owed = what the bill owes (`billOutstandingSql` — the ONE
 * definition; it already nets every LIVE application to this bill, credit-note
 * applications included) less the UNAPPLIED balance of the other posted notes
 * against it. Conservative on purpose: an unapplied note is counted as settling
 * this bill; a note applied elsewhere settled that other bill and is not.
 */
async function assertNotSettlingReversed(note: Bill, original: Bill, vat: number, reversedInBucket: number): Promise<void> {
  if (!(reversedInBucket - vat > 0.005)) return; // nothing restorable would remain
  const { rows: pos } = await db.execute<{ outstanding: string; unapplied: string }>(sql`
    SELECT ${billOutstandingSql("b")}::text AS outstanding,
           coalesce((SELECT sum(n.total::numeric - coalesce((SELECT sum(a.amount::numeric) FROM supplier_payment_allocations a
                                                              WHERE a.supplier_credit_note_id = n.id
                                                                AND NOT EXISTS (SELECT 1 FROM supplier_payment_allocation_reversals r WHERE r.allocation_id = a.id)), 0))
                      FROM bills n
                     WHERE n.credit_note_against_bill_id = b.id AND n.document_type = 'credit_note'
                       AND n.status NOT IN ('draft', 'submitted') AND n.id <> ${note.id}), 0)::text AS unapplied
      FROM bills b WHERE b.id = ${original.id}`);
  const stillOwed = round2(Number(pos[0]?.outstanding ?? 0) - Number(pos[0]?.unapplied ?? 0));
  if (round2(Number(note.total)) >= stillOwed - 0.005) {
    throw new BusinessRuleError(422, {
      code: "input_vat_note_overpaid_reversed",
      error: noteRefusalWords("input_vat_note_overpaid_reversed", original, vat, "0.00", "0.00", "0.00"),
      field: "total",
    });
  }
}

export const inputVatLedgerService = {
  /**
   * 🔴 O-2, D-6 and S1, asked BEFORE a supplier credit note posts — so a
   * refusal reaches the user in words, never as a raw database error. The same
   * SQL functions (`input_vat_opening_note_precheck`, `input_vat_note_refusal`)
   * are what the admission trigger and the commit check read.
   * Returns the ledger bucket the note reduces (null when it carries no VAT).
   */
  async assertNoteAdmissible(note: Bill, original: Bill): Promise<NoteBucket | null> {
    // D-6 (O-4): a note corrects an invoice already issued (IR Art. 54(4)).
    if (note.date < original.date) {
      throw new BusinessRuleError(422, {
        code: "credit_note_before_original",
        error: `This credit note is dated ${note.date}, before ${original.billNumber} (dated ${original.date}), the document it corrects. A supplier's credit note corrects an invoice already issued — check the note's date.`,
        field: "date",
      });
    }
    const vat = round2(Number(note.vatAmount));
    // 🔴 S1 (paper §G Rule 3): against an OPENING payable, VAT 0 is not a bypass —
    // the supplier's document, a declared history and a non-transitional supply
    // are required for EVERY note, whatever VAT it states.
    if (original.isOpening) {
      const { rows } = await db.execute<{ pre: string | null }>(sql`SELECT input_vat_opening_note_precheck(${original.id}, ${note.id}) AS pre`);
      const pre = rows[0]?.pre ?? null;
      if (pre) throw new BusinessRuleError(422, { code: pre, error: noteRefusalWords(pre, original, vat, "0.00", "0.00", "0.00"), field: pre === "supplier_note_evidence_missing" ? "captureId" : "creditNoteAgainstBillId" });
    }
    if (!(vat > 0)) {
      // A VAT-free note moves no VAT — but settling a fully reversed payable strands its restorable
      // remainder exactly as a VAT-bearing one would, so B8 asks the same question of it.
      if (original.isOpening) {
        const { rows: bal } = await db.execute<{ reversed: string | null }>(sql`SELECT reversed_unpaid::text AS reversed FROM input_vat_balances WHERE document_id = ${original.id}`);
        await assertNotSettlingReversed(note, original, 0, Number(bal[0]?.reversed ?? 0));
      }
      return null;
    }
    const { rows } = await db.execute<{ refusal: string | null; from_bucket: NoteBucket | null; remaining: string; bucket_amount: string; ceiling: string }>(
      sql`SELECT refusal, from_bucket, remaining::text, bucket_amount::text, input_vat_document_ceiling(${original.id})::text AS ceiling
            FROM input_vat_note_refusal(${original.id}, ${note.id}, ${money2(vat)}::numeric)`);
    const r = rows[0]!;
    if (r.refusal) {
      const field = r.refusal === "supplier_note_evidence_missing" ? "captureId" : NOTE_REFUSALS.has(r.refusal) ? "vatAmount" : "creditNoteAgainstBillId";
      throw new BusinessRuleError(422, {
        code: r.refusal,
        error: noteRefusalWords(r.refusal, original, vat, Number(r.remaining).toFixed(2), Number(r.ceiling).toFixed(2), Number(r.bucket_amount).toFixed(2)),
        field,
      });
    }
    if (r.from_bucket === "REVERSED_UNPAID") await assertNotSettlingReversed(note, original, vat, Number(r.bucket_amount));
    return r.from_bucket;
  },

  /**
   * 🔴 S1 — AN OPENING PAYABLE'S DECLARED HISTORY, into the ledger. ONE
   * `declared_opening` event per declaration, in the declaration's own
   * transaction: the whole historical VAT H(D), into the bucket its state
   * names, dated the declaration's date, provenance `declared`, no journal
   * entry (the historical GL is the cut-over aggregate). From here the ledger's
   * buckets — not the declaration, not the bill's columns — decide what a credit
   * note does. The database restates the declaration against the event (0110).
   */
  async recordDeclaredOpening(input: { declaration: OpeningPayableVatDeclaration; bill: Bill; userId: number }): Promise<boolean> {
    const { declaration: dc, bill, userId } = input;
    const toBucket = ({ DEDUCTED: "CLAIMED", NOT_DEDUCTED: "NOT_DEDUCTED", BLOCKED_ART50: "BLOCKED", REVERSED_ART40_10: "REVERSED_UNPAID" } as const)[
      dc.state as "DEDUCTED" | "NOT_DEDUCTED" | "BLOCKED_ART50" | "REVERSED_ART40_10"];
    return record({
      organizationId: bill.organizationId, companyId: bill.companyId, documentId: bill.id,
      eventType: "declared_opening", fromBucket: "NONE", toBucket, amount: dc.historicalVat,
      occurredOn: dc.declaredOn, postingDate: dc.declaredOn,
      declarationId: dc.id,
      ...actor(userId, `Historical input VAT of opening payable ${bill.billNumber} declared (${dc.state})`),
      idempotencyKey: `declared_opening:${dc.id}`,
    }, "declared");
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
    /** S1: a credit note's bucket, AS THE LEDGER GAVE IT (`assertNoteAdmissible`) — never inferred from a cache. */
    noteBucket?: NoteBucket | null;
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
        eventType: "reduced_by_note", fromBucket: input.noteBucket ?? BUCKET[treatment], toBucket: "NONE", amount: money2(vat),
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
