import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";

export interface PageInfo {
  limit: number;
  offset: number;
  /** Rows matching the filter — not rows on this page. */
  total: number;
}

/**
 * "Showing 1–50 of 237", with a way to the rest.
 *
 * 🔴 A list that silently stops at 50 is the same defect as a count that
 * saturates at 200: the number describes a set the reader does not think they
 * are looking at (B-6). So a paginated list must always SAY what it is showing
 * and of how many — the page total is not decoration, it is the sentence that
 * makes the page honest.
 *
 * Extracted after the ledger pass wrote this markup inline in four pages and
 * twelve more were about to need it. Four copies of a rule are four places for
 * it to drift.
 */
export function ListPagination({
  page,
  shown,
  onPrev,
  onNext,
}: {
  page: PageInfo | undefined;
  /** Rows actually rendered — `items.length`, which is < limit on the last page. */
  shown: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { t } = useLanguage();
  if (!page || page.total === 0) return null;

  const first = page.offset + 1;
  const last = Math.min(page.offset + shown, page.total);
  const atStart = page.offset === 0;
  const atEnd = page.offset + shown >= page.total;

  return (
    <div className="flex items-center justify-between pt-3 text-sm text-muted-foreground">
      <span>
        {t(`Showing ${first}–${last} of ${page.total}`, `عرض ${first}–${last} من ${page.total}`)}
      </span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={atStart} onClick={onPrev}>
          {t("Previous", "السابق")}
        </Button>
        <Button variant="outline" size="sm" disabled={atEnd} onClick={onNext}>
          {t("Next", "التالي")}
        </Button>
      </div>
    </div>
  );
}
