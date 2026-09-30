/**
 * 🔴 PHASE 13B S1 — DECLARING AN OPENING PAYABLE'S HISTORICAL INPUT VAT (2026-09-30).
 * Records: docs/product/phase-13b-level-policy-implementation-contract.md §1 AC-8,
 *          §15 (the review), §16 (owner decisions D1–D7); decision paper
 *          docs/product/phase-13b3-opening-payable-credit-note-decision-paper.md
 *          §0.1 (AQ-1), §0.2 (AQ-2), §B, §F (option D), §M.4.
 *
 * A migrated payable's VAT was accounted for in the PREVIOUS system. What a later
 * supplier credit note does to input VAT depends on how it was treated there
 * (IR 40(6); GCC 47(1); accountant R1). This is the one act that states it:
 *
 *   · ONCE per committed staging item, by an admin or an accountant (D4 — a
 *     dedicated grant, `opening_vat_declaration`), never edited;
 *   · for the four histories S1 acts on (D3): DEDUCTED, NOT_DEDUCTED,
 *     BLOCKED_ART50, REVERSED_ART40_10 (fully reversed, nothing restored, the
 *     reversed VAT carried in COST — D7). Anything else is refused by name;
 *   · WITH the evidence its state requires (accountant AQ-1; the §M.4 product
 *     evidence policy — NOT a ZATCA-prescribed format). No evidence → nothing is
 *     declared, and the item stays UNKNOWN;
 *   · feeding the input-VAT ledger through ONE `declared_opening` event, in the
 *     same transaction. From then on the ledger's buckets decide credit notes.
 *
 * It never writes the frozen staging row, and reads only `historical_vat`'s
 * documented `amount` and `rate` — never `reportedPeriod`, never the bad-debt
 * keys (paper §E.5). The evidence documents are captures promoted as evidence OF
 * the opening bill (the existing capture outbox: retained, never purged while a
 * declaration holds them).
 *
 * 🔴 The database is the boundary (migration 0110): it refuses the same things at
 * insert or at commit. What this file adds is the refusal IN WORDS, first.
 */
import {
  OPENING_VAT_EVIDENCE_KINDS,
  OPENING_VAT_STATES,
  openingPayableVatDeclarationsTable,
  type OpeningPayableVatDeclaration,
  type OpeningVatEvidenceKind,
  type OpeningVatState,
} from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { BadRequestError, BusinessRuleError, NotFoundError } from "../lib/errors";
import { money2, round2 } from "../lib/money";
import { capturedDocumentsRepository } from "../repositories/capturedDocuments.repository";
import { openingVatDeclarationsRepository } from "../repositories/openingVatDeclarations.repository";
import { inputVatLedgerService } from "./accounting/inputVatLedger.service";
import { auditService } from "./audit.service";
import { captureService } from "./capture/capture.service";

/** The evidence each history requires (accountant AQ-1; paper §B / §M.4; the database requires the same, 0110). */
export const REQUIRED_EVIDENCE: Record<OpeningVatState, readonly OpeningVatEvidenceKind[]> = {
  DEDUCTED: ["ORIGINAL_TAX_INVOICE", "DEDUCTION_RETURN"],
  NOT_DEDUCTED: ["ORIGINAL_TAX_INVOICE"],
  BLOCKED_ART50: ["ORIGINAL_TAX_INVOICE", "CLASSIFICATION"],
  REVERSED_ART40_10: ["ORIGINAL_TAX_INVOICE", "DEDUCTION_RETURN", "REVERSAL_RETURN", "PAYMENT_RECORDS"],
};

/** Histories that exist but S1 does not act on — refused by name, never approximated (S2 / S3). */
const LATER_STATES = new Set(["PARTIALLY_DEDUCTED", "PARTIALLY_RESTORED", "ART51_APPORTIONED", "LINE_SPLIT"]);

const STATE_WORDS: Record<OpeningVatState, string> = {
  DEDUCTED: "deducted in the previous system",
  NOT_DEDUCTED: "never deducted, and carried in cost or the asset",
  BLOCKED_ART50: "blocked under VAT IR Art. 50 (never deductible)",
  REVERSED_ART40_10: "deducted, then fully reversed under VAT IR Art. 40(10) with nothing restored, the reversed VAT carried in cost",
};

export interface DeclareOpeningVatInput {
  itemId: number;
  state: string;
  historicalVat?: number | null;
  vatRate?: number | null;
  deductedPeriod?: string | null;
  notDeductedReason?: string | null;
  carriedInCost?: boolean | null;
  art50Ground?: string | null;
  reversedPeriod?: string | null;
  reversedVatLocation?: string | null;
  recordReference?: string | null;
  evidence: Array<{ kind: string; captureId: string }>;
}

