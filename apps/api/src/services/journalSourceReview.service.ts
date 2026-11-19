/**
 * 🔴 A15 review (owner decisions 2026-11-17 and 2026-11-19; migration 0164) — THE UNCLASSIFIED-ENTRIES REVIEW.
 *
 * The 0163 back-fill tagged every old journal entry from authoritative relationships only and left the rest
 * `legacy_unclassified`. The generic reverse refuses them, and an unclassified draft is never posted: "classify it
 * through the review route first" (owner, 2026-11-19). The owner's terms (2026-11-17): the screen exposes the evidence
 * and the review status; an administrator's stated reason alone never makes an entry `manual`; `manual` waits for an
 * accountant-approved policy.
 *
 *  - READ by an admin or an accountant of the organisation; refused to every other role.
 *  - CLASSIFY by an admin only, and only as a candidate 0163's own rules confirm at the moment of the act — the
 *    database function re-runs them, so this service never decides what is evidence. Never `manual`.
 *  - Every refusal is structured (code, English, Arabic), whether this service or the database refuses first.
 */
import { journalSourceReviewRepository, type ReviewListRow } from "../repositories/journalSourceReview.repository";
import { BusinessRuleError } from "../lib/errors";
import { pgErrorFields } from "../lib/dbRefusals";

/** The rules whose candidate the review may write: F a document's own key, N its number, S Batch 1C, R reversal_of. */
const REVIEWABLE_RULES = new Set(["F", "N", "S", "R"]);
/** Tags a review never writes: no source row stands behind them, or (manual) an accountant's policy comes first. */
const NEVER_BY_REVIEW = new Set(["manual", "legacy_unclassified", "demo_seed", "test_fixture"]);

type Refusal = { status: 403 | 404 | 409 | 422; code: string; error: string; errorAr: string };

export const REVIEW_REFUSALS = {
  forbidden: {
    status: 403,
    code: "journal_source_review_forbidden",
    error: "Only an admin or an accountant of this organisation reads the review of unclassified entries.",
    errorAr: "لا يطّلع على مراجعة القيود غير المصنَّفة إلا مسؤول أو محاسب في هذه المنشأة.",
  },
  adminOnly: {
    status: 403,
    code: "journal_source_review_admin_only",
    error: "Only an admin of this organisation classifies an unclassified entry. Nothing was changed.",
    errorAr: "لا يصنِّف القيد غير المصنَّف إلا مسؤول في هذه المنشأة. لم يتغيّر شيء.",
  },
  notFound: {
    status: 404,
    code: "journal_source_review_entry_not_found",
    error: "This entry is not on this company's review of unclassified entries. Nothing was changed.",
    errorAr: "هذا القيد ليس ضمن مراجعة القيود غير المصنَّفة لهذه الشركة. لم يتغيّر شيء.",
  },
  notUnclassified: {
    status: 409,
    code: "journal_source_review_not_unclassified",
    error: "This entry is no longer unclassified: its source has been classified already. Nothing was changed.",
    errorAr: "لم يعد هذا القيد غير مصنَّف: صُنِّف مصدره من قبل. لم يتغيّر شيء.",
  },
  manual: {
    status: 422,
    code: "journal_source_review_manual_needs_policy",
    error:
      "An unclassified entry is not classified as a manual entry from here: that waits for an accountant-approved policy on entries whose source cannot be traced. The entry stays unclassified. Nothing was changed.",
    errorAr:
      "لا يُصنَّف القيد غير المصنَّف هنا قيداً يدوياً: ينتظر ذلك سياسة يعتمدها المحاسب للقيود التي لا يمكن تتبّع مصدرها. يبقى القيد غير مصنَّف. لم يتغيّر شيء.",
  },
  typeInvalid: {
    status: 422,
    code: "journal_source_review_type_invalid",
    error: "A review classifies an entry only as a source the records name. Choose one of the sources this screen lists as confirmed. Nothing was changed.",
    errorAr: "لا تصنِّف المراجعة القيد إلا بمصدر تذكره السجلات. اختر أحد المصادر التي تعرضها هذه الشاشة على أنها مؤكَّدة. لم يتغيّر شيء.",
  },
  noEvidence: {
    status: 422,
    code: "journal_source_review_no_evidence",
    error:
      "The records do not confirm this source for the entry today, so it was not classified. Choose a source this screen lists as confirmed; if none is, the entry stays unclassified. Nothing was changed.",
    errorAr:
      "لا تؤكّد السجلات اليوم هذا المصدر للقيد، لذا لم يُصنَّف. اختر مصدراً تعرضه هذه الشاشة على أنه مؤكَّد؛ وإن لم يوجد، يبقى القيد غير مصنَّف. لم يتغيّر شيء.",
  },
} as const satisfies Record<string, Refusal>;

