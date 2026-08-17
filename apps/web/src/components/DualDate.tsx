/**
 * The shared date RENDER for ledger dates (F3-dual) — dual display at the
 * shared formatter, never per-page.
 *
 * For a tenant whose declared fiscal calendar is HIJRI, every ledger date
 * renders as the Gregorian primary with the Umm al-Qura date beneath it
 * (or as a tooltip in running text, where a second line would break the
 * sentence). The accountant asked for BOTH — which is why this is dual
 * display and not a toggle (F3). For a Gregorian tenant, and for an
 * undeclared one, output is exactly `fmtDate` — no second line exists to
 * be wrong about a calendar nobody declared.
 *
 * Hijri strings come from `lib/hijriDate`, which refuses (returns null) on
 * a runtime that would silently substitute Gregorian — so the fallback in
 * every failure direction is "Gregorian only", never a wrong Hijri date.
 *
 * Date INPUTS stay Gregorian, and in-table date CONVERSION (replacing the
 * Gregorian) stays out of scope — this renders alongside, never instead.
 */
import { useLanguage } from "@/contexts/LanguageContext";
import { fmtDate } from "@/lib/api";
import { formatHijri, hijriAvailable } from "@/lib/hijriDate";
import { useFiscalYearsQuery } from "@/hooks/useReportDefaultRange";

/** True only when a HIJRI fiscal calendar is DECLARED and the runtime passed the probe. */
export function useHijriDualDates(): boolean {
  const { data } = useFiscalYearsQuery();
  return !!data?.declared && data.calendar === "hijri" && hijriAvailable();
}

export function DualDate({
  date,
  inline = false,
}: {
  /** ISO date (or null/undefined — renders an em dash, absorbing the `x ? fmtDate(x) : "—"` sites). */
  date?: string | null;
  /** In running text a second line breaks the sentence — the Hijri date becomes the tooltip. */
  inline?: boolean;
}) {
  const dual = useHijriDualDates();
  const { lang } = useLanguage();

  if (!date) return <>—</>;
  const gregorian = fmtDate(date);
  const hijri = dual ? formatHijri(date, lang) : null;
  if (!hijri) return <>{gregorian}</>;

  if (inline) return <span title={hijri}>{gregorian}</span>;
  return (
    <span className="inline-flex flex-col leading-tight">
      <span>{gregorian}</span>
      <span className="text-[10px] opacity-70">{hijri}</span>
    </span>
  );
}