const refuse = (status: number, code: string, error: string, field?: string): never => {
  throw new BusinessRuleError(status, { code, error, ...(field ? { field } : {}) });
};
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The last day of (supply month + 12): D13B-06's Art. 40(10) trigger date (the month after supply is month 1). */
export function art4010TriggerDate(supplyDate: string): string {
  const y = Number(supplyDate.slice(0, 4));
  const m = Number(supplyDate.slice(5, 7)); // 1-12
  const last = new Date(Date.UTC(y + 1, m, 0)); // day 0 of the month after (supply month + 12)
  return last.toISOString().slice(0, 10);
}

function mapDatabaseRefusal(err: unknown): never {
  const pg = err as { cause?: { constraint?: string; message?: string }; constraint?: string; message?: string };
  const constraint = pg.cause?.constraint ?? pg.constraint ?? "";
  // Two declarations of one item racing: the loser meets the unique index — the same answer as the pre-check.
  if (constraint === "opening_payable_vat_declarations_item_unq" || constraint === "input_vat_events_one_declared_opening_unq") {
    throw new BusinessRuleError(409, { code: "opening_vat_declaration_exists", error: "This migrated item's VAT history was declared at the same moment by someone else. A declaration is permanent; nothing more was declared." });
  }
  if (/^opening_vat_declaration|^opening_item_not_live|^opening_vat_declarations/.test(constraint)) {
    throw new BusinessRuleError(422, { code: constraint, error: pg.cause?.message ?? pg.message ?? constraint });
  }
  throw err;
}

