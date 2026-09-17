/**
 * Batch 1B Part 2, Phase D (2026-09-17) — THE MATCHING POLICY VALUES.
 *
 * PRODUCT POLICY, not accounting requirement (batch-1b decision pack §3):
 * no authoritative source states a date tolerance for bank matching, so the
 * window is a stated product value, centralised here so it is never
 * discovered in code. Changing it is a reviewed decision, not an edit.
 *
 * What is NOT a policy value, because it is identity: same bank, same
 * direction, exact amount, and an identifying reference resolving uniquely.
 * None of those has a tolerance.
 */

/** ± calendar days between a statement row's date and a payment's date. */
export const MATCH_DATE_WINDOW_DAYS = 3;

/** Exact amount only. Bank charges and gateway fees are a human's explicit override with the difference recorded as evidence. */
export const MATCH_AMOUNT_TOLERANCE = 0;

/** Tokens shorter than this never identify anything (they collide with everything). */
export const MATCH_MIN_REFERENCE_LENGTH = 4;
