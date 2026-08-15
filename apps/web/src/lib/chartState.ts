/**
 * "Should this chart draw, or say something?" (M19.3.1)
 *
 * 🔴 WHY THIS EXISTS. The first Analytics build rendered an axis, a legend and
 * nothing else whenever every point was null — and a second chart drew two flat
 * lines overlapping at zero on a y-axis recharts had auto-scaled to 0–4, which
 * reads as a ratio scale on a money chart.
 *
 * Both were faithful renderings of degenerate data. Neither was an acceptable
 * answer, because **an empty frame reads as "your business had no activity"** —
 * a statement about the TENANT that was false in most of these cases. It is the
 * same defect the API's 400 guards against: a data-quality or
 * nothing-to-compute problem presented as a business fact.
 *
 * So the decision is made explicitly, and each reason gets its own sentence.
 * Extracted here from the page so it can be tested — the logic that decides
 * whether a chart lies is worth more than the chart.
 */

export type EmptyReason = "loading" | "no_activity" | "all_withheld" | "undefined_ratio" | null;

export interface ClaimablePoint {
  claimable: boolean;
}

/**
 * Returns `null` when there is something worth drawing, otherwise the reason
 * there is not.
 *
 * `values` are the already-nulled series values — a withheld point arrives here
 * as `null`, which is also how recharts is told to break the line.
 *
 * The `ratio` flag distinguishes the two ways "all zeros" can happen: for money
 * it means nothing was posted; for a ratio it means there were no current
 * liabilities, which makes the ratio **undefined, not zero** — the same
 * distinction the API makes by returning null rather than 0.
 */
export function classifyChartState(
  points: readonly ClaimablePoint[] | undefined,
  values: ReadonlyArray<number | null>,
  opts: { ratio?: boolean } = {},
): EmptyReason {
  if (!points) return "loading";
  if (points.length === 0) return "no_activity";
  if (values.some((v) => v !== null && v !== 0)) return null;
  if (points.every((p) => !p.claimable)) return "all_withheld";
  return opts.ratio ? "undefined_ratio" : "no_activity";
}