export const openingVatDeclarationsService = {
  async list() {
    const rows = await openingVatDeclarationsRepository.list();
    const evidence = await openingVatDeclarationsRepository.evidenceFor(rows.map((r) => r.id));
    return rows.map((r) => ({ ...present(r), evidence: evidence.filter((e) => e.declarationId === r.id).map((e) => ({ kind: e.kind, captureId: e.captureId, captureSha256: e.captureSha256 })) }));
  },

  async declare(input: DeclareOpeningVatInput, userId: number | null) {
    if (userId == null) refuse(401, "unauthenticated", "Sign in to declare a historical VAT position.");
    const state = String(input.state ?? "");
    if (LATER_STATES.has(state)) {
      refuse(422, "opening_vat_declaration_state_not_enabled",
        `A ${state.replace(/_/g, " ").toLowerCase()} history needs the proportional treatment, which is not available yet (S2/S3). Nothing was declared; the item stays unknown, and credit notes against it are refused.`, "state");
    }
    if (!(OPENING_VAT_STATES as readonly string[]).includes(state)) {
      throw new BadRequestError(`state must be one of ${OPENING_VAT_STATES.join(", ")}.`);
    }
    const st = state as OpeningVatState;

    const item = await openingVatDeclarationsRepository.findItem(Number(input.itemId));
    if (!item) throw new NotFoundError("Migrated open item not found");
    if (item.itemType !== "ap") {
      refuse(422, "opening_vat_declaration_not_payable", `Migrated item ${item.documentNumber} is a receivable. An input VAT history belongs to a payable.`, "itemId");
    }
    const bill = item.batchStatus === "committed" ? await openingVatDeclarationsRepository.liveBillForItem(item.id) : null;
    if (!bill) {
      refuse(409, "opening_item_not_live", `Migrated item ${item.documentNumber} has no live opening payable (its migration is not committed, or was reversed). Declare it on the live migration.`, "itemId");
    }
    if (await openingVatDeclarationsRepository.findByItem(item.id)) {
      refuse(409, "opening_vat_declaration_exists", `The historical VAT of ${item.documentNumber} is already declared. A declaration is made once and never changed.`, "itemId");
    }

    // The staged figures are FACTS of the migration: a declaration restates them, never contradicts them.
    const staged = (item.historicalVat ?? {}) as { amount?: number | null; rate?: number | null };
    const stagedAmount = staged.amount == null ? null : round2(Number(staged.amount));
    const stagedRate = staged.rate == null ? null : round2(Number(staged.rate));
    const historicalVat = input.historicalVat == null ? stagedAmount : round2(Number(input.historicalVat));
    const vatRate = input.vatRate == null ? stagedRate : round2(Number(input.vatRate));
    if (historicalVat == null || !(historicalVat > 0)) {
      refuse(422, "opening_vat_declaration_amount_required", `State the historical invoice's VAT for ${item.documentNumber} (the migration did not stage it).`, "historicalVat");
    }
    if (vatRate == null || !(vatRate > 0) || vatRate > 100) {
      refuse(422, "opening_vat_declaration_rate_required", `State the historical invoice's VAT rate (%) for ${item.documentNumber} (the migration did not stage it).`, "vatRate");
    }
    if (stagedAmount != null && Math.abs(stagedAmount - historicalVat!) > 0.005) {
      refuse(422, "opening_vat_declaration_contradicts_staging", `The migration staged historical VAT ${stagedAmount.toFixed(2)} for ${item.documentNumber}; the declaration cannot state ${historicalVat!.toFixed(2)}.`, "historicalVat");
    }
    if (stagedRate != null && Math.abs(stagedRate - vatRate!) > 0.005) {
      refuse(422, "opening_vat_declaration_contradicts_staging", `The migration staged a ${stagedRate} % rate for ${item.documentNumber}; the declaration cannot state ${vatRate} %.`, "vatRate");
    }
    // Arithmetic, not judgement: a document of gross G at rate r carries at most
    // G·r/(100+r) of VAT — and exactly that only when ALL of it was standard-rated.
    // A mixed supply carries less, so there is no lower bound.
    const maxVat = round2((Number(item.originalAmount) * vatRate!) / (100 + vatRate!));
    if (historicalVat! > maxVat + 0.005) {
      refuse(422, "opening_vat_declaration_exceeds_document", `${item.documentNumber} was ${money2(Number(item.originalAmount))} in total; at ${vatRate} % it can have carried at most ${money2(maxVat)} of VAT, not ${money2(historicalVat!)}.`, "historicalVat");
    }

    const invoiceMonth = bill!.date.slice(0, 7);
    const cutoverMonth = String(item.openingDate).slice(0, 7);
    const period = (v: unknown, field: string, what: string): string => {
      const p = text(v);
      if (!p || !PERIOD.test(p)) refuse(422, "opening_vat_declaration_period_required", `State ${what} as YYYY-MM.`, field);
      if (p! < invoiceMonth || p! > cutoverMonth) refuse(422, "opening_vat_declaration_period_out_of_range", `${what} (${p}) must fall between the invoice (${invoiceMonth}) and the cut-over (${cutoverMonth}).`, field);
      return p!;
    };
    const facts: Partial<typeof openingPayableVatDeclarationsTable.$inferInsert> = {};
    if (st === "DEDUCTED" || st === "REVERSED_ART40_10") facts.deductedPeriod = period(input.deductedPeriod, "deductedPeriod", "the return period that deducted it");
    if (st === "DEDUCTED") {
      // 🔴 §15.1.4 (accountant §M.6 #7): unpaid past its 40(10) trigger before the cut-over, a deduction that was never reversed is not an established history.
      const trigger = art4010TriggerDate(bill!.date);
      if (trigger < String(item.openingDate)) {
        refuse(422, "opening_vat_declaration_40_10_not_established",
          `${item.documentNumber} was still unpaid at its VAT IR Art. 40(10) trigger (${trigger}), before the cut-over (${item.openingDate}). A deduction that was never reversed then is not an established history: declare the reversal (fully reversed, nothing restored), or leave it undeclared.`, "state");
      }
    }
    if (st === "NOT_DEDUCTED") {
      facts.notDeductedReason = text(input.notDeductedReason) ?? refuse(422, "opening_vat_declaration_reason_required", "State why the input VAT was never deducted (accountant AQ-1).", "notDeductedReason");
      if (input.carriedInCost !== true) {
        refuse(422, "opening_vat_declaration_premise_not_affirmed",
          "Affirm that the previous system carried the undeducted VAT in cost or in the asset (accountant AQ-2's premise). A history where it sat in a VAT balance awaiting deduction is not covered, so it cannot be declared yet.", "carriedInCost");
      }
      facts.carriedInCost = true;
    }
    if (st === "BLOCKED_ART50") {
      facts.art50Ground = text(input.art50Ground) ?? refuse(422, "opening_vat_declaration_ground_required", "State the VAT IR Art. 50 ground that blocked the deduction.", "art50Ground");
    }
    if (st === "REVERSED_ART40_10") {
      facts.reversedPeriod = period(input.reversedPeriod, "reversedPeriod", "the return period of the Art. 40(10) reversal");
      if (facts.reversedPeriod! < facts.deductedPeriod!) refuse(422, "opening_vat_declaration_period_out_of_range", "The reversal cannot precede the deduction it reverses.", "reversedPeriod");
      const location = text(input.reversedVatLocation);
      if (!location) {
        refuse(422, "opening_vat_declaration_location_required",
          "State where the previous system carried the reversed VAT — in cost, or in an adjustment account. It is never assumed (owner decision D7).", "reversedVatLocation");
      }
      if (location === "adjustment_account") {
        refuse(422, "opening_vat_declaration_state_not_enabled",
          "A reversal carried in an adjustment account awaits the accountant's guidance on how that migrated balance moves, so it cannot be declared yet. Nothing was declared; the item stays unknown.", "reversedVatLocation");
      }
      if (location !== "cost") throw new BadRequestError("reversedVatLocation must be cost or adjustment_account.");
      facts.reversedVatLocation = "cost";
    }

    // 🔴 The evidence its state requires (AQ-1 / §M.4). Without it nothing is declared — the item stays UNKNOWN.
    const evidence = (input.evidence ?? []).map((e) => ({ kind: String(e.kind), captureId: String(e.captureId) }));
    for (const e of evidence) {
      if (!(OPENING_VAT_EVIDENCE_KINDS as readonly string[]).includes(e.kind)) throw new BadRequestError(`evidence kind must be one of ${OPENING_VAT_EVIDENCE_KINDS.join(", ")}.`);
    }
    // One document is one kind of evidence — else one upload satisfies every required kind (0110 refuses it too).
    const reused = evidence.find((e, i) => evidence.some((o, j) => j !== i && o.captureId === e.captureId && o.kind !== e.kind));
    if (reused) {
      refuse(422, "opening_vat_declaration_evidence_reused", `The same document was given as more than one kind of evidence (${reused.kind} and another). Each kind needs its own document — the invoice and the return that deducted it are different records.`, "evidence");
    }
    const missing = REQUIRED_EVIDENCE[st].filter((k) => !evidence.some((e) => e.kind === k));
    if (missing.length > 0) {
      refuse(422, "opening_vat_declaration_evidence_missing",
        `A ${st.replace(/_/g, " ").toLowerCase()} history needs this evidence, which is missing: ${missing.join(", ")}. Nothing was declared; the item stays unknown, and credit notes against it are refused.`, "evidence");
    }
    const captures = new Map<string, NonNullable<Awaited<ReturnType<typeof capturedDocumentsRepository.findById>>>>();
    for (const id of new Set(evidence.map((e) => e.captureId))) {
      const cap = await capturedDocumentsRepository.findById(id);
      const usable = cap && cap.status !== "discarded" && (cap.billId == null || cap.billId === bill!.id)
        && (cap.status === "staged" || cap.billId === bill!.id);
      if (!usable) {
        refuse(422, "capture_unavailable", "That document cannot be used as evidence: it is already the evidence of another document, or was discarded.", "evidence");
      }
      captures.set(id, cap!);
    }

    try {
      // Each document becomes evidence OF the opening payable (the capture outbox — retained, never purged).
      for (const [id, cap] of captures) if (cap.status === "staged") await captureService.attachToBill(id, bill!.id);
      const declaredOn = businessToday();
      const declaration = await openingVatDeclarationsRepository.insert({
        migrationOpenItemId: item.id,
        billId: bill!.id,
        state: st,
        historicalVat: money2(historicalVat!),
        vatRate: money2(vatRate!),
        ...facts,
        recordReference: text(input.recordReference),
        statement: `The input VAT of ${item.documentNumber} (${money2(historicalVat!)} at ${vatRate} %) was ${STATE_WORDS[st]}, as the attached evidence shows.`,
        declaredBy: userId!,
        declaredOn,
      });
      await openingVatDeclarationsRepository.insertEvidence(
        evidence.map((e) => ({ declarationId: declaration.id, kind: e.kind, captureId: e.captureId, captureSha256: captures.get(e.captureId)!.sha256 })),
      );
      await inputVatLedgerService.recordDeclaredOpening({ declaration, bill: bill!, userId: userId! });
      await auditService.record({
        action: "opening_vat_declaration_record",
        entityType: "bill",
        entityId: bill!.id,
        before: null,
        after: { declarationId: declaration.id, stagingItemId: item.id, sourceDocument: item.documentNumber, state: st, historicalVat: declaration.historicalVat, evidence },
      });
      return { ...present(declaration), evidence: evidence.map((e) => ({ ...e, captureSha256: captures.get(e.captureId)!.sha256 })) };
    } catch (err) {
      if (err instanceof BusinessRuleError || err instanceof BadRequestError) throw err;
      mapDatabaseRefusal(err);
    }
  },
};

function present(r: OpeningPayableVatDeclaration) {
  return {
    id: r.id, itemId: r.migrationOpenItemId, billId: r.billId, state: r.state,
    historicalVat: Number(r.historicalVat), vatRate: Number(r.vatRate),
    deductedPeriod: r.deductedPeriod, notDeductedReason: r.notDeductedReason, carriedInCost: r.carriedInCost,
    art50Ground: r.art50Ground, reversedPeriod: r.reversedPeriod, reversedVatLocation: r.reversedVatLocation,
    recordReference: r.recordReference, statement: r.statement, declaredBy: r.declaredBy, declaredOn: r.declaredOn,
  };
}