/** The database's own refusals (0164), by the constraint name each raises with. */
const DB_REFUSAL: Record<string, Refusal> = {
  journal_source_review_admin_only: REVIEW_REFUSALS.adminOnly,
  journal_source_review_no_tenant: REVIEW_REFUSALS.adminOnly,
  journal_source_review_entry_not_found: REVIEW_REFUSALS.notFound,
  journal_source_review_not_unclassified: REVIEW_REFUSALS.notUnclassified,
  journal_source_review_manual_needs_policy: REVIEW_REFUSALS.manual,
  journal_source_review_type_invalid: REVIEW_REFUSALS.typeInvalid,
  journal_source_review_no_evidence: REVIEW_REFUSALS.noEvidence,
};

function refuse(r: Refusal): never {
  throw new BusinessRuleError(r.status, { code: r.code, error: r.error, errorAr: r.errorAr });
}

export type ReviewCandidateOut = {
  rule: "F" | "N" | "S" | "A" | "R";
  type: string;
  sourceId: number | null;
  checksPass: boolean;
  classifiable: boolean;
  evidence: Record<string, unknown>;
};

export type UnclassifiedEntryOut = {
  id: number;
  entryNumber: string | null;
  date: string;
  status: "draft" | "posted" | "reversed";
  description: string | null;
  total: number;
  currentSourceType: string;
  currentSourceId: number | null;
  reviewStatus: "classifiable" | "awaiting_policy" | "classified";
  backfillOutcome: "ambiguous" | "no_authoritative_relationship";
  backfillEvidence: Record<string, unknown>;
  candidates: ReviewCandidateOut[];
  review: { id: number; newSourceType: string; newSourceId: number | null; rule: "F" | "N" | "S" | "R"; reviewedAt: string } | null;
};

function toOut(r: ReviewListRow): UnclassifiedEntryOut {
  const review = r.review
    ? {
        id: r.review.id,
        newSourceType: r.review.new_source_type,
        newSourceId: r.review.new_source_id ?? null,
        rule: r.review.rule as "F" | "N" | "S" | "R",
        reviewedAt: new Date(r.review.reviewed_at).toISOString(),
      }
    : null;
  const candidates: ReviewCandidateOut[] = review
    ? []
    : (r.candidates ?? []).map((c) => ({
        rule: c.rule as ReviewCandidateOut["rule"],
        type: c.type,
        sourceId: c.source_id ?? null,
        checksPass: c.checks_pass === true,
        classifiable: c.checks_pass === true && REVIEWABLE_RULES.has(c.rule) && !NEVER_BY_REVIEW.has(c.type),
        evidence: c.evidence ?? {},
      }));
  const outcome = (r.backfill_evidence as { outcome?: string } | null)?.outcome;
  return {
    id: r.entry_id,
    entryNumber: r.entry_number,
    date: r.entry_date,
    status: r.entry_status as UnclassifiedEntryOut["status"],
    description: r.description,
    total: Number(r.total),
    currentSourceType: r.current_source_type,
    currentSourceId: r.current_source_id ?? null,
    reviewStatus: review ? "classified" : candidates.some((c) => c.classifiable) ? "classifiable" : "awaiting_policy",
    backfillOutcome: outcome === "ambiguous" ? "ambiguous" : "no_authoritative_relationship",
    backfillEvidence: r.backfill_evidence ?? {},
    candidates,
    review,
  };
}

function translateDbRefusal(err: unknown): never {
  const r = DB_REFUSAL[pgErrorFields(err).constraint ?? ""];
  if (r) refuse(r);
  throw err;
}

export const journalSourceReviewService = {
  async list(role: string | undefined, page: { limit: number; offset: number }) {
    if (role !== "admin" && role !== "accountant") refuse(REVIEW_REFUSALS.forbidden);
    const rows = await journalSourceReviewRepository.list(page.limit, page.offset);
    return { items: rows.map(toOut), total: Number(rows[0]?.total_count ?? 0), limit: page.limit, offset: page.offset };
  },

  async classify(role: string | undefined, entryId: number, body: { sourceType: string; sourceId?: number | null }) {
    if (role !== "admin") refuse(REVIEW_REFUSALS.adminOnly);
    // The database refuses each of these too (0164); refusing here first names them without a round trip.
    if (body.sourceType === "manual") refuse(REVIEW_REFUSALS.manual);
    if (NEVER_BY_REVIEW.has(body.sourceType)) refuse(REVIEW_REFUSALS.typeInvalid);
    try {
      await journalSourceReviewRepository.classify(entryId, body.sourceType, body.sourceId ?? null);
    } catch (err) {
      translateDbRefusal(err);
    }
    const [row] = await journalSourceReviewRepository.list(1, 0, entryId);
    if (!row) refuse(REVIEW_REFUSALS.notFound);
    return toOut(row);
  },
};
