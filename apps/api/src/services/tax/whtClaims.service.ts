/**
 * 🔴 Phase 18 G4b — WHT owner decisions 17 and 18 (2026-10-27; register §11.43).
 * Each DECIDED 2026-10-27: an owner decision based on research, not a
 * professional opinion; reversible; to be reviewed before go-live.
 *
 * RECORDS ONLY. Nothing here posts, refunds, offsets, reverses or waives: an
 * over-withheld amount is never reversed in a later month (decisions 16, 17 —
 * G4a's refusal), and an instalment plan changes no figure.
 *
 *  - 17: the REFUND CLAIM — the six-item evidence checklist, the five-year clock
 *    (Income Tax Law Art. 65(c), shown as 31 December of the overpaid tax year
 *    + 5: a reasoned reading of "from the overpaid tax year", not verified), and
 *    its life as events: the evidence updated, submitted, then refunded or
 *    refused. A claim past its deadline is shown so, never refused.
 *  - 18: the INSTALMENT REQUEST under Resolution 1117 (as recorded: returns due
 *    before 1 July 2026, so WHT months up to 2026-05). It COUNTS only once
 *    ZATCA's written acceptance is recorded.
 */
import { WHT_REFUND_CHECKLIST_ITEMS } from "@workspace/db";
import { businessToday, isCalendarDate } from "@workspace/shared";
import { BadRequestError, BusinessRuleError, NotFoundError } from "../../lib/errors";
import { round2 } from "../../lib/money";
import { vendorsRepository } from "../../repositories/vendors.repository";
import { whtClaimsRepository } from "../../repositories/whtClaims.repository";
import { auditService } from "../audit.service";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Resolution 1117 (register research 2026-10-26): fines on returns due before 1 July 2026 — WHT months up to May 2026. */
const RES_1117_LAST_MONTH = "2026-05";
const INSTALMENT_NOTE =
  "Regulations Art. 65(1)(c) normally excludes withheld tax from instalments. A plan for WHT principal counts only once ZATCA's written acceptance is recorded; until then the months stay outstanding, with any delay fine counted from each month's due date.";

const refuse = (status: number, code: string, error: string, field?: string): never => {
  throw new BusinessRuleError(status, { code, error, ...(field ? { field } : {}) });
};
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
function pastDate(v: unknown, field: string): string {
  if (typeof v !== "string" || !isCalendarDate(v)) throw new BadRequestError(`${field} is a real calendar date (YYYY-MM-DD).`);
  if (v > businessToday()) refuse(422, "date_in_future", `${field} has already happened: it is never in the future.`, field);
  return v;
}

type Checklist = Record<(typeof WHT_REFUND_CHECKLIST_ITEMS)[number], { held: boolean; note: string }>;
/** Decision 17's checklist: exactly its six items, each held or not, with a note. */
function checklistOf(v: unknown): Checklist {
  const bad = () => refuse(400, "wht_refund_checklist_invalid", `The checklist names exactly these items, each { held, note }: ${WHT_REFUND_CHECKLIST_ITEMS.join(", ")}.`, "checklist");
  if (!v || typeof v !== "object" || Array.isArray(v)) bad();
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== WHT_REFUND_CHECKLIST_ITEMS.length || !keys.every((k) => (WHT_REFUND_CHECKLIST_ITEMS as readonly string[]).includes(k))) bad();
  const out = {} as Checklist;
  for (const k of WHT_REFUND_CHECKLIST_ITEMS) {
    const item = o[k] as { held?: unknown; note?: unknown } | null;
    if (!item || typeof item.held !== "boolean" || (item.note != null && typeof item.note !== "string")) bad();
    out[k] = { held: item!.held as boolean, note: typeof item!.note === "string" ? item!.note.trim() : "" };
  }
  return out;
}

type ClaimRow = Awaited<ReturnType<typeof whtClaimsRepository.refundClaims>>[number];
type ClaimEventRow = Awaited<ReturnType<typeof whtClaimsRepository.refundClaimEvents>>[number];
function claimOut(c: ClaimRow, events: ClaimEventRow[]) {
  const mine = events.filter((e) => e.claimId === c.id);
  const latestChecklist = [...mine].reverse().find((e) => e.kind === "evidence_updated")?.checklist as Checklist | undefined;
  const checklist = latestChecklist ?? (c.checklist as Checklist);
  const decisive = [...mine].reverse().find((e) => e.kind === "refunded" || e.kind === "refused");
  const submitted = mine.some((e) => e.kind === "submitted");
  const deadline = `${c.overpaidTaxYear + 5}-12-31`;
  return {
    id: c.id, period: c.period, vendorId: c.vendorId, overpaidTaxYear: c.overpaidTaxYear, excessAmount: Number(c.excessAmount),
    borneBy: c.borneBy as "payer" | "beneficiary", reason: c.reason, checklist,
    evidenceHeld: WHT_REFUND_CHECKLIST_ITEMS.filter((k) => checklist[k]?.held).length, evidenceItems: WHT_REFUND_CHECKLIST_ITEMS.length,
    deadline, pastDeadline: businessToday() > deadline,
    state: (decisive?.kind ?? (submitted ? "submitted" : "open")) as "open" | "submitted" | "refunded" | "refused",
    events: mine.map((e) => ({ id: e.id, kind: e.kind, onDate: e.onDate, reference: e.reference ?? null, amount: e.amount == null ? null : Number(e.amount), note: e.note ?? null, createdAt: e.createdAt.toISOString() })),
    createdBy: c.createdBy ?? null, createdAt: c.createdAt.toISOString(),
  };
}

