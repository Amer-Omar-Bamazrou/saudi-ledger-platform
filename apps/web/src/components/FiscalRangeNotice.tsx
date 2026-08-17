/**
 * The inline notice a report shows when its default window is the ROLLING
 * fallback because no fiscal year is declared (M20.1, F11/F13).
 *
 * F13 placed this ON THE REPORT that is actually using the rolling window —
 * not a session-wide banner ("a persistent nag is noise") — and F11 requires
 * the wording to be specific enough to act on: what is not set, what the page
 * is doing meanwhile, and where to change it.
 *
 * Renders nothing for `fiscal` (the declared year needs no caveat) and nothing
 * for `rolling-unknown` (the settings fetch failed, so claiming "your year
 * hasn't been set" would assert something we do not know).
 */
import { Link } from "wouter";
import { useLanguage } from "@/contexts/LanguageContext";
import type { RangeSource } from "@/hooks/useReportDefaultRange";

export function FiscalRangeNotice({ source }: { source: RangeSource }) {
  const { t } = useLanguage();
  if (source !== "rolling-undeclared") return null;

  return (
    <p className="text-xs text-muted-foreground">
      {t(
        "Your financial year hasn't been set — showing the last 12 months. ",
        "لم تُحدَّد سنتك المالية — يُعرض آخر 12 شهراً. ",
      )}
      <Link href="/company" className="underline hover:text-foreground">
        {t("Set it in Company Settings", "حدِّدها في إعدادات الشركة")}
      </Link>
    </p>
  );
}

/**
 * What a report shows while `useReportDefaultRange` resolves. The report does
 * not mount until then — so a wrong window is never queried or rendered, even
 * for a frame. (Mirrors CompanySettings' own loading line.)
 */
export function ReportRangeLoading() {
  const { t } = useLanguage();
  return <p className="text-muted-foreground text-sm p-4">{t("Loading…", "جارٍ التحميل…")}</p>;
}
