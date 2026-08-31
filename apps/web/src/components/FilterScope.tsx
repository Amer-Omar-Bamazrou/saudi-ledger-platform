/**
 * FILTER SCOPE — the destination's answer to a deep link that carried a filter.
 *
 * ── 🔴 WHY A COMPONENT AND NOT A LINE OF JSX PER PAGE ──────────────────────
 * The owner's condition on every FILTER-OF nav entry: the destination must
 * REFLECT the filter — the heading, the selected control, and the row count.
 * Not "the link resolves"; that was never in doubt. The lost-scope defect had
 * a link that resolved perfectly to a page that answered a broader question
 * than the one asked, and every static check stayed green.
 *
 * Making it a component does three things a hand-rolled line per page cannot:
 * the wording is identical everywhere, the count is always the SERVER's total
 * for the filtered set rather than a length taken from the fetched page (the
 * volume lesson — a count off a capped list describes the page, not the set),
 * and it gives `e2e/nav-tree.spec.ts` ONE selector to assert against, so the
 * deep-link check can cover every filter entry mechanically instead of a
 * sample someone chose.
 *
 * Renders nothing when no filter is applied: an unfiltered list needs no
 * announcement, and a permanent "All" banner is noise that teaches nothing.
 */
import { useLanguage } from "@/contexts/LanguageContext";
import { filterLabel, type FilterOption } from "@/lib/listFilters";

export function FilterScope({
  options,
  value,
  total,
  onClear,
}: {
  options: readonly FilterOption[];
  value: string;
  /**
   * The count of the FILTERED set, from the server. `undefined` while loading —
   * rendered as an em dash rather than a 0, because a zero that means "not
   * measured yet" is the vacuous-green shape in miniature.
   */
  total: number | undefined;
  onClear: () => void;
}) {
  const { t, lang } = useLanguage();
  if (value === "all") return null;

  return (
    <div
      data-testid="filter-scope"
      data-status={value}
      data-total={total ?? ""}
      className="flex items-center gap-2 flex-wrap text-sm rounded-md border border-border bg-secondary/30 px-3 py-2"
    >
      <span className="text-muted-foreground">{t("Showing", "عرض")}</span>
      <span data-testid="filter-scope-label" className="font-semibold text-foreground">
        {filterLabel(options, value, lang)}
      </span>
      <span data-testid="filter-scope-count" className="font-mono text-muted-foreground">
        {total === undefined ? "—" : `· ${total.toLocaleString()}`}
      </span>
      <button
        type="button"
        onClick={onClear}
        className="ms-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        {t("Show all", "عرض الكل")}
      </button>
    </div>
  );
}
