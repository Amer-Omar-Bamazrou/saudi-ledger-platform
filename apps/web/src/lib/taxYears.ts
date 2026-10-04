/**
 * Which fiscal year a new Zakat / income-tax computation starts on, before the
 * person picks one (QA 2026-10-04: it pre-selected the OLDEST year offered —
 * the list is newest first and the code took its last item — so "Start" on a
 * company that went live on 2025-01-01 began 2024, the year its books hold only
 * the opening balances).
 *
 * The year a computation is for is normally the LATEST COMPLETED one: approval
 * waits until the year has ended. If no offered year has ended yet, the one
 * running today; failing that, the earliest offered. A suggestion only — the
 * person still chooses, and every offered year stays in the list.
 */
export interface OfferedYear { label: number; startDate: string; endDate: string }

export function defaultComputationYear(years: readonly OfferedYear[], today: string): OfferedYear | null {
  if (years.length === 0) return null;
  const completed = years.filter((y) => y.endDate < today).sort((a, b) => b.endDate.localeCompare(a.endDate));
  if (completed.length) return completed[0]!;
  const running = years.find((y) => y.startDate <= today && today <= y.endDate);
  if (running) return running;
  return [...years].sort((a, b) => a.startDate.localeCompare(b.startDate))[0]!;
}
