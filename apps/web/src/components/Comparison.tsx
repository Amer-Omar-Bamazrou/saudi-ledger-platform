/**
 * Shared comparison pieces for the three financial statements (F7-cmp).
 *
 * The scope is deliberately the three statements ONLY (owner decision) —
 * these pieces are shared so the RULES live in one place, but each page
 * keeps its own table (the F5 posture).
 *
 * Rules enforced here rather than per-page:
 *  - the prior window is always NAMED (M20.3's formatter when it is a
 *    fiscal period), so nothing is compared against an unstated window;
 *  - an unavailable comparison says WHY (no earlier fiscal year known;
 *    the two windows answered from different sources) instead of showing a
 *    mixed or fabricated table;
 *  - an empty prior period renders as a named fact, never as a column of
 *    confident zeros (the flaw-#8 family);
 *  - variance carries NO status colours — a variance is a judgment, not a
 *    state (§4's palette rule).
 */
import { useLanguage } from "@/contexts/LanguageContext";
import { fmtDate } from "@/lib/api";
import { fiscalPeriodLabel } from "@/lib/fiscalLabel";
import type { CompareMode, PriorAsOf, PriorRange } from "@/lib/priorPeriod";

export type CompareSetting = "off" | CompareMode;

export function CompareSelect({
  value,
  onChange,
}: {
  value: CompareSetting;
  onChange: (v: CompareSetting) => void;
}) {
  const { t } = useLanguage();
  return (
    <div>
      <label className="text-xs text-muted-foreground block">{t("Compare", "مقارنة")}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as CompareSetting)}
        className="mt-1 h-8 text-sm rounded-md border border-border bg-background px-2"
      >
        <option value="off">{t("Off", "بدون")}</option>
        <option value="yoy">{t("Same period last year", "الفترة نفسها من العام الماضي")}</option>
        <option value="prev">{t("Previous period", "الفترة السابقة")}</option>
      </select>
    </div>
  );
}

/** "vs FY 1446 (Jul 2024 – Jun 2025)" / "vs 1 Apr 2025 – 30 Jun 2025" — the window, stated. */
export function priorRangeLabel(prior: PriorRange, lang: "en" | "ar"): string {
  const vs = lang === "ar" ? "مقابل" : "vs";
  if (prior.kind === "fiscal" && prior.fiscalPeriod) {
    return `${vs} ${fiscalPeriodLabel(prior.fiscalPeriod, lang)}`;
  }
  return `${vs} ${fmtDate(prior.from)} – ${fmtDate(prior.to)}`;
}

export function priorAsOfLabel(prior: PriorAsOf, lang: "en" | "ar"): string {
  const vs = lang === "ar" ? "مقابل" : "vs";
  if (prior.kind === "fiscal-end" && prior.fiscalPeriod) {
    return `${vs} ${fiscalPeriodLabel(prior.fiscalPeriod, lang)}`;
  }
  return `${vs} ${fmtDate(prior.date)}`;
}

/** The comparison could not honestly run — say why, show nothing else. */
export function ComparisonUnavailable({ reason }: { reason: string }) {
  return <p className="text-xs text-muted-foreground border border-border rounded-md px-3 py-2">{reason}</p>;
}