type RequestRow = Awaited<ReturnType<typeof whtClaimsRepository.instalmentRequests>>[number];
type RequestEventRow = Awaited<ReturnType<typeof whtClaimsRepository.instalmentRequestEvents>>[number];
function requestOut(r: RequestRow, events: RequestEventRow[]) {
  const mine = events.filter((e) => e.requestId === r.id);
  const decisive = [...mine].reverse().find((e) => e.kind === "accepted" || e.kind === "refused");
  const state = (decisive?.kind ?? "requested") as "requested" | "accepted" | "refused";
  return {
    id: r.id, periodFrom: r.periodFrom, periodTo: r.periodTo, principal: Number(r.principal), requestedOn: r.requestedOn, reference: r.reference,
    state, counts: state === "accepted",
    acceptance: decisive?.kind === "accepted" ? { onDate: decisive.onDate, reference: decisive.reference ?? "" } : null,
    events: mine.map((e) => ({ id: e.id, kind: e.kind, onDate: e.onDate, reference: e.reference ?? null, note: e.note ?? null, createdAt: e.createdAt.toISOString() })),
    note: INSTALMENT_NOTE, createdBy: r.createdBy ?? null, createdAt: r.createdAt.toISOString(),
  };
}

export const whtClaimsService = {
  // ── decision 17 ────────────────────────────────────────────────────────────
  async refundClaims() {
    const rows = await whtClaimsRepository.refundClaims();
    const events = await whtClaimsRepository.refundClaimEvents(rows.map((r) => r.id));
    return { items: rows.map((r) => claimOut(r, events)) };
  },

  async createRefundClaim(body: Record<string, unknown>, userId: number | null) {
    const period = typeof body.period === "string" && MONTH.test(body.period) ? body.period : refuse(400, "period_invalid", "period is the WHT month the excess was withheld in (YYYY-MM).", "period");
    const vendorId = Number(body.vendorId);
    const [vendor] = Number.isInteger(vendorId) && vendorId > 0 ? await vendorsRepository.findById(vendorId) : [];
    if (!vendor) refuse(422, "reference_not_found", `Supplier ${String(body.vendorId)} does not exist for this organization.`, "vendorId");
    const year = Number(body.overpaidTaxYear);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) refuse(400, "tax_year_invalid", "overpaidTaxYear is the tax year the excess was withheld in (e.g. 2026).", "overpaidTaxYear");
    const excess = typeof body.excessAmount === "number" ? round2(body.excessAmount) : Number.NaN;
    if (!(excess > 0)) refuse(422, "wht_refund_excess_invalid", "The excess withheld is a positive amount.", "excessAmount");
    if (body.borneBy !== "payer" && body.borneBy !== "beneficiary") refuse(400, "wht_refund_borne_by_invalid", "borneBy is payer or beneficiary — who bore the excess.", "borneBy");
    const reason = text(body.reason) ?? refuse(400, "reason_required", "State why the amount was over-withheld.", "reason");
    const checklist = checklistOf(body.checklist);
    const [row] = await whtClaimsRepository.insertRefundClaim({
      period: period as string, vendorId, overpaidTaxYear: year, excessAmount: excess.toFixed(2), borneBy: body.borneBy as string,
      reason: reason as string, checklist, createdBy: userId,
    });
    await auditService.created("wht_refund_claim", row!.id, row);
    return claimOut(row!, []);
  },

  async addRefundClaimEvent(id: number, body: Record<string, unknown>, userId: number | null) {
    const [claim] = await whtClaimsRepository.refundClaim(id);
    if (!claim) throw new NotFoundError("Refund claim not found");
    const kind = body.kind;
    if (kind !== "evidence_updated" && kind !== "submitted" && kind !== "refunded" && kind !== "refused") {
      refuse(400, "wht_refund_event_invalid", "kind is evidence_updated, submitted, refunded or refused.", "kind");
    }
    const onDate = pastDate(body.onDate, "onDate");
    const events = await whtClaimsRepository.refundClaimEvents([id]);
    const current = claimOut(claim, events);
    if (current.state === "refunded" || current.state === "refused") refuse(409, "wht_refund_claim_closed", `This claim is already ${current.state}; its record is closed.`);
    if ((kind === "refunded" || kind === "refused") && current.state !== "submitted") {
      refuse(409, "wht_refund_claim_not_submitted", "Record the claim's submission to ZATCA first: a refund or a refusal answers a submitted claim.", "kind");
    }
    const amount = kind === "refunded" ? (typeof body.amount === "number" ? round2(body.amount) : Number.NaN) : null;
    if (kind === "refunded" && !(amount! > 0)) refuse(422, "wht_refund_amount_invalid", "The amount refunded is a positive amount.", "amount");
    const [row] = await whtClaimsRepository.insertRefundClaimEvent({
      claimId: id, kind: kind as string, onDate, reference: text(body.reference), amount: amount == null ? null : amount.toFixed(2),
      note: text(body.note), checklist: kind === "evidence_updated" ? checklistOf(body.checklist) : null, createdBy: userId,
    });
    await auditService.created("wht_refund_claim_event", row!.id, row);
    return claimOut(claim, [...events, row!]);
  },

  // ── decision 18 ────────────────────────────────────────────────────────────
  async instalmentRequests() {
    const rows = await whtClaimsRepository.instalmentRequests();
    const events = await whtClaimsRepository.instalmentRequestEvents(rows.map((r) => r.id));
    return { items: rows.map((r) => requestOut(r, events)) };
  },

  async createInstalmentRequest(body: Record<string, unknown>, userId: number | null) {
    const from = typeof body.periodFrom === "string" && MONTH.test(body.periodFrom) ? body.periodFrom : refuse(400, "period_invalid", "periodFrom is a WHT month (YYYY-MM).", "periodFrom");
    const to = typeof body.periodTo === "string" && MONTH.test(body.periodTo) ? body.periodTo : refuse(400, "period_invalid", "periodTo is a WHT month (YYYY-MM).", "periodTo");
    if ((from as string) > (to as string)) refuse(400, "period_invalid", "periodFrom is on or before periodTo.", "periodTo");
    if ((to as string) > RES_1117_LAST_MONTH) {
      refuse(422, "wht_instalment_month_ineligible",
        `Resolution 1117 covers returns due before 1 July 2026 — WHT months up to ${RES_1117_LAST_MONTH}. ${to} is later, so it cannot be in this request.`, "periodTo");
    }
    const principal = typeof body.principal === "number" ? round2(body.principal) : Number.NaN;
    if (!(principal > 0)) refuse(422, "wht_instalment_principal_invalid", "The principal is a positive amount.", "principal");
    const requestedOn = pastDate(body.requestedOn, "requestedOn");
    const reference = text(body.reference) ?? refuse(400, "reference_required", "The reference of the request made to ZATCA is required.", "reference");
    const [row] = await whtClaimsRepository.insertInstalmentRequest({
      periodFrom: from as string, periodTo: to as string, principal: principal.toFixed(2), requestedOn, reference: reference as string, note: text(body.note), createdBy: userId,
    });
    await auditService.created("wht_instalment_request", row!.id, row);
    return requestOut(row!, []);
  },

  async addInstalmentRequestEvent(id: number, body: Record<string, unknown>, userId: number | null) {
    const [req] = await whtClaimsRepository.instalmentRequest(id);
    if (!req) throw new NotFoundError("Instalment request not found");
    if (body.kind !== "accepted" && body.kind !== "refused") refuse(400, "wht_instalment_event_invalid", "kind is accepted (ZATCA's written acceptance) or refused.", "kind");
    const onDate = pastDate(body.onDate, "onDate");
    const events = await whtClaimsRepository.instalmentRequestEvents([id]);
    const current = requestOut(req, events);
    if (current.state !== "requested") refuse(409, "wht_instalment_request_closed", `This request is already ${current.state}; its record is closed.`);
    const reference = text(body.reference);
    if (body.kind === "accepted" && !reference) refuse(400, "wht_instalment_acceptance_reference_required", "Record the reference of ZATCA's WRITTEN acceptance: the plan counts only on it.", "reference");
    const [row] = await whtClaimsRepository.insertInstalmentRequestEvent({ requestId: id, kind: body.kind as string, onDate, reference, note: text(body.note), createdBy: userId });
    await auditService.created("wht_instalment_request_event", row!.id, row);
    return requestOut(req, [...events, row!]);
  },
};
